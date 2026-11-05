import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@libsql/client";
import {
  fixture,
  message,
  provider,
  fixturePassword,
} from "./helpers/mail-fixture.ts";
import { mailRequest } from "../src/lib/mail/http.ts";
import { runMailWorker } from "../src/lib/mail/worker.ts";
import { saveDraft } from "../src/lib/mail/drafts.ts";
import { randomUUID } from "node:crypto";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type User = "alice" | "bob" | "none";
async function call(
  f: Fixture,
  path: string,
  method = "GET",
  input?: unknown,
  user: User = "alice",
  headers: Record<string, string> = {},
) {
  return mailRequest(
    f.request(
      path,
      {
        method,
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        headers,
      },
      user,
    ),
    path.split("?")[0].split("/"),
    f.db,
    () => f.storage,
  );
}
const base = "admin/organizations/a";
const role = (
  userId: string,
  scope = "organization",
  extra: Record<string, unknown> = {},
) => ({ userId, scope, status: "active", ...extra });
const rights = (canRead = false, canSend = false, canManage = false) => ({
  canRead,
  canSend,
  canManage,
});
async function root(f: Fixture) {
  await f.db.execute(
    "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope) VALUES ('root','a','alice','organization')",
  );
  await f.db.execute(
    "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('a','bob')",
  );
  await f.db.execute(
    "UPDATE mail_identity_grants SET can_send=1,can_manage=1 WHERE user_id='alice'",
  );
  await f.db.execute({
    sql: "INSERT INTO mail_domains(tenant_id,id,source_id,name,status) VALUES ('a','second',?,'second.example.invalid','disabled')",
    args: [f.source],
  });
  await f.db.execute(
    "INSERT INTO mail_identities(tenant_id,id,domain_id,address,label) VALUES ('a','second-box','second','box@second.example.invalid','Second')",
  );
}
async function auditCount(f: Fixture) {
  return Number(
    (await f.db.execute("SELECT count(*) AS n FROM mail_administration_audit"))
      .rows[0].n,
  );
}
async function receive(f: Fixture) {
  const value = message();
  await f.enqueue(value);
  await runMailWorker(f.db, f.storage, {
    enabled: true,
    fixtures: true,
    provider: () => provider(value),
  });
  return String(
    (
      await f.db.execute({
        sql: "SELECT id FROM mail_messages WHERE provider_email_id=?",
        args: [value.id],
      })
    ).rows[0].id,
  );
}

test("administrative APIs authenticate every request and only enumerate administrable resources", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await call(f, "admin/organizations", "GET", undefined, "none")).status,
      401,
    );
    assert.deepEqual(
      (await (await call(f, "admin/organizations")).json()).items,
      [],
    );
    assert.equal((await call(f, base + "/domains")).status, 403);
    await root(f);
    const tenants = await (await call(f, "admin/organizations")).json();
    assert.deepEqual(tenants.items, [{ id: "a", status: "active" }]);
    assert.equal((await call(f, "admin/organizations/b/domains")).status, 403);
    assert.equal(
      (await (await call(f, base + "/domains")).json()).items.length,
      2,
    );
    assert.equal(
      (await (await call(f, base + "/mailboxes")).json()).items.length,
      3,
    );
    assert.equal(
      (await (await call(f, base + "/mailboxes?domainId=da")).json()).items
        .length,
      2,
    );
    assert.equal(
      (await (await call(f, base + "/mailboxes?domainId=db")).json()).items
        .length,
      0,
    );
    for (const resource of [
      "domains",
      "mailboxes",
      "memberships",
      "roles",
      "grants",
    ]) {
      const response = await call(f, base + "/" + resource);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const data = JSON.stringify(await response.json());
      for (const forbidden of [
        "password_hash",
        "encrypted_api_key",
        "encrypted_webhook_secret",
        "token_hash",
        "object_key",
        "content_object_id",
        "provider_email_id",
        "verified_email",
      ])
        assert.ok(!data.includes(forbidden), forbidden);
    }
  } finally {
    f.close();
  }
});

