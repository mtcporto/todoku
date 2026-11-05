import type { Client, Transaction, InValue } from "@libsql/client";
import { z } from "zod";
import { requireUser, sameOrigin } from "./auth.ts";
import { body, json, MailError, transaction } from "./common.ts";
import { administrativeCapabilities } from "./admin-capabilities.ts";
import { invitationAdministration } from "./invitations-http.ts";
import {
  administrativeId,
  membershipInput,
  roleInput,
  grantInput,
  updateMembership,
  updateAdministrativeRole,
  updateContentGrant,
} from "./administration.ts";

// Only metadata is selected. There is no join to messages, objects, auth identities,
// sessions or provider configuration, and no SELECT * on administrative responses.
const roleVisible = `(EXISTS(SELECT 1 FROM own WHERE scope='organization')
 OR (a.scope='domain' AND EXISTS(SELECT 1 FROM own WHERE scope='domain' AND domain_id=a.domain_id))
 OR (a.scope='mailbox' AND a.identity_id IN (SELECT id FROM visible_boxes)))`;
const catalog = `WITH own AS (
 SELECT a.tenant_id,a.scope,a.domain_id,a.identity_id FROM mail_admin_grants a
 JOIN mail_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id
 JOIN mail_users u ON u.id=a.user_id JOIN tenants t ON t.id=a.tenant_id
 WHERE a.user_id=? AND a.tenant_id=? AND a.status='active' AND m.status='active' AND u.status='active' AND t.status='active'
), visible_boxes AS (
 SELECT i.tenant_id,i.id,i.domain_id,i.address,i.label,i.status FROM mail_identities i
 WHERE i.tenant_id=(SELECT tenant_id FROM own LIMIT 1) AND EXISTS(
 SELECT 1 FROM own WHERE scope='organization' OR (scope='domain' AND domain_id=i.domain_id) OR (scope='mailbox' AND identity_id=i.id))
), visible_domains AS (
 SELECT d.id,d.name,d.status FROM mail_domains d WHERE d.tenant_id=(SELECT tenant_id FROM own LIMIT 1)
 AND (EXISTS(SELECT 1 FROM own WHERE scope='organization' OR (scope='domain' AND domain_id=d.id)) OR d.id IN (SELECT domain_id FROM visible_boxes))
), visible_members AS (
 SELECT m.user_id,m.status,u.username,u.status AS account_status FROM mail_memberships m JOIN mail_users u ON u.id=m.user_id
 WHERE m.tenant_id=(SELECT tenant_id FROM own LIMIT 1) AND
 (EXISTS(SELECT 1 FROM own WHERE scope='organization') OR
 EXISTS(SELECT 1 FROM mail_identity_grants g WHERE g.tenant_id=m.tenant_id AND g.user_id=m.user_id AND g.identity_id IN (SELECT id FROM visible_boxes)) OR
 EXISTS(SELECT 1 FROM mail_admin_grants a WHERE a.tenant_id=m.tenant_id AND a.user_id=m.user_id AND ${roleVisible}))
)`;
const collections = [
  "domains",
  "mailboxes",
  "memberships",
  "roles",
  "grants",
] as const;
type Collection = (typeof collections)[number] | "organizations";
const pagination = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(1200).optional(),
  domainId: administrativeId.optional(),
  identityId: administrativeId.optional(),
});
function pageInput(url: URL, collection: Collection, tenant: string | null) {
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (key in values) throw new MailError("invalid_filter");
    values[key] = value;
  }
  const input = pagination.parse(values);
  if (
    (input.domainId && !["mailboxes", "grants"].includes(collection)) ||
    (input.identityId && collection !== "grants")
  )
    throw new MailError("invalid_filter");
  const context = {
    collection,
    tenant,
    domainId: input.domainId ?? null,
    identityId: input.identityId ?? null,
  };
  let key: string | null = null;
  if (input.cursor) {
    try {
      const cursor = z
        .strictObject({ context: z.string(), key: z.string().min(1).max(201) })
        .parse(
          JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")),
        );
      if (cursor.context !== JSON.stringify(context))
        throw new Error("different list");
      key = cursor.key;
    } catch {
      throw new MailError("invalid_cursor");
    }
  }
  return { ...input, key, context };
}
async function list(
  tx: Transaction,
  user: string,
  tenant: string | null,
  collection: Collection,
  url: URL,
) {
  const page = pageInput(url, collection, tenant);
  const capabilities = await administrativeCapabilities(tx, user);
  if (tenant && !capabilities.scopes.some((x) => x.tenantId === tenant))
    throw new MailError("administration_not_permitted", 403);
  let sql: string, key: string, args: InValue[];
  if (collection === "organizations") {
    sql = `SELECT t.id,t.status FROM tenants t WHERE t.status='active' AND t.id IN
   (SELECT a.tenant_id FROM mail_admin_grants a JOIN mail_memberships m ON m.tenant_id=a.tenant_id AND m.user_id=a.user_id
    WHERE a.user_id=? AND a.status='active' AND m.status='active')`;
    key = "t.id";
    args = [user];
  } else {
    args = [user, tenant];
    switch (collection) {
      case "domains":
        sql = "SELECT d.id,d.name,d.status FROM visible_domains d WHERE 1=1";
        key = "d.id";
        break;
      case "mailboxes":
        sql =
          "SELECT b.id,b.domain_id,b.address,b.label,b.status FROM visible_boxes b WHERE 1=1";
        key = "b.id";
        break;
      case "memberships":
        sql =
          "SELECT m.user_id,m.username,m.status,m.account_status FROM visible_members m WHERE 1=1";
        key = "m.user_id";
        break;
      case "roles":
        sql = `SELECT a.id,a.user_id,a.scope,a.domain_id,a.identity_id,a.status FROM mail_admin_grants a WHERE a.tenant_id=(SELECT tenant_id FROM own LIMIT 1) AND ${roleVisible}`;
        key = "a.id";
        break;
      case "grants":
        sql =
          "SELECT g.identity_id,g.user_id,g.can_read,g.can_send,g.can_manage FROM mail_identity_grants g JOIN visible_boxes b ON b.tenant_id=g.tenant_id AND b.id=g.identity_id WHERE 1=1";
        key = "g.identity_id||':'||g.user_id";
        break;
    }
    if (page.domainId) {
      sql += " AND b.domain_id=?";
      args.push(page.domainId);
    }
    if (page.identityId) {
      sql += " AND b.id=?";
      args.push(page.identityId);
    }
  }
  // Repeat the safe key expression as an extra selected field, then remove it.
  sql = sql.replace(" FROM ", `,${key} AS page_key FROM `);
  sql += ` AND (? IS NULL OR (${key})>?) ORDER BY (${key}) LIMIT ?`;
  args.push(page.key, page.key, page.limit + 1);
  const rows = (
    await tx.execute({ sql: (tenant ? catalog + " " : "") + sql, args })
  ).rows;
  const items = rows.slice(0, page.limit).map(({ page_key, ...item }) => item);
  return json({
    items,
    nextCursor:
      rows.length > page.limit
        ? Buffer.from(
            JSON.stringify({
              context: JSON.stringify(page.context),
              key: String(rows[page.limit - 1].page_key),
            }),
          ).toString("base64url")
        : null,
  });
}

