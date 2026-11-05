import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { Webhook } from "svix";
import {
  fixture,
  message,
  provider,
  ring,
  secret,
} from "./helpers/mail-fixture.ts";
import { mailRequest } from "../src/lib/mail/http.ts";
import {
  saveDraft,
  composeTemplate,
  type DraftInput,
} from "../src/lib/mail/drafts.ts";
import {
  queueMail,
  runMailSendWorker,
  ResendMailSender,
  sendingWebhook,
  type MailSendResult,
} from "../src/lib/mail/send.ts";
import { retainMail, runMailWorker } from "../src/lib/mail/worker.ts";
import { sealSecret, openSecret } from "../src/lib/secrets.ts";
import { validateFile } from "../src/lib/mail/outbound-common.ts";
import {
  sendingPolicySchema,
  updateSendingPolicy,
} from "../src/lib/mail/sending-policy.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

test("legacy MIME reply fallback ignores email-looking display names, comments and Bcc", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const value = message();
    await f.enqueue(value);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(value),
    });
    const row = (await f.db.execute("SELECT * FROM mail_messages")).rows[0],
      objects = (await f.db.execute("SELECT id,object_key FROM mail_objects"))
        .rows;
    const content = String(
        objects.find((x) => x.id === row.content_object_id)!.object_key,
      ),
      raw = String(objects.find((x) => x.id === row.raw_object_id)!.object_key);
    await f.storage.put(
      "a",
      content,
      Buffer.from(JSON.stringify({ text: "legacy", html: "" })),
    );
    await f.storage.put(
      "a",
      raw,
      Buffer.from(
        'To: "fake@evil.invalid, Name" <visible@example.invalid>, inbox@a.example.invalid\r\nCc: carbon@example.invalid (comment@evil.invalid)\r\nReply-To: reply@example.invalid\r\nBcc: hidden@example.invalid\r\nReferences: <previous@example.invalid>\r\n\r\nPrivate body',
      ),
    );
    const reply = await composeTemplate(
      f.db,
      "alice",
      String(row.id),
      "ia",
      "reply-all",
      f.storage,
    );
    assert.deepEqual(reply.to, ["reply@example.invalid"]);
    assert.deepEqual(reply.cc, [
      "visible@example.invalid",
      "carbon@example.invalid",
    ]);
    assert.deepEqual(reply.bcc, []);
  } finally {
    f.close();
  }
});

test("independent outbound workers claim one job and invoke the fake transport exactly once", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await queued(f);
    let calls = 0;
    const providerId = randomUUID();
    const start = () =>
      new Promise<void>((resolve, reject) => {
        const worker = new Worker(
          new URL("./helpers/mail-send-worker.ts", import.meta.url),
          {
            workerData: {
              url: f.url,
              objects: [...f.storage.objects],
              providerId,
            },
          },
        );
        worker.on("message", (value) => {
          if (value.called) calls++;
        });
        worker.on("error", reject);
        worker.on("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("worker failed")),
        );
      });
    await Promise.all([start(), start()]);
    assert.equal(calls, 1);
    assert.equal(
      (await f.db.execute("SELECT attempts,state FROM mail_send_jobs")).rows[0]
        .state,
      "accepted",
    );
  } finally {
    f.close();
  }
});

test("provider receipt persistence failure preserves the lease and retries the identical provider key", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await queued(f);
    let now = Date.now();
    const keys: string[] = [],
      providerId = randomUUID();
    const adapter = {
      send: async (_payload: unknown, key: string): Promise<MailSendResult> => {
        keys.push(key);
        return { kind: "accepted", id: providerId };
      },
    };
    await f.db.execute(
      "CREATE TRIGGER reject_receipt BEFORE UPDATE ON mail_send_jobs WHEN NEW.state='accepted' BEGIN SELECT RAISE(ABORT,'test persistence failure'); END",
    );
    await assert.rejects(
      runMailSendWorker(f.db, f.storage, {
        enabled: true,
        now: () => now,
        provider: () => adapter,
      }),
    );
    assert.equal(
      (await f.db.execute("SELECT state FROM mail_send_jobs")).rows[0].state,
      "sending",
    );
    await f.db.execute("DROP TRIGGER reject_receipt");
    now += 400000;
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          now: () => now,
          provider: () => adapter,
        })
      ).state,
      "accepted",
    );
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  } finally {
    f.close();
  }
});

