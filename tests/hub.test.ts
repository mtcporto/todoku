import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { migrate } from "../src/lib/migrations.ts";
import { createMailSession } from "../src/lib/mail/auth.ts";
import { hashCredential } from "../src/lib/ingestion.ts";
import { provisionConfiguration } from "../src/lib/configurations.ts";
import { bootstrapHubAdministrator } from "../src/lib/hub/administration.ts";
import { hubRequest } from "../src/lib/hub/http.ts";
import { handleEventRequest } from "../src/lib/http.ts";
import { handleEventStatus } from "../src/lib/event-status.ts";
import { runWorker } from "../src/lib/worker.ts";
import { renderManagedTemplate, validateTemplate, commonTemplates } from "../src/lib/hub/templates.ts";

const owner = randomUUID(), stranger = randomUUID();
const token = "h".repeat(43);
async function fixture() {
  const directory = await mkdtemp(join(process.env.TODOKU_TEST_TMPDIR!, "hub-"));
  const db = createClient({ url: `file:${join(directory, "test.db").replaceAll("\\", "/")}` });
  await db.execute("PRAGMA journal_mode=WAL");
  await migrate(db, "migrations");
  await db.batch([
    "INSERT INTO tenants(id) VALUES ('hub-a'),('hub-b')",
    "INSERT INTO applications(tenant_id,id) VALUES ('hub-a','pilot'),('hub-b','pilot')",
    ...[owner, stranger].map((id, index) => ({ sql: "INSERT INTO mail_users(id,username,password_hash) VALUES (?,?,?)", args: [id, `hub-user-${index}`, "unused-fixture"] })),
    { sql: "INSERT INTO application_credentials(tenant_id,application_id,id,token_hash) VALUES ('hub-a','pilot',?,?)", args: [randomUUID(), hashCredential(token)] },
  ], "write");
  const configuration = await provisionConfiguration(db, { tenantId: "hub-a", applicationId: "pilot", mode: "dry_run", senderEmail: "notificacoes@minhanota.app", senderName: "MinhaNota" });
  await bootstrapHubAdministrator(db, "hub-a", owner, owner, true);
  const cookie = (await createMailSession(db, new Request("http://localhost/hub"), owner)).split(";")[0];
  const otherCookie = (await createMailSession(db, new Request("http://localhost/hub"), stranger)).split(";")[0];
  function req(path: string, input?: unknown, selectedCookie = cookie, origin = "http://localhost") {
    return hubRequest(new Request(`http://localhost/api/hub/${path}`, { method: input === undefined ? "GET" : "POST", headers: { cookie: selectedCookie, origin, "content-type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) }), path.split("/"), db);
  }
  const app = "tenants/hub-a/applications/pilot";
  async function adopt() { assert.equal((await req(`${app}/catalog`, { name: "MinhaNota" })).status, 200); }
  function ingest(data: Record<string, unknown> = {}) {
    const payload = { id: randomUUID(), type: "user.welcome", occurredAt: new Date().toISOString(), tenantId: "hub-a", applicationId: "pilot", recipient: { email: "pilot@example.invalid" }, data: { firstName: "Pessoa" }, idempotencyKey: randomUUID(), ...data };
    return { payload, send: () => handleEventRequest(new Request("http://localhost/api/v1/events", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(payload) }), () => db) };
  }
  return { db, req, app, adopt, ingest, configuration, cookie, otherCookie };
}

test("Hub permission is explicit, tenant-scoped, revocable and independent of Mail roles/content", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.req("session", undefined, "")).status, 401);
    assert.equal((await f.req("session", undefined, f.otherCookie)).status, 200);
    assert.equal((await f.req("tenants/hub-a/applications", undefined, f.otherCookie)).status, 403);
    assert.equal((await f.req("tenants/hub-b/applications")).status, 403);
    assert.equal(Number((await f.db.execute("SELECT COUNT(*) AS n FROM mail_identity_grants")).rows[0].n), 0);
    assert.equal(Number((await f.db.execute("SELECT COUNT(*) AS n FROM mail_admin_grants")).rows[0].n), 0);
    assert.equal((await f.req(`${f.app}/catalog`, { name: "MinhaNota" }, f.cookie, "https://evil.invalid")).status, 403);
    await f.db.execute("UPDATE hub_administrators SET status='revoked'");
    assert.equal((await f.req(`${f.app}/catalog`, { name: "MinhaNota" })).status, 403);
    assert.equal((await f.req("tenants/hub-a/applications")).status, 403);
  } finally { f.db.close(); }
});

