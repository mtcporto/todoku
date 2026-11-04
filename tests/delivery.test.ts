import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createClient, type Client } from "@libsql/client";
import { Webhook } from "svix";
import { migrate } from "../src/lib/migrations.ts";
import { hashCredential } from "../src/lib/ingestion.ts";
import { handleEventRequest } from "../src/lib/http.ts";
import { provisionConfiguration, reencryptConfiguration, revokeConfiguration } from "../src/lib/configurations.ts";
import { openSecret, sealSecret, type Keyring } from "../src/lib/secrets.ts";
import { renderTemplate } from "../src/lib/templates.ts";
import { ResendProvider } from "../src/lib/providers.ts";
import { recoverLeases, runWorker } from "../src/lib/worker.ts";
import { handleWebhook } from "../src/lib/webhooks.ts";
import { handleEventStatus } from "../src/lib/event-status.ts";
import { handleWorkerRequest } from "../src/lib/worker-http.ts";
import type { SendInput, SendResult } from "../src/lib/events.ts";

const ring: Keyring = { activeId: "key1", keys: { key1: randomBytes(32).toString("base64"), key2: randomBytes(32).toString("base64") } };
const scope = { tenantId: "a", applicationId: "app" };
const token = "t".repeat(43);
const apiKey = "re_fixture_secret_never_a_real_credential";
const webhookSecret = `whsec_${randomBytes(32).toString("base64")}`;
const providerId = "4fc19898-e355-4b64-9d7f-d68db87657c6";