test("sending webhook rejects missing signatures, disabled processing and unrelated provider IDs", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await queued(f);
    const request = () =>
      new Request("https://todoku.test/api/webhooks/mail/sending/ia", {
        method: "POST",
        body: "{}",
      });
    assert.equal(
      (
        await sendingWebhook(request(), "ia", f.db, {
          enabled: false,
          keyring: ring,
        })
      ).status,
      503,
    );
    assert.equal(
      (
        await sendingWebhook(request(), "ia", f.db, {
          enabled: true,
          keyring: ring,
        })
      ).status,
      401,
    );
    const id = randomUUID(),
      svixId = randomUUID();
    assert.equal((await event(f, id, "email.bounced", svixId)).status, 200);
    assert.equal((await event(f, id, "email.bounced", svixId)).status, 200);
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_send_events")).rows[0]
        .n,
      1,
    );
    assert.equal(
      (await f.db.execute("SELECT delivery_status FROM mail_messages")).rows[0]
        .delivery_status,
      "queued",
    );
  } finally {
    f.close();
  }
});
const draft = (changes: Partial<DraftInput> = {}): DraftInput => ({
  requestId: randomUUID(),
  identityId: "ia",
  to: ["external@example.invalid"],
  cc: [],
  bcc: [],
  subject: "Teste sintético",
  text: "Conteúdo privado",
  html: "",
  attachments: [],
  ...changes,
});
const post = (
  f: Fixture,
  path: string,
  input: unknown,
  as: "alice" | "bob" | "none" = "alice",
) =>
  mailRequest(
    f.request(path, { method: "POST", body: JSON.stringify(input) }, as),
    path.split("?")[0].split("/"),
    f.db,
    () => f.storage,
  );
async function prepare(f: Fixture) {
  await f.db.execute(
    "UPDATE mail_identity_grants SET can_send=1,can_manage=1 WHERE user_id='alice'",
  );
  const scope = { tenantId: "a", applicationId: "todoku-mail-send" };
  await f.db.execute({
    sql: "INSERT INTO mail_sending_configurations(tenant_id,identity_id,status,encrypted_api_key,encrypted_webhook_secret,allowed_recipients_json) VALUES ('a','ia','enabled',?,?,?)",
    args: [
      sealSecret("re_fake_sending_only", scope, "ia", "api_key", ring),
      sealSecret(secret, scope, "ia", "webhook", ring),
      JSON.stringify(["external@example.invalid", "hidden@example.invalid"]),
    ],
  });
}
async function queued(f: Fixture, changes: Partial<DraftInput> = {}) {
  const saved = await saveDraft(f.db, "alice", f.storage, draft(changes));
  await queueMail(
    f.db,
    "alice",
    saved.id,
    "ia",
    saved.version,
    f.storage,
    true,
  );
  return saved;
}
async function event(
  f: Fixture,
  providerId: string,
  type = "email.delivered",
  id = randomUUID(),
  rfc = "<outbound@example.invalid>",
) {
  const raw = JSON.stringify({
      type,
      data: { email_id: providerId, message_id: rfc },
    }),
    date = new Date();
  return sendingWebhook(
    new Request("https://todoku.test/api/webhooks/mail/sending/ia", {
      method: "POST",
      body: raw,
      headers: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(date.getTime() / 1000)),
        "svix-signature": new Webhook(secret).sign(id, date, raw),
      },
    }),
    "ia",
    f.db,
    { enabled: true, keyring: ring },
  );
}

test("outbound requires explicit send/manage grants, authentication, same origin and identity scope", async () => {
  const f = await fixture();
  try {
    assert.equal((await post(f, "drafts", draft(), "none")).status, 401);
    assert.equal((await post(f, "drafts", draft())).status, 403);
    await prepare(f);
    assert.equal(
      (await post(f, "drafts", draft({ identityId: "ib" }))).status,
      404,
    );
    assert.equal(
      (await post(f, "drafts", draft({ identityId: "private" }))).status,
      404,
    );
    const request = f.request("drafts", {
      method: "POST",
      body: JSON.stringify(draft()),
      headers: { origin: "https://evil.invalid" },
    });
    assert.equal(
      (await mailRequest(request, ["drafts"], f.db, () => f.storage)).status,
      403,
    );
    const saved = await saveDraft(f.db, "alice", f.storage, draft());
    assert.equal(
      (await post(f, `messages/${saved.id}/trash?identity=ia`, {}, "bob"))
        .status,
      404,
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_manage=0 WHERE user_id='alice'",
    );
    assert.equal(
      (await post(f, `messages/${saved.id}/trash?identity=ia`, {})).status,
      200, // Authors may discard their own draft without managing mailbox messages.
    );
  } finally {
    f.close();
  }
});