test("session exposes current UUID-based administrative capabilities independently from content and Google", async () => {
  const f = await fixture();
  try {
    let session = await (await call(f, "session")).json();
    assert.deepEqual(session.administration, {
      canAdminister: false,
      scopes: [],
    });
    await root(f);
    await f.db.execute(
      "DELETE FROM mail_identity_grants WHERE tenant_id='a' AND user_id='alice'",
    );
    session = await (await call(f, "session")).json();
    assert.deepEqual(session.user, { id: "alice", username: "alice" });
    assert.deepEqual(session.administration, {
      canAdminister: true,
      scopes: [
        {
          tenantId: "a",
          scope: "organization",
          domainId: null,
          identityId: null,
        },
      ],
    });
    assert.equal((await (await call(f, "inbox")).json()).messages.length, 0);
    await f.db.execute("UPDATE mail_admin_grants SET status='revoked'");
    assert.equal(
      (await (await call(f, "session")).json()).administration.canAdminister,
      false,
    );
    assert.equal((await call(f, base + "/roles")).status, 403);
  } finally {
    f.close();
  }
});

test("domain and mailbox lists hide sibling resources, memberships, roles and grants", async () => {
  const f = await fixture();
  try {
    await root(f);
    await f.db.execute(
      "INSERT INTO mail_users(id,username,password_hash) SELECT 'charlie','charlie',password_hash FROM mail_users WHERE id='alice'",
    );
    await f.db.execute(
      "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('a','charlie')",
    );
    await f.db.execute(
      "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_read) VALUES ('a','second-box','charlie',1)",
    );
    await f.db.execute(
      "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,domain_id) VALUES ('sibling-role','a','charlie','domain','second'),('bob-domain','a','bob','domain','da')",
    );
    assert.deepEqual(
      (
        await (await call(f, base + "/domains", "GET", undefined, "bob")).json()
      ).items.map((x: { id: string }) => x.id),
      ["da"],
    );
    assert.deepEqual(
      (
        await (
          await call(f, base + "/mailboxes", "GET", undefined, "bob")
        ).json()
      ).items.map((x: { id: string }) => x.id),
      ["ia", "private"],
    );
    assert.deepEqual(
      (
        await (await call(f, base + "/roles", "GET", undefined, "bob")).json()
      ).items.map((x: { id: string }) => x.id),
      ["bob-domain"],
    );
    const members = (
      await (
        await call(f, base + "/memberships", "GET", undefined, "bob")
      ).json()
    ).items.map((x: { user_id: string }) => x.user_id);
    assert.deepEqual(members, ["alice", "bob"]);
    const grants = (
      await (await call(f, base + "/grants", "GET", undefined, "bob")).json()
    ).items;
    assert.equal(grants.length, 1);
    assert.equal(grants[0].identity_id, "ia");
    await f.db.execute(
      "UPDATE mail_admin_grants SET status='revoked' WHERE id='bob-domain'",
    );
    await f.db.execute(
      "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,identity_id) VALUES ('bob-mailbox','a','bob','mailbox','ia')",
    );
    assert.deepEqual(
      (
        await (
          await call(f, base + "/mailboxes", "GET", undefined, "bob")
        ).json()
      ).items.map((x: { id: string }) => x.id),
      ["ia"],
    );
    assert.deepEqual(
      (
        await (await call(f, base + "/domains", "GET", undefined, "bob")).json()
      ).items.map((x: { id: string }) => x.id),
      ["da"],
    );
    assert.equal(
      (
        await call(
          f,
          base + "/mailboxes/second-box/grants/bob",
          "PUT",
          rights(),
          "bob",
        )
      ).status,
      403,
    );
  } finally {
    f.close();
  }
});