async function fixture(mode: "dry_run" | "test" = "dry_run") {
  const directory = await mkdtemp(join(process.env.TODOKU_TEST_TMPDIR!, "delivery-"));
  const url = `file:${join(directory, "test.db").replaceAll("\\", "/")}`;
  const db = createClient({ url, timeout: 0 });
  await db.execute("PRAGMA journal_mode = WAL");
  await migrate(db, "migrations");
  await db.batch([
    "INSERT INTO tenants(id) VALUES ('a'), ('b')",
    "INSERT INTO applications(tenant_id, id) VALUES ('a', 'app'), ('b', 'app')",
    { sql: "INSERT INTO application_credentials(tenant_id, application_id, id, token_hash) VALUES ('a', 'app', 'credential', ?)", args: [hashCredential(token)] },
  ], "write");
  const config = await provisionConfiguration(db, { ...scope, mode, senderEmail: "test@example.invalid", senderName: "Todoku",
    ...(mode === "test" ? { apiKey, webhookSecret, allowedRecipients: ["recipient@example.invalid"], verifiedDomain: { id: "domain-test", name: "example.invalid", verifiedAt: new Date().toISOString() } } : {}) }, ring);
  return { db, url, configId: config.configurationId, close: () => db.close() };
}
function payload(changes: Record<string, unknown> = {}) {
  return { id: randomUUID(), type: "user.welcome", occurredAt: new Date().toISOString(), ...scope,
    recipient: { email: "recipient@example.invalid" }, data: { firstName: "Teste <script>" }, idempotencyKey: randomUUID(), ...changes };
}
function req(body: unknown, value = token) {
  return new Request("http://localhost/api/v1/events", { method: "POST", headers: { authorization: `Bearer ${value}`, "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function enqueue(db: Client, data = payload()) {
  const response = await handleEventRequest(req(data), () => db);
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}
const factory = (send: (input: SendInput) => Promise<SendResult>) => () => ({ channel: "email" as const, name: "resend", send });
function signed(type: string, secret = webhookSecret, id = randomUUID(), date = new Date(), emailId = providerId) {
  const raw = JSON.stringify({ type, created_at: date.toISOString(), data: { email_id: emailId } });
  return new Request("http://localhost/webhook", { method: "POST", headers: { "svix-id": id, "svix-timestamp": String(Math.floor(date.getTime() / 1000)), "svix-signature": new Webhook(secret).sign(id, date, raw) }, body: raw });
}

test("AEAD binds secrets to scope, configuration and purpose and supports key rotation", () => {
  const encrypted = sealSecret(apiKey, scope, "config", "api_key", ring);
  assert.ok(!encrypted.includes(apiKey));
  assert.equal(openSecret(encrypted, scope, "config", "api_key", ring), apiKey);
  for (const [s, id, purpose] of [[{ tenantId: "b", applicationId: "app" }, "config", "api_key"], [scope, "other", "api_key"], [scope, "config", "webhook"]] as const) {
    assert.throws(() => openSecret(encrypted, s, id, purpose, ring), /Secret unavailable/);
  }
  const tampered = JSON.parse(encrypted); tampered.tag = randomBytes(16).toString("base64");
  assert.throws(() => openSecret(JSON.stringify(tampered), scope, "config", "api_key", ring));
  const rotated = { ...ring, activeId: "key2" };
  assert.equal(openSecret(encrypted, scope, "config", "api_key", rotated), apiKey);
});

test("templates escape HTML and reject missing, unknown or invalid configuration without accepting work", async () => {
  const f = await fixture();
  try {
    const event = { ...payload(), trafficType: "transactional" as const };
    assert.ok(renderTemplate(event).html.includes("&lt;script&gt;"));
    for (const body of [payload({ type: "unknown.event" }), payload({ data: { wrong: "variable" } }), payload({ trafficType: "marketing" })]) {
      assert.equal((await handleEventRequest(req(body), () => f.db)).status, 422);
    }
    await revokeConfiguration(f.db, scope, f.configId);
    assert.equal((await handleEventRequest(req(payload()), () => f.db)).status, 422);
    assert.equal(Number((await f.db.execute("SELECT count(*) AS n FROM events")).rows[0].n), 0);
  } finally { f.close(); }
});

test("dry-run completes and audits without constructing a transport; status endpoint isolates scopes", async () => {
  const f = await fixture();
  try {
    const accepted = await enqueue(f.db);
    const result = await runWorker(f.db, { providerFactory: () => { throw new Error("must not construct provider"); } });
    assert.deepEqual(result.states, ["dry_run"]);
    const row = (await f.db.execute("SELECT o.status, d.state, d.provider_message_id, a.provider FROM outbox_messages o JOIN message_deliveries d ON d.outbox_id = o.id JOIN delivery_attempts a ON a.outbox_id = o.id")).rows[0];
    assert.deepEqual({ ...row }, { status: "cancelled", state: "dry_run", provider_message_id: null, provider: "dry_run" });
    const status = await handleEventStatus(req({}), accepted.eventId, () => f.db);
    assert.equal((await status.json()).deliveryState, "dry_run");
    assert.equal((await handleEventStatus(req({}), randomUUID(), () => f.db)).status, 404);
    assert.equal((await runWorker(f.db)).processed, 0);
    assert.equal(Number((await f.db.execute("SELECT count(*) AS n FROM delivery_audit_log WHERE action = 'dry_run'")).rows[0].n), 1);
    await assert.rejects(f.db.execute("DELETE FROM delivery_audit_log"));
  } finally { f.close(); }
});

test("real test mode requires scoped allowlist, reserves a one-message budget and stores encrypted BYOK", async () => {
  const f = await fixture("test");
  let calls = 0;
  try {
    assert.equal((await handleEventRequest(req(payload({ recipient: { email: "other@example.invalid" } })), () => f.db)).status, 403);
    await enqueue(f.db); await enqueue(f.db);
    assert.equal((await runWorker(f.db)).processed, 0);
    await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory: factory(async input => {
      assert.ok(input.message.html.includes("&lt;script&gt;")); calls++; return { kind: "accepted", providerMessageId: providerId };
    }) });
    assert.equal(calls, 1);
    const rows = (await f.db.execute("SELECT state FROM message_deliveries ORDER BY state")).rows;
    assert.deepEqual(rows.map(row => row.state), ["manual_review", "sent"]);
    const config = (await f.db.execute("SELECT * FROM provider_configurations")).rows[0];
    assert.equal(config.send_count, 1);
    assert.ok(!JSON.stringify(config).includes(apiKey));
    assert.ok(!JSON.stringify(config).includes(webhookSecret));
  } finally { f.close(); }
});

test("concurrent worker instances claim a message only once", async () => {
  const f = await fixture("test");
  try {
    await enqueue(f.db);
    const results = await Promise.all(Array.from({ length: 5 }, () => new Promise<number>((resolve, reject) => {
      const worker = new Worker(new URL("./helpers/delivery-worker.ts", import.meta.url), { workerData: { url: f.url, configId: f.configId, ring, providerId } });
      let processed = 0;
      worker.on("message", value => { processed = value; }); worker.once("error", reject);
      worker.once("exit", code => code ? reject(new Error(`worker exited ${code}`)) : resolve(processed));
    })));
    assert.equal(results.reduce((sum, n) => sum + n, 0), 1);
    assert.equal(Number((await f.db.execute("SELECT count(*) AS n FROM delivery_attempts")).rows[0].n), 1);
  } finally { f.close(); }
});

test("timeout after provider acceptance retries identical payload and key within the idempotency window", async () => {
  const f = await fixture("test");
  let now = Date.now() + 1000;
  const calls: SendInput[] = [];
  try {
    await enqueue(f.db);
    const providerFactory = factory(async input => {
      calls.push(input);
      return calls.length === 1 ? { kind: "retryable", code: "provider_timeout_or_network", uncertain: true } : { kind: "accepted", providerMessageId: providerId };
    });
    assert.deepEqual((await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory, now: () => now, jitter: () => 0 })).states, ["queued"]);
    now += 31_000;
    assert.deepEqual((await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory, now: () => now })).states, ["sent"]);
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
    assert.equal((await f.db.execute("SELECT send_count FROM provider_configurations")).rows[0].send_count, 1);
  } finally { f.close(); }
});

