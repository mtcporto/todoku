import type { Client, Transaction } from "@libsql/client";

export type AdminDatabase = Pick<Client, "execute"> | Transaction;
export type AdminScope = {
  tenantId: string;
  scope: "organization" | "domain" | "mailbox";
  domainId: string | null;
  identityId: string | null;
};
export async function administrativeCapabilities(
  db: AdminDatabase,
  user: string,
) {
  const rows = (
    await db.execute({
      sql: `SELECT a.tenant_id,a.scope,a.domain_id,a.identity_id
      FROM mail_admin_grants a
      JOIN mail_memberships membership ON membership.tenant_id=a.tenant_id AND membership.user_id=a.user_id
      JOIN mail_users u ON u.id=a.user_id JOIN tenants t ON t.id=a.tenant_id
      WHERE a.user_id=? AND a.status='active' AND membership.status='active' AND u.status='active' AND t.status='active'
      ORDER BY a.tenant_id,a.scope,a.domain_id,a.identity_id`,
      args: [user],
    })
  ).rows;
  const scopes: AdminScope[] = rows.map((row) => ({
    tenantId: String(row.tenant_id),
    scope: row.scope as AdminScope["scope"],
    domainId: row.domain_id === null ? null : String(row.domain_id),
    identityId: row.identity_id === null ? null : String(row.identity_id),
  }));
  return { canAdminister: scopes.length > 0, scopes };
}
