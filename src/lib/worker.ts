import { randomUUID } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import type { DeliveryProvider, EmailMessage, SendResult } from "./events.ts";
import { configurationFromRow, deliveryAudit, type ProviderConfiguration } from "./configurations.ts";
import { openSecret, type Keyring, type Scope } from "./secrets.ts";
import { ResendProvider } from "./providers.ts";
import { retryDecision } from "./queue-policy.ts";
import { reconcileWebhooks } from "./delivery-status.ts";

const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;
const LEASE_MS = 120_000;
export type WorkerOptions = {
  mode?: "dry_run" | "test"; configurationId?: string; limit?: number; now?: () => number;
  keyring?: Keyring; providerFactory?: (key: string) => DeliveryProvider; jitter?: () => number;
};
type Claim = Scope & { id: string; token: string; attemptId: string; attemptCount: number; maxAttempts: number;
  mode: string; configurationId: string; message: EmailMessage; idempotencyKey: string; firstAttemptAt: number };

async function transaction<T>(db: Client, work: (tx: Transaction) => Promise<T>) {
  const tx = await db.transaction("write");
  try { const result = await work(tx); await tx.commit(); return result; }
  catch (error) { try { if (!tx.closed) await tx.rollback(); } catch {} throw error; }
  finally { tx.close(); }
}

