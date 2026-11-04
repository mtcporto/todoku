import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import {
  fixture,
  message,
  provider,
  signed,
  ring,
  secret,
  fixturePassword,
} from "./helpers/mail-fixture.ts";
import { mailWebhook } from "../src/lib/mail/inbound.ts";
import { runMailWorker, retainMail } from "../src/lib/mail/worker.ts";
import { mailRequest, mailWorkerRequest } from "../src/lib/mail/http.ts";
import { safeHtml, readerDocument } from "../src/lib/mail/content.ts";
import {
  objectKey,
  checkKey,
  R2Storage,
  mailStorage,
} from "../src/lib/mail/storage.ts";
import { filename, hash, limits } from "../src/lib/mail/common.ts";
import { ResendInbound } from "../src/lib/mail/provider.ts";

test("Mail never cleans fixture objects through R2 and rejects a mismatched read backend", async () => {
  const f = await fixture();
  try {
    const value = message();
    await f.enqueue(value);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(value),
    });
    const id = String(
      (await f.db.execute("SELECT id FROM mail_messages")).rows[0].id,
    );
    let calls = 0;
    const remote = {
      durable: true,
      put: async () => {
        calls++;
      },
      get: async () => {
        calls++;
        return new Uint8Array();
      },
      delete: async () => {
        calls++;
      },
    };
    assert.equal(
      (
        await mailRequest(
          f.request(`messages/${id}`),
          ["messages", id],
          f.db,
          () => remote,
        )
      ).status,
      503,
    );
    await f.db.execute(
      "UPDATE mail_objects SET expires_at='2000-01-01T00:00:00.000Z'",
    );
    assert.equal((await retainMail(f.db, remote)).deleted, 0);
    assert.equal(calls, 0);
    assert.equal(f.storage.objects.size, 3);
  } finally {
    f.close();
  }
});

test("Vercel cannot enable fixture storage, webhook handling or fixture claims by a local-mode variable", async () => {
  const f = await fixture();
  const original = {
    vercel: process.env.VERCEL,
    storage: process.env.TODOKU_MAIL_STORAGE,
    directory: process.env.TODOKU_MAIL_FIXTURE_DIRECTORY,
  };
  try {
    process.env.VERCEL = "1";
    process.env.TODOKU_MAIL_STORAGE = "fixture";
    process.env.TODOKU_MAIL_FIXTURE_DIRECTORY = f.root;
    const value = message();
    await f.enqueue(value);
    assert.equal(mailStorage(), null);
    assert.equal(
      (
        await mailWebhook(signed(value), f.source, f.db, {
          enabled: true,
          keyring: ring,
        })
      ).status,
      401,
    );
    assert.equal(
      (await runMailWorker(f.db, f.storage, { enabled: true })).state,
      "idle",
    );
  } finally {
    for (const [key, value] of [
      ["VERCEL", original.vercel],
      ["TODOKU_MAIL_STORAGE", original.storage],
      ["TODOKU_MAIL_FIXTURE_DIRECTORY", original.directory],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    f.close();
  }
});

test("Mail rejects invalid, altered and stale signatures and excessive raw bodies before durable acknowledgement", async () => {
  const f = await fixture();
  try {
    const value = message();
    for (const request of [
      signed(value, { secret: "whsec_" + Buffer.alloc(32).toString("base64") }),
      signed(value, { date: new Date(Date.now() - 600_000) }),
      signed(value, { date: new Date(Date.now() + 600_000) }),
    ])
      assert.equal(
        (
          await mailWebhook(request, f.source, f.db, {
            enabled: true,
            fixtures: true,
            keyring: ring,
          })
        ).status,
        401,
      );
    const valid = signed(value);
    const altered = new Request(valid.url, {
      method: "POST",
      headers: valid.headers,
      body: "{}",
    });
    assert.equal(
      (
        await mailWebhook(altered, f.source, f.db, {
          enabled: true,
          fixtures: true,
          keyring: ring,
        })
      ).status,
      401,
    );
    const large = new Request(valid.url, {
      method: "POST",
      headers: valid.headers,
      body: "x".repeat(limits.webhook + 1),
    });
    assert.equal(
      (
        await mailWebhook(large, f.source, f.db, {
          enabled: true,
          fixtures: true,
          keyring: ring,
        })
      ).status,
      413,
    );
    assert.equal(
      Number(
        (await f.db.execute("SELECT count(*) AS n FROM mail_ingestion_events"))
          .rows[0].n,
      ),
      0,
    );
  } finally {
    f.close();
  }
});

test("Mail acknowledges only a durable job, deduplicates new delivery IDs and never downloads inside the webhook", async () => {
  const f = await fixture();
  try {
    const value = message();
    await f.db.execute(
      "CREATE TRIGGER fail_mail BEFORE INSERT ON mail_ingestion_events BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    assert.equal((await f.enqueue(value)).status, 503);
    await f.db.execute("DROP TRIGGER fail_mail");
    const first = await f.enqueue(value);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).duplicate, false);
    const duplicate = await f.enqueue(value);
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal(
      Number(
        (await f.db.execute("SELECT count(*) AS n FROM mail_ingestion_events"))
          .rows[0].n,
      ),
      1,
    );
    assert.equal(
      Number(
        (await f.db.execute("SELECT count(*) AS n FROM mail_messages")).rows[0]
          .n,
      ),
      0,
    );
  } finally {
    f.close();
  }
});

test("Mail routes only authorized envelope destinations in the signed source scope and enforces quotas", async () => {
  const f = await fixture();
  try {
    const value = message({ received_for: ["inbox@b.example.invalid"] });
    assert.equal((await f.enqueue(value)).status, 200);
    assert.equal(
      (await f.db.execute("SELECT state FROM mail_ingestion_events")).rows[0]
        .state,
      "rejected",
    );
    let calls = 0;
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => {
        calls++;
        return provider(value);
      },
    });
    assert.equal(calls, 0);
    await f.db.execute("UPDATE mail_sources SET daily_limit=1");
    assert.equal((await f.enqueue(message())).status, 429);
  } finally {
    f.close();
  }
});