test("drafts sanitize HTML, persist privately, retry idempotently, enforce versions and preserve failed saves", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const input = draft({
      html: '<p>Seguro</p><script>alert(1)</script><img src="https://evil.invalid/track">',
      attachments: [
        {
          filename: "nota.txt",
          contentType: "text/plain",
          content: Buffer.from("anexo").toString("base64"),
        },
      ],
    });
    const saved = await saveDraft(f.db, "alice", f.storage, input);
    assert.deepEqual(await saveDraft(f.db, "alice", f.storage, input), saved);
    const detail = await (
      await mailRequest(
        f.request(`messages/${saved.id}?identity=ia`),
        ["messages", saved.id],
        f.db,
        () => f.storage,
      )
    ).json();
    assert.ok(!detail.html.includes("script") && !detail.html.includes("img"));
    assert.equal(detail.text, input.text);
    assert.equal(detail.folder, "drafts");
    assert.equal(detail.attachments.length, 1);
    const update = {
      ...input,
      version: 1,
      subject: "Atualizado",
      attachments: saved.attachments.map((x) => ({ existingId: String(x.id) })),
    };
    assert.equal(
      (await saveDraft(f.db, "alice", f.storage, update, saved.id)).version,
      2,
    );
    await assert.rejects(
      saveDraft(
        f.db,
        "alice",
        f.storage,
        { ...input, version: 1, subject: "Conflito" },
        saved.id,
      ),
      /draft_conflict/,
    );
    f.storage.failPut = true;
    await assert.rejects(
      saveDraft(
        f.db,
        "alice",
        f.storage,
        { ...input, version: 2, subject: "Falha" },
        saved.id,
      ),
    );
    assert.equal(
      (
        await f.db.execute({
          sql: "SELECT subject,draft_version FROM mail_messages WHERE id=?",
          args: [saved.id],
        })
      ).rows[0].subject,
      "Atualizado",
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_messages")).rows[0].n,
      1,
    );
    assert.ok(
      (await f.db.execute("SELECT id FROM mail_objects WHERE state='staged'"))
        .rows.length,
    );
  } finally {
    f.close();
  }
});

test("files, recipients and reply contexts reject invalid input without publishing a draft", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    assert.throws(
      () => validateFile("evil.pdf", "application/pdf", Buffer.from("not pdf")),
      /attachment_type_mismatch/,
    );
    assert.throws(
      () =>
        validateFile("evil.exe", "application/octet-stream", Buffer.from("MZ")),
      /unsupported_attachment/,
    );
    assert.throws(
      () => validateFile("note.txt", "text/plain", Buffer.from([0])),
      /attachment_type_mismatch/,
    );
    await assert.rejects(
      saveDraft(
        f.db,
        "alice",
        f.storage,
        draft({
          to: Array.from({ length: 10 }, (_, i) => `u${i}@example.invalid`),
          cc: ["more@example.invalid"],
        }),
      ),
      /too_many_recipients/,
    );
    await assert.rejects(
      saveDraft(
        f.db,
        "alice",
        f.storage,
        draft({
          attachments: [
            { filename: "x.txt", contentType: "text/plain", content: "%%%" },
          ],
        }),
      ),
      /invalid_attachment/,
    );
    const saved = await saveDraft(f.db, "alice", f.storage, draft());
    await assert.rejects(
      saveDraft(
        f.db,
        "alice",
        f.storage,
        draft({ version: 1, reply: { messageId: saved.id, mode: "reply" } }),
        saved.id,
      ),
      /reply_context_changed/,
    );
  } finally {
    f.close();
  }
});

