import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "../src/lib/migrations.ts";
import { hashCredential } from "../src/lib/ingestion.ts";
import { handleEventRequest, handleHealthRequest } from "../src/lib/http.ts";
import { retryDecision } from "../src/lib/queue-policy.ts";

const tokenA = "a".repeat(43);
const tokenB = "b".repeat(43);
const tokenC = "c".repeat(43);
const migrationDirectory = resolve("migrations");
const testRoot = process.env.TODOKU_TEST_TMPDIR;
if (!testRoot) throw new Error("Use npm test to create and clean up isolated test databases");

function event(changes: Record<string, unknown> = {}) {
  return {
    id: randomUUID(), type: "user.welcome", occurredAt: "2026-11-04T20:00:00Z",
    tenantId: "tenant-a", applicationId: "app", recipient: { email: "test@example.invalid" },
    data: { firstName: "Teste" }, idempotencyKey: randomUUID(), ...changes,
  };
}

function request(payload: unknown, token = tokenA) {
  return new Request("http://localhost/api/v1/events", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function fixture() {
  const directory = await mkdtemp(join(testRoot!, "db-"));
  const url = `file:${join(directory, "test.db").replaceAll("\\", "/")}`;
  const db = createClient({ url, timeout: 0 });
  // Keep local readers from blocking commits (native binding issue):
  // https://github.com/tursodatabase/libsql-client-ts/issues/361
  await db.execute("PRAGMA journal_mode = WAL");
  await migrate(db, migrationDirectory);
  await db.batch([
    "INSERT INTO tenants(id) VALUES ('tenant-a'), ('tenant-b')",
    "INSERT INTO applications(tenant_id, id) VALUES ('tenant-a', 'app'), ('tenant-b', 'app'), ('tenant-a', 'other')",
    ...[["tenant-a", "app", "credential-a", tokenA], ["tenant-b", "app", "credential-b", tokenB], ["tenant-a", "other", "credential-c", tokenC]].map(([tenant, app, id, token]) => ({
      sql: "INSERT INTO application_credentials(tenant_id, application_id, id, token_hash) VALUES (?, ?, ?, ?)",
      args: [tenant, app, id, hashCredential(token)],
    })),
  ], "write");
  return { db, url, async close() { db.close(); } };
}

async function count(db: Client, table: "events" | "outbox_messages" | "audit_log") {
  return Number((await db.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
}

function concurrentRequest(url: string, payload: unknown): Promise<{ status: number; body: { eventId: string; replay: boolean } }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./helpers/concurrent-client.ts", import.meta.url), { workerData: { url, payload, token: tokenA } });
    let response: { status: number; body: { eventId: string; replay: boolean } } | undefined;
    worker.once("message", (value) => { response = value; });
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code === 0 && response) resolve(response); else reject(new Error(`Test client exited with ${code}`)); });
  });
}

test("202 persists event, lane-specific outbox and audit before response; stable canonical replay and conflict", async () => {
  const f = await fixture();
  try {
    const payload = event();
    const first = await handleEventRequest(request(payload), () => f.db);
    assert.equal(first.status, 202);
    const accepted = await first.json();
    assert.equal(accepted.replay, false);
    assert.equal(await count(f.db, "events"), 1);
    assert.equal(await count(f.db, "outbox_messages"), 1);
    assert.equal(await count(f.db, "audit_log"), 1);
    const replay = await handleEventRequest(request({ ...payload, data: { firstName: "Teste" }, trafficType: "transactional" }), () => f.db);
    assert.deepEqual(await replay.json(), { ...accepted, replay: true });
    assert.equal(replay.status, 202);
    const changed = await handleEventRequest(request({ ...payload, data: { firstName: "Outro" } }), () => f.db);
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).error, "idempotency_conflict");
    const reusedId = await handleEventRequest(request({ ...payload, idempotencyKey: randomUUID() }), () => f.db);
    assert.equal(reusedId.status, 409);
    assert.equal((await reusedId.json()).error, "event_id_conflict");
    assert.equal(await count(f.db, "outbox_messages"), 1);
    assert.equal(await count(f.db, "audit_log"), 1);
    const outbox = (await f.db.execute("SELECT traffic_type, status, attempt_count FROM outbox_messages")).rows[0];
    assert.deepEqual({ ...outbox }, { traffic_type: "transactional", status: "pending", attempt_count: 0 });
  } finally { await f.close(); }
});