test("Mail fetches real adapter content and attachments into private storage with safe HTML and metadata", async () => {
  const f = await fixture();
  try {
    const value = message({
      html: '<h1>Olá</h1><script>alert(1)</script><img src="https://tracker.invalid/pixel"><svg onload="alert(2)"></svg><a href="javascript:alert(3)">link</a><p style="background:url(https://bad.invalid)">seguro</p>',
    });
    await f.enqueue(value);
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          provider: () => provider(value),
        })
      ).state,
      "completed",
    );
    const id = String(
      (await f.db.execute("SELECT id FROM mail_messages")).rows[0].id,
    );
    const read = await mailRequest(
      f.request(`messages/${id}`),
      ["messages", id],
      f.db,
      () => f.storage,
    );
    assert.equal(read.status, 200);
    const content = await read.json();
    assert.ok(content.document.includes("<h1>Olá</h1>"));
    for (const forbidden of [
      "<script",
      "<img",
      "<svg",
      "javascript:",
      "tracker.invalid",
      "bad.invalid",
      "onload",
    ])
      assert.ok(!content.document.includes(forbidden));
    assert.ok(content.document.includes("default-src 'none'"));
    const attachment = content.attachments[0];
    const downloaded = await mailRequest(
      f.request(`attachments/${attachment.id}`),
      ["attachments", attachment.id],
      f.db,
      () => f.storage,
    );
    assert.equal(await downloaded.text(), "test");
    assert.equal(
      downloaded.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.ok(
      downloaded.headers.get("content-disposition")?.startsWith("attachment;"),
    );
    assert.equal(f.storage.objects.size, 3);
    const responseText = JSON.stringify(content);
    assert.ok(!responseText.includes("download_url"));
    assert.ok(!responseText.includes("object_key"));
  } finally {
    f.close();
  }
});