test("mutations validate origin, input shape, bounded payloads and route methods without side effects", async () => {
  const f = await fixture();
  try {
    await root(f);
    const before = await auditCount(f);
    assert.equal((await call(f, "logout", "DELETE")).status, 405);
    assert.equal(
      (
        await call(f, "login", "PUT", {
          username: "alice",
          password: fixturePassword,
        })
      ).status,
      405,
    );
    assert.equal(
      (await call(f, base + "/roles", "PUT", role("bob"), "none")).status,
      401,
    );
    assert.equal(
      (
        await call(f, base + "/roles", "PUT", role("bob"), "alice", {
          origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(f, base + "/roles", "PUT", role("bob"), "alice", {
          "sec-fetch-site": "cross-site",
        })
      ).status,
      403,
    );
    for (const input of [
      role("bob", "organization", { domainId: "da" }),
      role("bob", "domain"),
      role("bob", "mailbox", { domainId: "da", identityId: "ia" }),
      role("bob", "owner"),
      role("bob", "organization", { canRead: true }),
      role("../bob"),
    ])
      assert.equal((await call(f, base + "/roles", "PUT", input)).status, 400);
    assert.equal(
      (
        await call(f, base + "/memberships/bob", "PUT", {
          status: "active",
          password: "forbidden",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(f, base + "/mailboxes/ia/grants/bob", "PUT", {
          ...rights(),
          actorId: "bob",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/mailboxes/ia/grants/bob",
          "PUT",
          rights(),
          "alice",
          { "content-type": "application/json" },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "organization", { unexpected: "x".repeat(5000) }),
        )
      ).status,
      413,
    );
    assert.equal(
      (await call(f, base + "/roles", "POST", role("bob"))).status,
      405,
    );
    assert.equal(
      (await call(f, base + "/memberships/bob", "DELETE")).status,
      405,
    );
    assert.equal(
      (await call(f, base + "/roles?scope=organization", "PUT", role("bob")))
        .status,
      400,
    );
    assert.equal(await auditCount(f), before + 1);
  } finally {
    f.close();
  }
});

test("role delegation is scoped, cannot grant superior roles and never grants content", async () => {
  const f = await fixture();
  try {
    await root(f);
    const id = await receive(f);
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "domain", { domainId: "da" }),
        )
      ).status,
      200,
    );
    const count = await auditCount(f);
    assert.deepEqual(
      await (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "domain", { domainId: "da" }),
        )
      ).json(),
      { changed: false },
    );
    assert.equal(await auditCount(f), count);
    assert.equal(
      (await call(f, "messages/" + id, "GET", undefined, "bob")).status,
      404,
    );
    assert.equal((await call(f, "drafts", "POST", {}, "bob")).status, 400);
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_identity_grants WHERE tenant_id='a' AND user_id='bob'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "organization"),
          "bob",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("alice", "organization", { status: "revoked" }),
          "bob",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "domain", { domainId: "second" }),
          "bob",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "mailbox", { identityId: "second-box" }),
          "bob",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/memberships/alice",
          "PUT",
          { status: "suspended" },
          "bob",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "mailbox", { identityId: "ia" }),
          "bob",
        )
      ).status,
      200,
    );
    // After losing domain scope, a mailbox admin cannot assign the parent domain role.
    await call(
      f,
      base + "/roles",
      "PUT",
      role("bob", "domain", { domainId: "da", status: "revoked" }),
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "domain", { domainId: "da" }),
          "bob",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("alice", "mailbox", { identityId: "private" }),
          "bob",
        )
      ).status,
      403,
    );
  } finally {
    f.close();
  }
});

test("content delegation checks both administrative scope and the actor permission ceiling", async () => {
  const f = await fixture();
  try {
    await root(f);
    await call(
      f,
      base + "/roles",
      "PUT",
      role("bob", "domain", { domainId: "da" }),
    );
    const before = await auditCount(f);
    for (const input of [
      rights(true),
      rights(false, true),
      rights(false, false, true),
    ])
      assert.equal(
        (await call(f, base + "/mailboxes/ia/grants/bob", "PUT", input, "bob"))
          .status,
        403,
      );
    assert.equal(await auditCount(f), before);
    // Owning full content permissions in one mailbox does not permit delegation elsewhere.
    assert.equal(
      (
        await call(
          f,
          base + "/mailboxes/private/grants/bob",
          "PUT",
          rights(true),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/mailboxes/ia/grants/bob",
          "PUT",
          rights(true, false, false),
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/mailboxes/ia/grants/bob",
          "PUT",
          rights(true, true, false),
          "bob",
        )
      ).status,
      403,
    );
    // Existing privileged bits may be retained while reducing others, without minting rights.
    await call(
      f,
      base + "/mailboxes/ia/grants/bob",
      "PUT",
      rights(true, true, true),
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_send=0,can_manage=0 WHERE tenant_id='a' AND user_id='alice'",
    );
    assert.equal(
      (
        await call(
          f,
          base + "/mailboxes/ia/grants/bob",
          "PUT",
          rights(true, true, false),
        )
      ).status,
      200,
    );
    // An admin without read may revoke a grant; administration does not require message access.
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_read=0 WHERE tenant_id='a' AND user_id='alice'",
    );
    assert.equal(
      (await call(f, base + "/mailboxes/ia/grants/bob", "DELETE")).status,
      200,
    );
    assert.equal(
      (await call(f, base + "/mailboxes/ia/grants/alice", "PUT", rights(true)))
        .status,
      403,
    );
  } finally {
    f.close();
  }
});

