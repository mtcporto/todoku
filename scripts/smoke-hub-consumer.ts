import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createClient } from "@libsql/client";
import { migrate } from "../src/lib/migrations.ts";
import { hashCredential } from "../src/lib/ingestion.ts";
import { provisionConfiguration } from "../src/lib/configurations.ts";
import { bootstrapHubAdministrator } from "../src/lib/hub/administration.ts";
import { createMailSession } from "../src/lib/mail/auth.ts";
import { hubRequest } from "../src/lib/hub/http.ts";
import { handleEventRequest } from "../src/lib/http.ts";
import { handleEventStatus } from "../src/lib/event-status.ts";
import { runWorker } from "../src/lib/worker.ts";

// Explicitly select a reviewed consumer module; no env file or remote DB is read.
const modulePath = process.argv[2];
if (!modulePath || !process.env.TODOKU_TEST_TMPDIR) throw new Error("Usage: smoke:hub:consumer -- <local minhanota/src/lib/email/todoku.ts>");
const consumer = await import(pathToFileURL(resolve(modulePath)).href);
const root = process.env.TODOKU_TEST_TMPDIR;
const db = createClient({ url: `file:${join(root, "hub.db").replaceAll("\\", "/")}` });
const local = new DatabaseSync(join(root, "consumer.db"));
const token = randomBytes(32).toString("base64url"), user = randomUUID();
const requests: { status: number; replay?: boolean }[] = [];
const server = createServer(async (incoming, outgoing) => {
  try {
    const parts: Buffer[] = [];
    for await (const part of incoming) parts.push(Buffer.from(part));
    const req = new Request(`http://127.0.0.1${incoming.url}`, { method: incoming.method, headers: incoming.headers as Record<string, string>, ...(incoming.method === "POST" ? { body: Buffer.concat(parts) } : {}) });
    const response = incoming.method === "POST" ? await handleEventRequest(req, () => db) : await handleEventStatus(req, new URL(req.url).pathname.split("/").at(-1)!, () => db);
    if (incoming.method === "POST") requests.push({ status: response.status, replay: (await response.clone().json()).replay });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers)); outgoing.end(await response.text());
  } catch { outgoing.writeHead(500); outgoing.end(); }
});
try {
  await migrate(db, "migrations");
  await db.batch([
    "INSERT INTO tenants(id) VALUES ('minhanota-pilot')",
    "INSERT INTO applications(tenant_id,id) VALUES ('minhanota-pilot','minhanota')",
    { sql: "INSERT INTO mail_users(id,username,password_hash) VALUES (?,'pilot-operator','not-a-password')", args: [user] },
    { sql: "INSERT INTO application_credentials(tenant_id,application_id,id,token_hash) VALUES ('minhanota-pilot','minhanota',?,?)", args: [randomUUID(), hashCredential(token)] },
  ], "write");
  await provisionConfiguration(db, { tenantId: "minhanota-pilot", applicationId: "minhanota", mode: "dry_run", senderEmail: "notificacoes@minhanota.app", senderName: "MinhaNota" });
  await bootstrapHubAdministrator(db, "minhanota-pilot", user, user, true);
  const cookie = (await createMailSession(db, new Request("http://localhost"), user)).split(";")[0];
  const path = "tenants/minhanota-pilot/applications/minhanota";
  async function configure(collection: string, payload: unknown) {
    const response = await hubRequest(new Request(`http://localhost/api/hub/${path}/${collection}`, { method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(payload) }), [...path.split("/"), collection], db);
    assert.equal(response.status, 200, await response.text());
  }
  await configure("catalog", { name: "MinhaNota" });
  await configure("templates", { id: "minhanota.welcome", subject: "Boas-vindas ao MinhaNota", body: "Olá, {{firstName}}! Sua conta MinhaNota está pronta. Acesse https://minhanota.app para começar.", variables: [{ name: "firstName", type: "text" }] });
  await configure("bindings", { eventType: "user.welcome", templateId: "minhanota.welcome", templateVersion: 1, enabled: true });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = consumer.configuracaoTodoku({ MINHANOTA_TODOKU_ENABLED: "true", TODOKU_ORIGIN: origin, TODOKU_TENANT_ID: "minhanota-pilot", TODOKU_APPLICATION_ID: "minhanota", TODOKU_APPLICATION_TOKEN: token });
  const sql = async (commands: { sql: string; args?: (string | number | null)[] }[]) => commands.map(command => {
    const statement = local.prepare(command.sql), columns = statement.columns().map(column => column.name);
    if (!columns.length) { statement.run(...(command.args ?? [])); return { cols: [], rows: [] }; }
    return { cols: columns, rows: statement.all(...(command.args ?? [])).map(row => columns.map(column => row[column])) };
  });
  // Simulate a lost acknowledgement AFTER the Hub has committed. Real retry must replay.
  let lost = false;
  const network: typeof fetch = async (url, init) => {
    assert.ok(String(url).startsWith(origin + "/"));
    const response = await fetch(url, init);
    if (!lost) { lost = true; throw new Error("isolated lost acknowledgement"); }
    return response;
  };
  await consumer.boasVindasViaHub(config, "pilot@example.invalid", "Pessoa Teste", sql, network);
  await consumer.boasVindasViaHub(config, "pilot@example.invalid", "Nome Alterado", sql, network);
  assert.deepEqual(requests, [{ status: 202, replay: false }, { status: 202, replay: true }]);
  const saved = local.prepare("SELECT event_id FROM emails_boas_vindas_hub").get();
  const snapshot = (await db.execute("SELECT request_json,template_version FROM message_deliveries")).rows[0];
  assert.equal(snapshot.template_version, "minhanota.welcome@1");
  assert.ok(String(snapshot.request_json).includes("Pessoa Teste"));
  assert.ok(!String(snapshot.request_json).includes("Nome Alterado"));
  assert.equal((await db.execute("SELECT count(*) AS n FROM events")).rows[0].n, 1);
  await db.execute("UPDATE outbox_messages SET available_at='2020-01-01T00:00:00Z'");
  const worker = await runWorker(db, { mode: "dry_run", providerFactory: () => { throw new Error("No Resend transport allowed"); } });
  assert.deepEqual(worker.states, ["dry_run"]);
  const status = await (await fetch(`${origin}/api/v1/events/${saved!.event_id}`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(status.deliveryState, "dry_run");
  assert.equal(status.attempts, 1);
  assert.ok((await db.execute("SELECT 1 FROM delivery_audit_log WHERE action='dry_run'")).rows.length);
  assert.deepEqual((await db.execute("PRAGMA foreign_key_check")).rows, []);
  assert.equal((await db.execute("PRAGMA integrity_check")).rows[0].integrity_check, "ok");
  console.log(JSON.stringify({ consumer: "MinhaNota real welcome module", isolatedDatabases: 2, httpIngestion: true, lostAcknowledgementReplay: true, events: 1, workerAttempts: 1, template: "minhanota.welcome@1", status: "dry_run", audit: true, integrity: "ok", externalEmails: 0, remoteMutations: 0 }));
} finally {
  await new Promise<void>(done => server.close(() => done()));
  db.close(); local.close();
}
