import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { getDatabase, isDatabaseReady } from "../src/lib/database.ts";
import { hashCredential } from "../src/lib/ingestion.ts";
import { provisionConfiguration, revokeConfiguration } from "../src/lib/configurations.ts";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:3037");
if (origin.pathname !== "/" || origin.search || origin.username || origin.password ||
    !(origin.protocol === "https:" || (origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)))) throw new Error("Provide an HTTPS or loopback origin");
const cronSecret = process.env.CRON_SECRET;
if (!cronSecret || cronSecret.length < 32) throw new Error("Worker credential unavailable");
const headers: Record<string, string> = { "content-type": "application/json" };
if (origin.hostname.endsWith(".vercel.app") && process.env.VERCEL_OIDC_TOKEN) headers["x-vercel-trusted-oidc-idp-token"] = process.env.VERCEL_OIDC_TOKEN;
async function call(path: string, init?: RequestInit) {
  return fetch(new URL(path, origin), { ...init, headers: { ...headers, ...init?.headers }, redirect: "error", signal: AbortSignal.timeout(60_000) });
}
const health = await call("/api/health");
assert.equal(health.status, 200);
assert.equal((await health.json()).delivery, "dry_run");
const db = getDatabase();
const scope = { tenantId: `dry-run-${randomUUID()}`, applicationId: "smoke" };
const token = randomBytes(32).toString("base64url");
let provisioned = false;
let configId: string | undefined;
try {
  assert.equal(await isDatabaseReady(db), true);
  await db.batch([
    { sql: "INSERT INTO tenants(id) VALUES (?)", args: [scope.tenantId] },
    { sql: "INSERT INTO applications(tenant_id, id) VALUES (?, ?)", args: [scope.tenantId, scope.applicationId] },
    { sql: "INSERT INTO application_credentials(tenant_id, application_id, id, token_hash) VALUES (?, ?, ?, ?)", args: [scope.tenantId, scope.applicationId, randomUUID(), hashCredential(token)] },
  ], "write");
  provisioned = true;
  configId = (await provisionConfiguration(db, { ...scope, mode: "dry_run", senderEmail: "dry-run@example.invalid", senderName: "Todoku" })).configurationId;
  const response = await call("/api/v1/events", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({
    ...scope, id: randomUUID(), type: "system.delivery_test", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID(),
    recipient: { email: process.env.TODOKU_SMOKE_RECIPIENT ?? "validation@example.invalid" },
    data: { message: "Este é o primeiro teste controlado de entrega do Todoku. Nenhuma campanha foi iniciada." },
  }) });
  assert.equal(response.status, 202);
  const accepted = await response.json();
  let state;
  for (let batch = 0; batch < 20; batch++) {
    const worker = await call("/api/internal/worker", { headers: { authorization: `Bearer ${cronSecret}` } });
    assert.equal(worker.status, 200);
    const status = await call(`/api/v1/events/${accepted.eventId}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(status.status, 200);
    state = await status.json();
    if (state.deliveryState !== "queued") break;
  }
  assert.equal(state.deliveryState, "dry_run");
  assert.equal(state.providerMessageId, null);
  const attempts = (await db.execute({ sql: "SELECT provider, status FROM delivery_attempts WHERE tenant_id = ? AND application_id = ?", args: [scope.tenantId, scope.applicationId] })).rows;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].provider, "dry_run");
  assert.equal(attempts[0].status, "succeeded");
  const audit = await db.execute({ sql: "SELECT count(*) AS n FROM delivery_audit_log WHERE tenant_id = ? AND application_id = ? AND action = 'dry_run'", args: [scope.tenantId, scope.applicationId] });
  assert.equal(Number(audit.rows[0].n), 1);
  console.log(JSON.stringify({ origin: origin.origin, database: new URL(process.env.TURSO_DATABASE_URL!).hostname,
    eventId: accepted.eventId, worker: "authenticated", state: state.deliveryState, audited: true, externalSends: 0 }));
} finally {
  try {
    if (configId) await revokeConfiguration(db, scope, configId, true);
    if (provisioned) await db.batch([
      { sql: "UPDATE application_credentials SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE tenant_id = ? AND application_id = ?", args: [scope.tenantId, scope.applicationId] },
      { sql: "UPDATE tenants SET status = 'disabled' WHERE id = ?", args: [scope.tenantId] },
      { sql: "UPDATE outbox_messages SET status = 'cancelled' WHERE tenant_id = ? AND application_id = ? AND status IN ('pending', 'retry_wait')", args: [scope.tenantId, scope.applicationId] },
    ], "write");
  } finally { db.close(); }
}