test("latent can_manage cannot become effective through a read-only delegate", async () => {
  const f = await fixture();
  try {
    await root(f);
    await call(
      f,
      base + "/mailboxes/ia/grants/bob",
      "PUT",
      rights(false, false, true),
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_manage=0 WHERE user_id='alice'",
    );
    assert.equal(
      (
        await call(
          f,
          base + "/mailboxes/ia/grants/bob",
          "PUT",
          rights(true, false, true),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/mailboxes/ia/grants/bob",
          "PUT",
          rights(true, false, false),
        )
      ).status,
      200,
    );
  } finally {
    f.close();
  }
});

test("membership changes use existing internal IDs, preserve global sessions, roles and content grants", async () => {
  const f = await fixture();
  try {
    await root(f);
    const id = await receive(f);
    assert.equal(
      (
        await call(f, base + "/memberships/missing", "PUT", {
          status: "active",
        })
      ).status,
      404,
    );
    await f.db.execute(
      "INSERT INTO mail_users(id,username,password_hash) SELECT 'charlie','charlie',password_hash FROM mail_users WHERE id='alice'",
    );
    assert.equal(
      (
        await call(f, base + "/memberships/charlie", "PUT", {
          status: "active",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_identity_grants WHERE user_id='charlie'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_admin_grants WHERE user_id='charlie'",
        )
      ).rows[0].n,
      0,
    );
    await call(
      f,
      base + "/roles",
      "PUT",
      role("bob", "domain", { domainId: "da" }),
    );
    await call(
      f,
      base + "/mailboxes/ia/grants/bob",
      "PUT",
      rights(true, true, true),
    );
    const original = (
      await f.db.execute(
        "SELECT * FROM mail_identity_grants WHERE user_id='bob'",
      )
    ).rows;
    await call(f, base + "/memberships/bob", "PUT", { status: "suspended" });
    assert.equal(
      (await call(f, "messages/" + id, "GET", undefined, "bob")).status,
      404,
    );
    assert.equal(
      (await call(f, base + "/domains", "GET", undefined, "bob")).status,
      403,
    );
    const session = await (
      await call(f, "session", "GET", undefined, "bob")
    ).json();
    assert.equal(session.user.id, "bob");
    assert.equal(session.administration.canAdminister, false);
    assert.deepEqual(
      (
        await f.db.execute(
          "SELECT * FROM mail_identity_grants WHERE user_id='bob'",
        )
      ).rows,
      original,
    );
    assert.equal(
      (await (await call(f, "inbox", "GET", undefined, "bob")).json())
        .identities[0].id,
      "ib",
    );
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_read=0 WHERE tenant_id='a' AND user_id='alice'",
    );
    assert.equal(
      (await call(f, base + "/memberships/bob", "PUT", { status: "active" }))
        .status,
      403,
    ); // no restoration above actor's ceiling
    await f.db.execute(
      "UPDATE mail_identity_grants SET can_read=1 WHERE tenant_id='a' AND user_id='alice'",
    );
    assert.equal(
      (await call(f, base + "/memberships/bob", "PUT", { status: "active" }))
        .status,
      200,
    );
    assert.equal(
      (await call(f, "messages/" + id, "GET", undefined, "bob")).status,
      200,
    );
  } finally {
    f.close();
  }
});