test("tenant and application come from credential; no cross-scope replay or conflicts", async () => {
  const f = await fixture();
  try {
    const payload = event();
    assert.equal((await handleEventRequest(request(payload, tokenB), () => f.db)).status, 403);
    assert.equal((await handleEventRequest(request(payload, tokenC), () => f.db)).status, 403);
    assert.equal(await count(f.db, "events"), 0);
    assert.equal((await handleEventRequest(request(payload), () => f.db)).status, 202);
    assert.equal((await handleEventRequest(request({ ...payload, tenantId: "tenant-b" }, tokenB), () => f.db)).status, 202);
    assert.equal((await handleEventRequest(request({ ...payload, applicationId: "other" }, tokenC), () => f.db)).status, 202);
    assert.equal(await count(f.db, "events"), 3);
    const stored = await f.db.execute("SELECT token_hash FROM application_credentials");
    assert.ok(stored.rows.every((row) => String(row.token_hash).length === 64 && ![tokenA, tokenB, tokenC].includes(String(row.token_hash))));
  } finally { await f.close(); }
});

test("missing, invalid, revoked, expired or disabled credentials/parents fail closed", async () => {
  const f = await fixture();
  try {
    assert.equal((await handleEventRequest(request(event(), "wrong".repeat(10)), () => f.db)).status, 401);
    assert.equal((await handleEventRequest(new Request("http://localhost", { method: "POST" }), () => f.db)).status, 401);
    for (const sql of [
      "UPDATE application_credentials SET revoked_at = '2026-01-01' WHERE id = 'credential-a'",
      "UPDATE application_credentials SET revoked_at = NULL, expires_at = '2000-01-01' WHERE id = 'credential-a'",
      "UPDATE application_credentials SET expires_at = NULL, scope = 'disabled' WHERE id = 'credential-a'",
      "UPDATE application_credentials SET scope = 'events:write' WHERE id = 'credential-a';",
      "UPDATE applications SET status = 'disabled' WHERE tenant_id = 'tenant-a' AND id = 'app'",
      "UPDATE applications SET status = 'active' WHERE tenant_id = 'tenant-a' AND id = 'app'",
      "UPDATE tenants SET status = 'disabled' WHERE id = 'tenant-a'",
    ]) {
      await f.db.execute(sql);
      if (sql.includes("SET scope = 'events:write'") || sql.includes("SET status = 'active'")) continue;
      assert.equal((await handleEventRequest(request(event()), () => f.db)).status, 401);
    }
    assert.equal(await count(f.db, "events"), 0);
  } finally { await f.close(); }
});

test("simultaneous replays over independent clients create one event and one outbox", async () => {
  const f = await fixture();
  try {
    const payload = event();
    const responses = await Promise.all(Array.from({ length: 8 }, () => concurrentRequest(f.url, payload)));
    assert.deepEqual(responses.map((response) => response.status), Array(8).fill(202));
    const bodies = responses.map((response) => response.body);
    assert.equal(new Set(bodies.map((body) => body.eventId)).size, 1);
    assert.equal(bodies.filter((body) => !body.replay).length, 1);
    assert.equal(await count(f.db, "events"), 1);
    assert.equal(await count(f.db, "outbox_messages"), 1);
    assert.equal(await count(f.db, "audit_log"), 1);
  } finally { await f.close(); }
});

