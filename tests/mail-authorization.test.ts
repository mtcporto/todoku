import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { fixture, message, provider, ring } from "./helpers/mail-fixture.ts";
import { mailRequest } from "../src/lib/mail/http.ts";
import { runMailWorker } from "../src/lib/mail/worker.ts";
import { saveDraft, type DraftInput } from "../src/lib/mail/drafts.ts";
import { queueMail, runMailSendWorker } from "../src/lib/mail/send.ts";
import {
  identityGrant,
  messageGrant,
  requireAdministration,
  bootstrapAdministrator,
} from "../src/lib/mail/authorization.ts";
import { sealSecret } from "../src/lib/secrets.ts";
import { migrate } from "../src/lib/migrations.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const draft = (changes: Partial<DraftInput> = {}): DraftInput => ({
  requestId: randomUUID(),
  identityId: "ia",
  to: ["external@example.invalid"],
  cc: [],
  bcc: [],
  subject: "Authorization fixture",
  text: "Private content",
  html: "",
  attachments: [],
  ...changes,
});
const request = (
  f: Fixture,
  path: string,
  as: "alice" | "bob" = "alice",
  input?: unknown,
) =>
  mailRequest(
    f.request(
      path,
      input === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(input) },
      as,
    ),
    path.split("?")[0].split("/"),
    f.db,
    () => f.storage,
  );
async function receive(f: Fixture) {
  const value = message();
  await f.enqueue(value);
  await runMailWorker(f.db, f.storage, {
    enabled: true,
    fixtures: true,
    provider: () => provider(value),
  });
  return (
    await f.db.execute({
      sql: "SELECT id FROM mail_messages WHERE provider_email_id=?",
      args: [value.id],
    })
  ).rows[0].id as string;
}
async function sending(f: Fixture) {
  await f.db.execute(
    "UPDATE mail_identity_grants SET can_send=1,can_manage=1 WHERE user_id='alice'",
  );
  await f.db.execute({
    sql: "INSERT INTO mail_sending_configurations(tenant_id,identity_id,status,encrypted_api_key,recipient_policy,allowed_recipients_json,daily_limit) VALUES ('a','ia','enabled',?,'external','[]',20)",
    args: [
      sealSecret(
        "re_fixture",
        { tenantId: "a", applicationId: "todoku-mail-send" },
        "ia",
        "api_key",
        ring,
      ),
    ],
  });
}
async function share(f: Fixture, read = 0, send = 1, manage = 0) {
  await f.db.execute(
    "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('a','bob')",
  );
  await f.db.execute({
    sql: "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_read,can_send,can_manage) VALUES ('a','ia','bob',?,?,?)",
    args: [read, send, manage],
  });
}

test("administrative scopes never imply content access or message management", async () => {
  const f = await fixture();
  try {
    const id = await receive(f);
    await f.db.execute(
      "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('a','bob')",
    );
    for (const scope of ["organization", "domain", "mailbox"] as const) {
      await f.db.execute({
        sql: "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,domain_id,identity_id) VALUES (?,'a','bob',?,?,?)",
        args: [
          randomUUID(),
          scope,
          scope === "domain" ? "da" : null,
          scope === "mailbox" ? "ia" : null,
        ],
      });
      await requireAdministration(f.db, "bob", "a", { identityId: "ia" });
      await assert.rejects(
        requireAdministration(f.db, "bob", "b"),
        /administration_not_permitted/,
      );
      assert.equal(
        (await (await request(f, "inbox", "bob")).json()).messages.length,
        0,
      );
      assert.equal(
        (await request(f, `messages/${id}?identity=ia`, "bob")).status,
        404,
      );
      const attachment = (
        await f.db.execute(
          "SELECT id FROM mail_attachments WHERE tenant_id='a'",
        )
      ).rows[0];
      assert.equal(
        (await request(f, `attachments/${attachment.id}`, "bob")).status,
        404,
      );
      assert.equal(
        (await request(f, `messages/${id}/trash?identity=ia`, "bob", {}))
          .status,
        404,
      );
      await f.db.execute("DELETE FROM mail_admin_grants WHERE tenant_id='a'");
    }
    // A content manager is not an administrator either.
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_manage=1 WHERE user_id='alice'",
    );
    await assert.rejects(
      requireAdministration(f.db, "alice", "a"),
      /administration_not_permitted/,
    );
  } finally {
    f.close();
  }
});

