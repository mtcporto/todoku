import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { Webhook } from "svix";
import { migrate } from "../../src/lib/migrations.ts";
import { sealSecret, type Keyring } from "../../src/lib/secrets.ts";
import { passwordHash } from "../../src/lib/mail/auth.ts";
import { hash } from "../../src/lib/mail/common.ts";
import { checkKey, type MailStorage } from "../../src/lib/mail/storage.ts";
import type {
  InboundMessage,
  InboundProvider,
} from "../../src/lib/mail/provider.ts";
import { mailWebhook } from "../../src/lib/mail/inbound.ts";

export const ring: Keyring = {
  activeId: "fixture",
  keys: { fixture: randomBytes(32).toString("base64") },
};
export const secret = `whsec_${randomBytes(32).toString("base64")}`;
export const fixturePassword = "only-an-isolated-test-password";
const storedPassword = passwordHash(fixturePassword);
export class MemoryStorage implements MailStorage {
  readonly durable = false;
  objects = new Map<string, Uint8Array>();
  failPut = false;
  failDelete = false;
  async put(tenant: string, key: string, value: Uint8Array) {
    checkKey(tenant, key);
    if (this.failPut) throw new Error("storage offline");
    this.objects.set(key, value.slice());
  }
  async get(tenant: string, key: string) {
    checkKey(tenant, key);
    const value = this.objects.get(key);
    if (!value) throw new Error("object unavailable");
    return value.slice();
  }
  async delete(tenant: string, key: string) {
    checkKey(tenant, key);
    if (this.failDelete) throw new Error("storage offline");
    this.objects.delete(key);
  }
}
export function message(changes: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: randomUUID(),
    from: "Example <sender@example.invalid>",
    subject: "Uma conversa de teste",
    to: ["inbox@a.example.invalid"],
    received_for: ["inbox@a.example.invalid"],
    cc: [],
    bcc: [],
    html: "<h1>Olá</h1><p>Uma mensagem sintética.</p>",
    text: "Uma mensagem sintética.",
    message_id: `<${randomUUID()}@example.invalid>`,
    headers: {},
    authentication: { dmarc: "pass" },
    raw: { download_url: "https://fixture.cloudfront.net/message" },
    attachments: [
      {
        id: randomUUID(),
        filename: "nota.txt",
        content_type: "text/plain",
        size: 4,
      },
    ],
    ...changes,
  };
}
export function provider(value: InboundMessage): InboundProvider {
  return {
    get: async () => structuredClone(value),
    raw: async () => Buffer.from("From: sender@example.invalid\r\n\r\nFixture"),
    attachment: async () => Buffer.from("test"),
  };
}
export function signed(
  value: InboundMessage,
  options: {
    id?: string;
    secret?: string;
    date?: Date;
    to?: string[];
    envelope?: string[];
  } = {},
) {
  const id = options.id ?? randomUUID(),
    date = options.date ?? new Date();
  const raw = JSON.stringify({
    type: "email.received",
    data: {
      email_id: value.id,
      to: options.to ?? value.to,
      received_for: options.envelope ?? value.received_for,
    },
  });
  return new Request("https://todoku.test/api/webhooks/mail", {
    method: "POST",
    body: raw,
    headers: {
      "svix-id": id,
      "svix-timestamp": String(Math.floor(date.getTime() / 1000)),
      "svix-signature": new Webhook(options.secret ?? secret).sign(
        id,
        date,
        raw,
      ),
    },
  });
}
export async function fixture() {
  const root = await mkdtemp(join(process.env.TODOKU_TEST_TMPDIR!, "mail-"));
  const url = `file:${join(root, "test.db").replaceAll("\\", "/")}`;
  const db = createClient({ url, timeout: 3000 });
  await db.execute("PRAGMA journal_mode=WAL");
  await migrate(db, "migrations");
  const source = randomUUID(),
    otherSource = randomUUID();
  await db.batch(
    [
      "INSERT INTO tenants(id) VALUES ('a'),('b')",
      {
        sql: "INSERT INTO mail_users(id,username,password_hash) VALUES (?,?,?),(?,?,?)",
        args: [
          "alice",
          "alice",
          await storedPassword,
          "bob",
          "bob",
          await storedPassword,
        ],
      },
      ...[
        ["a", source],
        ["b", otherSource],
      ].map(([tenant, id]) => ({
        sql: "INSERT INTO mail_sources(tenant_id,id,provider,status,encrypted_api_key,encrypted_webhook_secret) VALUES (?,?,'fixture','active',?,?)",
        args: [
          tenant,
          id,
          sealSecret(
            "re_fixture",
            { tenantId: tenant, applicationId: "todoku-mail" },
            id,
            "api_key",
            ring,
          ),
          sealSecret(
            secret,
            { tenantId: tenant, applicationId: "todoku-mail" },
            id,
            "webhook",
            ring,
          ),
        ],
      })),
      {
        sql: "INSERT INTO mail_domains(tenant_id,id,source_id,name,status) VALUES ('a','da',?,'a.example.invalid','active'),('b','db',?,'b.example.invalid','active')",
        args: [source, otherSource],
      },
      "INSERT INTO mail_identities(tenant_id,id,domain_id,address,label,status) VALUES ('a','ia','da','inbox@a.example.invalid','Inbox','active'),('a','private','da','private@a.example.invalid','Private','active'),('b','ib','db','inbox@b.example.invalid','Other','active')",
      "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id) VALUES ('a','ia','alice'),('b','ib','bob')",
    ],
    "write",
  );
  const aliceToken = randomBytes(32).toString("base64url"),
    bobToken = randomBytes(32).toString("base64url");
  await db.batch(
    [
      ["alice", aliceToken],
      ["bob", bobToken],
    ].map(([user, token]) => ({
      sql: "INSERT INTO mail_sessions(token_hash,user_id,expires_at) VALUES (?,?,?)",
      args: [hash(token), user, new Date(Date.now() + 3_600_000).toISOString()],
    })),
    "write",
  );
  const storage = new MemoryStorage();
  const request = (
    path: string,
    init: RequestInit = {},
    as: "alice" | "bob" | "none" = "alice",
  ) =>
    new Request(`https://todoku.test/api/mail/${path}`, {
      ...init,
      headers: {
        origin: "https://todoku.test",
        "content-type": "application/json",
        ...(as === "none"
          ? {}
          : {
              cookie: `__Host-todoku_mail=${as === "alice" ? aliceToken : bobToken}`,
            }),
        ...init.headers,
      },
    });
  const enqueue = (value: InboundMessage, src = source) =>
    mailWebhook(signed(value), src, db, {
      enabled: true,
      fixtures: true,
      keyring: ring,
    });
  return {
    db,
    url,
    root,
    source,
    otherSource,
    storage,
    request,
    enqueue,
    close: () => db.close(),
  };
}