test("expired leases recover conservatively; a lost lease cannot overwrite the next owner", async () => {
  const f = await fixture("test");
  let now = Date.now() + 1000;
  try {
    await enqueue(f.db);
    const result = await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, now: () => now,
      providerFactory: factory(async () => { now += 121_000; await recoverLeases(f.db, now); return { kind: "accepted", providerMessageId: providerId }; }) });
    assert.deepEqual(result.states, ["lease_lost"]);
    assert.equal((await f.db.execute("SELECT status FROM outbox_messages")).rows[0].status, "retry_wait");
    now += 24 * 60 * 60 * 1000;
    let calls = 0;
    await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, now: () => now, providerFactory: factory(async () => { calls++; return { kind: "accepted", providerMessageId: providerId }; }) });
    assert.equal(calls, 0);
    assert.equal((await f.db.execute("SELECT state FROM message_deliveries")).rows[0].state, "manual_review");
  } finally { f.close(); }
});

test("configuration revocation and encryption failures prevent sending; re-encryption preserves secrets", async () => {
  const f = await fixture("test");
  try {
    await reencryptConfiguration(f.db, scope, f.configId, { ...ring, activeId: "key2" });
    const encrypted = String((await f.db.execute("SELECT encrypted_api_key FROM provider_configurations")).rows[0].encrypted_api_key);
    assert.equal(JSON.parse(encrypted).kid, "key2");
    assert.equal(openSecret(encrypted, scope, f.configId, "api_key", ring), apiKey);
    await enqueue(f.db);
    await revokeConfiguration(f.db, scope, f.configId);
    let calls = 0;
    await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory: factory(async () => { calls++; return { kind: "accepted", providerMessageId: providerId }; }) });
    assert.equal(calls, 0);
    assert.equal((await f.db.execute("SELECT last_error_code FROM message_deliveries")).rows[0].last_error_code, "configuration_revoked");
  } finally { f.close(); }
});

test("Resend adapter uses stable idempotency and sanitizes provider failures and timeouts", async () => {
  const input = { message: { from: "Todoku <test@example.invalid>", to: ["test@example.invalid"], subject: "Teste", text: "Olá", html: "<p>Olá</p>" }, idempotencyKey: "stable-key" };
  for (const status of [200, 429, 500, 409, 422]) {
    const adapter = new ResendProvider(apiKey, async (_url, options) => {
      assert.equal(new Headers(options?.headers).get("idempotency-key"), input.idempotencyKey);
      assert.deepEqual(JSON.parse(String(options?.body)), input.message);
      return Response.json(status === 200 ? { id: providerId } : { message: apiKey }, { status });
    });
    const result = await adapter.send(input);
    assert.equal(result.kind, status === 200 ? "accepted" : status === 429 || status === 500 ? "retryable" : status === 409 ? "review" : "permanent");
    assert.ok(!JSON.stringify(result).includes(apiKey)); assert.ok(!JSON.stringify(adapter).includes(apiKey));
  }
  const timeout = await new ResendProvider(apiKey, async () => { throw new Error(apiKey); }).send(input);
  assert.deepEqual(timeout, { kind: "retryable", code: "provider_timeout_or_network", uncertain: true });
});