test("the last active organization administrator cannot revoke its role or suspend its membership", async () => {
  const f = await fixture();
  try {
    await root(f);
    const before = await auditCount(f);
    for (const [path, input] of [
      [base + "/roles", role("alice", "organization", { status: "revoked" })],
      [base + "/memberships/alice", { status: "suspended" }],
    ] as const) {
      const response = await call(f, path, "PUT", input);
      assert.equal(response.status, 409);
      assert.equal(
        (await response.json()).error,
        "last_organization_administrator",
      );
    }
    assert.equal(await auditCount(f), before);
    // Disabled accounts, suspended members and revoked roles do not count as backups.
    await call(f, base + "/roles", "PUT", role("bob"));
    await call(f, base + "/memberships/bob", "PUT", { status: "suspended" });
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("alice", "organization", { status: "revoked" }),
        )
      ).status,
      409,
    );
    await call(f, base + "/memberships/bob", "PUT", { status: "active" });
    await f.db.execute(
      "UPDATE mail_users SET status='disabled' WHERE id='bob'",
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("alice", "organization", { status: "revoked" }),
        )
      ).status,
      409,
    );
    await f.db.execute("UPDATE mail_users SET status='active' WHERE id='bob'");
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("alice", "organization", { status: "revoked" }),
        )
      ).status,
      200,
    );
    assert.equal((await call(f, base + "/roles")).status, 403);
  } finally {
    f.close();
  }
});

test("shared mailbox permissions and revocation apply immediately to existing sessions without roles granting content", async () => {
  const f = await fixture();
  try {
    await root(f);
    const id = await receive(f);
    await call(
      f,
      base + "/roles",
      "PUT",
      role("bob", "mailbox", { identityId: "ia" }),
    );
    await call(
      f,
      base + "/mailboxes/ia/grants/bob",
      "PUT",
      rights(false, true, false),
    );
    assert.equal(
      (await call(f, "messages/" + id, "GET", undefined, "bob")).status,
      404,
    );
    const saved = await saveDraft(f.db, "bob", f.storage, {
      requestId: randomUUID(),
      identityId: "ia",
      to: [],
      cc: [],
      bcc: [],
      subject: "Private draft",
      text: "Body",
      html: "",
      attachments: [],
    });
    assert.equal(
      (await call(f, "messages/" + saved.id, "GET", undefined, "bob")).status,
      200,
    );
    await call(
      f,
      base + "/mailboxes/ia/grants/bob",
      "PUT",
      rights(true, true, false),
    );
    assert.equal(
      (await call(f, "messages/" + id, "GET", undefined, "bob")).status,
      200,
    );
    assert.equal(
      (
        await call(
          f,
          "messages/" + id + "/trash?identity=ia",
          "POST",
          {},
          "bob",
        )
      ).status,
      403,
    );
    await call(
      f,
      base + "/mailboxes/ia/grants/bob",
      "PUT",
      rights(true, true, true),
    );
    assert.equal(
      (
        await call(
          f,
          "messages/" + id + "/trash?identity=ia",
          "POST",
          {},
          "bob",
        )
      ).status,
      200,
    );
    await call(f, base + "/mailboxes/ia/grants/bob", "DELETE");
    assert.equal(
      (await call(f, "messages/" + id, "GET", undefined, "bob")).status,
      404,
    );
    assert.equal(
      (await call(f, "messages/" + saved.id, "GET", undefined, "bob")).status,
      404,
    );
    assert.equal(
      (await call(f, base + "/mailboxes", "GET", undefined, "bob")).status,
      200,
    ); // metadata admin survives content revocation
  } finally {
    f.close();
  }
});

test("administrative writes and their audit are atomic and retries do not duplicate changes", async () => {
  const f = await fixture();
  try {
    await root(f);
    await f.db.execute(
      "CREATE TRIGGER reject_admin_audit BEFORE INSERT ON mail_administration_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    for (const [path, input] of [
      [base + "/roles", role("bob")],
      [base + "/memberships/bob", { status: "suspended" }],
      [base + "/mailboxes/ia/grants/bob", rights(true)],
    ] as const)
      assert.equal((await call(f, path, "PUT", input)).status, 503);
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_admin_grants WHERE user_id='bob'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT status FROM mail_memberships WHERE tenant_id='a' AND user_id='bob'",
        )
      ).rows[0].status,
      "active",
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_identity_grants WHERE tenant_id='a' AND user_id='bob'",
        )
      ).rows[0].n,
      0,
    );
    await f.db.execute("DROP TRIGGER reject_admin_audit");
    await call(f, base + "/roles", "PUT", role("bob"));
    const count = await auditCount(f);
    await call(f, base + "/roles", "PUT", role("bob"));
    assert.equal(await auditCount(f), count);
    const row = (
      await f.db.execute(
        "SELECT actor_user_id,target_user_id,details_json FROM mail_administration_audit",
      )
    ).rows[0];
    assert.equal(row.actor_user_id, "alice");
    assert.equal(row.target_user_id, "bob");
    assert.deepEqual(Object.keys(JSON.parse(String(row.details_json))).sort(), [
      "after",
      "before",
      "domainId",
      "identityId",
      "roleId",
      "scope",
    ]);
  } finally {
    f.close();
  }
});