test("reply-all uses Reply-To, excludes owned identities and inbound Bcc, and preserves RFC threading", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const inbound = message({
      to: ["inbox@a.example.invalid", "visible@example.invalid"],
      cc: ["carbon@example.invalid"],
      bcc: ["hidden@example.invalid"],
      reply_to: ["reply@example.invalid"],
      headers: { references: "<previous@example.invalid>" },
    });
    await f.enqueue(inbound);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(inbound),
    });
    const row = (await f.db.execute("SELECT * FROM mail_messages")).rows[0];
    const template = await composeTemplate(
      f.db,
      "alice",
      String(row.id),
      "ia",
      "reply-all",
      f.storage,
    );
    assert.deepEqual(template.to, ["reply@example.invalid"]);
    assert.deepEqual(template.cc, [
      "visible@example.invalid",
      "carbon@example.invalid",
    ]);
    assert.deepEqual(template.bcc, []);
    const saved = await saveDraft(
      f.db,
      "alice",
      f.storage,
      draft({ ...template, attachments: [] }),
    );
    const object = (
      await f.db.execute({
        sql: "SELECT o.object_key,r.thread_id FROM mail_messages m JOIN mail_objects o ON o.id=m.content_object_id JOIN mail_message_recipients r ON r.message_id=m.id WHERE m.id=?",
        args: [saved.id],
      })
    ).rows[0];
    const content = JSON.parse(
      Buffer.from(
        await f.storage.get("a", String(object.object_key)),
      ).toString(),
    );
    assert.equal(content.headers["In-Reply-To"], inbound.message_id);
    assert.ok(
      content.headers.References.includes("<previous@example.invalid>"),
    );
    assert.equal(
      object.thread_id,
      (
        await f.db.execute({
          sql: "SELECT thread_id FROM mail_message_recipients WHERE message_id=?",
          args: [row.id],
        })
      ).rows[0].thread_id,
    );
    const forward = await composeTemplate(
      f.db,
      "alice",
      String(row.id),
      "ia",
      "forward",
      f.storage,
    );
    assert.deepEqual(forward.to, []);
    assert.equal(forward.attachments.length, 1);
    const forbidden = await post(
      f,
      "drafts",
      draft({
        attachments: [
          { existingId: forward.attachments[0].existingId as string },
        ],
      }),
    );
    assert.equal(forbidden.status, 403);
  } finally {
    f.close();
  }
});

test("disabled sending never calls provider; queue requires allowlist and deduplicates retries", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const saved = await saveDraft(f.db, "alice", f.storage, draft());
    await assert.rejects(
      queueMail(f.db, "alice", saved.id, "ia", 1, f.storage, false),
      /sending_disabled/,
    );
    const result = await runMailSendWorker(f.db, f.storage, {
      enabled: false,
      provider: () => {
        throw new Error("must not access provider");
      },
    });
    assert.equal(result.state, "sending_disabled");
    await f.db.execute(
      "UPDATE mail_sending_configurations SET allowed_recipients_json='[]'",
    );
    await assert.rejects(
      queueMail(f.db, "alice", saved.id, "ia", 1, f.storage, true),
      /recipient_not_allowed/,
    );
    await f.db.execute({
      sql: "UPDATE mail_sending_configurations SET allowed_recipients_json=?",
      args: [JSON.stringify(["external@example.invalid"])],
    });
    await queueMail(f.db, "alice", saved.id, "ia", 1, f.storage, true);
    assert.equal(
      (await queueMail(f.db, "alice", saved.id, "ia", 1, f.storage, true))
        .duplicate,
      true,
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_send_jobs")).rows[0]
        .n,
      1,
    );
    assert.equal(
      (await post(f, `messages/${saved.id}/trash?identity=ia`, {})).status,
      409,
    );
    await assert.rejects(
      saveDraft(f.db, "alice", f.storage, draft({ version: 1 }), saved.id),
      /draft_locked/,
    );
  } finally {
    f.close();
  }
});

test("external recipient policy allows To/Cc/Bcc and multiple messages while preserving idempotency and credentials", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const before = (
      await f.db.execute("SELECT * FROM mail_sending_configurations")
    ).rows[0];
    assert.equal(before.recipient_policy, "allowlist");
    const policy = {
      recipientPolicy: "external" as const,
      allowedRecipients: [],
      dailyLimit: 20,
    };
    assert.equal(
      (await updateSendingPolicy(f.db, "a", "ia", policy)).changed,
      true,
    );
    assert.equal(
      (await updateSendingPolicy(f.db, "a", "ia", policy)).changed,
      false,
    );
    const after = (
      await f.db.execute("SELECT * FROM mail_sending_configurations")
    ).rows[0];
    assert.equal(after.encrypted_api_key, before.encrypted_api_key);
    assert.equal(
      after.encrypted_webhook_secret,
      before.encrypted_webhook_secret,
    );
    assert.equal(after.status, "enabled");
    const first = await queued(f, {
      to: ["new@outside.invalid"],
      cc: ["copy@outside.invalid"],
      bcc: ["blind@outside.invalid"],
    });
    assert.equal(
      (
        await queueMail(
          f.db,
          "alice",
          first.id,
          "ia",
          first.version,
          f.storage,
          true,
        )
      ).duplicate,
      true,
    );
    let calls = 0;
    const adapter = () => ({
      send: async (payload: {
        to: string[];
        cc?: string[];
        bcc?: string[];
      }) => {
        calls++;
        assert.deepEqual(payload.to, ["new@outside.invalid"]);
        assert.deepEqual(payload.cc, ["copy@outside.invalid"]);
        assert.deepEqual(payload.bcc, ["blind@outside.invalid"]);
        return { kind: "accepted" as const, id: randomUUID() };
      },
    });
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          provider: adapter,
        })
      ).state,
      "accepted",
    );
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          provider: adapter,
        })
      ).processed,
      0,
    );
    await queued(f, { to: ["another@outside.invalid"] });
    assert.equal(calls, 1);
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_send_jobs")).rows[0]
        .n,
      2,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_audit_log WHERE action='sending_policy_changed'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    f.close();
  }
});