test("Mail partial download and storage failures retry without exposing partial messages or duplicating objects", async () => {
  const f = await fixture();
  let now = Date.now() + 1000;
  try {
    const value = message();
    await f.enqueue(value);
    const original = provider(value);
    const failed = await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      now: () => now,
      provider: () => ({
        ...original,
        attachment: async () => {
          throw new Error("download failed");
        },
      }),
    });
    assert.equal(failed.state, "retry_wait");
    assert.equal(f.storage.objects.size, 2);
    assert.equal(
      Number(
        (await f.db.execute("SELECT count(*) AS n FROM mail_messages")).rows[0]
          .n,
      ),
      0,
    );
    now += 3_600_000;
    f.storage.failPut = true;
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          now: () => now,
          provider: () => original,
        })
      ).state,
      "retry_wait",
    );
    f.storage.failPut = false;
    now += 3_600_000;
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          now: () => now,
          provider: () => original,
        })
      ).state,
      "completed",
    );
    assert.equal(
      Number(
        (await f.db.execute("SELECT count(*) AS n FROM mail_messages")).rows[0]
          .n,
      ),
      1,
    );
    assert.equal(f.storage.objects.size, 3);
    assert.equal((await f.enqueue(value)).status, 200);
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          provider: () => original,
        })
      ).processed,
      0,
    );
  } finally {
    f.close();
  }
});

test("Mail is isolated by tenant and identity, including filters, message bodies, attachment downloads and grants", async () => {
  const f = await fixture();
  try {
    const own = message(),
      privateMessage = message({
        to: ["private@a.example.invalid"],
        received_for: ["private@a.example.invalid"],
      }),
      other = message({
        to: ["inbox@b.example.invalid"],
        received_for: ["inbox@b.example.invalid"],
      });
    for (const [value, src] of [
      [own, f.source],
      [privateMessage, f.source],
      [other, f.otherSource],
    ] as const) {
      await f.enqueue(value, src);
      await runMailWorker(f.db, f.storage, {
        enabled: true,
        fixtures: true,
        provider: () => provider(value),
      });
    }
    const inbox = await (
      await mailRequest(f.request("inbox"), ["inbox"], f.db, () => f.storage)
    ).json();
    assert.equal(inbox.messages.length, 1);
    assert.equal(inbox.identities.length, 1);
    const empty = await (
      await mailRequest(
        f.request("inbox?identity=ib&domain=db"),
        ["inbox"],
        f.db,
        () => f.storage,
      )
    ).json();
    assert.equal(empty.messages.length, 0);
    const messages = (
      await f.db.execute(
        "SELECT tenant_id,id,provider_email_id FROM mail_messages",
      )
    ).rows;
    for (const row of messages.filter(
      (row) => row.provider_email_id !== own.id,
    ))
      assert.equal(
        (
          await mailRequest(
            f.request(`messages/${row.id}`),
            ["messages", String(row.id)],
            f.db,
            () => f.storage,
          )
        ).status,
        404,
      );
    const foreign = (
      await f.db.execute("SELECT id FROM mail_attachments WHERE tenant_id='b'")
    ).rows[0];
    assert.equal(
      (
        await mailRequest(
          f.request(`attachments/${foreign.id}`),
          ["attachments", String(foreign.id)],
          f.db,
          () => f.storage,
        )
      ).status,
      404,
    );
    await assert.rejects(
      f.db.execute(
        "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id) VALUES ('a','ib','alice')",
      ),
    );
    await f.db.execute(
      "DELETE FROM mail_identity_grants WHERE user_id='alice'",
    );
    assert.equal(
      (
        await mailRequest(
          f.request(`messages/${inbox.messages[0].id}`),
          ["messages", inbox.messages[0].id],
          f.db,
          () => f.storage,
        )
      ).status,
      404,
    );
  } finally {
    f.close();
  }
});