test("adoption is explicit; common templates start disabled; failures and unknown fields accept no work", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.ingest().send()).status, 202); // legacy behavior
    await f.adopt();
    assert.equal((await f.req(`${f.app}/catalog`, { name: "Again" })).status, 409);
    const disabled = await f.ingest().send();
    assert.equal(disabled.status, 422);
    assert.equal((await disabled.json()).error, "communication_disabled");
    const catalog = await (await f.req(f.app)).json();
    assert.equal(catalog.templates.length, 4);
    assert.ok(catalog.bindings.every((binding: { enabled: number }) => binding.enabled === 0));
    assert.equal((await f.req(`${f.app}/bindings`, { eventType: "user.welcome", templateId: "welcome", templateVersion: 1, enabled: true, extra: true })).status, 422);
    assert.equal((await f.req(`${f.app}/bindings`, { eventType: "user.welcome", templateId: "welcome", templateVersion: 2, enabled: true })).status, 422);
    assert.equal(Number((await f.db.execute("SELECT COUNT(*) AS n FROM events")).rows[0].n), 1);
  } finally { f.db.close(); }
});

test("custom application template freezes version/content for replay, worker dry-run, status and audits", async () => {
  const f = await fixture();
  try {
    await f.adopt();
    const template = { id: "minhanota.welcome", subject: "Boas-vindas ao MinhaNota", body: "Olá, {{firstName}}! Acesse https://minhanota.app para começar.", variables: [{ name: "firstName", type: "text" }] };
    assert.equal((await f.req(`${f.app}/templates`, template)).status, 200);
    assert.equal((await f.req(`${f.app}/bindings`, { eventType: "user.welcome", templateId: template.id, templateVersion: 1, enabled: true })).status, 200);
    const attempt = f.ingest({ data: { firstName: "Pessoa <script>alert(1)</script>" } });
    const accepted = await (await attempt.send()).json();
    assert.equal((await (await attempt.send()).json()).replay, true);
    assert.equal((await f.req(`${f.app}/templates`, { ...template, body: "Versão nova: {{firstName}}" })).status, 200);
    const snapshot = (await f.db.execute("SELECT request_json,template_version FROM message_deliveries")).rows[0];
    assert.equal(snapshot.template_version, "minhanota.welcome@1");
    assert.ok(String(snapshot.request_json).includes("&lt;script&gt;"));
    assert.ok(!String(snapshot.request_json).includes("Versão nova"));
    await f.db.execute("UPDATE outbox_messages SET available_at='2020-01-01T00:00:00Z'");
    const result = await runWorker(f.db, { mode: "dry_run", providerFactory: () => { throw new Error("dry-run must never create a transport"); } });
    assert.deepEqual(result.states, ["dry_run"]);
    const status = await handleEventStatus(new Request("http://localhost/status", { headers: { authorization: `Bearer ${token}` } }), accepted.eventId, () => f.db);
    assert.equal((await status.json()).deliveryState, "dry_run");
    const events = await (await f.req(`${f.app}/events`)).json();
    assert.equal(events.events[0].attempts, 1);
    assert.ok(events.deliveryAudit.some((entry: { action: string }) => entry.action === "dry_run"));
    assert.ok(events.audit.some((entry: { action: string }) => entry.action === "communication.updated"));
    const serialized = JSON.stringify(events);
    for (const secret of ["pilot@example.invalid", "firstName", "request_json", "encrypted_api_key", "token_hash"]) assert.ok(!serialized.includes(secret));
    await assert.rejects(() => f.db.execute("UPDATE hub_administration_audit SET action='tampered'"));
    await assert.rejects(() => f.db.execute("UPDATE hub_templates SET body='tampered'"));
  } finally { f.db.close(); }
});

