import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { z } from "zod";
import {
  address,
  audit,
  hash,
  limits,
  MailError,
  transaction,
} from "./common.ts";
import { safeHtml, plainText } from "./content.ts";
import { objectKey, type MailStorage } from "./storage.ts";
import {
  attachmentSchema,
  composeContent,
  identityGrant,
  messageGrant,
  outboundLimits,
  rateLimit,
  readDraftContent,
  recipients,
  requireStorage,
  rfcId,
  validateFile,
  type DraftContent,
} from "./outbound-common.ts";

export const draftSchema = z.strictObject({
  requestId: z.uuid(),
  identityId: z.string().min(1).max(100),
  version: z.int().min(1).optional(),
  to: z.array(z.string().max(320)).max(10),
  cc: z.array(z.string().max(320)).max(10),
  bcc: z.array(z.string().max(320)).max(10),
  subject: z
    .string()
    .max(1000)
    .regex(/^[^\r\n]*$/),
  text: z.string().max(limits.body),
  html: z.string().max(limits.body),
  attachments: z.array(attachmentSchema).max(limits.attachments),
  reply: z
    .strictObject({
      messageId: z.string().regex(/^[a-f0-9]{64}$/),
      mode: z.enum(["reply", "reply-all", "forward"]),
    })
    .optional(),
});
export type DraftInput = z.infer<typeof draftSchema>;
export async function composeTemplate(
  db: Client,
  user: string,
  id: string,
  identity: string,
  mode: "reply" | "reply-all" | "forward",
  storage: MailStorage | null,
) {
  const sender = await identityGrant(db, user, identity, "send"),
    store = requireStorage(storage, sender);
  const parent = await messageGrant(db, user, id, identity);
  if (parent.delivery_status === "draft")
    throw new MailError("invalid_reply", 409);
  const content = await composeContent(db, store, parent);
  const owned = new Set(
    (
      await db.execute({
        sql: "SELECT address FROM mail_identities WHERE tenant_id=?",
        args: [parent.tenant_id],
      })
    ).rows.map((x) => String(x.address)),
  );
  const clean = (values: string[]) =>
    values.flatMap((value) => {
      try {
        const email = address(value);
        return owned.has(email) ? [] : [email];
      } catch {
        return [];
      }
    });
  const target =
    parent.direction === "outbound"
      ? content.envelope.to
      : content.envelope.replyTo?.length
        ? content.envelope.replyTo
        : [String(parent.sender)];
  const envelope =
    mode === "forward"
      ? { to: [], cc: [], bcc: [] }
      : recipients({
          to: clean(target),
          cc:
            mode === "reply-all"
              ? clean([...content.envelope.to, ...content.envelope.cc])
              : [],
          bcc: [],
        });
  const attachments =
    mode === "forward"
      ? (
          await db.execute({
            sql: "SELECT id,filename,size FROM mail_attachments WHERE tenant_id=? AND message_id=?",
            args: [parent.tenant_id, id],
          })
        ).rows
      : [];
  await identityGrant(db, user, identity, "send");
  await messageGrant(db, user, id, identity);
  return {
    identityId: identity,
    ...envelope,
    subject: /^(re|fwd):/i.test(String(parent.subject))
      ? String(parent.subject)
      : `${mode === "forward" ? "Fwd" : "Re"}: ${parent.subject}`,
    text: `\n\n${mode === "forward" ? "---------- Mensagem encaminhada ----------" : "Em resposta a"}\nDe: ${parent.sender}\nAssunto: ${parent.subject}\n\n${content.text
      .split("\n")
      .map((x) => "> " + x)
      .join("\n")}`.slice(0, limits.body),
    html: "",
    attachments: attachments.map((x) => ({
      existingId: x.id,
      filename: x.filename,
      size: x.size,
    })),
    reply: { messageId: id, mode },
  };
}
export async function saveDraft(
  db: Client,
  user: string,
  storage: MailStorage | null,
  input: DraftInput,
  existingId?: string,
) {
  const identity = await identityGrant(db, user, input.identityId, "send"),
    tenant = String(identity.tenant_id),
    source = String(identity.source_id),
    store = requireStorage(storage, identity);
  await rateLimit(db, tenant, user, "draft-write");
  const id =
    existingId ??
    hash(`draft:${tenant}:${input.identityId}:${input.requestId}`);
  const current = (
    await db.execute({
      sql: "SELECT * FROM mail_messages WHERE tenant_id=? AND id=?",
      args: [tenant, id],
    })
  ).rows[0];
  if (existingId || current) {
    const row = await messageGrant(db, user, id, input.identityId);
    if (
      row.direction !== "outbound" ||
      row.delivery_status !== "draft" ||
      row.folder !== "drafts"
    )
      throw new MailError("draft_locked", 409);
  }
  if (current) {
    const object = (
      await db.execute({
        sql: "SELECT object_key FROM mail_objects WHERE tenant_id=? AND id=?",
        args: [tenant, current.content_object_id],
      })
    ).rows[0];
    const previous = await readDraftContent(
      store,
      tenant,
      String(object.object_key),
    );
    if (
      JSON.stringify(previous.reply ?? null) !==
      JSON.stringify(input.reply ?? null)
    )
      throw new MailError("reply_context_changed", 409);
  }
  const html = safeHtml(input.html),
    text = input.text || plainText(html),
    envelope = recipients(input);
  const content: DraftContent = {
    text,
    html,
    envelope,
    headers: {},
    ...(input.reply ? { reply: input.reply } : {}),
  };
  let threadId: string | undefined;
  if (input.reply) {
    const parent = await messageGrant(
      db,
      user,
      input.reply.messageId,
      input.identityId,
    );
    if (parent.delivery_status === "draft")
      throw new MailError("invalid_reply", 409);
    if (input.reply.mode !== "forward") {
      const previous = await composeContent(db, store, parent);
      const messageId = rfcId(parent.message_id);
      if (messageId) {
        content.headers["In-Reply-To"] = messageId;
        content.headers.References = [
          ...((previous.headers.References ?? "").match(/<[^<>\s]{1,500}>/g) ??
            []),
          messageId,
        ]
          .slice(-10)
          .join(" ");
      }
      threadId = String(parent.thread_id);
    }
  }
  const files: { filename: string; contentType: string; data: Uint8Array }[] =
    [];
  let total = 0;
  for (const attachment of input.attachments) {
    let data: Uint8Array, name: string, type: string;
    if ("existingId" in attachment) {
      const row = (
        await db.execute({
          sql: "SELECT a.*,o.object_key FROM mail_attachments a JOIN mail_objects o ON o.tenant_id=a.tenant_id AND o.id=a.object_id WHERE a.tenant_id=? AND a.id=? AND o.state='ready'",
          args: [tenant, attachment.existingId],
        })
      ).rows[0];
      if (!row) throw new MailError("attachment_unavailable", 404);
      await messageGrant(db, user, String(row.message_id), input.identityId);
      if (row.message_id !== id && row.message_id !== input.reply?.messageId)
        throw new MailError("attachment_scope_mismatch", 403);
      data = await store.get(tenant, String(row.object_key));
      name = String(row.filename);
      type = String(row.content_type);
      if (data.length !== Number(row.size))
        throw new MailError("attachment_unavailable", 503);
    } else {
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          attachment.content,
        )
      )
        throw new MailError("invalid_attachment", 422);
      data = Buffer.from(attachment.content, "base64");
      name = attachment.filename;
      type = attachment.contentType;
    }
    total += data.length;
    if (total > outboundLimits.attachmentBytes)
      throw new MailError("attachment_size_limit", 422);
    const metadata = validateFile(name, type, data);
    files.push({ ...metadata, data });
  }
  const fingerprint = hash(
    JSON.stringify({
      identity: input.identityId,
      content,
      subject: input.subject,
      files: files.map((x) => ({
        filename: x.filename,
        contentType: x.contentType,
        hash: hash(Buffer.from(x.data).toString("base64")),
      })),
    }),
  );
  if (current && current.draft_fingerprint === fingerprint) {
    const saved = (
      await db.execute({
        sql: "SELECT id,filename,size FROM mail_attachments WHERE tenant_id=? AND message_id=? ORDER BY id",
        args: [tenant, id],
      })
    ).rows;
    await messageGrant(db, user, id, input.identityId);
    await identityGrant(db, user, input.identityId, "send");
    return {
      id,
      version: Number(current.draft_version),
      saved: true,
      attachments: saved,
    };
  }
  if (
    current &&
    (!existingId || Number(current.draft_version) !== input.version)
  )
    throw new MailError("draft_conflict", 409);
  if (!current) {
    const n = (
      await db.execute({
        sql: "SELECT count(*) AS n FROM mail_messages m JOIN mail_message_recipients r ON r.tenant_id=m.tenant_id AND r.message_id=m.id WHERE m.tenant_id=? AND r.identity_id=? AND m.delivery_status='draft' AND m.state='ready'",
        args: [tenant, input.identityId],
      })
    ).rows[0];
    if (Number(n.n) >= 50) throw new MailError("draft_quota", 429);
  }
  const now = new Date().toISOString(),
    expires = new Date(
      Date.now() + Number(identity.retention_days) * 86_400_000,
    ).toISOString(),
    staged = new Date(Date.now() + 86_400_000).toISOString();
  const objects: string[] = [];
  async function put(part: string, value: Uint8Array) {
    const objectId = hash(randomUUID()),
      key = objectKey(tenant, source, id, part + ":" + objectId);
    await db.execute({
      sql: "INSERT INTO mail_objects(tenant_id,id,source_id,object_key,expires_at) VALUES (?,?,?,?,?)",
      args: [tenant, objectId, source, key, staged],
    });
    objects.push(objectId);
    await store.put(tenant, key, value);
    return objectId;
  }
  const contentId = await put(
    "content",
    Buffer.from(JSON.stringify(content), "utf8"),
  );
  const attachments: {
    id: string;
    objectId: string;
    filename: string;
    contentType: string;
    data: Uint8Array;
  }[] = [];
  for (const file of files)
    attachments.push({
      ...file,
      id: hash(randomUUID()),
      objectId: await put("attachment", file.data),
    });
  await transaction(db, async (tx) => {
    await identityGrant(tx, user, input.identityId, "send");
    if (input.reply)
      await messageGrant(tx, user, input.reply.messageId, input.identityId);
    if (current) {
      await messageGrant(tx, user, id, input.identityId);
      const updated = await tx.execute({
        sql: "UPDATE mail_messages SET subject=?,preview=?,content_object_id=?,raw_object_id=?,draft_fingerprint=?,draft_version=draft_version+1,expires_at=? WHERE tenant_id=? AND id=? AND direction='outbound' AND delivery_status='draft' AND draft_version=? AND state='ready' AND EXISTS(SELECT 1 FROM mail_message_recipients r WHERE r.tenant_id=mail_messages.tenant_id AND r.message_id=mail_messages.id AND r.identity_id=? AND r.folder='drafts' AND r.deleted_at IS NULL)",
        args: [
          input.subject,
          text.slice(0, 160),
          contentId,
          contentId,
          fingerprint,
          expires,
          tenant,
          id,
          input.version!,
          input.identityId,
        ],
      });
      if (updated.rowsAffected !== 1)
        throw new MailError("draft_conflict", 409);
      const old = (
        await tx.execute({
          sql: "SELECT object_id FROM mail_attachments WHERE tenant_id=? AND message_id=?",
          args: [tenant, id],
        })
      ).rows;
      for (const oldId of [
        current.content_object_id,
        ...old.map((x) => x.object_id),
      ])
        await tx.execute({
          sql: "UPDATE mail_objects SET expires_at=? WHERE tenant_id=? AND id=?",
          args: [now, tenant, oldId],
        });
      await tx.execute({
        sql: "DELETE FROM mail_attachments WHERE tenant_id=? AND message_id=?",
        args: [tenant, id],
      });
    } else {
      await tx.execute({
        sql: "INSERT INTO mail_messages(tenant_id,id,source_id,provider_email_id,message_id,sender,subject,preview,authentication,content_object_id,raw_object_id,received_at,expires_at,direction,delivery_status,draft_fingerprint,author_user_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'outbound','draft',?,?)",
        args: [
          tenant,
          id,
          source,
          "outbound:" + id,
          null,
          identity.address,
          input.subject,
          text.slice(0, 160),
          "self",
          contentId,
          contentId,
          now,
          expires,
          fingerprint,
          user,
        ],
      });
      if (!threadId) {
        threadId = randomUUID();
        await tx.execute({
          sql: "INSERT INTO mail_threads(tenant_id,id,identity_id) VALUES (?,?,?)",
          args: [tenant, threadId, input.identityId],
        });
      }
      await tx.execute({
        sql: "INSERT INTO mail_message_recipients(tenant_id,message_id,identity_id,thread_id,is_read,folder) VALUES (?,?,?,?,1,'drafts')",
        args: [tenant, id, input.identityId, threadId],
      });
    }
    for (const file of attachments)
      await tx.execute({
        sql: "INSERT INTO mail_attachments(tenant_id,id,message_id,object_id,filename,content_type,size) VALUES (?,?,?,?,?,?,?)",
        args: [
          tenant,
          file.id,
          id,
          file.objectId,
          file.filename,
          file.contentType,
          file.data.length,
        ],
      });
    for (const object of objects)
      await tx.execute({
        sql: "UPDATE mail_objects SET state='ready',expires_at=? WHERE tenant_id=? AND id=?",
        args: [expires, tenant, object],
      });
    await audit(tx, tenant, source, null, "draft_saved");
  });
  return {
    id,
    version: current ? Number(current.draft_version) + 1 : 1,
    saved: true,
    attachments: attachments.map((x) => ({
      id: x.id,
      filename: x.filename,
      size: x.data.length,
    })),
  };
}
