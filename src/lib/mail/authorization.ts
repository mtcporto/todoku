import { randomUUID } from "node:crypto";
import type { Client, Row, Transaction } from "@libsql/client";
import { MailError, transaction } from "./common.ts";

type Database = Pick<Client, "execute"> | Transaction;

// All content endpoints use the same joins and predicate. Administrative roles
// deliberately do not participate in these queries.
export const contentJoins = `FROM mail_messages m
 JOIN mail_message_recipients r ON r.tenant_id=m.tenant_id AND r.message_id=m.id
 JOIN mail_identity_grants g ON g.tenant_id=r.tenant_id AND g.identity_id=r.identity_id
 JOIN mail_identities i ON i.tenant_id=r.tenant_id AND i.id=r.identity_id
 JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id
 JOIN mail_sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id AND s.id=m.source_id
 JOIN tenants t ON t.id=m.tenant_id JOIN mail_users u ON u.id=g.user_id
 JOIN mail_memberships membership ON membership.tenant_id=g.tenant_id AND membership.user_id=g.user_id`;
export const contentVisible = `m.state='ready' AND julianday(m.expires_at)>julianday('now')
 AND r.deleted_at IS NULL AND t.status='active' AND u.status='active'
 AND membership.status='active' AND i.status='active' AND d.status='active' AND s.status='active'
 AND ((m.delivery_status='draft' AND g.can_send=1 AND
 (m.author_user_id=g.user_id OR (m.author_user_id IS NULL AND g.can_read=1)))
 OR (m.delivery_status!='draft' AND (g.can_read=1 OR
 (m.direction='outbound' AND m.author_user_id=g.user_id AND g.can_send=1))))`;

export async function identityGrant(
  db: Database,
  user: string,
  identity: string,
  action: "read" | "send" | "manage" = "read",
) {
  const row = (
    await db.execute({
      sql: `SELECT i.*,d.source_id,d.status AS domain_status,s.status AS source_status,s.provider,s.retention_days,g.can_read,g.can_send,g.can_manage
  FROM mail_identity_grants g JOIN mail_identities i ON i.tenant_id=g.tenant_id AND i.id=g.identity_id
  JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id
  JOIN mail_sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id
  JOIN tenants t ON t.id=i.tenant_id JOIN mail_users u ON u.id=g.user_id
  JOIN mail_memberships membership ON membership.tenant_id=g.tenant_id AND membership.user_id=g.user_id
  WHERE g.user_id=? AND i.id=? AND t.status='active' AND u.status='active' AND membership.status='active'`,
      args: [user, identity],
    })
  ).rows[0];
  if (!row) throw new MailError("not_found", 404);
  if (
    row.status !== "active" ||
    row.domain_status !== "active" ||
    row.source_status !== "active"
  )
    throw new MailError("mailbox_unavailable", 403);
  if (
    (action === "read" && !row.can_read) ||
    (action === "send" && !row.can_send) ||
    (action === "manage" && (!row.can_read || !row.can_manage))
  )
    throw new MailError(
      action === "send"
        ? "sending_not_permitted"
        : action === "manage"
          ? "management_not_permitted"
          : "reading_not_permitted",
      403,
    );
  return row;
}

export async function messageGrant(
  db: Database,
  user: string,
  id: string,
  identity: string | null,
) {
  const row = (
    await db.execute({
      sql: `SELECT m.*,r.identity_id,r.folder,r.previous_folder,r.deleted_at,r.thread_id,r.trashed_at,g.can_read,g.can_send,g.can_manage,s.provider
 ${contentJoins} WHERE m.id=? AND g.user_id=? AND (? IS NULL OR r.identity_id=?) AND ${contentVisible} LIMIT 1`,
      args: [id, user, identity, identity],
    })
  ).rows[0];
  if (!row) throw new MailError("not_found", 404);
  return row;
}