test("webhooks verify raw signatures, timestamps and scope; duplicates and out-of-order events are safe", async () => {
  const f = await fixture("test");
  try {
    await enqueue(f.db);
    await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory: factory(async () => ({ kind: "accepted", providerMessageId: providerId })) });
    assert.equal((await handleWebhook(signed("email.delivered", `whsec_${randomBytes(32).toString("base64")}`), f.configId, () => f.db, ring)).status, 401);
    assert.equal((await handleWebhook(signed("email.sent", webhookSecret, randomUUID(), new Date(Date.now() - 600_000)), f.configId, () => f.db, ring)).status, 401);
    const eventId = randomUUID();
    assert.equal((await handleWebhook(signed("email.delivered", webhookSecret, eventId), f.configId, () => f.db, ring)).status, 200);
    const duplicate = await handleWebhook(signed("email.delivered", webhookSecret, eventId), f.configId, () => f.db, ring);
    assert.equal((await duplicate.json()).duplicate, true);
    await handleWebhook(signed("email.sent"), f.configId, () => f.db, ring);
    assert.equal((await f.db.execute("SELECT state FROM message_deliveries")).rows[0].state, "delivered");
    await handleWebhook(signed("email.bounced"), f.configId, () => f.db, ring);
    await handleWebhook(signed("email.complained"), f.configId, () => f.db, ring);
    await handleWebhook(signed("email.delivered"), f.configId, () => f.db, ring);
    assert.equal((await f.db.execute("SELECT state FROM message_deliveries")).rows[0].state, "complained");
    assert.equal((await f.db.execute("SELECT reason FROM recipient_suppressions")).rows[0].reason, "complained");
    assert.equal(Number((await f.db.execute("SELECT count(*) AS n FROM provider_webhook_events")).rows[0].n), 5);
  } finally { f.close(); }
});

test("a webhook arriving before the send receipt is durably stored and reconciled after commit", async () => {
  const f = await fixture("test");
  try {
    await enqueue(f.db);
    await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory: factory(async () => {
      assert.equal((await handleWebhook(signed("email.delivered"), f.configId, () => f.db, ring)).status, 200);
      assert.equal((await f.db.execute("SELECT status FROM provider_webhook_events")).rows[0].status, "received");
      return { kind: "accepted", providerMessageId: providerId };
    }) });
    assert.equal((await f.db.execute("SELECT state FROM message_deliveries")).rows[0].state, "delivered");
    assert.equal((await f.db.execute("SELECT status FROM provider_webhook_events")).rows[0].status, "processed");
  } finally { f.close(); }
});

test("webhook persistence failure returns 503 and does not falsely acknowledge receipt", async () => {
  const f = await fixture("test");
  try {
    await f.db.execute("CREATE TRIGGER fail_webhook BEFORE INSERT ON provider_webhook_events BEGIN SELECT RAISE(ABORT, 'failure'); END");
    assert.equal((await handleWebhook(signed("email.sent"), f.configId, () => f.db, ring)).status, 503);
    assert.equal(Number((await f.db.execute("SELECT count(*) AS n FROM provider_webhook_events")).rows[0].n), 0);
  } finally { f.close(); }
});

test("worker HTTP authentication fails closed and real sends require a separate explicit switch", async () => {
  const previous = process.env.CRON_SECRET;
  try {
    process.env.CRON_SECRET = "w".repeat(43);
    assert.equal((await handleWorkerRequest(new Request("http://localhost"), () => { throw new Error("must not connect"); })).status, 401);
    const previousEnabled = process.env.TODOKU_TEST_SEND_ENABLED;
    process.env.TODOKU_TEST_SEND_ENABLED = "false";
    assert.equal((await handleWorkerRequest(new Request("http://localhost", { method: "POST", headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, body: JSON.stringify({ configurationId: randomUUID() }) }), () => { throw new Error("must not connect"); })).status, 403);
    if (previousEnabled === undefined) delete process.env.TODOKU_TEST_SEND_ENABLED; else process.env.TODOKU_TEST_SEND_ENABLED = previousEnabled;
  } finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});

test("failure persisting provider acceptance leaves a recoverable lease and preserves the same send key", async () => {
  const f = await fixture("test");
  let now = Date.now() + 1000;
  const requests: SendInput[] = [];
  let fail = true;
  const wrapped = new Proxy(f.db, { get(target, name) {
    if (name === "transaction") return async () => {
      const tx = await target.transaction("write");
      return new Proxy(tx, { get(t, key) {
        if (key === "execute") return async (statement: unknown) => {
          const sql = typeof statement === "string" ? statement : (statement as { sql: string }).sql;
          if (fail && sql.startsWith("UPDATE delivery_attempts SET status = ?")) { fail = false; throw new Error("injected persistence failure"); }
          return t.execute(statement as Parameters<typeof t.execute>[0]);
        };
        const value = Reflect.get(t, key); return typeof value === "function" ? value.bind(t) : value;
      } });
    };
    const value = Reflect.get(target, name); return typeof value === "function" ? value.bind(target) : value;
  } });
  const providerFactory = factory(async input => { requests.push(input); return { kind: "accepted", providerMessageId: providerId }; });
  try {
    await enqueue(f.db);
    await assert.rejects(runWorker(wrapped, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory, now: () => now }));
    assert.equal((await f.db.execute("SELECT status FROM outbox_messages")).rows[0].status, "processing");
    now += 121_000; await recoverLeases(f.db, now); now += 31_000;
    assert.deepEqual((await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory, now: () => now })).states, ["sent"]);
    assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
    assert.equal((await f.db.execute("SELECT send_count FROM provider_configurations")).rows[0].send_count, 1);
  } finally { f.close(); }
});