test("domain and mailbox administrators cannot escape their scope, including within one tenant", async () => {
  const f = await fixture();
  try {
    await f.db.execute({
      sql: "INSERT INTO mail_domains(tenant_id,id,source_id,name,status) VALUES ('a','second',?,'second.example.invalid','disabled')",
      args: [f.source],
    });
    await f.db.execute(
      "INSERT INTO mail_identities(tenant_id,id,domain_id,address,label) VALUES ('a','second-box','second','box@second.example.invalid','Second')",
    );
    await f.db.execute(
      "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,domain_id) VALUES ('domain-admin','a','alice','domain','da')",
    );
    await requireAdministration(f.db, "alice", "a", { domainId: "da" });
    await requireAdministration(f.db, "alice", "a", { identityId: "private" });
    await assert.rejects(
      requireAdministration(f.db, "alice", "a"),
      /administration_not_permitted/,
    );
    await assert.rejects(
      requireAdministration(f.db, "alice", "a", { identityId: "second-box" }),
      /administration_not_permitted/,
    );
    await assert.rejects(
      requireAdministration(f.db, "alice", "a", { domainId: "db" }),
      /not_found/,
    );
    await assert.rejects(
      requireAdministration(f.db, "alice", "a", {
        domainId: "second",
        identityId: "ia",
      }),
      /not_found/,
    );
    await f.db.execute("UPDATE mail_admin_grants SET status='revoked'");
    await f.db.execute(
      "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,identity_id) VALUES ('mailbox-admin','a','alice','mailbox','ia')",
    );
    await requireAdministration(f.db, "alice", "a", { identityId: "ia" });
    await assert.rejects(
      requireAdministration(f.db, "alice", "a", { domainId: "da" }),
      /administration_not_permitted/,
    );
    await assert.rejects(
      requireAdministration(f.db, "alice", "a", { identityId: "private" }),
      /administration_not_permitted/,
    );
    await f.db.execute(
      "UPDATE mail_identities SET status='disabled' WHERE id='ia'",
    );
    await requireAdministration(f.db, "alice", "a", { identityId: "ia" }); // metadata can be managed while disabled
    await f.db.execute("UPDATE mail_admin_grants SET status='revoked'");
    await assert.rejects(
      requireAdministration(f.db, "alice", "a", { identityId: "ia" }),
      /administration_not_permitted/,
    );
    await assert.rejects(
      f.db.execute(
        "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,identity_id) VALUES ('cross-tenant','a','alice','mailbox','ib')",
      ),
    );
  } finally {
    f.close();
  }
});

