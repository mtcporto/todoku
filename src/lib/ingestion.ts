import { createHash, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { Client, Transaction } from "@libsql/client";
import type { CommunicationEvent } from "./events.ts";
import { activeConfiguration } from "./configurations.ts";
import { TemplateError } from "./templates.ts";
import { resolveTemplate } from "./hub/templates.ts";

export class IngestionError extends Error {
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.status = status; }
}

export function hashCredential(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function authenticate(db: Pick<Client, "execute"> | Transaction, token: string) {
  const result = await db.execute({
    sql: `SELECT c.tenant_id, c.application_id, c.id FROM application_credentials c
      JOIN applications a ON a.tenant_id = c.tenant_id AND a.id = c.application_id
      JOIN tenants t ON t.id = c.tenant_id
      WHERE c.token_hash = ? AND c.scope = 'events:write' AND c.revoked_at IS NULL
      AND (c.expires_at IS NULL OR julianday(c.expires_at) > julianday('now'))
      AND a.status = 'active' AND t.status = 'active'`,
    args: [hashCredential(token)],
  });
  const credential = result.rows[0];
  if (!credential) throw new IngestionError("unauthorized", 401);
  return { tenantId: String(credential.tenant_id), applicationId: String(credential.application_id), credentialId: String(credential.id) };
}

async function beginWrite(db: Client): Promise<Transaction> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction("write"); } catch (error) {
      const code = (error as { code?: string }).code;
      // Retry only lock acquisition, before any writes or commit have occurred.
      if (attempt >= 5 || (code !== "SQLITE_BUSY" && code !== "SQLITE_LOCKED")) throw error;
      await setTimeout(20 * 2 ** attempt + Math.random() * 20);
    }
  }
}

export async function ingestEvent(db: Client, token: string, event: CommunicationEvent) {
  const tx = await beginWrite(db);
  try {
    // Recheck auth within the write transaction, serializing ingestion with revocation.
    const scope = await authenticate(tx, token);
    if (event.tenantId !== scope.tenantId || event.applicationId !== scope.applicationId) {
      throw new IngestionError("scope_mismatch", 403);
    }
    const payload = canonicalJson(event);
    const hash = createHash("sha256").update(payload).digest("hex");
    const existing = await tx.execute({
      sql: "SELECT id, payload_hash FROM events WHERE tenant_id = ? AND application_id = ? AND idempotency_key = ?",
      args: [scope.tenantId, scope.applicationId, event.idempotencyKey],
    });
    if (existing.rows.length) {
      if (existing.rows[0].payload_hash !== hash) throw new IngestionError("idempotency_conflict", 409);
      await tx.commit();
      return { eventId: String(existing.rows[0].id), status: "accepted" as const, replay: true };
    }
    const duplicateId = await tx.execute({
      sql: "SELECT id FROM events WHERE tenant_id = ? AND application_id = ? AND producer_event_id = ?",
      args: [scope.tenantId, scope.applicationId, event.id],
    });
    if (duplicateId.rows.length) throw new IngestionError("event_id_conflict", 409);
    if (event.trafficType === "marketing") throw new IngestionError("marketing_disabled", 422);
    let rendered;
    try { rendered = await resolveTemplate(tx, event); } catch (error) {
      if (error instanceof TemplateError) throw new IngestionError(error.message, 422);
      throw error;
    }
    const configuration = await activeConfiguration(tx, scope);
    if (!configuration) throw new IngestionError("provider_not_configured", 422);
    if (configuration.mode === "test" && !configuration.allowedRecipients.includes(event.recipient.email.toLowerCase())) throw new IngestionError("recipient_not_authorized", 403);
    if (configuration.mode === "test" && configuration.sendCount >= configuration.sendLimit) throw new IngestionError("test_send_limit_reached", 422);
    const eventId = randomUUID();
    const outboxId = randomUUID();
    await tx.execute({
      sql: `INSERT INTO events(tenant_id, application_id, id, producer_event_id, idempotency_key,
        payload_hash, payload_json, event_type, traffic_type, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [scope.tenantId, scope.applicationId, eventId, event.id, event.idempotencyKey, hash, payload, event.type, event.trafficType, event.occurredAt],
    });
    await tx.execute({
      sql: "INSERT INTO outbox_messages(tenant_id, application_id, id, event_id, traffic_type) VALUES (?, ?, ?, ?, ?)",
      args: [scope.tenantId, scope.applicationId, outboxId, eventId, event.trafficType],
    });
    await tx.execute({ sql: `INSERT INTO message_deliveries(tenant_id, application_id, outbox_id, configuration_id, mode, template_version, request_json, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, args: [scope.tenantId, scope.applicationId, outboxId, configuration.id, configuration.mode, rendered.templateVersion,
        JSON.stringify({ from: `${configuration.senderName} <${configuration.senderEmail}>`, to: [event.recipient.email.toLowerCase()], subject: rendered.subject, text: rendered.text, html: rendered.html }),
        `todoku/${createHash("sha256").update(JSON.stringify([scope.tenantId, scope.applicationId])).digest("hex").slice(0, 24)}/${outboxId}`] });
    await tx.execute({
      sql: "INSERT INTO audit_log(tenant_id, application_id, id, event_id, credential_id, action) VALUES (?, ?, ?, ?, ?, 'event.accepted')",
      args: [scope.tenantId, scope.applicationId, randomUUID(), eventId, scope.credentialId],
    });
    await tx.commit();
    return { eventId, status: "accepted" as const, replay: false };
  } catch (error) {
    try { if (!tx.closed) await tx.rollback(); } catch { /* A commit acknowledgement may have been lost. Fail closed. */ }
    throw error;
  } finally {
    tx.close();
  }
}
