import { timingSafeEqual, createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import { z } from "zod";
import { authRequest, requireUser, sameOrigin } from "./auth.ts";
import { body, filename, json, MailError, limits } from "./common.ts";
import { readerDocument } from "./content.ts";
import { mailStorage, type MailStorage } from "./storage.ts";
import { runMailWorker } from "./worker.ts";

const visible = `m.state='ready' AND julianday(m.expires_at)>julianday('now') AND t.status='active'`;
const joins = `FROM mail_messages m JOIN mail_message_recipients r ON r.tenant_id=m.tenant_id AND r.message_id=m.id
 JOIN mail_identity_grants g ON g.tenant_id=r.tenant_id AND g.identity_id=r.identity_id
 JOIN mail_identities i ON i.tenant_id=r.tenant_id AND i.id=r.identity_id JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id
 JOIN tenants t ON t.id=m.tenant_id`;
async function access(
  db: Client,
  userId: string,
  id: string,
  identity: string | null,
) {
  const row = (
    await db.execute({
      sql: `SELECT m.*,r.identity_id,r.thread_id,o.object_key,s.provider ${joins}
    JOIN mail_sources s ON s.tenant_id=m.tenant_id AND s.id=m.source_id
    JOIN mail_objects o ON o.tenant_id=m.tenant_id AND o.id=m.content_object_id
    WHERE m.id=? AND g.user_id=? AND (? IS NULL OR r.identity_id=?) AND ${visible} LIMIT 1`,
      args: [id, userId, identity, identity],
    })
  ).rows[0];
  if (!row) throw new MailError("not_found", 404);
  return row;
}
export async function mailRequest(
  request: Request,
  segments: string[],
  db: Client,
  storage: () => MailStorage | null = mailStorage,
) {
  try {
    const [operation, id, action] = segments;
    if (
      ["login", "logout", "session"].includes(operation) &&
      segments.length === 1
    ) {
      if ((operation === "session") !== (request.method === "GET"))
        return json({ error: "method_not_allowed" }, 405);
      return await authRequest(
        db,
        request,
        operation as "login" | "logout" | "session",
      );
    }
    const user = await requireUser(db, request);
    const url = new URL(request.url),
      identity = url.searchParams.get("identity");
    if (
      operation === "inbox" &&
      segments.length === 1 &&
      request.method === "GET"
    ) {
      const domain = url.searchParams.get("domain");
      const cursor = url.searchParams.get("cursor");
      let before: string | null = null,
        beforeId: string | null = null;
      if ((cursor?.length ?? 0) > 400) throw new MailError("invalid_cursor");
      if (cursor) {
        try {
          const parsed = z
            .tuple([z.iso.datetime(), z.string().regex(/^[a-f0-9]{64}$/)])
            .parse(
              JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
            );
          [before, beforeId] = parsed;
        } catch {
          throw new MailError("invalid_cursor");
        }
      }
      if (
        (identity?.length ?? 0) > 100 ||
        (domain?.length ?? 0) > 100 ||
        (cursor?.length ?? 0) > 400
      )
        throw new MailError("invalid_filter");
      const identities = (
        await db.execute({
          sql: `SELECT i.id,i.address,i.label,d.id AS domain_id,d.name AS domain,s.provider,s.status AS receiving_status
        FROM mail_identity_grants g JOIN mail_identities i ON i.tenant_id=g.tenant_id AND i.id=g.identity_id
        JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id JOIN mail_sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id
        JOIN tenants t ON t.id=i.tenant_id WHERE g.user_id=? AND t.status='active' ORDER BY d.name,i.address`,
          args: [user.id],
        })
      ).rows;
      const messages = (
        await db.execute({
          sql: `SELECT m.id,m.sender,m.subject,m.preview,m.received_at,MIN(r.is_read) AS is_read,
        COUNT(DISTINCT a.id) AS attachment_count,GROUP_CONCAT(DISTINCT i.address) AS identities
        ${joins} LEFT JOIN mail_attachments a ON a.tenant_id=m.tenant_id AND a.message_id=m.id
        WHERE g.user_id=? AND ${visible} AND (? IS NULL OR i.id=?) AND (? IS NULL OR d.id=?)
        AND (? IS NULL OR m.received_at<? OR (m.received_at=? AND m.id<?)) GROUP BY m.tenant_id,m.id ORDER BY m.received_at DESC,m.id DESC LIMIT 31`,
          args: [
            user.id,
            identity,
            identity,
            domain,
            domain,
            before,
            before,
            before,
            beforeId,
          ],
        })
      ).rows;
      const page = messages.slice(0, 30);
      return json({
        identities,
        messages: page,
        nextCursor:
          messages.length > 30
            ? Buffer.from(
                JSON.stringify([page.at(-1)!.received_at, page.at(-1)!.id]),
              ).toString("base64url")
            : null,
        receivingEnabled: process.env.TODOKU_MAIL_RECEIVING_ENABLED === "true",
        storageReady: storage() !== null,
        fixture:
          !process.env.VERCEL && process.env.TODOKU_MAIL_STORAGE === "fixture",
      });
    }
    if (operation === "messages" && id && segments.length <= 3) {
      const message = await access(db, user.id, id, identity);
      if (request.method === "POST" && action === "read") {
        sameOrigin(request);
        const input = z
          .strictObject({ read: z.boolean() })
          .parse(JSON.parse(await body(request, 256)));
        await db.execute({
          sql: `UPDATE mail_message_recipients SET is_read=? WHERE tenant_id=? AND message_id=? AND identity_id=?
          AND EXISTS (SELECT 1 FROM mail_identity_grants g WHERE g.tenant_id=mail_message_recipients.tenant_id AND g.identity_id=mail_message_recipients.identity_id AND g.user_id=?)`,
          args: [
            input.read ? 1 : 0,
            message.tenant_id,
            id,
            message.identity_id,
            user.id,
          ],
        });
        return json({ updated: true });
      }
      if (request.method === "GET" && !action) {
        const store = storage();
        if (!store || (message.provider === "resend") !== store.durable)
          throw new MailError("storage_unavailable", 503);
        const content = z
          .object({
            html: z.string().max(limits.body),
            text: z.string().max(limits.body),
          })
          .parse(
            JSON.parse(
              Buffer.from(
                await store.get(
                  String(message.tenant_id),
                  String(message.object_key),
                ),
              ).toString("utf8"),
            ),
          );
        const attachments = (
          await db.execute({
            sql: "SELECT id,filename,size FROM mail_attachments WHERE tenant_id=? AND message_id=? ORDER BY id",
            args: [message.tenant_id, id],
          })
        ).rows;
        const thread = (
          await db.execute({
            sql: `SELECT m.id,m.sender,m.subject,m.received_at ${joins}
          WHERE m.tenant_id=? AND r.thread_id=? AND r.identity_id=? AND g.user_id=? AND ${visible}
          ORDER BY m.received_at,m.id LIMIT 50`,
            args: [
              message.tenant_id,
              message.thread_id,
              message.identity_id,
              user.id,
            ],
          })
        ).rows;
        return json({
          id,
          subject: message.subject,
          sender: message.sender,
          receivedAt: message.received_at,
          authentication: message.authentication,
          identityId: message.identity_id,
          text: content.text,
          document: readerDocument(content.html),
          attachments,
          thread,
        });
      }
    }
    if (
      operation === "attachments" &&
      id &&
      segments.length === 2 &&
      request.method === "GET"
    ) {
      const attachment = (
        await db.execute({
          sql: `SELECT a.filename,a.size,o.object_key,o.tenant_id,s.provider FROM mail_attachments a
        JOIN mail_objects o ON o.tenant_id=a.tenant_id AND o.id=a.object_id JOIN mail_messages m ON m.tenant_id=a.tenant_id AND m.id=a.message_id
        JOIN tenants t ON t.id=m.tenant_id JOIN mail_sources s ON s.tenant_id=m.tenant_id AND s.id=m.source_id WHERE a.id=? AND o.state='ready' AND ${visible}
        AND EXISTS (SELECT 1 FROM mail_message_recipients r JOIN mail_identity_grants g ON g.tenant_id=r.tenant_id AND g.identity_id=r.identity_id
          WHERE r.tenant_id=m.tenant_id AND r.message_id=m.id AND g.user_id=?) LIMIT 1`,
          args: [id, user.id],
        })
      ).rows[0];
      if (!attachment) throw new MailError("not_found", 404);
      const store = storage();
      if (!store || (attachment.provider === "resend") !== store.durable)
        throw new MailError("storage_unavailable", 503);
      const value = await store.get(
        String(attachment.tenant_id),
        String(attachment.object_key),
      );
      if (
        value.length > limits.attachment ||
        value.length !== Number(attachment.size)
      )
        throw new MailError("attachment_unavailable", 503);
      const encoded = encodeURIComponent(
        filename(String(attachment.filename)),
      ).replace(/['()*]/g, (x) => "%" + x.charCodeAt(0).toString(16));
      return new Response(Buffer.from(value), {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="attachment"; filename*=UTF-8''${encoded}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "no-store",
          "content-length": String(value.length),
        },
      });
    }
    return json({ error: "not_found" }, 404);
  } catch (error) {
    return json(
      {
        error:
          error instanceof MailError
            ? error.message
            : error instanceof SyntaxError || error instanceof z.ZodError
              ? "invalid_request"
              : "mail_unavailable",
      },
      error instanceof MailError
        ? error.status
        : error instanceof SyntaxError || error instanceof z.ZodError
          ? 400
          : 503,
    );
  }
}
export async function mailWorkerRequest(request: Request, db: () => Client) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32)
    return json({ error: "worker_unavailable" }, 503);
  const digest = (x: string) => createHash("sha256").update(x).digest();
  if (
    !timingSafeEqual(
      digest(request.headers.get("authorization") ?? ""),
      digest(`Bearer ${secret}`),
    )
  )
    return json({ error: "unauthorized" }, 401);
  try {
    return json(await runMailWorker(db(), mailStorage()));
  } catch {
    return json({ error: "mail_worker_unavailable" }, 503);
  }
}