test("concurrent administrators cannot remove each other and leave no active organization administrator", async () => {
  const f = await fixture();
  const second = createClient({ url: f.url, timeout: 3000 });
  try {
    await root(f);
    await call(f, base + "/roles", "PUT", role("bob"));
    const change = (actor: User, target: string, db = f.db) =>
      mailRequest(
        f.request(
          base + "/roles",
          {
            method: "PUT",
            body: JSON.stringify(
              role(target, "organization", { status: "revoked" }),
            ),
          },
          actor,
        ),
        ["admin", "organizations", "a", "roles"],
        db,
        () => f.storage,
      );
    const responses = await Promise.all([
      change("alice", "bob"),
      change("bob", "alice", second),
    ]);
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert.ok(responses.every((r) => [200, 403, 409, 503].includes(r.status)));
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_admin_grants WHERE scope='organization' AND status='active'",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(await auditCount(f), 2); // assignment plus exactly one revocation
  } finally {
    second.close();
    f.close();
  }
});

test("list pagination is bounded, scoped and validates cursor context and duplicate filters", async () => {
  const f = await fixture();
  try {
    await root(f);
    const first = await (await call(f, base + "/mailboxes?limit=1")).json();
    assert.equal(first.items.length, 1);
    assert.ok(first.nextCursor);
    const second = await (
      await call(
        f,
        base +
          "/mailboxes?limit=1&cursor=" +
          encodeURIComponent(first.nextCursor),
      )
    ).json();
    assert.equal(second.items.length, 1);
    assert.notEqual(first.items[0].id, second.items[0].id);
    for (const path of [
      base + "/mailboxes?limit=101",
      base + "/mailboxes?limit=0",
      base + "/mailboxes?limit=1&limit=2",
      base + "/domains?domainId=da",
      base + "/roles?unexpected=1",
      base + "/domains?cursor=" + first.nextCursor,
      base + "/mailboxes?cursor=bad",
    ])
      assert.equal((await call(f, path)).status, 400, path);
    await call(
      f,
      base + "/roles",
      "PUT",
      role("bob", "mailbox", { identityId: "ia" }),
    );
    const narrow = await (
      await call(
        f,
        base +
          "/mailboxes?limit=1&cursor=" +
          encodeURIComponent(first.nextCursor),
        "GET",
        undefined,
        "bob",
      )
    ).json();
    assert.ok(narrow.items.every((x: { id: string }) => x.id === "ia"));
  } finally {
    f.close();
  }
});

test("disabled tenant/user, suspended membership, revoked role and revoked session deny administrative APIs", async () => {
  const f = await fixture();
  try {
    await root(f);
    for (const [disable, restore] of [
      [
        "UPDATE mail_admin_grants SET status='revoked' WHERE id='root'",
        "UPDATE mail_admin_grants SET status='active' WHERE id='root'",
      ],
      [
        "UPDATE mail_memberships SET status='suspended' WHERE tenant_id='a' AND user_id='alice'",
        "UPDATE mail_memberships SET status='active' WHERE tenant_id='a' AND user_id='alice'",
      ],
      [
        "UPDATE tenants SET status='disabled' WHERE id='a'",
        "UPDATE tenants SET status='active' WHERE id='a'",
      ],
    ]) {
      await f.db.execute(disable);
      assert.equal((await call(f, base + "/roles")).status, 403);
      assert.equal(
        (
          await call(f, base + "/memberships/bob", "PUT", {
            status: "suspended",
          })
        ).status,
        403,
      );
      await f.db.execute(restore);
    }
    await f.db.execute(
      "UPDATE mail_users SET status='disabled' WHERE id='alice'",
    );
    assert.equal((await call(f, base + "/roles")).status, 401);
    await f.db.execute(
      "UPDATE mail_users SET status='active' WHERE id='alice'",
    );
    await f.db.execute(
      "UPDATE mail_sessions SET revoked_at='2026-01-01' WHERE user_id='alice'",
    );
    assert.equal((await call(f, base + "/roles")).status, 401);
  } finally {
    f.close();
  }
});

