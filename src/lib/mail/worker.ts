import { randomUUID } from "node:crypto";
import type { Client, Row } from "@libsql/client";
import { openSecret, type Keyring } from "../secrets.ts";
import {
  address,
  audit,
  hash,
  limits,
  MailError,
  filename,
  transaction,
} from "./common.ts";
import { safeHtml, plainText } from "./content.ts";
import {
  ResendInbound,
  validateMessage,
  type InboundProvider,
} from "./provider.ts";
import { FixtureInbound } from "./fixture-provider.ts";
import { objectKey, type MailStorage } from "./storage.ts";

type Options = {
  enabled?: boolean;
  fixtures?: boolean;
  keyring?: Keyring;
  provider?: (source: Row) => InboundProvider;
  now?: () => number;
};
export async function retainMail(
  db: Client,
  storage: MailStorage | null,
  now = Date.now(),
) {
  const iso = new Date(now).toISOString();
  // Hide expired content first. Physical deletion is idempotent and retried after a storage outage.
  await db.execute({
    sql: "UPDATE mail_messages SET state='expired',sender='',subject='',preview='',message_id=NULL WHERE state='ready' AND julianday(expires_at)<=julianday(?)",
    args: [iso],
  });
  await db.execute(
    "UPDATE mail_attachments SET filename='anexo expirado',content_type='application/octet-stream' WHERE EXISTS (SELECT 1 FROM mail_messages m WHERE m.tenant_id=mail_attachments.tenant_id AND m.id=mail_attachments.message_id AND m.state='expired')",
  );
  const backend = storage ? (storage.durable ? "resend" : "fixture") : null;
  const objects = (
    await db.execute({
      sql: `SELECT o.* FROM mail_objects o JOIN mail_sources s ON s.tenant_id=o.tenant_id AND s.id=o.source_id
    WHERE o.state!='deleted' AND julianday(o.expires_at)<=julianday(?) AND (? IS NULL OR s.provider=?) LIMIT 5`,
      args: [iso, backend, backend],
    })
  ).rows;
  let deleted = 0;
  for (const object of objects) {
    if (!storage) break;
    try {
      await storage.delete(String(object.tenant_id), String(object.object_key));
      await transaction(db, async (tx) => {
        await tx.execute({
          sql: "UPDATE mail_objects SET state='deleted' WHERE tenant_id=? AND id=?",
          args: [object.tenant_id, object.id],
        });
        await tx.execute({
          sql: "UPDATE mail_attachments SET filename='anexo expirado',content_type='application/octet-stream' WHERE tenant_id=? AND object_id=?",
          args: [object.tenant_id, object.id],
        });
        await audit(
          tx,
          String(object.tenant_id),
          String(object.source_id),
          null,
          "object_deleted",
        );
      });
      deleted++;
    } catch {
      /* Retry remaining objects on the next authenticated run. */
    }
  }
  await db.batch(
    [
      {
        sql: "DELETE FROM mail_sessions WHERE julianday(expires_at)<=julianday(?) OR revoked_at IS NOT NULL",
        args: [iso],
      },
      {
        sql: "DELETE FROM mail_login_limits WHERE julianday(resets_at)<=julianday(?)",
        args: [iso],
      },
    ],
    "write",
  );
  return { deleted, pending: objects.length - deleted };
}
async function recover(db: Client, now: number) {
  await transaction(db, async (tx) => {
    const rows = (
      await tx.execute({
        sql: "SELECT * FROM mail_ingestion_events WHERE state='processing' AND julianday(locked_until)<=julianday(?) LIMIT 20",
        args: [new Date(now).toISOString()],
      })
    ).rows;
    for (const row of rows) {
      await tx.execute({
        sql: "UPDATE mail_ingestion_events SET state=?,lease_token=NULL,locked_until=NULL,available_at=?,last_error_code='lease_expired' WHERE tenant_id=? AND id=?",
        args: [
          Number(row.attempts) < 5 ? "retry_wait" : "failed",
          new Date(now + 30_000).toISOString(),
          row.tenant_id,
          row.id,
        ],
      });
      await audit(
        tx,
        String(row.tenant_id),
        String(row.source_id),
        String(row.id),
        "lease_expired",
      );
    }
  });
}
export async function runMailWorker(
  db: Client,
  storage: MailStorage | null,
  options: Options = {},
) {
  const now = options.now ?? Date.now;
  const fixtures =
    options.fixtures ??
    (!process.env.VERCEL && process.env.TODOKU_MAIL_STORAGE === "fixture");
  const retention = await retainMail(db, storage, now());
  if (
    !(options.enabled ?? process.env.TODOKU_MAIL_RECEIVING_ENABLED === "true")
  )
    return { processed: 0, state: "receiving_disabled", retention };
  if (!storage)
    return { processed: 0, state: "storage_unavailable", retention };
  await recover(db, now());
  const job = await transaction(db, async (tx) => {
    const row = (
      await tx.execute({
        sql: `SELECT e.*,s.encrypted_api_key,s.provider,s.retention_days FROM mail_ingestion_events e
      JOIN mail_sources s ON s.tenant_id=e.tenant_id AND s.id=e.source_id JOIN tenants t ON t.id=e.tenant_id
      WHERE e.state IN ('pending','retry_wait') AND e.attempts<5 AND julianday(e.available_at)<=julianday(?)
      AND s.status='active' AND t.status='active' AND (s.provider='resend' OR ?=1)
      ORDER BY e.received_at,e.id LIMIT 1`,
        args: [new Date(now()).toISOString(), fixtures ? 1 : 0],
      })
    ).rows[0];
    if (!row) return null;
    const token = randomUUID();
    await tx.execute({
      sql: "UPDATE mail_ingestion_events SET state='processing',attempts=attempts+1,lease_token=?,locked_until=? WHERE tenant_id=? AND id=?",
      args: [
        token,
        new Date(now() + 360_000).toISOString(),
        row.tenant_id,
        row.id,
      ],
    });
    await audit(
      tx,
      String(row.tenant_id),
      String(row.source_id),
      String(row.id),
      "claimed",
    );
    return Object.assign(row, {
      lease_token: token,
      attempts: Number(row.attempts) + 1,
    });
  });
  if (!job) return { processed: 0, state: "idle", retention };
  const tenant = String(job.tenant_id),
    source = String(job.source_id),
    emailId = String(job.provider_email_id);
  const messageId = hash(source + ":" + emailId);
  const owned = async () => {
    const row = (
      await db.execute({
        sql: `SELECT e.id FROM mail_ingestion_events e JOIN mail_sources s ON s.tenant_id=e.tenant_id AND s.id=e.source_id
      JOIN tenants t ON t.id=e.tenant_id WHERE e.tenant_id=? AND e.id=? AND e.lease_token=? AND e.state='processing'
      AND julianday(e.locked_until)>julianday(?) AND s.status='active' AND t.status='active'`,
        args: [tenant, job.id, job.lease_token, new Date(now()).toISOString()],
      })
    ).rows[0];
    if (!row) throw new MailError("lease_lost", 409);
  };
  try {
    if (job.provider === "resend" && !storage.durable)
      throw new MailError("durable_storage_required", 503);
    const provider =
      options.provider?.(job) ??
      (job.provider === "fixture"
        ? new FixtureInbound()
        : new ResendInbound(
            openSecret(
              String(job.encrypted_api_key),
              { tenantId: tenant, applicationId: "todoku-mail" },
              source,
              "api_key",
              options.keyring,
            ),
          ));
    const message = validateMessage(await provider.get(emailId), emailId);
    if (
      new Set(message.attachments.map((item) => item.id)).size !==
      message.attachments.length
    )
      throw new MailError("duplicate_attachment", 422);
    const destinations = (
      message.received_for?.length ? message.received_for : message.to
    ).map(address);
    const targets = JSON.parse(String(job.targets_json)) as string[];
    const recipients = (
      await db.execute({
        sql: `SELECT i.id,i.address FROM mail_identities i JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id
      WHERE i.tenant_id=? AND d.source_id=? AND i.status='active' AND d.status='active'`,
        args: [tenant, source],
      })
    ).rows.filter(
      (row) =>
        targets.includes(String(row.id)) &&
        destinations.includes(String(row.address)),
    );
    if (!recipients.length)
      throw new MailError("destination_not_authorized", 422);
    const html = safeHtml(message.html ?? "");
    const text = message.text ?? plainText(html);
    const raw = await provider.raw(message);
    if (raw.length > limits.raw || raw.length === 0)
      throw new MailError("size_limit", 422);
    const expires = new Date(
      now() + Number(job.retention_days) * 86_400_000,
    ).toISOString();
    const stagedExpires = new Date(now() + 86_400_000).toISOString();
    const objects: string[] = [];
    async function put(part: string, data: Uint8Array) {
      await owned();
      const id = hash(source + ":" + emailId + ":" + part),
        key = objectKey(tenant, source, emailId, part);
      await db.execute({
        sql: `INSERT INTO mail_objects(tenant_id,id,source_id,object_key,expires_at) VALUES (?,?,?,?,?)
        ON CONFLICT(tenant_id,id) DO NOTHING`,
        args: [tenant, id, source, key, stagedExpires],
      });
      await storage!.put(tenant, key, data);
      objects.push(id);
      return id;
    }
    const rawId = await put("raw", raw);
    const contentId = await put(
      "content",
      Buffer.from(JSON.stringify({ html, text }), "utf8"),
    );
    const attachments: {
      id: string;
      objectId: string;
      name: string;
      type: string;
      size: number;
    }[] = [];
    let total = 0;
    for (const attachment of message.attachments) {
      if (total + attachment.size > limits.total)
        throw new MailError("size_limit", 422);
      const data = await provider.attachment(emailId, attachment.id);
      if (data.length > limits.attachment || data.length !== attachment.size)
        throw new MailError("attachment_size_mismatch", 422);
      total += data.length;
      attachments.push({
        id: hash(messageId + ":" + attachment.id),
        objectId: await put("attachment:" + attachment.id, data),
        name: filename(attachment.filename ?? "anexo"),
        type: attachment.content_type,
        size: data.length,
      });
    }
    await owned();
    await transaction(db, async (tx) => {
      const owner = (
        await tx.execute({
          sql: "SELECT id FROM mail_ingestion_events WHERE tenant_id=? AND id=? AND lease_token=? AND state='processing' AND julianday(locked_until)>julianday(?)",
          args: [
            tenant,
            job.id,
            job.lease_token,
            new Date(now()).toISOString(),
          ],
        })
      ).rows[0];
      if (!owner) throw new MailError("lease_lost", 409);
      const stillActive = (
        await tx.execute({
          sql: "SELECT s.id FROM mail_sources s JOIN tenants t ON t.id=s.tenant_id WHERE s.tenant_id=? AND s.id=? AND s.status='active' AND t.status='active'",
          args: [tenant, source],
        })
      ).rows[0];
      if (!stillActive) throw new MailError("source_disabled", 422);
      for (const recipient of recipients) {
        const current = (
          await tx.execute({
            sql: "SELECT i.id FROM mail_identities i JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id WHERE i.tenant_id=? AND i.id=? AND i.status='active' AND d.status='active' AND d.source_id=?",
            args: [tenant, recipient.id, source],
          })
        ).rows[0];
        if (!current) throw new MailError("destination_not_authorized", 422);
      }
      await tx.execute({
        sql: `INSERT INTO mail_messages(tenant_id,id,source_id,provider_email_id,message_id,sender,subject,preview,authentication,content_object_id,raw_object_id,received_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          tenant,
          messageId,
          source,
          emailId,
          message.message_id,
          address(message.from),
          message.subject,
          text.slice(0, 160),
          message.authentication?.dmarc === "pass" ? "pass" : "unverified",
          contentId,
          rawId,
          job.received_at,
          expires,
        ],
      });
      const headers = Object.fromEntries(
        Object.entries(message.headers).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      const references =
        (headers["in-reply-to"] ?? headers.references ?? "")
          .match(/<[^<>\s]{1,500}>/g)
          ?.slice(-10)
          .reverse() ?? [];
      for (const recipient of recipients) {
        let threadId: string | undefined;
        for (const reference of references) {
          const parent = (
            await tx.execute({
              sql: `SELECT r.thread_id FROM mail_message_recipients r JOIN mail_messages m ON m.tenant_id=r.tenant_id AND m.id=r.message_id
            WHERE r.tenant_id=? AND r.identity_id=? AND m.message_id=? AND m.state='ready' ORDER BY m.received_at LIMIT 1`,
              args: [tenant, recipient.id, reference],
            })
          ).rows[0];
          if (parent) {
            threadId = String(parent.thread_id);
            break;
          }
        }
        if (!threadId) {
          threadId = randomUUID();
          await tx.execute({
            sql: "INSERT INTO mail_threads(tenant_id,id,identity_id) VALUES (?,?,?)",
            args: [tenant, threadId, recipient.id],
          });
        }
        await tx.execute({
          sql: "INSERT INTO mail_message_recipients(tenant_id,message_id,identity_id,thread_id) VALUES (?,?,?,?)",
          args: [tenant, messageId, recipient.id, threadId],
        });
      }
      for (const attachment of attachments)
        await tx.execute({
          sql: "INSERT INTO mail_attachments(tenant_id,id,message_id,object_id,filename,content_type,size) VALUES (?,?,?,?,?,?,?)",
          args: [
            tenant,
            attachment.id,
            messageId,
            attachment.objectId,
            attachment.name,
            attachment.type,
            attachment.size,
          ],
        });
      for (const id of objects)
        await tx.execute({
          sql: "UPDATE mail_objects SET state='ready',expires_at=? WHERE tenant_id=? AND id=?",
          args: [expires, tenant, id],
        });
      await tx.execute({
        sql: "UPDATE mail_ingestion_events SET state='completed',lease_token=NULL,locked_until=NULL,last_error_code=NULL WHERE tenant_id=? AND id=?",
        args: [tenant, job.id],
      });
      await audit(tx, tenant, source, String(job.id), "completed");
    });
    return { processed: 1, state: "completed", retention };
  } catch (error) {
    const code =
      error instanceof MailError ? error.message : "processing_unavailable";
    const terminal = error instanceof MailError && error.status === 422;
    const state = terminal || job.attempts >= 5 ? "failed" : "retry_wait";
    await transaction(db, async (tx) => {
      const updated = await tx.execute({
        sql: "UPDATE mail_ingestion_events SET state=?,last_error_code=?,lease_token=NULL,locked_until=NULL,available_at=? WHERE tenant_id=? AND id=? AND lease_token=? AND state='processing'",
        args: [
          state,
          code,
          new Date(
            now() +
              Math.min(3_600_000, 30_000 * 2 ** (job.attempts - 1)) *
                (1 + Math.random() * 0.2),
          ).toISOString(),
          tenant,
          job.id,
          job.lease_token,
        ],
      });
      if (updated.rowsAffected)
        await audit(tx, tenant, source, String(job.id), state, code);
    });
    return {
      processed: 1,
      state: code === "lease_lost" ? "lease_lost" : state,
      retention,
    };
  }
}