export async function recoverLeases(db: Client, now: number) {
  return transaction(db, async tx => {
    const rows = (await tx.execute({ sql: `SELECT o.*, d.mode, d.state, d.first_attempt_at FROM outbox_messages o
      JOIN message_deliveries d ON d.tenant_id = o.tenant_id AND d.application_id = o.application_id AND d.outbox_id = o.id
      WHERE o.status = 'processing' AND julianday(o.locked_until) <= julianday(?) LIMIT 20`, args: [new Date(now).toISOString()] })).rows;
    for (const row of rows) {
      const scope = { tenantId: String(row.tenant_id), applicationId: String(row.application_id) };
      if (["sent", "delivered", "bounced", "complained", "suppressed", "dry_run"].includes(String(row.state))) {
        await tx.execute({ sql: "UPDATE outbox_messages SET status = ?, lease_token = NULL, locked_until = NULL WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [row.state === "dry_run" ? "cancelled" : "sent", scope.tenantId, scope.applicationId, row.id] });
        await deliveryAudit(tx, scope, String(row.id), "lease_expired", { state: String(row.state) });
        continue;
      }
      const first = Date.parse(String(row.first_attempt_at));
      const canRetry = Number(row.attempt_count) < Number(row.max_attempts) && (row.mode === "dry_run" || (Number.isFinite(first) && now - first < IDEMPOTENCY_WINDOW_MS));
      await tx.execute({ sql: "UPDATE outbox_messages SET status = ?, lease_token = NULL, locked_until = NULL, available_at = ?, updated_at = ? WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [canRetry ? "retry_wait" : "manual_review", new Date(now + 30_000).toISOString(), new Date(now).toISOString(), scope.tenantId, scope.applicationId, row.id] });
      await tx.execute({ sql: "UPDATE delivery_attempts SET status = 'ambiguous', error_code = 'lease_expired', finished_at = ? WHERE tenant_id = ? AND application_id = ? AND outbox_id = ? AND status = 'started'", args: [new Date(now).toISOString(), scope.tenantId, scope.applicationId, row.id] });
      await tx.execute({ sql: "UPDATE message_deliveries SET state = ?, last_error_code = 'lease_expired', updated_at = ? WHERE tenant_id = ? AND application_id = ? AND outbox_id = ?", args: [canRetry ? "queued" : "manual_review", new Date(now).toISOString(), scope.tenantId, scope.applicationId, row.id] });
      await deliveryAudit(tx, scope, String(row.id), "lease_expired", { state: canRetry ? "retry_wait" : "manual_review" });
    }
    return rows.length;
  });
}

async function claim(db: Client, options: WorkerOptions, now: number): Promise<Claim | null> {
  return transaction(db, async tx => {
    const row = (await tx.execute({ sql: `SELECT o.*, d.configuration_id, d.mode, d.request_json, d.idempotency_key, d.first_attempt_at
      FROM outbox_messages o JOIN message_deliveries d ON d.tenant_id = o.tenant_id AND d.application_id = o.application_id AND d.outbox_id = o.id
      JOIN tenants t ON t.id = o.tenant_id JOIN applications a ON a.tenant_id = o.tenant_id AND a.id = o.application_id
      WHERE o.status IN ('pending', 'retry_wait') AND o.traffic_type = 'transactional' AND d.mode = ?
      AND d.state = 'queued'
      AND (? IS NULL OR d.configuration_id = ?) AND julianday(o.available_at) <= julianday(?)
      AND o.attempt_count < o.max_attempts AND t.status = 'active' AND a.status = 'active'
      ORDER BY o.available_at, o.id LIMIT 1`, args: [options.mode ?? "dry_run", options.configurationId ?? null, options.configurationId ?? null, new Date(now).toISOString()] })).rows[0];
    if (!row) return null;
    const token = randomUUID();
    const attemptId = randomUUID();
    const scope = { tenantId: String(row.tenant_id), applicationId: String(row.application_id) };
    await tx.execute({ sql: "UPDATE outbox_messages SET status = 'processing', attempt_count = attempt_count + 1, locked_until = ?, lease_token = ?, updated_at = ? WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [new Date(now + LEASE_MS).toISOString(), token, new Date(now).toISOString(), scope.tenantId, scope.applicationId, row.id] });
    await tx.execute({ sql: "UPDATE message_deliveries SET first_attempt_at = COALESCE(first_attempt_at, ?), updated_at = ? WHERE tenant_id = ? AND application_id = ? AND outbox_id = ?", args: [new Date(now).toISOString(), new Date(now).toISOString(), scope.tenantId, scope.applicationId, row.id] });
    await tx.execute({ sql: "INSERT INTO delivery_attempts(tenant_id, application_id, id, outbox_id, attempt_number, provider, status, started_at) VALUES (?, ?, ?, ?, ?, ?, 'started', ?)", args: [scope.tenantId, scope.applicationId, attemptId, row.id, Number(row.attempt_count) + 1, row.mode === "dry_run" ? "dry_run" : "resend", new Date(now).toISOString()] });
    await deliveryAudit(tx, scope, String(row.id), "claimed", { attempt: Number(row.attempt_count) + 1 });
    return { ...scope, id: String(row.id), token, attemptId, attemptCount: Number(row.attempt_count) + 1, maxAttempts: Number(row.max_attempts),
      mode: String(row.mode), configurationId: String(row.configuration_id), message: JSON.parse(String(row.request_json)),
      idempotencyKey: String(row.idempotency_key), firstAttemptAt: row.first_attempt_at ? Date.parse(String(row.first_attempt_at)) : now };
  });
}

async function authorizeSend(db: Client, job: Claim, now: number): Promise<{ config?: ProviderConfiguration; error?: string }> {
  return transaction(db, async tx => {
    const lease = await tx.execute({ sql: "SELECT id FROM outbox_messages WHERE tenant_id = ? AND application_id = ? AND id = ? AND lease_token = ? AND status = 'processing' AND julianday(locked_until) > julianday(?)", args: [job.tenantId, job.applicationId, job.id, job.token, new Date(now).toISOString()] });
    if (!lease.rows.length) return { error: "lease_lost" };
    const result = await tx.execute({ sql: `SELECT c.* FROM provider_configurations c
      JOIN tenants t ON t.id = c.tenant_id JOIN applications a ON a.tenant_id = c.tenant_id AND a.id = c.application_id
      WHERE c.tenant_id = ? AND c.application_id = ? AND c.id = ? AND t.status = 'active' AND a.status = 'active'`, args: [job.tenantId, job.applicationId, job.configurationId] });
    if (!result.rows[0]) return { error: "scope_disabled" };
    const config = configurationFromRow(result.rows[0]);
    if (config.status !== "active") return { error: "configuration_revoked" };
    if (job.mode !== config.mode) return { error: "configuration_mode_changed" };
    const suppressed = await tx.execute({ sql: "SELECT email FROM recipient_suppressions WHERE tenant_id = ? AND application_id = ? AND email = ?", args: [job.tenantId, job.applicationId, job.message.to[0].toLowerCase()] });
    if (suppressed.rows.length) return { error: "recipient_suppressed" };
    if (job.mode === "test") {
      if (!config.encryptedApiKey || !config.domainVerifiedAt || !config.allowedRecipients.includes(job.message.to[0].toLowerCase()) ||
          job.message.to.length !== 1 || job.message.from !== `${config.senderName} <${config.senderEmail}>` ||
          config.senderEmail.split("@")[1].toLowerCase() !== config.domain) return { error: "sending_not_authorized" };
      const reserved = (await tx.execute({ sql: "SELECT budget_reserved FROM message_deliveries WHERE tenant_id = ? AND application_id = ? AND outbox_id = ?", args: [job.tenantId, job.applicationId, job.id] })).rows[0];
      if (!Number(reserved.budget_reserved)) {
        const updated = await tx.execute({ sql: "UPDATE provider_configurations SET send_count = send_count + 1 WHERE tenant_id = ? AND application_id = ? AND id = ? AND send_count < send_limit", args: [job.tenantId, job.applicationId, config.id] });
        if (updated.rowsAffected !== 1) return { error: "test_send_limit_reached" };
        await tx.execute({ sql: "UPDATE message_deliveries SET budget_reserved = 1 WHERE tenant_id = ? AND application_id = ? AND outbox_id = ?", args: [job.tenantId, job.applicationId, job.id] });
      }
    }
    return { config };
  });
}

async function finish(db: Client, job: Claim, result: SendResult | { kind: "dry_run" }, now: number, jitter: number) {
  return transaction(db, async tx => {
    const owner = (await tx.execute({ sql: "SELECT lease_token FROM outbox_messages WHERE tenant_id = ? AND application_id = ? AND id = ? AND status = 'processing'", args: [job.tenantId, job.applicationId, job.id] })).rows[0];
    if (!owner || owner.lease_token !== job.token) return "lease_lost";
    let outboxStatus = "dead", state = "failed", attemptStatus = "permanent_failure", action = "failed";
    let code: string | null = null;
    let providerId: string | null = null;
    let availableAt = new Date(now).toISOString();
    if (result.kind === "dry_run") { outboxStatus = "cancelled"; state = "dry_run"; attemptStatus = "succeeded"; action = "dry_run"; }
    else if (result.kind === "accepted") { outboxStatus = "sent"; state = "sent"; attemptStatus = "succeeded"; action = "sent"; providerId = result.providerMessageId; }
    else {
      code = result.code;
      if (result.kind === "review") { outboxStatus = "manual_review"; state = "manual_review"; attemptStatus = "ambiguous"; action = "manual_review"; }
      if (result.kind === "retryable") {
        const retry = retryDecision({ attempts: job.attemptCount, maxAttempts: job.maxAttempts, outcome: "transient_not_sent", now, jitter });
        const next = retry.status === "retry_wait" ? Math.max(Date.parse(retry.availableAt), now + (result.retryAfterMs ?? 0)) : now;
        if (now - job.firstAttemptAt >= IDEMPOTENCY_WINDOW_MS || (result.uncertain && (retry.status !== "retry_wait" || next - job.firstAttemptAt >= IDEMPOTENCY_WINDOW_MS))) {
          outboxStatus = "manual_review"; state = "manual_review"; action = "manual_review";
        } else if (retry.status === "retry_wait") { outboxStatus = "retry_wait"; state = "queued"; action = "retry_scheduled"; availableAt = new Date(next).toISOString(); }
        attemptStatus = result.uncertain ? "ambiguous" : "transient_failure";
      }
    }
    await tx.execute({ sql: "UPDATE delivery_attempts SET status = ?, provider_message_id = ?, error_code = ?, finished_at = ? WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [attemptStatus, providerId, code, new Date(now).toISOString(), job.tenantId, job.applicationId, job.attemptId] });
    await tx.execute({ sql: "UPDATE outbox_messages SET status = ?, lease_token = NULL, locked_until = NULL, available_at = ?, updated_at = ? WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [outboxStatus, availableAt, new Date(now).toISOString(), job.tenantId, job.applicationId, job.id] });
    await tx.execute({ sql: "UPDATE message_deliveries SET state = CASE WHEN state IN ('delivered', 'bounced', 'complained', 'suppressed') THEN state ELSE ? END, provider_message_id = COALESCE(?, provider_message_id), last_error_code = ?, updated_at = ? WHERE tenant_id = ? AND application_id = ? AND outbox_id = ?", args: [state, providerId, code, new Date(now).toISOString(), job.tenantId, job.applicationId, job.id] });
    await deliveryAudit(tx, job, job.id, action, { ...(code ? { code } : {}), state });
    if (providerId) await reconcileWebhooks(tx, job, job.configurationId, providerId);
    return state;
  });
}

export async function runWorker(db: Client, options: WorkerOptions = {}) {
  const now = options.now ?? Date.now;
  if (options.mode === "test" && !options.configurationId) throw new Error("Explicit test configuration required");
  const recovered = await recoverLeases(db, now());
  const states: string[] = [];
  for (let index = 0; index < Math.min(3, Math.max(1, options.limit ?? 3)); index++) {
    const job = await claim(db, options, now());
    if (!job) break;
    let result: SendResult | { kind: "dry_run" };
    const authorization = await authorizeSend(db, job, now());
    if (authorization.error || !authorization.config) result = { kind: "review", code: authorization.error ?? "configuration_unavailable" };
    else if (job.mode === "dry_run") result = { kind: "dry_run" };
    else if (now() - job.firstAttemptAt >= IDEMPOTENCY_WINDOW_MS) result = { kind: "review", code: "idempotency_window_expired" };
    else {
      let key: string | undefined;
      try { key = openSecret(authorization.config.encryptedApiKey!, job, job.configurationId, "api_key", options.keyring); }
      catch { /* No provider call if decryption fails. */ }
      if (!key) result = { kind: "review", code: "provider_secret_unavailable" };
      else try {
        const provider = options.providerFactory?.(key) ?? new ResendProvider(key);
        result = await provider.send({ message: job.message, idempotencyKey: job.idempotencyKey });
      } catch { result = { kind: "retryable", code: "provider_timeout_or_network", uncertain: true }; }
    }
    states.push(await finish(db, job, result, now(), options.jitter?.() ?? Math.random()));
  }
  return { processed: states.length, recovered, states };
}
