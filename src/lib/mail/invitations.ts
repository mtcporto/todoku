import { randomBytes, randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { z } from "zod";
import { requireAdministration } from "./authorization.ts";
import { administrativeId } from "./administration.ts";
import { hash, MailError } from "./common.ts";
import { bindGoogleIdentity, googleBinding } from "./google-identity.ts";

export const invitationToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const invitationInput = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((x) => x.toLowerCase()),
  userId: administrativeId.optional(),
  expiresInHours: z.int().min(1).max(168).default(24),
});
async function invitationAudit(
  tx: Transaction,
  tenant: string,
  actor: string,
  target: string | null,
  action: string,
  details: unknown,
) {
  await tx.execute({
    sql: "INSERT INTO mail_administration_audit(tenant_id,id,actor_user_id,target_user_id,action,details_json) VALUES (?,?,?,?,?,?)",
    args: [
      tenant,
      randomUUID(),
      actor,
      target,
      action,
      JSON.stringify(details),
    ],
  });
}
export async function createInvitation(
  tx: Transaction,
  tenant: string,
  actor: string,
  input: z.infer<typeof invitationInput>,
) {
  await requireAdministration(tx, actor, tenant);
  if (input.userId) {
    const target = (
      await tx.execute({
        sql: "SELECT status FROM mail_users WHERE id=?",
        args: [input.userId],
      })
    ).rows[0];
    if (!target) throw new MailError("member_not_found", 404);
    if (target.status !== "active") throw new MailError("member_inactive", 409);
    const member = (
      await tx.execute({
        sql: "SELECT status FROM mail_memberships WHERE tenant_id=? AND user_id=?",
        args: [tenant, input.userId],
      })
    ).rows[0];
    if (member)
      throw new MailError(
        member.status === "active"
          ? "member_already_active"
          : "membership_suspended",
        409,
      );
  }
  const prior = (
    await tx.execute({
      sql: "SELECT id,target_user_id,expires_at FROM mail_invitations WHERE tenant_id=? AND email_normalized=? AND state='pending'",
      args: [tenant, input.email],
    })
  ).rows[0];
  if (prior) {
    if (Date.parse(String(prior.expires_at)) > Date.now())
      throw new MailError("invitation_already_pending", 409);
    await tx.execute({
      sql: "UPDATE mail_invitations SET state='expired' WHERE id=?",
      args: [prior.id],
    });
    await invitationAudit(
      tx,
      tenant,
      actor,
      prior.target_user_id === null ? null : String(prior.target_user_id),
      "invitation_expired",
      { invitationId: prior.id },
    );
  }
  const count = (
    await tx.execute({
      sql: "SELECT count(*) AS n FROM mail_invitations WHERE tenant_id=? AND state='pending' AND julianday(expires_at)>julianday('now')",
      args: [tenant],
    })
  ).rows[0];
  if (Number(count.n) >= 100) throw new MailError("invitation_limit", 429);
  const token = randomBytes(32).toString("base64url"),
    id = randomUUID(),
    expiresAt = new Date(
      Date.now() + input.expiresInHours * 3600000,
    ).toISOString();
  await tx.execute({
    sql: "INSERT INTO mail_invitations(id,tenant_id,email_normalized,target_user_id,token_hash,created_by,expires_at) VALUES (?,?,?,?,?,?,?)",
    args: [
      id,
      tenant,
      input.email,
      input.userId ?? null,
      hash(token),
      actor,
      expiresAt,
    ],
  });
  await invitationAudit(
    tx,
    tenant,
    actor,
    input.userId ?? null,
    "invitation_created",
    { invitationId: id, expiresAt },
  );
  return { id, token, expiresAt };
}
export async function endInvitation(
  tx: Transaction,
  tenant: string,
  actor: string,
  id: string,
  state: "revoked" | "expired",
) {
  await requireAdministration(tx, actor, tenant);
  const invitation = (
    await tx.execute({
      sql: "SELECT state,target_user_id FROM mail_invitations WHERE tenant_id=? AND id=?",
      args: [tenant, id],
    })
  ).rows[0];
  if (!invitation) throw new MailError("not_found", 404);
  if (invitation.state === "accepted")
    throw new MailError("invitation_already_used", 409);
  if (invitation.state !== "pending") return { changed: false };
  await tx.execute({
    sql: "UPDATE mail_invitations SET state=? WHERE tenant_id=? AND id=?",
    args: [state, tenant, id],
  });
  await invitationAudit(
    tx,
    tenant,
    actor,
    invitation.target_user_id === null
      ? null
      : String(invitation.target_user_id),
    "invitation_" + state,
    { invitationId: id },
  );
  return { changed: true };
}
export async function pendingInvitation(
  tx: Pick<Transaction, "execute">,
  id: string,
  byToken = false,
) {
  const row = (
    await tx.execute({
      sql: `SELECT v.id,v.tenant_id,v.email_normalized,v.target_user_id,v.created_by FROM mail_invitations v JOIN tenants t ON t.id=v.tenant_id WHERE v.${byToken ? "token_hash" : "id"}=? AND v.state='pending' AND julianday(v.expires_at)>julianday('now') AND t.status='active'`,
      args: [id],
    })
  ).rows[0];
  if (!row) throw new MailError("invitation_unavailable", 401);
  return row;
}
// Runs only after signature/issuer/audience/nonce/PKCE and verified email checks.
export async function acceptInvitation(
  tx: Transaction,
  id: string,
  subject: string,
  email: string,
  sessionUser: string | null,
) {
  const invitation = await pendingInvitation(tx, id);
  if (invitation.email_normalized !== email)
    throw new MailError("invalid_oidc", 401);
  await requireAdministration(
    tx,
    String(invitation.created_by),
    String(invitation.tenant_id),
  );
  const binding = await googleBinding(tx, subject);
  if (
    (invitation.target_user_id &&
      binding &&
      binding.user_id !== invitation.target_user_id) ||
    (sessionUser && binding && binding.user_id !== sessionUser) ||
    (sessionUser &&
      invitation.target_user_id &&
      sessionUser !== invitation.target_user_id)
  )
    throw new MailError("invalid_oidc", 401);
  let user = binding
    ? String(binding.user_id)
    : invitation.target_user_id
      ? String(invitation.target_user_id)
      : sessionUser;
  if (!binding && user && sessionUser !== user)
    throw new MailError("invalid_oidc", 401);
  if (!user) {
    user = randomUUID();
    await tx.execute({
      sql: "INSERT INTO mail_users(id,username,password_hash) VALUES (?,?,'!google-only')",
      args: [user, "user_" + user],
    });
  }
  const active = (
    await tx.execute({
      sql: "SELECT status FROM mail_users WHERE id=?",
      args: [user],
    })
  ).rows[0];
  if (active?.status !== "active") throw new MailError("invalid_oidc", 401);
  await bindGoogleIdentity(tx, user, subject, email);
  const member = (
    await tx.execute({
      sql: "SELECT status FROM mail_memberships WHERE tenant_id=? AND user_id=?",
      args: [invitation.tenant_id, user],
    })
  ).rows[0];
  if (member?.status === "suspended")
    throw new MailError("membership_suspended", 409);
  if (!member)
    await tx.execute({
      sql: "INSERT INTO mail_memberships(tenant_id,user_id) VALUES (?,?)",
      args: [invitation.tenant_id, user],
    });
  const accepted = await tx.execute({
    sql: "UPDATE mail_invitations SET state='accepted',accepted_user_id=?,accepted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state='pending' AND julianday(expires_at)>julianday('now')",
    args: [user, id],
  });
  if (accepted.rowsAffected !== 1)
    throw new MailError("invitation_unavailable", 401);
  await invitationAudit(
    tx,
    String(invitation.tenant_id),
    user,
    user,
    "invitation_accepted",
    { invitationId: id, existingMembership: !!member },
  );
  return user;
}