test("send-only users see their own drafts and sent messages, without reading shared inbox or others' drafts", async () => {
  const f = await fixture();
  try {
    await sending(f);
    await share(f);
    const inbound = await receive(f);
    const alice = await saveDraft(f.db, "alice", f.storage, draft());
    const input = draft({
      attachments: [
        {
          filename: "own.txt",
          contentType: "text/plain",
          content: Buffer.from("own").toString("base64"),
        },
      ],
    });
    const own = await saveDraft(f.db, "bob", f.storage, input);
    assert.equal(
      (
        await f.db.execute({
          sql: "SELECT author_user_id FROM mail_messages WHERE id=?",
          args: [own.id],
        })
      ).rows[0].author_user_id,
      "bob",
    );
    assert.equal((await request(f, `messages/${inbound}`, "bob")).status, 404);
    assert.equal((await request(f, `messages/${alice.id}`, "bob")).status, 404);
    assert.equal((await request(f, `messages/${own.id}`, "alice")).status, 404);
    await assert.rejects(
      saveDraft(
        f.db,
        "bob",
        f.storage,
        { ...input, requestId: alice.id },
        alice.id,
      ),
      /not_found/,
    );
    await assert.rejects(
      queueMail(f.db, "bob", alice.id, "ia", 1, f.storage, true),
      /not_found/,
    );
    await assert.rejects(
      identityGrant(f.db, "bob", "ia", "read"),
      /reading_not_permitted/,
    );
    assert.equal(
      (await request(f, `attachments/${own.attachments[0].id}`, "bob")).status,
      200,
    );
    const listed = await (
      await request(f, "inbox?folder=drafts", "bob")
    ).json();
    assert.deepEqual(
      listed.messages.map((m: { id: string }) => m.id),
      [own.id],
    );
    // A shared conversation must not disclose its inbound parent to a send-only participant.
    const parentThread = (
      await f.db.execute({
        sql: "SELECT thread_id FROM mail_message_recipients WHERE message_id=?",
        args: [inbound],
      })
    ).rows[0].thread_id;
    await f.db.execute({
      sql: "UPDATE mail_message_recipients SET thread_id=? WHERE message_id=?",
      args: [parentThread, own.id],
    });
    const detail = await (await request(f, `messages/${own.id}`, "bob")).json();
    assert.deepEqual(
      detail.thread.map((m: { id: string }) => m.id),
      [own.id],
    );
    await queueMail(f.db, "bob", own.id, "ia", own.version, f.storage, true);
    let transports = 0;
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          provider: () => ({
            send: async () => {
              transports++;
              return { kind: "accepted", id: randomUUID() };
            },
          }),
        })
      ).state,
      "accepted",
    );
    assert.equal(transports, 1);
    assert.equal((await request(f, `messages/${own.id}`, "bob")).status, 200);
    assert.equal(
      (await (await request(f, "inbox?folder=sent", "bob")).json()).messages
        .length,
      1,
    );
    assert.equal(
      (await request(f, `messages/${own.id}/trash?identity=ia`, "bob", {}))
        .status,
      403,
    );
    // Own unsent drafts can be discarded/restored/purged without general management.
    const disposable = await saveDraft(f.db, "bob", f.storage, draft());
    for (const action of ["trash", "restore", "trash", "purge"])
      assert.equal(
        (
          await request(
            f,
            `messages/${disposable.id}/${action}?identity=ia`,
            "bob",
            action === "purge" ? { confirm: true } : {},
          )
        ).status,
        200,
      );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_send=0 WHERE tenant_id='a' AND user_id='bob'",
    );
    assert.equal((await request(f, `messages/${own.id}`, "bob")).status, 404);
  } finally {
    f.close();
  }
});

test("shared mailbox read, send and message management remain independent and revocable in existing sessions", async () => {
  const f = await fixture();
  try {
    const id = await receive(f);
    await share(f, 1, 0, 0);
    assert.equal((await request(f, `messages/${id}`, "bob")).status, 200);
    assert.equal((await request(f, "drafts", "bob", draft())).status, 403);
    assert.equal(
      (await request(f, `messages/${id}/trash?identity=ia`, "bob", {})).status,
      403,
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_manage=1 WHERE tenant_id='a' AND user_id='bob'",
    );
    assert.equal(
      (await request(f, `messages/${id}/trash?identity=ia`, "bob", {})).status,
      200,
    );
    assert.equal(
      (await request(f, `messages/${id}/restore?identity=ia`, "bob", {}))
        .status,
      200,
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_read=0 WHERE tenant_id='a' AND user_id='bob'",
    );
    assert.equal((await request(f, `messages/${id}`, "bob")).status, 404);
    assert.equal(
      (await request(f, `messages/${id}/trash?identity=ia`, "bob", {})).status,
      404,
    );
    await assert.rejects(
      identityGrant(f.db, "bob", "ia", "manage"),
      /management_not_permitted/,
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_read=1 WHERE tenant_id='a' AND user_id='bob'",
    );
    await f.db.execute(
      "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope) VALUES ('admin','a','bob','organization')",
    );
    await f.db.execute(
      "UPDATE mail_memberships SET status='suspended' WHERE tenant_id='a' AND user_id='bob'",
    );
    assert.equal((await request(f, `messages/${id}`, "bob")).status, 404);
    await assert.rejects(
      requireAdministration(f.db, "bob", "a"),
      /administration_not_permitted/,
    );
    // Suspension is scoped: the same login/session still reaches tenant b.
    assert.equal(
      (await (await request(f, "inbox", "bob")).json()).identities[0].id,
      "ib",
    );
    await f.db.execute(
      "UPDATE mail_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id='bob'",
    );
    assert.equal((await request(f, "inbox", "bob")).status, 401);
  } finally {
    f.close();
  }
});