test("simultaneous conflicting payloads resolve to 202 and 409 without duplicate messages", async () => {
  const f = await fixture();
  try {
    const payload = event();
    const responses = await Promise.all([
      concurrentRequest(f.url, payload),
      concurrentRequest(f.url, { ...payload, data: { changed: true } }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
    assert.equal(await count(f.db, "outbox_messages"), 1);
  } finally { await f.close(); }
});

test("outbox/audit persistence failure rolls back all writes and never returns 202", async () => {
  for (const table of ["outbox_messages", "audit_log"]) {
    const f = await fixture();
    try {
      await f.db.execute(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected persistence failure'); END`);
      const payload = event();
      const response = await handleEventRequest(request(payload), () => f.db);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "service_unavailable" });
      for (const name of ["events", "outbox_messages", "audit_log"] as const) assert.equal(await count(f.db, name), 0);
      await f.db.execute("DROP TRIGGER fail_insert");
      assert.equal((await handleEventRequest(request(payload), () => f.db)).status, 202);
    } finally { await f.close(); }
  }
});

test("commit failure and database outage cannot acknowledge acceptance or expose errors", async () => {
  const f = await fixture();
  try {
    const failing = new Proxy(f.db, {
      get(target, prop) {
        if (prop === "transaction") return async () => {
          const tx = await target.transaction("write");
          return new Proxy(tx, { get(t, p) { if (p === "commit") return async () => { throw new Error("secret URL"); }; const value = Reflect.get(t, p); return typeof value === "function" ? value.bind(t) : value; } });
        };
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    assert.equal((await handleEventRequest(request(event()), () => failing)).status, 503);
    assert.equal(await count(f.db, "events"), 0);
    const unavailable = await handleEventRequest(request(event()), () => { throw new Error("secret token"); });
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { error: "service_unavailable" });
    assert.equal((await handleHealthRequest(() => { throw new Error("secret token"); })).status, 503);
  } finally { await f.close(); }
});

test("FKs, traffic constraints, state constraints and append-only audit protect integrity", async () => {
  const f = await fixture();
  try {
    assert.equal((await handleEventRequest(request(event({ trafficType: "marketing" })), () => f.db)).status, 202);
    const row = (await f.db.execute("SELECT id, event_id, traffic_type FROM outbox_messages")).rows[0];
    assert.equal(row.traffic_type, "marketing");
    for (const sql of [
      "UPDATE outbox_messages SET tenant_id = 'tenant-b'",
      "UPDATE outbox_messages SET application_id = 'other'",
      "UPDATE outbox_messages SET traffic_type = 'transactional'",
      "UPDATE outbox_messages SET status = 'unknown'",
      "UPDATE outbox_messages SET attempt_count = 99",
      "UPDATE audit_log SET action = 'event.accepted'",
      "DELETE FROM audit_log",
    ]) await assert.rejects(f.db.execute(sql));
    await assert.rejects(f.db.execute({
      sql: "INSERT INTO delivery_attempts(tenant_id, application_id, id, outbox_id, attempt_number, provider, status) VALUES ('tenant-b', 'app', 'attempt', ?, 1, 'test', 'started')",
      args: [row.id],
    }));
    await assert.rejects(f.db.execute({
      sql: "INSERT INTO provider_webhook_events(tenant_id, application_id, id, provider, provider_event_id, outbox_id, event_type, payload_json) VALUES ('tenant-b', 'app', 'hook', 'test', 'hook-id', ?, 'sent', '{}')",
      args: [row.id],
    }));
    assert.deepEqual((await f.db.execute("PRAGMA foreign_key_check")).rows, []);
  } finally { await f.close(); }
});

test("HTTP guards reject malformed, excessive, unsupported and invalid events without persistence", async () => {
  const f = await fixture();
  try {
    const headers = { authorization: `Bearer ${tokenA}`, "content-type": "application/json" };
    const cases: [Request, number][] = [
      [new Request("http://localhost", { method: "POST", headers, body: "{" }), 400],
      [new Request("http://localhost", { method: "POST", headers: { ...headers, "content-type": "text/plain" }, body: "{}" }), 415],
      [new Request("http://localhost", { method: "POST", headers, body: "x".repeat(32769) }), 413],
      [new Request("http://localhost", { method: "POST", headers: { ...headers, "content-length": "32769" }, body: "{}" }), 413],
      [request(event({ trafficType: "unknown" })), 422],
      [request(event({ recipient: { email: "invalid" } })), 422],
    ];
    for (const [req, expected] of cases) assert.equal((await handleEventRequest(req, () => f.db)).status, expected);
    assert.equal(await count(f.db, "events"), 0);
  } finally { await f.close(); }
});

test("migrations are repeatable and checksummed; health requires applied schema", async () => {
  const f = await fixture();
  const directory = await mkdtemp(join(testRoot!, "migration-"));
  const empty = createClient({ url: ":memory:" });
  try {
    assert.equal((await handleHealthRequest(() => empty)).status, 503);
    assert.deepEqual(await migrate(f.db, migrationDirectory), []);
    const health = await handleHealthRequest(() => f.db);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { service: "todoku", status: "ready", ingestion: "durable", delivery: "disabled" });
    const source = await readFile(join(migrationDirectory, "0001_durable_ingestion.sql"), "utf8");
    await writeFile(join(directory, "0001_durable_ingestion.sql"), `${source}\n-- changed\n`);
    await assert.rejects(migrate(f.db, directory), /checksum mismatch/);
  } finally { empty.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("retry is bounded and ambiguous delivery requires manual review", () => {
  const base = { attempts: 1, maxAttempts: 5, now: 0, jitter: 0 };
  assert.deepEqual(retryDecision({ ...base, outcome: "transient_not_sent" }), { status: "retry_wait", availableAt: "1970-01-01T00:00:30.000Z" });
  assert.deepEqual(retryDecision({ ...base, attempts: 5, outcome: "transient_not_sent" }), { status: "dead" });
  assert.deepEqual(retryDecision({ ...base, outcome: "permanent" }), { status: "dead" });
  assert.deepEqual(retryDecision({ ...base, outcome: "ambiguous" }), { status: "manual_review" });
});