test("Mail login uses secure hashed sessions, same-origin mutations, expiry, logout and account revocation", async () => {
  const f = await fixture();
  try {
    const payload = JSON.stringify({
      username: "ALICE",
      password: fixturePassword,
    });
    const wrongOrigin = f.request(
      "login",
      {
        method: "POST",
        headers: { origin: "https://attacker.invalid" },
        body: payload,
      },
      "none",
    );
    assert.equal((await mailRequest(wrongOrigin, ["login"], f.db)).status, 403);
    const login = await mailRequest(
      f.request("login", { method: "POST", body: payload }, "none"),
      ["login"],
      f.db,
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!;
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(cookie.includes("SameSite=Strict"));
    assert.ok(cookie.includes("Secure"));
    const token = cookie.split(";")[0].split("=")[1];
    const stored = (
      await f.db.execute({
        sql: "SELECT token_hash FROM mail_sessions WHERE token_hash=?",
        args: [hash(token)],
      })
    ).rows[0];
    assert.equal(stored.token_hash, hash(token));
    const request = (op: string, init: RequestInit = {}) =>
      f.request(op, {
        ...init,
        headers: { cookie: cookie.split(";")[0], ...init.headers },
      });
    assert.equal(
      (await mailRequest(request("session"), ["session"], f.db)).status,
      200,
    );
    assert.equal(
      (
        await mailRequest(
          request("logout", { method: "POST" }),
          ["logout"],
          f.db,
        )
      ).status,
      200,
    );
    assert.equal(
      (await mailRequest(request("session"), ["session"], f.db)).status,
      401,
    );
    await f.db.execute(
      "UPDATE mail_users SET status='disabled' WHERE id='alice'",
    );
    assert.equal(
      (await mailRequest(f.request("inbox"), ["inbox"], f.db)).status,
      401,
    );
    assert.equal(
      (await mailRequest(f.request("session", {}, "none"), ["session"], f.db))
        .status,
      401,
    );
    await f.db.execute(
      "UPDATE mail_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE user_id='bob'",
    );
    assert.equal(
      (await mailRequest(f.request("session", {}, "bob"), ["session"], f.db))
        .status,
      401,
    );
  } finally {
    f.close();
  }
});

test("Mail login throttles distributed attempts against a username without exposing account existence", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 7; i++) {
      const result = await mailRequest(
        f.request(
          "login",
          {
            method: "POST",
            body: JSON.stringify({ username: "unknown", password: "bad" }),
          },
          "none",
        ),
        ["login"],
        f.db,
      );
      assert.equal(result.status, i < 6 ? 401 : 429);
    }
  } finally {
    f.close();
  }
});

test("Mail independent worker instances atomically claim one job", async () => {
  const f = await fixture();
  try {
    const value = message();
    await f.enqueue(value);
    let calls = 0;
    const run = () =>
      new Promise<{ processed: number }>((resolve, reject) => {
        const worker = new Worker(
          new URL("./helpers/mail-worker.ts", import.meta.url),
          {
            workerData: { url: f.url, root: f.root, message: value },
            execArgv: ["--experimental-strip-types"],
          },
        );
        let result: { processed: number } | undefined;
        worker.on("message", (event) => {
          if (event.called) calls++;
          if (event.result) result = event.result;
        });
        worker.on("error", reject);
        worker.on("exit", (code) =>
          code || !result
            ? reject(new Error("worker failed"))
            : resolve(result),
        );
      });
    const results = await Promise.all([run(), run()]);
    assert.equal(
      results.reduce((n, result) => n + result.processed, 0),
      1,
    );
    assert.equal(calls, 1);
    assert.equal(
      Number(
        (await f.db.execute("SELECT attempts FROM mail_ingestion_events"))
          .rows[0].attempts,
      ),
      1,
    );
  } finally {
    f.close();
  }
});

test("Mail recovers expired leases, fences late workers and bounds repeated failures", async () => {
  const f = await fixture();
  let now = Date.now() + 1000;
  try {
    const value = message();
    await f.enqueue(value);
    await f.db.execute(
      "UPDATE mail_ingestion_events SET state='processing',attempts=1,lease_token='old',locked_until='2000-01-01T00:00:00.000Z'",
    );
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          now: () => now,
          provider: () => provider(value),
        })
      ).processed,
      0,
    );
    now += 31_000;
    const original = provider(value);
    const late = await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      now: () => now,
      provider: () => ({
        ...original,
        raw: async (mail) => {
          await f.db.execute(
            "UPDATE mail_ingestion_events SET lease_token='new-owner'",
          );
          return original.raw(mail);
        },
      }),
    });
    assert.equal(late.state, "lease_lost");
    assert.equal(
      (await f.db.execute("SELECT lease_token FROM mail_ingestion_events"))
        .rows[0].lease_token,
      "new-owner",
    );
    assert.equal(
      Number(
        (await f.db.execute("SELECT count(*) AS n FROM mail_messages")).rows[0]
          .n,
      ),
      0,
    );
    await f.db.execute(
      "UPDATE mail_ingestion_events SET lease_token=NULL,state='retry_wait',attempts=4,available_at='2000-01-01T00:00:00.000Z'",
    );
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          now: () => now,
          provider: () => ({
            ...original,
            get: async () => {
              throw new Error("network");
            },
          }),
        })
      ).state,
      "failed",
    );
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          now: () => now,
          provider: () => original,
        })
      ).processed,
      0,
    );
  } finally {
    f.close();
  }
});