export async function administrativeRequest(
  request: Request,
  segments: string[],
  db: Client,
) {
  await requireUser(db, request);
  const url = new URL(request.url);
  if (segments[0] !== "organizations") throw new MailError("not_found", 404);
  const tenant =
    segments[1] === undefined ? null : administrativeId.parse(segments[1]);
  if (tenant && segments[2] === "invitations")
    return invitationAdministration(request, segments, db, tenant);
  if (request.method === "GET") {
    const collection = tenant
      ? z.enum(collections).parse(segments[2])
      : "organizations";
    if (segments.length !== (tenant ? 3 : 1))
      throw new MailError("not_found", 404);
    const tx = await db.transaction("read");
    try {
      const actor = await requireUser(tx, request);
      const result = await list(tx, actor.id, tenant, collection, url);
      await tx.commit();
      return result;
    } finally {
      tx.close();
    }
  }
  if (!tenant) return json({ error: "method_not_allowed" }, 405);
  sameOrigin(request);
  if (url.search) throw new MailError("invalid_filter");
  let operation: "membership" | "role" | "grant";
  if (
    segments[2] === "memberships" &&
    segments.length === 4 &&
    request.method === "PUT"
  )
    operation = "membership";
  else if (
    segments[2] === "roles" &&
    segments.length === 3 &&
    request.method === "PUT"
  )
    operation = "role";
  else if (
    segments[2] === "mailboxes" &&
    segments[4] === "grants" &&
    segments.length === 6 &&
    ["PUT", "DELETE"].includes(request.method)
  )
    operation = "grant";
  else return json({ error: "method_not_allowed" }, 405);
  const raw = request.body ? JSON.parse(await body(request, 4096)) : undefined;
  const input =
    operation === "membership"
      ? membershipInput.parse(raw)
      : operation === "role"
        ? roleInput.parse(raw)
        : request.method === "DELETE"
          ? raw === undefined
            ? null
            : (z.strictObject({}).parse(raw), null)
          : grantInput.parse(raw);
  const target =
    operation === "membership"
      ? administrativeId.parse(segments[3])
      : operation === "grant"
        ? administrativeId.parse(segments[5])
        : null;
  const identity =
    operation === "grant" ? administrativeId.parse(segments[3]) : null;
  return transaction(db, async (tx) => {
    // Recheck the actual session and role after body I/O and under the write lock.
    const actor = await requireUser(tx, request);
    const result =
      operation === "membership"
        ? await updateMembership(
            tx,
            tenant,
            actor.id,
            target!,
            input as z.infer<typeof membershipInput>,
          )
        : operation === "role"
          ? await updateAdministrativeRole(
              tx,
              tenant,
              actor.id,
              input as z.infer<typeof roleInput>,
            )
          : await updateContentGrant(
              tx,
              tenant,
              actor.id,
              identity!,
              target!,
              input as z.infer<typeof grantInput> | null,
            );
    return json(result);
  });
}
