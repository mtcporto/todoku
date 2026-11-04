import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { getDatabase, isDatabaseReady } from "../src/lib/database.ts";
import { hashCredential } from "../src/lib/ingestion.ts";
import { provisionConfiguration } from "../src/lib/configurations.ts";

// Explicit integration test: writes synthetic events and retains their audit trail.
// It refuses a service with delivery enabled and revokes all test credentials afterwards.
const origin = new URL(process.argv[2] ?? "http://127.0.0.1:3037");
if (origin.pathname !== "/" || origin.search || origin.username || origin.password ||
    !(origin.protocol === "https:" || (origin.protocol === "http:" && ["127.0.0.1", "localhost"].includes(origin.hostname)))) {
  throw new Error("Provide an HTTPS origin or local test server origin");
}
const headers: Record<string, string> = { "content-type": "application/json" };
if (origin.hostname.endsWith(".vercel.app") && process.env.VERCEL_OIDC_TOKEN) {
  headers["x-vercel-trusted-oidc-idp-token"] = process.env.VERCEL_OIDC_TOKEN;
}
async function call(path: string, init?: RequestInit) {
  return fetch(new URL(path, origin), { ...init, headers: { ...headers, ...init?.headers }, redirect: "error", signal: AbortSignal.timeout(30_000) });
}
const health = await call("/api/health");
assert.equal(health.status, 200, "Service must be ready before validation");
const healthBody = await health.json();
assert.equal(healthBody.service, "todoku");
assert.equal(healthBody.ingestion, "durable");
assert.ok(["disabled", "dry_run"].includes(healthBody.delivery), "Refusing to create events when delivery is enabled");

const db = getDatabase();
const tenantA = `validation-${randomUUID()}`;
const tenantB = `validation-${randomUUID()}`;
const scopes = [
  { tenant: tenantA, app: "smoke", token: randomBytes(32).toString("base64url") },
  { tenant: tenantB, app: "smoke", token: randomBytes(32).toString("base64url") },
  { tenant: tenantA, app: "other", token: randomBytes(32).toString("base64url") },
];
let provisioned = false;
try {
  assert.equal(await isDatabaseReady(db), true);
  await db.batch([
    { sql: "INSERT INTO tenants(id) VALUES (?), (?)", args: [tenantA, tenantB] },
    ...scopes.flatMap(scope => [
      { sql: "INSERT INTO applications(tenant_id, id) VALUES (?, ?)", args: [scope.tenant, scope.app] },
      { sql: "INSERT INTO application_credentials(tenant_id, application_id, id, token_hash) VALUES (?, ?, ?, ?)", args: [scope.tenant, scope.app, randomUUID(), hashCredential(scope.token)] },
    ]),
  ], "write");
  provisioned = true;
  for (const scope of scopes) {
    await provisionConfiguration(db, { tenantId: scope.tenant, applicationId: scope.app, mode: "dry_run", senderEmail: "dry-run@example.invalid", senderName: "Todoku" });
  }
  const payload = {
    id: randomUUID(), type: "system.validation", occurredAt: new Date().toISOString(),
    tenantId: tenantA, applicationId: "smoke", recipient: { email: "validation@example.invalid" },
    data: { synthetic: true, purpose: "durable-ingestion-validation" }, idempotencyKey: randomUUID(),
  };
  const post = (body: unknown, token = scopes[0].token) => call("/api/v1/events", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  assert.equal((await post(payload, randomBytes(32).toString("base64url"))).status, 401);
  assert.equal((await post({ ...payload, tenantId: tenantB })).status, 403);
  assert.equal((await post({ ...payload, applicationId: "other" })).status, 403);
  const simultaneous = await Promise.all(Array.from({ length: 8 }, () => post(payload)));
  const receipts: { eventId: string; status: string; replay: boolean }[] = [];
  for (const result of simultaneous) {
    assert.equal(result.status, 202);
    receipts.push(await result.json());
  }
  assert.equal(receipts.filter(result => !result.replay).length, 1);
  const accepted = receipts.find(result => !result.replay)!;
  for (const receipt of receipts) assert.equal(receipt.eventId, accepted.eventId);
  const replay = await post(payload);
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), { ...accepted, replay: true });
  const conflict = await post({ ...payload, data: { changed: true } });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, "idempotency_conflict");
  for (const scope of scopes.slice(1)) {
    const isolated = await post({ ...payload, tenantId: scope.tenant, applicationId: scope.app }, scope.token);
    assert.equal(isolated.status, 202);
    assert.equal((await isolated.json()).replay, false);
  }
  const marketing = await post({ ...payload, id: randomUUID(), idempotencyKey: randomUUID(), trafficType: "marketing" });
  assert.equal(marketing.status, 422);
  for (const table of ["events", "outbox_messages", "audit_log"]) {
    const result = await db.execute({ sql: `SELECT count(*) AS n FROM ${table} WHERE tenant_id IN (?, ?)`, args: [tenantA, tenantB] });
    assert.equal(Number(result.rows[0].n), 3, `${table}: unexpected duplication or missing persistence`);
  }
  const lane = await db.execute({ sql: "SELECT traffic_type, count(*) AS n FROM outbox_messages WHERE tenant_id IN (?, ?) GROUP BY traffic_type", args: [tenantA, tenantB] });
  assert.deepEqual(lane.rows.map(row => [row.traffic_type, Number(row.n)]), [["transactional", 3]]);
  const pending = await db.execute({ sql: "SELECT count(*) AS n FROM outbox_messages WHERE tenant_id IN (?, ?) AND status = 'pending' AND attempt_count = 0", args: [tenantA, tenantB] });
  assert.equal(Number(pending.rows[0].n), 3);
  const attempts = await db.execute({ sql: "SELECT count(*) AS n FROM delivery_attempts WHERE tenant_id IN (?, ?)", args: [tenantA, tenantB] });
  assert.equal(Number(attempts.rows[0].n), 0);
  console.log(JSON.stringify({ origin: origin.origin, database: new URL(process.env.TURSO_DATABASE_URL!).hostname,
    accepted: true, replay: true, conflict: true, isolation: true, concurrentRequests: 8,
    persistedEvents: 3, pendingMessages: 3, marketing: "disabled", deliveryAttempts: 0 }));
} finally {
  try {
    if (provisioned) {
      await db.batch([
        { sql: "UPDATE outbox_messages SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE tenant_id IN (?, ?) AND status = 'pending'", args: [tenantA, tenantB] },
        { sql: "UPDATE application_credentials SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE tenant_id IN (?, ?)", args: [tenantA, tenantB] },
        { sql: "UPDATE tenants SET status = 'disabled', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (?, ?)", args: [tenantA, tenantB] },
      ], "write");
      console.log(JSON.stringify({ testCredentials: "revoked", testTenants: "disabled", testMessages: "cancelled", audit: "retained" }));
    }
  } finally { db.close(); }
}
