import type { Client, Transaction, Row } from "@libsql/client";
import { z } from "zod";
import { address, MailError, limits, filename, transaction } from "./common.ts";
import type { MailStorage } from "./storage.ts";

export const outboundLimits = {
  recipients: 10,
  attachmentBytes: 2 * 1024 * 1024,
  requestBytes: 4 * 1024 * 1024,
};
export const mailboxFolder = z.enum(["inbox", "sent", "drafts", "trash"]);
export const rfcId = (value: unknown): string | null =>
  typeof value === "string" && /^<[^<>\s]{1,500}>$/.test(value) ? value : null;
export type Envelope = {
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo?: string[];
};
export type DraftContent = {
  text: string;
  html: string;
  envelope: Envelope;
  headers: Record<string, string>;
  reply?: { messageId: string; mode: "reply" | "reply-all" | "forward" };
};
export function recipients(input: {
  to: string[];
  cc: string[];
  bcc: string[];
}) {
  const seen = new Set<string>();
  const result = {
    to: [] as string[],
    cc: [] as string[],
    bcc: [] as string[],
  };
  for (const field of ["to", "cc", "bcc"] as const)
    for (const value of input[field]) {
      const email = address(value);
      if (!seen.has(email)) {
        result[field].push(email);
        seen.add(email);
      }
    }
  if (seen.size > outboundLimits.recipients)
    throw new MailError("too_many_recipients", 422);
  return result;
}
export async function identityGrant(
  db: Pick<Client, "execute"> | Transaction,
  userId: string,
  identityId: string,
  action: "read" | "send" | "manage" = "read",
) {
  const row = (
    await db.execute({
      sql: `SELECT i.*,d.source_id,d.status AS domain_status,s.status AS source_status,s.provider,s.retention_days,g.can_send,g.can_manage
 FROM mail_identity_grants g JOIN mail_identities i ON i.tenant_id=g.tenant_id AND i.id=g.identity_id
 JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id JOIN mail_sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id
 JOIN tenants t ON t.id=i.tenant_id JOIN mail_users u ON u.id=g.user_id
 WHERE g.user_id=? AND i.id=? AND t.status='active' AND u.status='active'`,
      args: [userId, identityId],
    })
  ).rows[0];
  if (!row) throw new MailError("not_found", 404);
  if (
    action === "send" &&
    (!row.can_send ||
      row.status !== "active" ||
      row.domain_status !== "active" ||
      row.source_status !== "active")
  )
    throw new MailError("sending_not_permitted", 403);
  if (action === "manage" && !row.can_manage)
    throw new MailError("management_not_permitted", 403);
  return row;
}
export async function rateLimit(
  db: Client,
  tenant: string,
  user: string,
  action: string,
  max = 20,
  now = Date.now(),
) {
  await transaction(db, async (tx) => {
    const row = (
      await tx.execute({
        sql: "SELECT attempts,resets_at FROM mail_action_limits WHERE tenant_id=? AND user_id=? AND action=?",
        args: [tenant, user, action],
      })
    ).rows[0];
    if (
      row &&
      Date.parse(String(row.resets_at)) > now &&
      Number(row.attempts) >= max
    )
      throw new MailError("mail_rate_limited", 429);
    await tx.execute({
      sql: `INSERT INTO mail_action_limits(tenant_id,user_id,action,attempts,resets_at) VALUES (?,?,?,1,?) ON CONFLICT(tenant_id,user_id,action) DO UPDATE SET attempts=CASE WHEN julianday(resets_at)<=julianday(?) THEN 1 ELSE attempts+1 END,resets_at=CASE WHEN julianday(resets_at)<=julianday(?) THEN excluded.resets_at ELSE resets_at END`,
      args: [
        tenant,
        user,
        action,
        new Date(now + 60_000).toISOString(),
        new Date(now).toISOString(),
        new Date(now).toISOString(),
      ],
    });
  });
}
export async function messageGrant(
  db: Pick<Client, "execute"> | Transaction,
  user: string,
  id: string,
  identity: string | null,
) {
  const row = (
    await db.execute({
      sql: `SELECT m.*,r.identity_id,r.folder,r.previous_folder,r.deleted_at,r.thread_id,r.trashed_at,g.can_send,g.can_manage,s.provider
 FROM mail_messages m JOIN mail_message_recipients r ON r.tenant_id=m.tenant_id AND r.message_id=m.id
 JOIN mail_identity_grants g ON g.tenant_id=r.tenant_id AND g.identity_id=r.identity_id
 JOIN mail_sources s ON s.tenant_id=m.tenant_id AND s.id=m.source_id JOIN tenants t ON t.id=m.tenant_id JOIN mail_users u ON u.id=g.user_id
 WHERE m.id=? AND g.user_id=? AND (? IS NULL OR r.identity_id=?) AND r.deleted_at IS NULL AND m.state='ready' AND julianday(m.expires_at)>julianday('now') AND t.status='active' AND u.status='active' LIMIT 1`,
      args: [id, user, identity, identity],
    })
  ).rows[0];
  if (!row || (row.delivery_status === "draft" && !row.can_send))
    throw new MailError("not_found", 404);
  return row;
}
export function requireStorage(storage: MailStorage | null, identity: Row) {
  if (!storage || (identity.provider === "resend") !== storage.durable)
    throw new MailError("storage_unavailable", 503);
  return storage;
}
export const attachmentSchema = z.union([
  z.strictObject({ existingId: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({
    filename: z.string().min(1).max(200),
    contentType: z.string().max(150),
    content: z
      .string()
      .max(Math.ceil(outboundLimits.attachmentBytes / 3) * 4 + 4),
  }),
]);
export function validateFile(name: string, type: string, value: Uint8Array) {
  const clean = filename(name);
  const extension = clean.split(".").at(-1)?.toLowerCase() ?? "";
  const types: Record<string, string> = {
    txt: "text/plain",
    csv: "text/csv",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
  const expected = types[extension];
  if (
    !expected ||
    (type && type !== expected && type !== "application/octet-stream")
  )
    throw new MailError("unsupported_attachment", 422);
  if (!value.length || value.length > outboundLimits.attachmentBytes)
    throw new MailError("attachment_size_limit", 422);
  const start = Buffer.from(value.slice(0, 8));
  if (
    (extension === "pdf" && !start.toString().startsWith("%PDF-")) ||
    (extension === "png" && start.toString("hex") !== "89504e470d0a1a0a") ||
    (["jpg", "jpeg"].includes(extension) &&
      start.toString("hex").slice(0, 6) !== "ffd8ff") ||
    (["zip", "docx", "xlsx"].includes(extension) &&
      start.toString("hex").slice(0, 8) !== "504b0304")
  )
    throw new MailError("attachment_type_mismatch", 422);
  if (["txt", "csv"].includes(extension)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
      if (text.includes("\0")) throw new Error();
    } catch {
      throw new MailError("attachment_type_mismatch", 422);
    }
  }
  return { filename: clean, contentType: expected };
}
export async function readDraftContent(
  storage: MailStorage,
  tenant: string,
  key: string,
): Promise<DraftContent> {
  const bytes = await storage.get(tenant, key);
  if (bytes.length > limits.body * 8 + 64 * 1024)
    throw new MailError("content_size_limit", 422);
  const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  const addresses = z.array(z.email()).max(50),
    envelope = z
      .object({
        to: addresses.default([]),
        cc: addresses.default([]),
        bcc: addresses.default([]),
        replyTo: addresses.default([]),
      })
      .parse(value.envelope ?? {});
  const headers = z
    .record(
      z.string().regex(/^(In-Reply-To|References)$/),
      z
        .string()
        .max(6000)
        .regex(/^[^\r\n]*$/),
    )
    .parse(value.headers ?? {});
  return {
    text: z.string().max(limits.body).parse(value.text),
    html: z.string().max(limits.body).parse(value.html),
    envelope,
    headers,
    ...(value.reply
      ? {
          reply: z
            .object({
              messageId: z.string().regex(/^[a-f0-9]{64}$/),
              mode: z.enum(["reply", "reply-all", "forward"]),
            })
            .parse(value.reply),
        }
      : {}),
  };
}

// Older inbound objects predate stored envelopes. Read only the MIME header block
// from their private raw object; never use Bcc or render MIME as HTML.
export async function composeContent(
  db: Pick<Client, "execute">,
  storage: MailStorage,
  message: Row,
) {
  const tenant = String(message.tenant_id);
  const rows = (
    await db.execute({
      sql: "SELECT id,object_key FROM mail_objects WHERE tenant_id=? AND id IN (?,?)",
      args: [tenant, message.content_object_id, message.raw_object_id],
    })
  ).rows;
  const content = await readDraftContent(
    storage,
    tenant,
    String(rows.find((x) => x.id === message.content_object_id)!.object_key),
  );
  if (
    message.direction !== "inbound" ||
    content.envelope.to.length ||
    message.content_object_id === message.raw_object_id
  )
    return content;
  const raw = await storage.get(
    tenant,
    String(rows.find((x) => x.id === message.raw_object_id)!.object_key),
  );
  if (raw.length > limits.raw) throw new MailError("content_size_limit", 422);
  const block = Buffer.from(raw.slice(0, 64 * 1024))
    .toString("utf8")
    .split(/\r?\n\r?\n/, 1)[0]
    .replace(/\r?\n[ \t]+/g, " ");
  const header = (name: string) =>
    block
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().startsWith(name + ":"))
      .map((line) => line.slice(name.length + 1))
      .join(",");
  const emails = (name: string) => {
    // Split mailboxes outside quoted display names, comments and angle brackets.
    // Never treat an email-looking display name or comment as a recipient.
    const parts: string[] = [];
    let part = "",
      quoted = false,
      escaped = false,
      comments = 0,
      angle = false;
    for (const char of header(name)) {
      if (escaped) {
        if (!comments) part += char;
        escaped = false;
        continue;
      }
      if (char === "\\" && (quoted || comments)) {
        if (!comments) part += char;
        escaped = true;
        continue;
      }
      if (char === '"' && !comments) quoted = !quoted;
      if (!quoted && char === "(") {
        comments++;
        continue;
      }
      if (comments) {
        if (char === ")") comments--;
        continue;
      }
      if (!quoted && char === "<") angle = true;
      if (!quoted && char === ">") angle = false;
      if (char === "," && !quoted && !angle) {
        parts.push(part);
        part = "";
      } else part += char;
    }
    if (!quoted && !comments && !angle) parts.push(part);
    return Array.from(
      new Set(
        parts.flatMap((value) => {
          try {
            return [address(value)];
          } catch {
            return [];
          }
        }),
      ),
    ).slice(0, 50);
  };
  content.envelope = {
    to: emails("to"),
    cc: emails("cc"),
    bcc: [],
    replyTo: emails("reply-to"),
  };
  content.headers.References = (
    header("references").match(/<[^<>\s]{1,500}>/g) ?? []
  )
    .slice(-10)
    .join(" ");
  return content;
}