test("operational daily quota remains atomic, scoped and retry-safe with external recipients", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await updateSendingPolicy(f.db, "a", "ia", {
      recipientPolicy: "external",
      allowedRecipients: [],
      dailyLimit: 2,
    });
    const first = await queued(f);
    const drafts = [
      await saveDraft(f.db, "alice", f.storage, draft()),
      await saveDraft(f.db, "alice", f.storage, draft()),
    ];
    const attempts = await Promise.all(
      drafts.map(
        (x) =>
          new Promise<{ queued: boolean; error?: string }>(
            (resolve, reject) => {
              const worker = new Worker(
                new URL("./helpers/mail-queue-worker.ts", import.meta.url),
                {
                  workerData: {
                    url: f.url,
                    id: x.id,
                    version: x.version,
                    objects: f.storage.objects,
                  },
                },
              );
              let result: { queued: boolean; error?: string };
              worker.on("message", (value) => {
                result = value;
              });
              worker.once("error", reject);
              worker.once("exit", (code) =>
                code
                  ? reject(new Error(`worker exited ${code}`))
                  : resolve(result),
              );
            },
          ),
      ),
    );
    assert.equal(attempts.filter((x) => x.queued).length, 1);
    assert.equal(attempts.find((x) => !x.queued)?.error, "send_quota");
    assert.equal(
      (
        await queueMail(
          f.db,
          "alice",
          first.id,
          "ia",
          first.version,
          f.storage,
          true,
        )
      ).duplicate,
      true,
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_send_jobs")).rows[0]
        .n,
      2,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_messages WHERE delivery_status='draft'",
        )
      ).rows[0].n,
      1,
    );
    await f.db.execute(
      "UPDATE mail_send_jobs SET created_at='2000-01-01T00:00:00Z'",
    );
    await f.db.execute("DELETE FROM mail_action_limits");
    await queued(f);
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_send_jobs")).rows[0]
        .n,
      3,
    );
  } finally {
    f.close();
  }
});

test("external sending retains burst and recipient limits", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await updateSendingPolicy(f.db, "a", "ia", {
      recipientPolicy: "external",
      allowedRecipients: [],
      dailyLimit: 20,
    });
    for (let i = 0; i < 5; i++) await queued(f);
    const saved = await saveDraft(f.db, "alice", f.storage, draft());
    await assert.rejects(
      queueMail(f.db, "alice", saved.id, "ia", saved.version, f.storage, true),
      /mail_rate_limited/,
    );
    await assert.rejects(
      saveDraft(
        f.db,
        "alice",
        f.storage,
        draft({
          to: Array.from(
            { length: 11 },
            (_, i) => `person${i}@outside.invalid`,
          ),
        }),
      ),
      /too_many_recipients/,
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_send_jobs")).rows[0]
        .n,
      5,
    );
  } finally {
    f.close();
  }
});

test("external policy preserves authentication, grants, tenant isolation and worker revocation checks", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await updateSendingPolicy(f.db, "a", "ia", {
      recipientPolicy: "external",
      allowedRecipients: [],
      dailyLimit: 20,
    });
    assert.equal((await post(f, "drafts", draft(), "none")).status, 401);
    assert.equal(
      (await post(f, "drafts", draft({ identityId: "ib" }))).status,
      404,
    );
    const saved = await queued(f, { to: ["outside@other.invalid"] });
    await assert.rejects(
      queueMail(f.db, "bob", saved.id, "ia", saved.version, f.storage, true),
      /not_found/,
    );
    await assert.rejects(
      updateSendingPolicy(f.db, "b", "ia", {
        recipientPolicy: "external",
        allowedRecipients: [],
        dailyLimit: 20,
      }),
      /sending_not_configured/,
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_send=0 WHERE user_id='alice'",
    );
    let calls = 0;
    const result = await runMailSendWorker(f.db, f.storage, {
      enabled: true,
      provider: () => ({
        send: async () => {
          calls++;
          return { kind: "accepted", id: randomUUID() };
        },
      }),
    });
    assert.equal(result.state, "failed");
    assert.equal(calls, 0);
    assert.equal(
      (await f.db.execute("SELECT last_error_code FROM mail_send_jobs")).rows[0]
        .last_error_code,
      "sending_not_permitted",
    );
  } finally {
    f.close();
  }
});

