import { randomUUID } from "node:crypto";
import type { Client, Transaction, Row } from "@libsql/client";
import { z } from "zod";
import { Webhook } from "svix";
import { openSecret, type Keyring } from "../secrets.ts";
import { allowRecipients } from "./sending-policy.ts";
import {
  audit,
  body,
  hash,
  json,
  limits,
  MailError,
  transaction,
} from "./common.ts";
import type { MailStorage } from "./storage.ts";
import {
  identityGrant,
  messageGrant,
  rateLimit,
  readDraftContent,
  rfcId,
} from "./outbound-common.ts";

export const mailSendingEnabled = () =>
  process.env.TODOKU_MAIL_SENDING_ENABLED === "true";
type Payload = {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  headers: Record<string, string>;
  attachments: { filename: string; content: string; content_type: string }[];
};
export type MailSendResult =
  | { kind: "accepted"; id: string; messageId?: string }
  | { kind: "retry"; code: string; uncertain: boolean }
  | { kind: "failed" | "review"; code: string };
export interface MailSendProvider {
  send(payload: Payload, key: string): Promise<MailSendResult>;
}
export class ResendMailSender implements MailSendProvider {
  #key: string;
  #fetch: typeof fetch;
  constructor(key: string, fetcher: typeof fetch = fetch) {
    this.#key = key;
    this.#fetch = fetcher;
  }
  async send(payload: Payload, key: string): Promise<MailSendResult> {
    try {
      const r = await this.#fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#key}`,
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const receipt = await r.json();
        return z.uuid().safeParse(receipt.id).success
          ? {
              kind: "accepted",
              id: receipt.id,
              ...(rfcId(receipt.message_id)
                ? { messageId: receipt.message_id }
                : {}),
            }
          : {
              kind: "retry",
              code: "invalid_provider_receipt",
              uncertain: true,
            };
      }
      if (r.status === 429 || r.status >= 500)
        return {
          kind: "retry",
          code:
            r.status === 429 ? "provider_rate_limited" : "provider_unavailable",
          uncertain: r.status >= 500,
        };
      if (r.status === 409) {
        const error = await r.json().catch(() => ({}));
        return error.name === "concurrent_idempotent_requests"
          ? { kind: "retry", code: "concurrent_request", uncertain: true }
          : { kind: "review", code: "provider_idempotency_conflict" };
      }
      return { kind: "failed", code: "provider_rejected" };
    } catch {
      return {
        kind: "retry",
        code: "provider_timeout_or_network",
        uncertain: true,
      };
    }
  }
}
async function config(
  db: Pick<Client, "execute"> | Transaction,
  tenant: string,
  identity: string,
) {
  const row = (
    await db.execute({
      sql: "SELECT * FROM mail_sending_configurations WHERE tenant_id=? AND identity_id=? AND status='enabled'",
      args: [tenant, identity],
    })
  ).rows[0];
  if (!row?.encrypted_api_key)
    throw new MailError("sending_not_configured", 403);
  return row;
}
export async function queueMail(
  db: Client,
  user: string,
  id: string,
  identity: string,
  version: number,
  storage: MailStorage | null,
  enabled = mailSendingEnabled(),
) {
  if (!enabled) throw new MailError("sending_disabled", 403);
  const grant = await identityGrant(db, user, identity, "send"),
    tenant = String(grant.tenant_id);
  if (!storage || (grant.provider === "resend") !== storage.durable)
    throw new MailError("storage_unavailable", 503);
  const message = await messageGrant(db, user, id, identity);
  const existing = (
    await db.execute({
      sql: "SELECT state,provider_id FROM mail_send_jobs WHERE tenant_id=? AND message_id=?",
      args: [tenant, id],
    })
  ).rows[0];
  if (existing)
    return { queued: true, id, state: existing.state, duplicate: true };
  if (
    message.direction !== "outbound" ||
    message.delivery_status !== "draft" ||
    message.folder !== "drafts" ||
    Number(message.draft_version) !== version
  )
    throw new MailError("draft_conflict", 409);
  if (!String(message.subject).trim())
    throw new MailError("subject_required", 422);
  const object = (
    await db.execute({
      sql: "SELECT object_key FROM mail_objects WHERE tenant_id=? AND id=?",
      args: [tenant, message.content_object_id],
    })
  ).rows[0];
  const content = await readDraftContent(
    storage,
    tenant,
    String(object.object_key),
  );
  if (!content.text.trim() && !content.html.trim())
    throw new MailError("body_required", 422);
  allowRecipients(content, await config(db, tenant, identity));
  await rateLimit(db, tenant, user, "send", 5);
  await transaction(db, async (tx) => {
    await identityGrant(tx, user, identity, "send");
    const sending = await config(tx, tenant, identity);
    allowRecipients(content, sending);
    const old = (
      await tx.execute({
        sql: "SELECT id FROM mail_send_jobs WHERE tenant_id=? AND message_id=?",
        args: [tenant, id],
      })
    ).rows[0];
    if (old) return;
    const count = (
      await tx.execute({
        sql: "SELECT count(*) AS n FROM mail_send_jobs WHERE tenant_id=? AND identity_id=? AND created_at>=?",
        args: [
          tenant,
          identity,
          new Date(Date.now() - 86_400_000).toISOString(),
        ],
      })
    ).rows[0];
    if (Number(count.n) >= Number(sending.daily_limit))
      throw new MailError("send_quota", 429);
    const update = await tx.execute({
      sql: "UPDATE mail_messages SET delivery_status='queued' WHERE tenant_id=? AND id=? AND delivery_status='draft' AND draft_version=? AND state='ready'",
      args: [tenant, id, version],
    });
    if (update.rowsAffected !== 1) throw new MailError("draft_conflict", 409);
    const moved = await tx.execute({
      sql: "UPDATE mail_message_recipients SET folder='sent' WHERE tenant_id=? AND message_id=? AND identity_id=? AND folder='drafts' AND deleted_at IS NULL",
      args: [tenant, id, identity],
    });
    if (moved.rowsAffected !== 1) throw new MailError("draft_conflict", 409);
    await tx.execute({
      sql: "INSERT INTO mail_send_jobs(tenant_id,id,message_id,identity_id,user_id,idempotency_key,available_at) VALUES (?,?,?,?,?,?,?)",
      args: [
        tenant,
        hash("send:" + id),
        id,
        identity,
        user,
        "todoku-mail/" + hash(tenant) + "/" + id,
        new Date().toISOString(),
      ],
    });
    await audit(tx, tenant, String(grant.source_id), null, "send_queued");
  });
  return { queued: true, id, state: "pending", duplicate: false };
}
async function applySendEvents(
  tx: Pick<Client, "execute"> | Transaction,
  tenant: string,
  identity: string,
  providerId: string,
) {
  const job = (
    await tx.execute({
      sql: "SELECT message_id FROM mail_send_jobs WHERE tenant_id=? AND identity_id=? AND provider_id=?",
      args: [tenant, identity, providerId],
    })
  ).rows[0];
  if (!job) return;
  const events = (
    await tx.execute({
      sql: "SELECT event_type,message_id FROM mail_send_events WHERE tenant_id=? AND identity_id=? AND provider_id=? ORDER BY created_at,id",
      args: [tenant, identity, providerId],
    })
  ).rows;
  const priority = [
    "email.sent",
    "email.delivered",
    "email.failed",
    "email.bounced",
    "email.complained",
  ];
  let status = "accepted",
    rank = -1;
  for (const event of events) {
    const n = priority.indexOf(String(event.event_type));
    if (n > rank) {
      rank = n;
      status = ["accepted", "delivered", "failed", "bounced", "complained"][n];
    }
    const rfc = rfcId(event.message_id);
    if (rfc)
      await tx.execute({
        sql: "UPDATE mail_messages SET message_id=? WHERE tenant_id=? AND id=? AND state='ready'",
        args: [rfc, tenant, job.message_id],
      });
  }
  await tx.execute({
    sql: "UPDATE mail_messages SET delivery_status=? WHERE tenant_id=? AND id=? AND state='ready'",
    args: [status, tenant, job.message_id],
  });
}
export async function runMailSendWorker(
  db: Client,
  storage: MailStorage | null,
  options: {
    enabled?: boolean;
    provider?: (row: Row) => MailSendProvider;
    keyring?: Keyring;
    now?: () => number;
  } = {},
) {
  if (!(options.enabled ?? mailSendingEnabled()))
    return { processed: 0, state: "sending_disabled" };
  if (!storage) return { processed: 0, state: "storage_unavailable" };
  const now = options.now ?? Date.now;
  await transaction(db, async (tx) => {
    const expired = (
      await tx.execute({
        sql: "SELECT j.*,m.source_id FROM mail_send_jobs j JOIN mail_messages m ON m.tenant_id=j.tenant_id AND m.id=j.message_id WHERE j.state='sending' AND julianday(j.locked_until)<=julianday(?)",
        args: [new Date(now()).toISOString()],
      })
    ).rows;
    for (const row of expired) {
      const state = Number(row.attempts) >= 5 ? "manual_review" : "retry_wait";
      await tx.execute({
        sql: "UPDATE mail_send_jobs SET state=?,uncertain=1,available_at=?,lease_token=NULL,locked_until=NULL,last_error_code='lease_expired' WHERE tenant_id=? AND id=? AND state='sending'",
        args: [state, new Date(now()).toISOString(), row.tenant_id, row.id],
      });
      await tx.execute({
        sql: "UPDATE mail_messages SET delivery_status=? WHERE tenant_id=? AND id=? AND state='ready'",
        args: [
          state === "retry_wait" ? "queued" : state,
          row.tenant_id,
          row.message_id,
        ],
      });
      await audit(
        tx,
        String(row.tenant_id),
        String(row.source_id),
        null,
        "send_lease_expired",
        "lease_expired",
      );
    }
  });
  const job = await transaction(db, async (tx) => {
    const row = (
      await tx.execute({
        sql: "SELECT j.* FROM mail_send_jobs j WHERE j.state IN ('pending','retry_wait') AND j.attempts<5 AND julianday(j.available_at)<=julianday(?) ORDER BY j.created_at,j.id LIMIT 1",
        args: [new Date(now()).toISOString()],
      })
    ).rows[0];
    if (!row) return null;
    const lease = randomUUID(),
      first = String(row.first_attempt_at ?? new Date(now()).toISOString());
    const updated = await tx.execute({
      sql: "UPDATE mail_send_jobs SET state='sending',attempts=attempts+1,lease_token=?,locked_until=?,first_attempt_at=COALESCE(first_attempt_at,?) WHERE tenant_id=? AND id=? AND state IN ('pending','retry_wait')",
      args: [
        lease,
        new Date(now() + 360_000).toISOString(),
        first,
        row.tenant_id,
        row.id,
      ],
    });
    if (updated.rowsAffected !== 1) return null;
    return Object.assign(row, {
      lease_token: lease,
      first_attempt_at: first,
      attempts: Number(row.attempts) + 1,
    });
  });
  if (!job) return { processed: 0, state: "idle" };
  const tenant = String(job.tenant_id),
    identity = String(job.identity_id),
    id = String(job.message_id);
  let result: MailSendResult,
    transportStarted = false;
  try {
    if (now() - Date.parse(job.first_attempt_at) >= 23 * 3_600_000)
      result = { kind: "review", code: "idempotency_window_expired" };
    else {
      const grant = await identityGrant(
        db,
        String(job.user_id),
        identity,
        "send",
      );
      if ((grant.provider === "resend") !== storage.durable)
        throw new MailError("storage_unavailable", 503);
      if (
        grant.provider !== "resend" &&
        (process.env.VERCEL || !options.provider)
      )
        throw new MailError("fixture_sending_disabled", 403);
      const sending = await config(db, tenant, identity),
        message = await messageGrant(db, String(job.user_id), id, identity);
      if (
        message.folder !== "sent" ||
        message.direction !== "outbound" ||
        message.sender !== grant.address
      )
        throw new MailError("sending_scope_changed", 403);
      const object = (
        await db.execute({
          sql: "SELECT object_key FROM mail_objects WHERE tenant_id=? AND id=?",
          args: [tenant, message.content_object_id],
        })
      ).rows[0];
      const content = await readDraftContent(
        storage,
        tenant,
        String(object.object_key),
      );
      allowRecipients(content, sending);
      const rows = (
        await db.execute({
          sql: "SELECT a.*,o.object_key FROM mail_attachments a JOIN mail_objects o ON o.tenant_id=a.tenant_id AND o.id=a.object_id WHERE a.tenant_id=? AND a.message_id=? ORDER BY a.id",
          args: [tenant, id],
        })
      ).rows;
      const attachments = [];
      for (const file of rows) {
        const bytes = await storage.get(tenant, String(file.object_key));
        if (bytes.length !== Number(file.size))
          throw new MailError("attachment_unavailable", 503);
        attachments.push({
          filename: String(file.filename),
          content: Buffer.from(bytes).toString("base64"),
          content_type: String(file.content_type),
        });
      }
      const payload: Payload = {
        from: String(message.sender),
        to: content.envelope.to,
        ...(content.envelope.cc.length ? { cc: content.envelope.cc } : {}),
        ...(content.envelope.bcc.length ? { bcc: content.envelope.bcc } : {}),
        subject: String(message.subject),
        text: content.text,
        ...(content.html ? { html: content.html } : {}),
        headers: content.headers,
        attachments,
      };
      const fingerprint = hash(JSON.stringify(payload));
      if (job.payload_hash && job.payload_hash !== fingerprint)
        result = { kind: "review", code: "send_snapshot_changed" };
      else {
        await transaction(db, async (tx) => {
          const owned = (
            await tx.execute({
              sql: "SELECT id FROM mail_send_jobs WHERE tenant_id=? AND id=? AND state='sending' AND lease_token=? AND julianday(locked_until)>julianday(?)",
              args: [
                tenant,
                job.id,
                job.lease_token,
                new Date(now()).toISOString(),
              ],
            })
          ).rows[0];
          if (!owned) throw new MailError("lease_lost", 409);
          await identityGrant(tx, String(job.user_id), identity, "send");
          allowRecipients(content, await config(tx, tenant, identity));
          await tx.execute({
            sql: "UPDATE mail_send_jobs SET payload_hash=? WHERE tenant_id=? AND id=? AND lease_token=?",
            args: [fingerprint, tenant, job.id, job.lease_token],
          });
          await audit(
            tx,
            tenant,
            String(grant.source_id),
            null,
            "send_attempted",
          );
        });
        const provider =
          options.provider?.(sending) ??
          new ResendMailSender(
            openSecret(
              String(sending.encrypted_api_key),
              { tenantId: tenant, applicationId: "todoku-mail-send" },
              identity,
              "api_key",
              options.keyring,
            ),
          );
        transportStarted = true;
        result = await provider.send(payload, String(job.idempotency_key));
      }
    }
  } catch (error) {
    result =
      !transportStarted && error instanceof MailError && error.status < 500
        ? { kind: "failed", code: error.message }
        : {
            kind: "retry",
            code: transportStarted
              ? "provider_timeout_or_network"
              : "send_preparation_unavailable",
            uncertain: transportStarted,
          };
  }
  const accepted = result.kind === "accepted",
    uncertain =
      Boolean(job.uncertain) || (result.kind === "retry" && result.uncertain);
  const receipt = result.kind === "accepted" ? result : null,
    code = result.kind === "accepted" ? null : result.code;
  const state = accepted
    ? "accepted"
    : result.kind === "review" ||
        ((result.kind === "failed" || job.attempts >= 5) && uncertain)
      ? "manual_review"
      : result.kind === "failed" || job.attempts >= 5
        ? "failed"
        : "retry_wait";
  const committed = await transaction(db, async (tx) => {
    const update = await tx.execute({
      sql: "UPDATE mail_send_jobs SET state=?,provider_id=COALESCE(?,provider_id),uncertain=?,last_error_code=?,available_at=?,lease_token=NULL,locked_until=NULL WHERE tenant_id=? AND id=? AND lease_token=? AND state='sending' AND julianday(locked_until)>julianday(?)",
      args: [
        state,
        receipt?.id ?? null,
        uncertain ? 1 : 0,
        code,
        new Date(
          now() +
            Math.min(3_600_000, 30_000 * 2 ** (job.attempts - 1)) *
              (1 + Math.random() * 0.2),
        ).toISOString(),
        tenant,
        job.id,
        job.lease_token,
        new Date(now()).toISOString(),
      ],
    });
    if (update.rowsAffected !== 1) return false;
    await tx.execute({
      sql: "UPDATE mail_messages SET delivery_status=?,message_id=COALESCE(?,message_id) WHERE tenant_id=? AND id=?",
      args: [
        state === "retry_wait" ? "queued" : state,
        rfcId(receipt?.messageId),
        tenant,
        id,
      ],
    });
    const message = (
      await tx.execute({
        sql: "SELECT source_id FROM mail_messages WHERE tenant_id=? AND id=?",
        args: [tenant, id],
      })
    ).rows[0];
    await audit(
      tx,
      tenant,
      String(message.source_id),
      null,
      "send_" + state,
      code,
    );
    if (receipt) await applySendEvents(tx, tenant, identity, receipt.id);
    return true;
  });
  return { processed: 1, state: committed ? state : "lease_lost" };
}
export async function sendingWebhook(
  request: Request,
  identity: string,
  db: Client,
  options: { enabled?: boolean; keyring?: Keyring } = {},
) {
  try {
    if (!(options.enabled ?? mailSendingEnabled()))
      return json({ error: "sending_disabled" }, 503);
    const configuration = (
      await db.execute({
        sql: "SELECT c.*,i.status AS identity_status FROM mail_sending_configurations c JOIN mail_identities i ON i.tenant_id=c.tenant_id AND i.id=c.identity_id JOIN tenants t ON t.id=c.tenant_id WHERE c.identity_id=? AND c.status='enabled' AND i.status='active' AND t.status='active'",
        args: [identity],
      })
    ).rows[0];
    if (!configuration?.encrypted_webhook_secret)
      return json({ error: "invalid_webhook" }, 401);
    const raw = await body(request, limits.webhook),
      id = request.headers.get("svix-id") ?? "";
    if (!id || id.length > 200) return json({ error: "invalid_webhook" }, 401);
    const secret = openSecret(
      String(configuration.encrypted_webhook_secret),
      {
        tenantId: String(configuration.tenant_id),
        applicationId: "todoku-mail-send",
      },
      identity,
      "webhook",
      options.keyring,
    );
    try {
      new Webhook(secret).verify(raw, {
        "svix-id": id,
        "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
        "svix-signature": request.headers.get("svix-signature") ?? "",
      });
    } catch {
      return json({ error: "invalid_webhook" }, 401);
    }
    const event = z
      .object({
        type: z.enum([
          "email.sent",
          "email.delivered",
          "email.failed",
          "email.bounced",
          "email.complained",
        ]),
        data: z.object({
          email_id: z.uuid(),
          message_id: z.string().max(502).nullable().optional(),
        }),
      })
      .parse(JSON.parse(raw));
    await transaction(db, async (tx) => {
      await tx.execute({
        sql: "INSERT INTO mail_send_events(tenant_id,identity_id,id,provider_id,event_type,message_id) VALUES (?,?,?,?,?,?) ON CONFLICT(tenant_id,identity_id,id) DO NOTHING",
        args: [
          configuration.tenant_id,
          identity,
          id,
          event.data.email_id,
          event.type,
          rfcId(event.data.message_id),
        ],
      });
      await applySendEvents(
        tx,
        String(configuration.tenant_id),
        identity,
        event.data.email_id,
      );
    });
    return json({ received: true });
  } catch (error) {
    return json(
      {
        error:
          error instanceof MailError
            ? error.message
            : error instanceof SyntaxError || error instanceof z.ZodError
              ? "invalid_event"
              : "webhook_unavailable",
      },
      error instanceof MailError
        ? error.status
        : error instanceof SyntaxError || error instanceof z.ZodError
          ? 400
          : 503,
    );
  }
}