export function canManageMessage(message: Row, user: string) {
  return Boolean(
    (message.can_read && message.can_manage) ||
      (message.delivery_status === "draft" &&
        message.author_user_id === user &&
        message.can_send),
  );
}
export async function manageMessage(
  db: Database,
  user: string,
  id: string,
  identity: string,
) {
  const message = await messageGrant(db, user, id, identity);
  if (!canManageMessage(message, user))
    throw new MailError("management_not_permitted", 403);
  return message;
}

// Administration includes disabled resources, so authorized administrators can
// later reactivate metadata. It never grants permission to read their contents.
export async function requireAdministration(
  db: Database,
  user: string,
  tenant: string,
  scope: { domainId?: string; identityId?: string } = {},
) {
  let domain = scope.domainId ?? null;
  if (scope.identityId) {
    const identity = (
      await db.execute({
        sql: "SELECT domain_id FROM mail_identities WHERE tenant_id=? AND id=?",
        args: [tenant, scope.identityId],
      })
    ).rows[0];
    if (!identity || (domain && domain !== identity.domain_id))
      throw new MailError("not_found", 404);
    domain = String(identity.domain_id);
  } else if (
    domain &&
    !(
      await db.execute({
        sql: "SELECT id FROM mail_domains WHERE tenant_id=? AND id=?",
        args: [tenant, domain],
      })
    ).rows.length
  )
    throw new MailError("not_found", 404);
  const grant = (
    await db.execute({
      sql: `SELECT a.* FROM mail_admin_grants a
 JOIN mail_memberships membership ON membership.tenant_id=a.tenant_id AND membership.user_id=a.user_id
 JOIN mail_users u ON u.id=a.user_id JOIN tenants t ON t.id=a.tenant_id
 WHERE a.tenant_id=? AND a.user_id=? AND a.status='active' AND membership.status='active' AND u.status='active' AND t.status='active'
 AND (a.scope='organization' OR (a.scope='domain' AND a.domain_id=?) OR (a.scope='mailbox' AND a.identity_id=?)) LIMIT 1`,
      args: [tenant, user, domain, scope.identityId ?? null],
    })
  ).rows[0];
  if (!grant) throw new MailError("administration_not_permitted", 403);
  return grant;
}

// Trusted operator-only bootstrap. Never called during authentication or exposed
// as an HTTP endpoint. The authorized UUID and actor must be provided explicitly.
export async function bootstrapAdministrator(
  db: Client,
  tenant: string,
  user: string,
  actor: string,
  confirmed: boolean,
) {
  if (!confirmed || user !== actor)
    throw new MailError("explicit_bootstrap_required", 403);
  return transaction(db, async (tx) => {
    const member = (
      await tx.execute({
        sql: `SELECT u.id FROM mail_memberships m JOIN mail_users u ON u.id=m.user_id JOIN tenants t ON t.id=m.tenant_id
   WHERE m.tenant_id=? AND m.user_id=? AND m.status='active' AND u.status='active' AND t.status='active'`,
        args: [tenant, user],
      })
    ).rows[0];
    if (!member) throw new MailError("not_found", 404);
    const current = (
      await tx.execute({
        sql: "SELECT user_id,status FROM mail_admin_grants WHERE tenant_id=? AND scope='organization'",
        args: [tenant],
      })
    ).rows;
    if (current.some((x) => x.user_id !== user || x.status !== "active"))
      throw new MailError("bootstrap_already_initialized", 409);
    if (current.length) return { created: false, userId: user };
    await tx.execute({
      sql: "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope) VALUES (?,?,?,'organization')",
      args: [randomUUID(), tenant, user],
    });
    await tx.execute({
      sql: "INSERT INTO mail_administration_audit(tenant_id,id,actor_user_id,target_user_id,action,details_json) VALUES (?,?,?,?,'organization_admin_bootstrapped',?)",
      args: [
        tenant,
        randomUUID(),
        actor,
        user,
        JSON.stringify({
          scope: "organization",
          method: "explicit_uuid_operator",
        }),
      ],
    });
    return { created: true, userId: user };
  });
}