test("decryption failure blocks the transport without exposing the stored secret", async () => {
  const f = await fixture("test");
  try {
    await enqueue(f.db);
    let calls = 0;
    const badRing = { activeId: "different", keys: { different: randomBytes(32).toString("base64") } };
    await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: badRing, providerFactory: factory(async () => { calls++; return { kind: "accepted", providerMessageId: providerId }; }) });
    assert.equal(calls, 0);
    assert.equal((await f.db.execute("SELECT last_error_code FROM message_deliveries")).rows[0].last_error_code, "provider_secret_unavailable");
  } finally { f.close(); }
});

test("permanent failures terminate, exhausted ambiguous attempts require review, and retries are bounded", async () => {
  for (const ambiguous of [false, true]) {
    const f = await fixture("test");
    try {
      await enqueue(f.db); await f.db.execute("UPDATE outbox_messages SET max_attempts = 1");
      const result = await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring,
        providerFactory: factory(async () => ambiguous ? { kind: "retryable", code: "provider_timeout_or_network", uncertain: true } : { kind: "permanent", code: "provider_rejected" }) });
      assert.deepEqual(result.states, [ambiguous ? "manual_review" : "failed"]);
      assert.equal((await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring })).processed, 0);
    } finally { f.close(); }
  }
});

test("a later rejection cannot resolve an earlier ambiguous acceptance", async () => {
  for (const finalKind of ["permanent", "retryable", "accepted"] as const) {
    const f = await fixture("test");
    let now = Date.now() + 1000;
    try {
      await enqueue(f.db);
      await f.db.execute("UPDATE outbox_messages SET max_attempts = 2");
      await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, now: () => now, jitter: () => 0,
        providerFactory: factory(async () => ({ kind: "retryable", code: "provider_timeout_or_network", uncertain: true })) });
      now += 3_600_000;
      const result = await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, now: () => now,
        providerFactory: factory(async () => finalKind === "accepted" ? { kind: "accepted", providerMessageId: providerId }
          : finalKind === "permanent" ? { kind: "permanent", code: "provider_rejected" }
          : { kind: "retryable", code: "provider_rate_limited", uncertain: false }) });
      assert.deepEqual(result.states, [finalKind === "accepted" ? "sent" : "manual_review"]);
      assert.equal((await f.db.execute("SELECT status FROM outbox_messages")).rows[0].status, finalKind === "accepted" ? "sent" : "manual_review");
    } finally { f.close(); }
  }
});

test("a correctly signed webhook for an unrelated email cannot alter another application", async () => {
  const f = await fixture("test");
  try {
    await enqueue(f.db);
    await runWorker(f.db, { mode: "test", configurationId: f.configId, keyring: ring, providerFactory: factory(async () => ({ kind: "accepted", providerMessageId: providerId })) });
    const other = await provisionConfiguration(f.db, { tenantId: "b", applicationId: "app", mode: "test", senderEmail: "test@example.invalid", senderName: "Other",
      apiKey, webhookSecret, allowedRecipients: ["recipient@example.invalid"], verifiedDomain: { id: "domain", name: "example.invalid", verifiedAt: new Date().toISOString() } }, ring);
    assert.equal((await handleWebhook(signed("email.complained"), other.configurationId, () => f.db, ring)).status, 200);
    assert.equal((await f.db.execute("SELECT state FROM message_deliveries")).rows[0].state, "sent");
    assert.equal(Number((await f.db.execute("SELECT count(*) AS n FROM recipient_suppressions")).rows[0].n), 0);
    assert.equal((await f.db.execute("SELECT tenant_id FROM provider_webhook_events")).rows[0].tenant_id, "b");
  } finally { f.close(); }
});