test("session, membership and role revocations during body I/O are checked again inside the mutation transaction", async () => {
  for (const [revoke, expected] of [
    [
      "UPDATE mail_sessions SET revoked_at='2026-01-01' WHERE user_id='alice'",
      401,
    ],
    [
      "UPDATE mail_memberships SET status='suspended' WHERE tenant_id='a' AND user_id='alice'",
      403,
    ],
    ["UPDATE mail_admin_grants SET status='revoked' WHERE id='root'", 403],
  ] as const) {
    const f = await fixture();
    try {
      await root(f);
      const stream = new ReadableStream(
        {
          async pull(controller) {
            await f.db.execute(revoke);
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify({ status: "suspended" })),
            );
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const request = f.request(base + "/memberships/bob", {
        method: "PUT",
        body: stream,
        duplex: "half",
      } as RequestInit);
      const response = await mailRequest(
        request,
        ["admin", "organizations", "a", "memberships", "bob"],
        f.db,
        () => f.storage,
      );
      assert.equal(response.status, expected);
      assert.equal(
        (
          await f.db.execute(
            "SELECT status FROM mail_memberships WHERE tenant_id='a' AND user_id='bob'",
          )
        ).rows[0].status,
        "active",
      );
      assert.equal(await auditCount(f), 0);
    } finally {
      f.close();
    }
  }
});

test("cross-tenant resource IDs and targets without membership cannot be used for writes", async () => {
  const f = await fixture();
  try {
    await root(f);
    assert.equal(
      (await call(f, base + "/mailboxes/ib/grants/alice", "PUT", rights(true)))
        .status,
      404,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "domain", { domainId: "db" }),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          f,
          base + "/roles",
          "PUT",
          role("bob", "mailbox", { identityId: "ib" }),
        )
      ).status,
      404,
    );
    await f.db.execute(
      "DELETE FROM mail_memberships WHERE tenant_id='a' AND user_id='bob'",
    );
    assert.equal(
      (await call(f, base + "/mailboxes/ia/grants/bob", "PUT", rights(true)))
        .status,
      404,
    );
    assert.equal(
      (await call(f, base + "/roles", "PUT", role("bob"))).status,
      404,
    );
    assert.equal(await auditCount(f), 0);
  } finally {
    f.close();
  }
});

test("GET metadata, session and rejected writes preserve messages, credentials and legitimate grants", async () => {
  const f = await fixture();
  try {
    await root(f);
    await receive(f);
    const tables = [
      "mail_messages",
      "mail_message_recipients",
      "mail_attachments",
      "mail_sources",
      "mail_sending_configurations",
      "mail_identity_grants",
      "mail_users",
    ];
    const before = await Promise.all(
      tables.map((t) => f.db.execute("SELECT * FROM " + t + " ORDER BY rowid")),
    );
    for (const resource of [
      "domains",
      "mailboxes",
      "memberships",
      "roles",
      "grants",
    ])
      assert.equal((await call(f, base + "/" + resource)).status, 200);
    await call(f, "session");
    await call(
      f,
      base + "/roles",
      "PUT",
      role("bob", "domain", { domainId: "db" }),
    );
    for (let i = 0; i < tables.length; i++)
      assert.deepEqual(
        (await f.db.execute("SELECT * FROM " + tables[i] + " ORDER BY rowid"))
          .rows,
        before[i].rows,
        tables[i],
      );
    const login = await call(
      f,
      "login",
      "POST",
      { username: "alice", password: fixturePassword },
      "none",
    );
    assert.equal(login.status, 200);
  } finally {
    f.close();
  }
});
