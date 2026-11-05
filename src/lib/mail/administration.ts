import { randomUUID } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import { z } from "zod";
import { MailError } from "./common.ts";
import { requireAdministration } from "./authorization.ts";

export const administrativeId = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export const membershipInput = z.strictObject({
  status: z.enum(["active", "suspended"]),
});
export const roleInput = z
  .strictObject({
    userId: administrativeId,
    scope: z.enum(["organization", "domain", "mailbox"]),
    domainId: administrativeId.optional(),
    identityId: administrativeId.optional(),
    status: z.enum(["active", "revoked"]),
  })
  .refine((x) =>
    x.scope === "organization"
      ? !x.domainId && !x.identityId
      : x.scope === "domain"
        ? !!x.domainId && !x.identityId
        : !!x.identityId && !x.domainId,
  );
export const grantInput = z.strictObject({
  canRead: z.boolean(),
  canSend: z.boolean(),
  canManage: z.boolean(),
});
type GrantInput = z.infer<typeof grantInput>;

async function member(tx: Transaction, tenant: string, user: string) {
  const row = (
    await tx.execute({
      sql: `SELECT m.status,u.status AS user_status FROM mail_memberships m JOIN mail_users u ON u.id=m.user_id WHERE m.tenant_id=? AND m.user_id=?`,
      args: [tenant, user],
    })
  ).rows[0];
  if (!row) throw new MailError("member_not_found", 404);
  return row;
}
function activeMember(row: Row) {
  if (row.status !== "active" || row.user_status !== "active")
    throw new MailError("member_inactive", 409);
}
async function lastAdministrator(tx: Transaction, tenant: string) {
  const count = (
    await tx.execute({
      sql: `SELECT count(*) AS n FROM mail_admin_grants a
    JOIN mail_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id
    JOIN mail_users u ON u.id=a.user_id WHERE a.tenant_id=? AND a.scope='organization' AND a.status='active' AND m.status='active' AND u.status='active'`,
      args: [tenant],
    })
  ).rows[0];
  if (!Number(count.n))
    throw new MailError("last_organization_administrator", 409);
}
async function audit(
  tx: Transaction,
  tenant: string,
  actor: string,
  target: string,
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
const permissions = (row?: Row): GrantInput => ({
  canRead: !!row?.can_read,
  canSend: !!row?.can_send,
  canManage: !!row?.can_manage,
});

// Administrative scope and content delegation are separate gates. An administrator
// may revoke a grant without reading its mailbox, but may not mint content privileges.
async function delegationCeiling(
  tx: Transaction,
  tenant: string,
  actor: string,
  identity: string,
  before: GrantInput,
  after: GrantInput,
) {
  const own = permissions(
    (
      await tx.execute({
        sql: "SELECT can_read,can_send,can_manage FROM mail_identity_grants WHERE tenant_id=? AND identity_id=? AND user_id=?",
        args: [tenant, identity, actor],
      })
    ).rows[0],
  );
  if (
    (after.canRead && !before.canRead && !own.canRead) ||
    (after.canSend && !before.canSend && !own.canSend) ||
    (after.canManage &&
      (!before.canManage || (after.canRead && !before.canRead)) &&
      !(own.canRead && own.canManage))
  )
    throw new MailError("content_delegation_exceeds_permissions", 403);
}

export async function updateMembership(
  tx: Transaction,
  tenant: string,
  actor: string,
  target: string,
  input: z.infer<typeof membershipInput>,
) {
  await requireAdministration(tx, actor, tenant);
  const before = (
    await tx.execute({
      sql: "SELECT status FROM mail_memberships WHERE tenant_id=? AND user_id=?",
      args: [tenant, target],
    })
  ).rows[0];
  if (before?.status === input.status) return { changed: false };
  const user = (
    await tx.execute({
      sql: "SELECT status FROM mail_users WHERE id=?",
      args: [target],
    })
  ).rows[0];
  if (!user) throw new MailError("member_not_found", 404);
  if (input.status === "active") {
    if (user.status !== "active") throw new MailError("member_inactive", 409);
    // Reactivation restores latent permissions, so check their content ceiling too.
    const grants = (
      await tx.execute({
        sql: "SELECT identity_id,can_read,can_send,can_manage FROM mail_identity_grants WHERE tenant_id=? AND user_id=?",
        args: [tenant, target],
      })
    ).rows;
    for (const grant of grants)
      await delegationCeiling(
        tx,
        tenant,
        actor,
        String(grant.identity_id),
        permissions(),
        permissions(grant),
      );
  } else if (!before) throw new MailError("member_not_found", 404);
  await tx.execute({
    sql: "INSERT INTO mail_memberships(tenant_id,user_id,status) VALUES (?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET status=excluded.status",
    args: [tenant, target, input.status],
  });
  await lastAdministrator(tx, tenant);
  await audit(tx, tenant, actor, target, "membership_updated", {
    before: before?.status ?? null,
    after: input.status,
  });
  return { changed: true };
}

export async function updateAdministrativeRole(
  tx: Transaction,
  tenant: string,
  actor: string,
  input: z.infer<typeof roleInput>,
) {
  await requireAdministration(tx, actor, tenant, {
    domainId: input.domainId,
    identityId: input.identityId,
  });
  const target = await member(tx, tenant, input.userId);
  if (input.status === "active") activeMember(target);
  const before = (
    await tx.execute({
      sql: "SELECT id,status FROM mail_admin_grants WHERE tenant_id=? AND user_id=? AND scope=? AND domain_id IS ? AND identity_id IS ?",
      args: [
        tenant,
        input.userId,
        input.scope,
        input.domainId ?? null,
        input.identityId ?? null,
      ],
    })
  ).rows[0];
  if (
    before?.status === input.status ||
    (!before && input.status === "revoked")
  )
    return { changed: false };
  const id = String(before?.id ?? randomUUID());
  if (before)
    await tx.execute({
      sql: "UPDATE mail_admin_grants SET status=? WHERE tenant_id=? AND id=?",
      args: [input.status, tenant, id],
    });
  else
    await tx.execute({
      sql: "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,domain_id,identity_id,status) VALUES (?,?,?,?,?,?,?)",
      args: [
        id,
        tenant,
        input.userId,
        input.scope,
        input.domainId ?? null,
        input.identityId ?? null,
        input.status,
      ],
    });
  if (input.scope === "organization") await lastAdministrator(tx, tenant);
  await audit(tx, tenant, actor, input.userId, "administrative_role_updated", {
    roleId: id,
    scope: input.scope,
    domainId: input.domainId ?? null,
    identityId: input.identityId ?? null,
    before: before?.status ?? null,
    after: input.status,
  });
  return { changed: true };
}

export async function updateContentGrant(
  tx: Transaction,
  tenant: string,
  actor: string,
  identity: string,
  target: string,
  input: GrantInput | null,
) {
  await requireAdministration(tx, actor, tenant, { identityId: identity });
  const membership = await member(tx, tenant, target);
  const row = (
    await tx.execute({
      sql: "SELECT can_read,can_send,can_manage FROM mail_identity_grants WHERE tenant_id=? AND identity_id=? AND user_id=?",
      args: [tenant, identity, target],
    })
  ).rows[0];
  const before = permissions(row);
  if (input) {
    await delegationCeiling(tx, tenant, actor, identity, before, input);
    if (
      (input.canRead && !before.canRead) ||
      (input.canSend && !before.canSend) ||
      (input.canManage && !before.canManage)
    )
      activeMember(membership);
    if (row && JSON.stringify(before) === JSON.stringify(input))
      return { changed: false };
    await tx.execute({
      sql: "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_read,can_send,can_manage) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,identity_id,user_id) DO UPDATE SET can_read=excluded.can_read,can_send=excluded.can_send,can_manage=excluded.can_manage",
      args: [
        tenant,
        identity,
        target,
        input.canRead ? 1 : 0,
        input.canSend ? 1 : 0,
        input.canManage ? 1 : 0,
      ],
    });
  } else {
    if (!row) return { changed: false };
    await tx.execute({
      sql: "DELETE FROM mail_identity_grants WHERE tenant_id=? AND identity_id=? AND user_id=?",
      args: [tenant, identity, target],
    });
  }
  await audit(
    tx,
    tenant,
    actor,
    target,
    input ? "content_grant_updated" : "content_grant_revoked",
    { identityId: identity, before: row ? before : null, after: input },
  );
  return { changed: true };
}