for (const [name, disable, enable] of [
  [
    "mailbox",
    "UPDATE mail_identities SET status='disabled' WHERE id='ia'",
    "UPDATE mail_identities SET status='active' WHERE id='ia'",
  ],
  [
    "domain",
    "UPDATE mail_domains SET status='disabled' WHERE id='da'",
    "UPDATE mail_domains SET status='active' WHERE id='da'",
  ],
  [
    "source",
    "UPDATE mail_sources SET status='disabled' WHERE tenant_id='a'",
    "UPDATE mail_sources SET status='active' WHERE tenant_id='a'",
  ],
  [
    "membership",
    "UPDATE mail_memberships SET status='suspended' WHERE tenant_id='a'",
    "UPDATE mail_memberships SET status='active' WHERE tenant_id='a'",
  ],
  [
    "tenant",
    "UPDATE tenants SET status='disabled' WHERE id='a'",
    "UPDATE tenants SET status='active' WHERE id='a'",
  ],
  [
    "user",
    "UPDATE mail_users SET status='disabled' WHERE id='alice'",
    "UPDATE mail_users SET status='active' WHERE id='alice'",
  ],
] as const)
  test(`${name} deactivation blocks every content API and queued transport`, async () => {
    const f = await fixture();
    try {
      await sending(f);
      const inbound = await receive(f);
      const attachment = String(
        (await f.db.execute("SELECT id FROM mail_attachments")).rows[0].id,
      );
      const own = await saveDraft(f.db, "alice", f.storage, draft());
      await queueMail(f.db, "alice", own.id, "ia", 1, f.storage, true);
      await f.db.execute(disable);
      const inbox = await request(f, "inbox");
      if (name === "user") assert.equal(inbox.status, 401);
      else assert.equal((await inbox.json()).messages.length, 0);
      for (const [path, input] of [
        [`messages/${inbound}`, undefined],
        [`attachments/${attachment}`, undefined],
        [`messages/${inbound}/compose?identity=ia&mode=reply`, undefined],
        [`messages/${inbound}/read?identity=ia`, { read: true }],
        [`messages/${inbound}/trash?identity=ia`, {}],
        [`messages/${inbound}/restore?identity=ia`, {}],
        [`messages/${inbound}/purge?identity=ia`, { confirm: true }],
        [`messages/${own.id}/draft`, draft({ version: 1 })],
        ["drafts", draft()],
      ] as const)
        assert.ok(
          [401, 403, 404].includes(
            (await request(f, path, "alice", input)).status,
          ),
          path,
        );
      await assert.rejects(
        queueMail(f.db, "alice", own.id, "ia", 1, f.storage, true),
      );
      let transports = 0;
      await runMailSendWorker(f.db, f.storage, {
        enabled: true,
        provider: () => {
          transports++;
          throw new Error("must not construct transport");
        },
      });
      assert.equal(transports, 0);
      await f.db.execute(enable);
      assert.equal((await request(f, `messages/${inbound}`)).status, 200);
    } finally {
      f.close();
    }
  });

test("revocations during storage I/O are rechecked before returning content or committing changes", async () => {
  const f = await fixture();
  try {
    await sending(f);
    const inbound = await receive(f);
    const attachment = String(
      (await f.db.execute("SELECT id FROM mail_attachments")).rows[0].id,
    );
    const originalGet = f.storage.get.bind(f.storage);
    f.storage.get = async (tenant, key) => {
      const bytes = await originalGet(tenant, key);
      await f.db.execute(
        "UPDATE mail_identity_grants SET can_read=0 WHERE user_id='alice'",
      );
      return bytes;
    };
    assert.equal((await request(f, `messages/${inbound}`)).status, 404);
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_read=1 WHERE user_id='alice'",
    );
    assert.equal((await request(f, `attachments/${attachment}`)).status, 404);
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_read=1 WHERE user_id='alice'",
    );
    assert.equal(
      (await request(f, `messages/${inbound}/compose?identity=ia&mode=reply`))
        .status,
      404,
    );
    f.storage.get = originalGet;
    const input = draft();
    const saved = await saveDraft(f.db, "alice", f.storage, input);
    const originalPut = f.storage.put.bind(f.storage);
    f.storage.put = async (tenant, key, bytes) => {
      await originalPut(tenant, key, bytes);
      await f.db.execute(
        "UPDATE mail_memberships SET status='suspended' WHERE tenant_id='a'",
      );
    };
    await assert.rejects(
      saveDraft(
        f.db,
        "alice",
        f.storage,
        { ...input, version: 1, subject: "Revoked write" },
        saved.id,
      ),
      /not_found/,
    );
    assert.equal(
      (
        await f.db.execute({
          sql: "SELECT draft_version FROM mail_messages WHERE id=?",
          args: [saved.id],
        })
      ).rows[0].draft_version,
      1,
    );
  } finally {
    f.close();
  }
});