test("external worker still rejects a stored envelope above the recipient limit before transport", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await updateSendingPolicy(f.db, "a", "ia", {
      recipientPolicy: "external",
      allowedRecipients: [],
      dailyLimit: 20,
    });
    const saved = await queued(f);
    const object = (
      await f.db.execute({
        sql: "SELECT o.object_key FROM mail_messages m JOIN mail_objects o ON o.tenant_id=m.tenant_id AND o.id=m.content_object_id WHERE m.id=?",
        args: [saved.id],
      })
    ).rows[0];
    const key = String(object.object_key);
    const content = JSON.parse(
      Buffer.from(await f.storage.get("a", key)).toString("utf8"),
    );
    content.envelope.to = Array.from(
      { length: 11 },
      (_, i) => `person${i}@outside.invalid`,
    );
    await f.storage.put("a", key, Buffer.from(JSON.stringify(content)));
    let calls = 0;
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          provider: () => ({
            send: async () => {
              calls++;
              return { kind: "accepted", id: randomUUID() };
            },
          }),
        })
      ).state,
      "failed",
    );
    assert.equal(calls, 0);
    assert.equal(
      (await f.db.execute("SELECT last_error_code FROM mail_send_jobs")).rows[0]
        .last_error_code,
      "too_many_recipients",
    );
  } finally {
    f.close();
  }
});

test("worker rechecks recipient policy after queuing and policy updates are validated and audited atomically", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    for (const bad of [
      { recipientPolicy: "external", allowedRecipients: [], dailyLimit: 0 },
      { recipientPolicy: "external", allowedRecipients: [], dailyLimit: 101 },
      {
        recipientPolicy: "external",
        allowedRecipients: ["someone@outside.invalid"],
        dailyLimit: 20,
      },
      { recipientPolicy: "allowlist", allowedRecipients: [], dailyLimit: 20 },
      { recipientPolicy: "unknown", allowedRecipients: [], dailyLimit: 20 },
    ])
      assert.equal(sendingPolicySchema.safeParse(bad).success, false);
    await assert.rejects(
      f.db.execute(
        "UPDATE mail_sending_configurations SET recipient_policy='unknown'",
      ),
    );
    await updateSendingPolicy(f.db, "a", "ia", {
      recipientPolicy: "external",
      allowedRecipients: [],
      dailyLimit: 20,
    });
    await queued(f, { to: ["outside@other.invalid"] });
    await updateSendingPolicy(f.db, "a", "ia", {
      recipientPolicy: "allowlist",
      allowedRecipients: ["limited@outside.invalid"],
      dailyLimit: 20,
    });
    let calls = 0;
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          provider: () => ({
            send: async () => {
              calls++;
              return { kind: "accepted", id: randomUUID() };
            },
          }),
        })
      ).state,
      "failed",
    );
    assert.equal(calls, 0);
    const before = (
      await f.db.execute(
        "SELECT recipient_policy,daily_limit FROM mail_sending_configurations",
      )
    ).rows[0];
    await f.db.execute(
      "CREATE TRIGGER fail_policy_audit BEFORE INSERT ON mail_audit_log WHEN NEW.action='sending_policy_changed' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    await assert.rejects(
      updateSendingPolicy(f.db, "a", "ia", {
        recipientPolicy: "external",
        allowedRecipients: [],
        dailyLimit: 50,
      }),
    );
    assert.deepEqual(
      (
        await f.db.execute(
          "SELECT recipient_policy,daily_limit FROM mail_sending_configurations",
        )
      ).rows[0],
      before,
    );
  } finally {
    f.close();
  }
});