test("Mail retries a database failure after object upload without duplicating messages or recipients", async () => {
  const f = await fixture();
  let now = Date.now() + 1000;
  try {
    const value = message();
    await f.enqueue(value);
    await f.db.execute(
      "CREATE TRIGGER fail_ready BEFORE INSERT ON mail_message_recipients BEGIN SELECT RAISE(ABORT,'failure'); END",
    );
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          now: () => now,
          provider: () => provider(value),
        })
      ).state,
      "retry_wait",
    );
    assert.equal(
      Number(
        (await f.db.execute("SELECT count(*) AS n FROM mail_messages")).rows[0]
          .n,
      ),
      0,
    );
    await f.db.execute("DROP TRIGGER fail_ready");
    now += 3_600_000;
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          now: () => now,
          provider: () => provider(value),
        })
      ).state,
      "completed",
    );
    assert.equal(
      Number(
        (
          await f.db.execute(
            "SELECT count(*) AS n FROM mail_message_recipients",
          )
        ).rows[0].n,
      ),
      1,
    );
    assert.equal(f.storage.objects.size, 3);
  } finally {
    f.close();
  }
});

test("Mail threads use references within one identity; a forged cross-tenant reference cannot join a conversation", async () => {
  const f = await fixture();
  try {
    const first = message({ message_id: "<same@fixture.invalid>" });
    await f.enqueue(first);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(first),
    });
    const reply = message({
      headers: { "In-Reply-To": "<same@fixture.invalid>" },
    });
    await f.enqueue(reply);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(reply),
    });
    assert.equal(
      Number(
        (
          await f.db.execute(
            "SELECT count(DISTINCT thread_id) AS n FROM mail_message_recipients WHERE tenant_id='a'",
          )
        ).rows[0].n,
      ),
      1,
    );
    const other = message({
      to: ["inbox@b.example.invalid"],
      received_for: ["inbox@b.example.invalid"],
      headers: { "In-Reply-To": "<same@fixture.invalid>" },
    });
    await f.enqueue(other, f.otherSource);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(other),
    });
    const threads = (
      await f.db.execute(
        "SELECT tenant_id,thread_id FROM mail_message_recipients",
      )
    ).rows;
    assert.notEqual(
      threads[0].thread_id,
      threads.find((row) => row.tenant_id === "b")!.thread_id,
    );
  } finally {
    f.close();
  }
});

test("Mail expiry hides content immediately, redacts metadata without storage and retries private object deletion", async () => {
  const f = await fixture();
  try {
    const value = message();
    await f.enqueue(value);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(value),
    });
    const row = (await f.db.execute("SELECT id FROM mail_messages")).rows[0];
    await f.db.batch(
      [
        "UPDATE mail_messages SET expires_at='2000-01-01T00:00:00.000Z'",
        "UPDATE mail_objects SET expires_at='2000-01-01T00:00:00.000Z'",
      ],
      "write",
    );
    assert.equal(
      (
        await mailRequest(
          f.request(`messages/${row.id}`),
          ["messages", String(row.id)],
          f.db,
          () => f.storage,
        )
      ).status,
      404,
    );
    assert.equal((await retainMail(f.db, null)).pending, 3);
    assert.equal(
      (await f.db.execute("SELECT subject,state FROM mail_messages")).rows[0]
        .subject,
      "",
    );
    f.storage.failDelete = true;
    assert.equal((await retainMail(f.db, f.storage)).pending, 3);
    f.storage.failDelete = false;
    assert.equal((await retainMail(f.db, f.storage)).deleted, 3);
    assert.equal(f.storage.objects.size, 0);
    assert.equal(
      (await f.db.execute("SELECT filename FROM mail_attachments")).rows[0]
        .filename,
      "anexo expirado",
    );
    assert.equal((await f.enqueue(value)).status, 200);
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          provider: () => provider(value),
        })
      ).processed,
      0,
    );
  } finally {
    f.close();
  }
});