test("queue and worker recheck send revocation after reading the draft from storage", async () => {
  for (const stage of ["queue", "worker"]) {
    const f = await fixture();
    try {
      await sending(f);
      const saved = await saveDraft(f.db, "alice", f.storage, draft());
      if (stage === "worker")
        await queueMail(f.db, "alice", saved.id, "ia", 1, f.storage, true);
      const original = f.storage.get.bind(f.storage);
      f.storage.get = async (tenant, key) => {
        const bytes = await original(tenant, key);
        await f.db.execute(
          "UPDATE mail_identity_grants SET can_send=0 WHERE user_id='alice'",
        );
        return bytes;
      };
      if (stage === "queue") {
        await assert.rejects(
          queueMail(f.db, "alice", saved.id, "ia", 1, f.storage, true),
          /sending_not_permitted/,
        );
        assert.equal(
          (await f.db.execute("SELECT count(*) AS n FROM mail_send_jobs"))
            .rows[0].n,
          0,
        );
      } else {
        let transports = 0;
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          provider: () => {
            transports++;
            throw new Error("unexpected transport");
          },
        });
        assert.equal(transports, 0);
      }
    } finally {
      f.close();
    }
  }
});

test("bootstrap rolls back the administrator assignment if audit persistence fails", async () => {
  const f = await fixture();
  try {
    await f.db.execute(
      "CREATE TRIGGER reject_admin_audit BEFORE INSERT ON mail_administration_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    await assert.rejects(
      bootstrapAdministrator(f.db, "a", "alice", "alice", true),
      /audit unavailable/,
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_admin_grants"))
        .rows[0].n,
      0,
    );
  } finally {
    f.close();
  }
});

test("initial administrator bootstrap is explicit, UUID based, audited and idempotent", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      bootstrapAdministrator(f.db, "a", "alice", "alice", false),
      /explicit_bootstrap_required/,
    );
    await assert.rejects(
      bootstrapAdministrator(f.db, "a", "alice", "bob", true),
      /explicit_bootstrap_required/,
    );
    await assert.rejects(
      bootstrapAdministrator(f.db, "a", "bob", "bob", true),
      /not_found/,
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_admin_grants"))
        .rows[0].n,
      0,
    );
    assert.deepEqual(
      await bootstrapAdministrator(f.db, "a", "alice", "alice", true),
      { created: true, userId: "alice" },
    );
    assert.equal(
      (await bootstrapAdministrator(f.db, "a", "alice", "alice", true)).created,
      false,
    );
    await share(f);
    await assert.rejects(
      bootstrapAdministrator(f.db, "a", "bob", "bob", true),
      /bootstrap_already_initialized/,
    );
    const audit = (
      await f.db.execute("SELECT * FROM mail_administration_audit")
    ).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, "alice");
    assert.equal(audit[0].target_user_id, "alice");
    assert.deepEqual(JSON.parse(String(audit[0].details_json)), {
      scope: "organization",
      method: "explicit_uuid_operator",
    });
    await assert.rejects(
      f.db.execute("DELETE FROM mail_administration_audit"),
      /append-only audit/,
    );
    await assert.rejects(
      f.db.execute("UPDATE mail_administration_audit SET action='changed'"),
      /append-only audit/,
    );
  } finally {
    f.close();
  }
});