test("sending keys are separately encrypted, early signed events reconcile and outbound RFC IDs thread inbound replies", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const saved = await queued(f, { bcc: ["hidden@example.invalid"] }),
      providerId = randomUUID();
    const configuration = (
      await f.db.execute("SELECT * FROM mail_sending_configurations")
    ).rows[0];
    assert.equal(
      openSecret(
        String(configuration.encrypted_api_key),
        { tenantId: "a", applicationId: "todoku-mail-send" },
        "ia",
        "api_key",
        ring,
      ),
      "re_fake_sending_only",
    );
    assert.throws(() =>
      openSecret(
        String(configuration.encrypted_api_key),
        { tenantId: "a", applicationId: "todoku-mail" },
        f.source,
        "api_key",
        ring,
      ),
    );
    assert.equal((await event(f, providerId)).status, 200);
    const result = await runMailSendWorker(f.db, f.storage, {
      enabled: true,
      provider: () => ({
        send: async (payload) => {
          assert.deepEqual(payload.bcc, ["hidden@example.invalid"]);
          return { kind: "accepted", id: providerId };
        },
      }),
    });
    assert.equal(result.state, "accepted");
    const sent = (
      await f.db.execute({
        sql: "SELECT * FROM mail_messages WHERE id=?",
        args: [saved.id],
      })
    ).rows[0];
    assert.equal(sent.delivery_status, "delivered");
    assert.equal(sent.message_id, "<outbound@example.invalid>");
    await event(f, providerId, "email.sent");
    assert.equal(
      (
        await f.db.execute({
          sql: "SELECT delivery_status FROM mail_messages WHERE id=?",
          args: [saved.id],
        })
      ).rows[0].delivery_status,
      "delivered",
    );
    const reply = message({
      headers: { "in-reply-to": "<outbound@example.invalid>" },
    });
    await f.enqueue(reply);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(reply),
    });
    const threads = (
      await f.db.execute(
        "SELECT DISTINCT thread_id FROM mail_message_recipients",
      )
    ).rows;
    assert.equal(threads.length, 1);
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_send=0 WHERE user_id='alice'",
    );
    const detail = await (
      await mailRequest(
        f.request(`messages/${saved.id}?identity=ia`),
        ["messages", saved.id],
        f.db,
        () => f.storage,
      )
    ).json();
    assert.deepEqual(detail.bcc, []);
  } finally {
    f.close();
  }
});

test("ambiguous retries retain stable payload and idempotency; they stop before provider window expires", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await queued(f);
    let now = Date.now(),
      calls = 0,
      firstKey = "",
      firstPayload = "";
    const adapter = {
      send: async (payload: unknown, key: string): Promise<MailSendResult> => {
        calls++;
        if (!firstKey) {
          firstKey = key;
          firstPayload = JSON.stringify(payload);
        } else {
          assert.equal(key, firstKey);
          assert.equal(JSON.stringify(payload), firstPayload);
        }
        return { kind: "retry", code: "timeout", uncertain: true };
      },
    };
    const run = () =>
      runMailSendWorker(f.db, f.storage, {
        enabled: true,
        now: () => now,
        provider: () => adapter,
      });
    assert.equal((await run()).state, "retry_wait");
    now += 120000;
    assert.equal((await run()).state, "retry_wait");
    now += 24 * 3600000;
    assert.equal((await run()).state, "manual_review");
    assert.equal(calls, 2);
    assert.equal(
      (await f.db.execute("SELECT delivery_status FROM mail_messages")).rows[0]
        .delivery_status,
      "manual_review",
    );
  } finally {
    f.close();
  }
});

test("worker fences late completions and recovers exhausted leases into audited manual review", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await queued(f);
    let now = Date.now();
    const result = await runMailSendWorker(f.db, f.storage, {
      enabled: true,
      now: () => now,
      provider: () => ({
        send: async () => {
          now += 400000;
          return { kind: "accepted", id: randomUUID() };
        },
      }),
    });
    assert.equal(result.state, "lease_lost");
    await f.db.execute("UPDATE mail_send_jobs SET attempts=5");
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          now: () => now,
        })
      ).state,
      "idle",
    );
    assert.equal(
      (await f.db.execute("SELECT delivery_status FROM mail_messages")).rows[0]
        .delivery_status,
      "manual_review",
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_audit_log WHERE action='send_lease_expired'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    f.close();
  }
});

test("worker rechecks revoked grants and treats unexpected transport failures as uncertain", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    await queued(f);
    let now = Date.now();
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          now: () => now,
          provider: () => ({
            send: async () => {
              throw new Error("network");
            },
          }),
        })
      ).state,
      "retry_wait",
    );
    assert.equal(
      (await f.db.execute("SELECT uncertain FROM mail_send_jobs")).rows[0]
        .uncertain,
      1,
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_send=0 WHERE user_id='alice'",
    );
    now += 120000;
    assert.equal(
      (
        await runMailSendWorker(f.db, f.storage, {
          enabled: true,
          now: () => now,
          provider: () => {
            throw new Error("must not call");
          },
        })
      ).state,
      "manual_review",
    );
  } finally {
    f.close();
  }
});