test("Mail validates limits, missing MIME, destination mismatch and disabled sources without publishing partial data", async () => {
  for (const kind of ["mime", "too-many", "destination", "disabled"] as const) {
    const f = await fixture();
    try {
      const value = message();
      await f.enqueue(value);
      const original = provider(value);
      if (kind === "too-many")
        value.attachments = Array.from({ length: 6 }, () => ({
          ...value.attachments[0],
          id: randomUUID(),
        }));
      if (kind === "destination")
        value.received_for = ["inbox@b.example.invalid"];
      if (kind === "disabled")
        await f.db.execute("UPDATE mail_sources SET status='disabled'");
      const result = await runMailWorker(f.db, f.storage, {
        enabled: true,
        fixtures: true,
        provider: () =>
          kind === "mime"
            ? { ...original, raw: async () => new Uint8Array() }
            : provider(value),
      });
      assert.equal(result.state, kind === "disabled" ? "idle" : "failed");
      assert.equal(
        Number(
          (await f.db.execute("SELECT count(*) AS n FROM mail_messages"))
            .rows[0].n,
        ),
        0,
      );
    } finally {
      f.close();
    }
  }
});

test("Mail object keys and filenames resist traversal and R2 signs server-only private requests", async () => {
  const key = objectKey("tenant", "source", "message", "../../evil.svg");
  checkKey("tenant", key);
  assert.throws(() => checkKey("other", key));
  assert.throws(() => checkKey("tenant", key + "/../file"));
  assert.ok(!filename("../../evil\r\n.svg").includes("/"));
  assert.ok(!filename("../../evil\r\n.svg").includes("\r"));
  const requests: Request[] = [];
  const storage = new R2Storage(
    {
      account: "a".repeat(32),
      bucket: "todoku-mail-test",
      accessKeyId: "fixture",
      secretAccessKey: "fixture",
    },
    async (input) => {
      requests.push(input as Request);
      return new Response("test");
    },
  );
  await storage.put("tenant", key, Buffer.from("test"));
  assert.equal(
    Buffer.from(await storage.get("tenant", key)).toString(),
    "test",
  );
  await storage.delete("tenant", key);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.ok(
      request.headers.get("authorization")?.startsWith("AWS4-HMAC-SHA256"),
    );
    assert.equal(new URL(request.url).search, "");
    assert.ok(request.url.includes(".r2.cloudflarestorage.com/"));
  }
  await assert.rejects(storage.get("other", key));
  assert.equal(requests.length, 3);
  assert.ok(
    !safeHtml(
      '<form action="https://bad.invalid"><input name="q"></form>',
    ).includes("<form"),
  );
  assert.ok(
    readerDocument('<iframe src="https://bad.invalid"></iframe>').includes(
      "form-action 'none'",
    ),
  );
});

test("Mail stays disabled and never falls back to fixture storage or downloads without a durable backend", async () => {
  const f = await fixture();
  try {
    const value = message();
    await f.enqueue(value);
    let calls = 0;
    assert.equal(
      (
        await runMailWorker(f.db, null, {
          enabled: true,
          fixtures: true,
          provider: () => {
            calls++;
            return provider(value);
          },
        })
      ).state,
      "storage_unavailable",
    );
    assert.equal(
      (await runMailWorker(f.db, f.storage, { enabled: false, fixtures: true }))
        .state,
      "receiving_disabled",
    );
    assert.equal(calls, 0);
    assert.equal(
      (await mailWebhook(signed(value), f.source, f.db, { enabled: false }))
        .status,
      503,
    );
    const unauth = await mailWorkerRequest(
      new Request("https://todoku.test/worker"),
      () => f.db,
    );
    assert.ok([401, 503].includes(unauth.status));
    assert.equal(
      Number(
        (await f.db.execute("SELECT attempts FROM mail_ingestion_events"))
          .rows[0].attempts,
      ),
      0,
    );
  } finally {
    f.close();
  }
});