test("new applications reuse public sender only, cannot move keys or enable delivery, and audit is atomic", async () => {
  const f = await fixture();
  try {
    const input = { id: "next-app", name: "Outro aplicativo", senderConfigurationId: f.configuration.configurationId };
    const rejected = await f.req("tenants/hub-b/applications", input);
    assert.equal(rejected.status, 403);
    assert.equal((await f.req("tenants/hub-a/applications", { ...input, apiKey: "re_not_allowed" })).status, 422);
    const created = await f.req("tenants/hub-a/applications", input);
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    assert.equal(createdBody.token.length, 43);
    const saved = (await f.db.execute("SELECT token_hash FROM application_credentials WHERE application_id='next-app'")).rows[0];
    assert.equal(saved.token_hash, hashCredential(createdBody.token));
    const config = (await f.db.execute("SELECT * FROM provider_configurations WHERE application_id='next-app'")).rows[0];
    assert.equal(config.mode, "dry_run");
    assert.equal(config.encrypted_api_key, null);
    assert.equal(config.encrypted_webhook_secret, null);
    assert.equal(config.domain_verified_at, null);
    assert.equal(config.sender_email, "notificacoes@minhanota.app");
    await f.db.execute("CREATE TRIGGER fail_hub_audit BEFORE INSERT ON hub_administration_audit BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    assert.equal((await f.req("tenants/hub-a/applications", { ...input, id: "rolled-back" })).status, 503);
    assert.equal((await f.db.execute("SELECT 1 FROM applications WHERE id='rolled-back'")).rows.length, 0);
    assert.equal((await f.req("tenants/hub-a/applications")).status, 200);
    const json = await (await f.req("tenants/hub-a/applications")).text();
    for (const field of ["encrypted_", "token_hash", "allowed_recipients", "webhook"]) assert.ok(!json.includes(field));
  } finally { f.db.close(); }
});

test("safe template language escapes markup, validates all variables/URLs and rejects header injection", () => {
  for (const template of commonTemplates) validateTemplate({ id: template.id, subject: template.subject, body: template.body, variables: template.variables });
  const input = { id: "verification", subject: "Olá {{name}}", body: "{{name}}: {{url}}", variables: [{ name: "name", type: "text" as const }, { name: "url", type: "https_url" as const }] };
  assert.throws(() => renderManagedTemplate(input, { name: "Name", url: "javascript:alert(1)" }, 1));
  assert.throws(() => renderManagedTemplate(input, { name: "Injected\r\nBcc: evil", url: "https://example.invalid" }, 1));
  assert.throws(() => renderManagedTemplate(input, { name: "Name", url: "https://user:pass@example.invalid" }, 1));
  assert.throws(() => renderManagedTemplate(input, { name: "Name", url: "https://example.invalid", extra: true }, 1));
  assert.throws(() => validateTemplate({ ...input, body: "{{unknown}}" }));
  const result = renderManagedTemplate(input, { name: "<img src=x onerror=alert(1)>", url: "https://example.invalid/?x=1&y=2" }, 1);
  assert.ok(!result.html.includes("<img"));
  assert.ok(result.html.includes('href="https://example.invalid/?x=1&amp;y=2"'));
});

test("missing additive migration preserves legacy ingestion, while Hub administration fails closed", async () => {
  const f = await fixture();
  try {
    await f.db.execute("DELETE FROM schema_migrations WHERE version='0009_hub_operations'");
    assert.equal((await f.req("session")).status, 503);
    assert.equal((await f.ingest().send()).status, 202);
  } finally { f.db.close(); }
});

test("disabling a communication also blocks already queued work and session revocation blocks writes", async () => {
  const f = await fixture();
  try {
    await f.adopt();
    const binding = { eventType: "user.welcome", templateId: "welcome", templateVersion: 1, enabled: true };
    assert.equal((await f.req(`${f.app}/bindings`, binding)).status, 200);
    assert.equal((await f.ingest().send()).status, 202);
    assert.equal((await f.req(`${f.app}/bindings`, { ...binding, enabled: false })).status, 200);
    await f.db.execute("UPDATE outbox_messages SET available_at='2020-01-01T00:00:00Z'");
    const result = await runWorker(f.db, { mode: "dry_run", providerFactory: () => { throw new Error("must not send"); } });
    assert.deepEqual(result.states, ["manual_review"]);
    assert.equal((await f.db.execute("SELECT last_error_code FROM message_deliveries")).rows[0].last_error_code, "communication_disabled");
    await f.db.execute("UPDATE mail_sessions SET revoked_at='2020-01-01T00:00:00Z'");
    assert.equal((await f.req(`${f.app}/bindings`, binding)).status, 401);
  } finally { f.db.close(); }
});