test("trash/restore/purge are per identity, require confirmation and retry private object deletion", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const inbound = message();
    await f.enqueue(inbound);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(inbound),
    });
    const id = String(
      (await f.db.execute("SELECT id FROM mail_messages")).rows[0].id,
    );
    await f.db.batch(
      [
        "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_read,can_manage) VALUES ('a','private','alice',1,1)",
        "INSERT INTO mail_threads(tenant_id,id,identity_id) VALUES ('a','private-thread','private')",
        {
          sql: "INSERT INTO mail_message_recipients(tenant_id,message_id,identity_id,thread_id) VALUES ('a',?,'private','private-thread')",
          args: [id],
        },
      ],
      "write",
    );
    assert.equal(
      (await post(f, `messages/${id}/trash?identity=ia`, {})).status,
      200,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT folder FROM mail_message_recipients WHERE identity_id='private'",
        )
      ).rows[0].folder,
      "inbox",
    );
    assert.equal(
      (await post(f, `messages/${id}/restore?identity=ia`, {})).status,
      200,
    );
    assert.equal(
      (await post(f, `messages/${id}/purge?identity=ia`, { confirm: true }))
        .status,
      409,
    );
    await post(f, `messages/${id}/trash?identity=ia`, {});
    assert.equal(
      (await post(f, `messages/${id}/purge?identity=ia`, {})).status,
      409,
    );
    assert.equal(
      (await post(f, `messages/${id}/purge?identity=ia`, { confirm: true }))
        .status,
      200,
    );
    assert.equal(
      (
        await mailRequest(
          f.request(`messages/${id}?identity=ia`),
          ["messages", id],
          f.db,
          () => f.storage,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await mailRequest(
          f.request(`messages/${id}?identity=private`),
          ["messages", id],
          f.db,
          () => f.storage,
        )
      ).status,
      200,
    );
    await post(f, `messages/${id}/trash?identity=private`, {});
    await post(f, `messages/${id}/purge?identity=private`, { confirm: true });
    f.storage.failDelete = true;
    await retainMail(f.db, f.storage);
    assert.equal(f.storage.objects.size, 3);
    f.storage.failDelete = false;
    await retainMail(f.db, f.storage);
    assert.equal(f.storage.objects.size, 0);
  } finally {
    f.close();
  }
});

test("trash retention removes access after 30 days and cleans private draft content", async () => {
  const f = await fixture();
  try {
    await prepare(f);
    const saved = await saveDraft(f.db, "alice", f.storage, draft());
    await post(f, `messages/${saved.id}/trash?identity=ia`, {});
    await retainMail(f.db, f.storage, Date.now() + 31 * 86400000);
    assert.equal(
      (await f.db.execute("SELECT state FROM mail_messages")).rows[0].state,
      "expired",
    );
    assert.equal(f.storage.objects.size, 0);
  } finally {
    f.close();
  }
});

test("Resend transport classifies receipts, concurrency, throttling, permanent rejection and network ambiguity", async () => {
  const payload = {
    from: "sender@example.invalid",
    to: ["external@example.invalid"],
    subject: "fixture",
    text: "test",
    headers: {},
    attachments: [],
  };
  const cases: [Response, MailSendResult["kind"]][] = [
    [Response.json({ id: randomUUID() }), "accepted"],
    [Response.json({}, { status: 429 }), "retry"],
    [Response.json({}, { status: 503 }), "retry"],
    [
      Response.json(
        { name: "concurrent_idempotent_requests" },
        { status: 409 },
      ),
      "retry",
    ],
    [
      Response.json({ name: "invalid_idempotent_request" }, { status: 409 }),
      "review",
    ],
    [Response.json({}, { status: 422 }), "failed"],
    [Response.json({ id: "bad" }), "retry"],
  ];
  for (const [response, kind] of cases) {
    const sender = new ResendMailSender("re_fixture", async (url, init) => {
      assert.equal(url, "https://api.resend.com/emails");
      assert.equal(
        (init!.headers as Record<string, string>)["Idempotency-Key"],
        "stable",
      );
      return response;
    });
    assert.equal((await sender.send(payload, "stable")).kind, kind);
  }
  const sender = new ResendMailSender("re_fixture", async () => {
    throw new Error("timeout");
  });
  assert.deepEqual(await sender.send(payload, "stable"), {
    kind: "retry",
    code: "provider_timeout_or_network",
    uncertain: true,
  });
});