test("Resend Inbound SDK fetches content and expiring attachment URLs server-side with bounded requests and host restrictions", async () => {
  const original = globalThis.fetch;
  const value = message();
  const calls: { url: string; signal: boolean }[] = [];
  try {
    globalThis.fetch = async (input, options) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      calls.push({ url, signal: Boolean(options?.signal) });
      if (url.startsWith("https://api.resend.com/"))
        return Response.json(
          url.includes("/attachments/")
            ? {
                id: value.attachments[0].id,
                size: 4,
                download_url: "https://inbound-cdn.resend.com/fixture",
              }
            : value,
        );
      return new Response(url.includes("inbound-cdn") ? "test" : "raw");
    };
    const adapter = new ResendInbound("re_fixture");
    const received = await adapter.get(value.id);
    assert.equal(received.id, value.id);
    assert.ok(calls[0].url.includes("html_format=cid"));
    assert.equal(calls[0].signal, true);
    assert.equal(
      Buffer.from(
        await adapter.attachment(value.id, value.attachments[0].id),
      ).toString(),
      "test",
    );
    assert.equal(Buffer.from(await adapter.raw(received)).toString(), "raw");
    const before = calls.length;
    await assert.rejects(
      adapter.raw({
        ...value,
        raw: { download_url: "http://127.0.0.1/private" },
      }),
    );
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = original;
  }
});

test("Mail paginates tied timestamps without loss and read mutations require same-origin identity access", async () => {
  const f = await fixture();
  try {
    const value = message();
    await f.enqueue(value);
    await runMailWorker(f.db, f.storage, {
      enabled: true,
      fixtures: true,
      provider: () => provider(value),
    });
    const row = (await f.db.execute("SELECT * FROM mail_messages")).rows[0];
    const ids = [String(row.id)];
    for (let i = 0; i < 31; i++) {
      const id = hash(`pagination-${i}`);
      ids.push(id);
      await f.db.batch(
        [
          {
            sql: "INSERT INTO mail_messages(tenant_id,id,source_id,provider_email_id,message_id,sender,subject,preview,authentication,content_object_id,raw_object_id,received_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            args: [
              "a",
              id,
              f.source,
              randomUUID(),
              null,
              "fixture@example.invalid",
              "Pagination",
              "",
              "unverified",
              row.content_object_id,
              row.raw_object_id,
              row.received_at,
              row.expires_at,
            ],
          },
          {
            sql: "INSERT INTO mail_message_recipients(tenant_id,message_id,identity_id,thread_id) SELECT 'a',?,'ia',thread_id FROM mail_message_recipients WHERE tenant_id='a' AND message_id=? LIMIT 1",
            args: [id, row.id],
          },
        ],
        "write",
      );
    }
    const first = await (
      await mailRequest(f.request("inbox"), ["inbox"], f.db, () => f.storage)
    ).json();
    assert.equal(first.messages.length, 30);
    const second = await (
      await mailRequest(
        f.request(`inbox?cursor=${first.nextCursor}`),
        ["inbox"],
        f.db,
        () => f.storage,
      )
    ).json();
    assert.equal(second.messages.length, 2);
    assert.equal(
      new Set([...first.messages, ...second.messages].map((item) => item.id))
        .size,
      32,
    );
    const csrf = f.request(`messages/${row.id}/read`, {
      method: "POST",
      headers: { origin: "https://attacker.invalid" },
      body: JSON.stringify({ read: true }),
    });
    assert.equal(
      (
        await mailRequest(
          csrf,
          ["messages", String(row.id), "read"],
          f.db,
          () => f.storage,
        )
      ).status,
      403,
    );
    const valid = f.request(`messages/${row.id}/read`, {
      method: "POST",
      body: JSON.stringify({ read: true }),
    });
    assert.equal(
      (
        await mailRequest(
          valid,
          ["messages", String(row.id), "read"],
          f.db,
          () => f.storage,
        )
      ).status,
      200,
    );
    assert.equal(
      Number(
        (
          await f.db.execute({
            sql: "SELECT is_read FROM mail_message_recipients WHERE message_id=?",
            args: [row.id],
          })
        ).rows[0].is_read,
      ),
      1,
    );
  } finally {
    f.close();
  }
});