test("0007 preserves legacy grants, only infers unambiguous draft authors and defaults new grants to no read", async () => {
  const root = await mkdtemp(
    join(process.env.TODOKU_TEST_TMPDIR!, "authorization-migration-"),
  );
  const { mkdir } = await import("node:fs/promises");
  const directory = join(root, "migrations");
  await mkdir(directory);
  for (const file of (await readdir("migrations")).filter((x) =>
    /^000[1-6]_/.test(x),
  ))
    await copyFile(join("migrations", file), join(directory, file));
  const db = createClient({
    url: "file:" + join(root, "migration.db").replaceAll("\\", "/"),
  });
  try {
    await migrate(db, directory);
    await db.batch(
      [
        "INSERT INTO tenants(id) VALUES ('a')",
        "INSERT INTO mail_users(id,username,password_hash) VALUES ('alice','alice','hash'),('bob','bob','hash')",
        "INSERT INTO mail_sources(tenant_id,id) VALUES ('a','s')",
        "INSERT INTO mail_domains(tenant_id,id,source_id,name) VALUES ('a','d','s','legacy.invalid')",
        "INSERT INTO mail_identities(tenant_id,id,domain_id,address,label) VALUES ('a','one','d','one@legacy.invalid','One'),('a','shared','d','shared@legacy.invalid','Shared'),('a','empty','d','empty@legacy.invalid','Empty')",
        "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_send,can_manage) VALUES ('a','one','alice',1,1),('a','shared','alice',1,0),('a','shared','bob',1,1),('a','empty','alice',0,0)",
        "INSERT INTO mail_objects(tenant_id,id,source_id,object_key,expires_at) VALUES ('a','object','s','private-object','2099-01-01')",
        ...["one", "shared", "empty"].flatMap((id) => [
          `INSERT INTO mail_messages(tenant_id,id,source_id,provider_email_id,sender,subject,preview,authentication,content_object_id,raw_object_id,received_at,expires_at,direction,delivery_status) VALUES ('a','${id}','s','${id}','sender','subject','preview','self','object','object','2026-01-01','2099-01-01','outbound','draft')`,
          `INSERT INTO mail_threads(tenant_id,id,identity_id) VALUES ('a','${id}','${id}')`,
          `INSERT INTO mail_message_recipients(tenant_id,message_id,identity_id,thread_id) VALUES ('a','${id}','${id}','${id}')`,
        ]),
      ],
      "write",
    );
    const before = (
      await db.execute(
        "SELECT * FROM mail_identity_grants ORDER BY identity_id,user_id",
      )
    ).rows;
    assert.deepEqual(await migrate(db, "migrations"), [
      "0007_mail_authorization",
      "0008_mail_users_invitations_sessions",
      "0009_hub_operations",
    ]);
    assert.deepEqual(
      (
        await db.execute(
          "SELECT tenant_id,identity_id,user_id,can_send,can_manage FROM mail_identity_grants ORDER BY identity_id,user_id",
        )
      ).rows,
      before,
    );
    assert.equal(
      (
        await db.execute(
          "SELECT count(*) AS n FROM mail_identity_grants WHERE can_read=1",
        )
      ).rows[0].n,
      4,
    );
    assert.equal(
      (await db.execute("SELECT count(*) AS n FROM mail_memberships")).rows[0]
        .n,
      2,
    );
    assert.equal(
      (await db.execute("SELECT count(*) AS n FROM mail_admin_grants")).rows[0]
        .n,
      0,
    );
    const authors = (
      await db.execute(
        "SELECT id,author_user_id FROM mail_messages ORDER BY id",
      )
    ).rows;
    assert.deepEqual(
      authors.map((x) => [x.id, x.author_user_id]),
      [
        ["empty", null],
        ["one", "alice"],
        ["shared", null],
      ],
    );
    await db.execute(
      "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id) VALUES ('a','one','bob')",
    );
    assert.equal(
      (
        await db.execute(
          "SELECT can_read FROM mail_identity_grants WHERE identity_id='one' AND user_id='bob'",
        )
      ).rows[0].can_read,
      0,
    );
    assert.deepEqual(await migrate(db, "migrations"), []);
    assert.equal((await db.execute("PRAGMA foreign_key_check")).rows.length, 0);
    assert.equal(
      (await db.execute("PRAGMA integrity_check")).rows[0].integrity_check,
      "ok",
    );
  } finally {
    db.close();
  }
});
