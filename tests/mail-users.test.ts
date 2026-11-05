import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { fixture, fixturePassword, ring } from "./helpers/mail-fixture.ts";
import { config, provider, issuer } from "./helpers/google-oidc-fixture.ts";
import { googleOidcRequest } from "../src/lib/mail/google-oidc.ts";
import { mailRequest } from "../src/lib/mail/http.ts";
import { hash } from "../src/lib/mail/common.ts";
import { migrate } from "../src/lib/migrations.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
function call(
  f: Fixture,
  path: string,
  method = "GET",
  input?: unknown,
  as: "alice" | "bob" | "none" = "alice",
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
      as,
    ),
    path.split("?")[0].split("/"),
    f.db,
    () => f.storage,
  );
}
async function root(f: Fixture) {
  await f.db.execute(
    "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope) VALUES ('root','a','alice','organization')",
  );
}
async function invite(
  f: Fixture,
  email = "new@example.invalid",
  userId?: string,
) {
  const response = await call(f, "admin/organizations/a/invitations", "POST", {
    email,
    ...(userId ? { userId } : {}),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const value = await response.json();
  return { ...value, token: new URL(value.invitationUrl).hash.slice(1) } as {
    id: string;
    expiresAt: string;
    invitationUrl: string;
    token: string;
  };
}
async function flow(
  f: Fixture,
  {
    token,
    as = "none",
    sub = "new-sub",
    email = "new@example.invalid",
    operation = "invite",
    db = f.db,
  }: {
    token?: string;
    as?: "alice" | "bob" | "none";
    sub?: string;
    email?: string;
    operation?: "invite" | "link" | "start";
    db?: Client;
  } = {},
) {
  const p = provider();
  Object.assign(p.override, { sub, email });
  const options = { config, keyring: ring, fetcher: p.fetcher };
  const response = await googleOidcRequest(
    f.request(
      "oidc/google/" + operation,
      { method: "POST", ...(token ? { body: JSON.stringify({ token }) } : {}) },
      as,
    ),
    operation,
    db,
    options,
  );
  assert.equal(response.status, 303, await response.clone().text());
  const url = new URL(response.headers.get("location")!);
  p.setAuthorization(url);
  const attemptCookie = response.headers.getSetCookie()[0].split(";")[0];
  const callback = () =>
    googleOidcRequest(
      new Request(
        config.origin +
          "/api/mail/oidc/google/callback?" +
          new URLSearchParams({
            state: url.searchParams.get("state")!,
            code: "valid-code",
          }),
        { headers: { cookie: attemptCookie } },
      ),
      "callback",
      db,
      options,
    );
  return { p, options, callback };
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .find((x) => x.startsWith("__Host-todoku_mail="))
    ?.split(";")[0];
}
async function accepted(f: Fixture, response: Response) {
  assert.ok(
    cookie(response),
    response.headers.get("location") ?? "missing cookie",
  );
  const session = await call(f, "session", "GET", undefined, "none", {
    cookie: cookie(response)!,
  });
  assert.equal(session.status, 200);
  return session.json();
}
async function count(f: Fixture, table: string) {
  return Number(
    (await f.db.execute("SELECT count(*) AS n FROM " + table)).rows[0].n,
  );
}

test("invitations require organization administration, strict inputs and store only a hash", async () => {
  const f = await fixture();
  try {
    await root(f);
    assert.equal(
      (
        await call(
          f,
          "admin/organizations/a/invitations",
          "POST",
          { email: "new@example.invalid" },
          "bob",
        )
      ).status,
      403,
    );
    await f.db.batch(
      [
        "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('a','bob')",
        "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,domain_id) VALUES ('domain','a','bob','domain','da')",
      ],
      "write",
    );
    assert.equal(
      (
        await call(
          f,
          "admin/organizations/a/invitations",
          "GET",
          undefined,
          "bob",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(f, "admin/organizations/b/invitations", "POST", {
          email: "new@example.invalid",
        })
      ).status,
      403,
    );
    for (const input of [
      { email: "bad" },
      { email: "new@example.invalid", expiresInHours: 169 },
      { email: "new@example.invalid", role: "organization" },
    ])
      assert.equal(
        (await call(f, "admin/organizations/a/invitations", "POST", input))
          .status,
        400,
      );
    const v = await invite(f, "New@example.invalid");
    assert.match(v.token, /^[A-Za-z0-9_-]{43}$/);
    const row = (await f.db.execute("SELECT * FROM mail_invitations")).rows[0];
    assert.equal(row.email_normalized, "new@example.invalid");
    assert.equal(row.token_hash, hash(v.token));
    assert.ok(!JSON.stringify(row).includes(v.token));
    const list = await (
      await call(f, "admin/organizations/a/invitations?limit=1")
    ).json();
    assert.equal(list.items.length, 1);
    assert.ok(!JSON.stringify(list).includes(String(row.token_hash)));
    assert.equal(
      (
        await call(f, "admin/organizations/a/invitations", "POST", {
          email: "new@example.invalid",
        })
      ).status,
      409,
    );
    assert.equal(await count(f, "mail_users"), 2);
    assert.equal(await count(f, "mail_identity_grants"), 2);
  } finally {
    f.close();
  }
});

test("Google invitation creates one internal identity and membership, without content grants, roles or password signup", async () => {
  const f = await fixture();
  try {
    await root(f);
    const v = await invite(f),
      g = await flow(f, { token: v.token });
    const response = await g.callback(),
      s = await accepted(f, response),
      id = s.user.id;
    assert.notEqual(id, "alice");
    assert.notEqual(id, "bob");
    assert.equal(s.session.method, "google");
    assert.equal(s.administration.canAdminister, false);
    assert.equal(s.administration.scopes.length, 0);
    assert.equal(
      (
        await f.db.execute({
          sql: "SELECT status FROM mail_memberships WHERE tenant_id='a' AND user_id=?",
          args: [id],
        })
      ).rows[0].status,
      "active",
    );
    assert.equal(await count(f, "mail_identity_grants"), 2);
    assert.equal(await count(f, "mail_admin_grants"), 1);
    const inbox = await (
      await call(f, "inbox", "GET", undefined, "none", {
        cookie: cookie(response)!,
      })
    ).json();
    assert.equal(inbox.identities.length, 0);
    const username = (
      await f.db.execute({
        sql: "SELECT username FROM mail_users WHERE id=?",
        args: [id],
      })
    ).rows[0].username;
    assert.equal(
      (
        await call(
          f,
          "login",
          "POST",
          { username, password: fixturePassword },
          "none",
        )
      ).status,
      401,
    );
    assert.equal(cookie(await g.callback()), undefined);
    assert.equal(
      (
        await googleOidcRequest(
          f.request(
            "oidc/google/invite",
            { method: "POST", body: JSON.stringify({ token: v.token }) },
            "none",
          ),
          "invite",
          f.db,
          { config, keyring: ring },
        )
      ).status,
      401,
    );
    const login = await flow(f, { operation: "start" });
    assert.equal((await accepted(f, await login.callback())).user.id, id);
    assert.equal(await count(f, "mail_users"), 3);
  } finally {
    f.close();
  }
});

test("an invitation targeting an existing user requires that user session or an already bound subject", async () => {
  const f = await fixture();
  try {
    await root(f);
    const v = await invite(f, "bob@example.invalid", "bob");
    assert.equal(
      cookie(
        await (
          await flow(f, { token: v.token, email: "bob@example.invalid" })
        ).callback(),
      ),
      undefined,
    );
    assert.equal(
      cookie(
        await (
          await flow(f, {
            token: v.token,
            email: "bob@example.invalid",
            as: "alice",
          })
        ).callback(),
      ),
      undefined,
    );
    const response = await (
      await flow(f, { token: v.token, email: "bob@example.invalid", as: "bob" })
    ).callback();
    assert.equal((await accepted(f, response)).user.id, "bob");
    assert.equal(await count(f, "mail_users"), 2);
    assert.equal(
      (await call(f, "session", "GET", undefined, "bob")).status,
      401,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT can_read FROM mail_identity_grants WHERE user_id='bob' AND identity_id='ib'",
        )
      ).rows[0].can_read,
      1,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_identity_grants WHERE user_id='bob' AND tenant_id='a'",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(
      (
        await call(
          f,
          `admin/organizations/a/invitations/${v.id}/revoke`,
          "POST",
          {},
        )
      ).status,
      409,
    );
  } finally {
    f.close();
  }
});

test("Google linking uses explicit authenticated proof, and unknown accounts cannot log in publicly", async () => {
  const f = await fixture();
  try {
    const unknown = await flow(f, {
      operation: "start",
      sub: "unknown",
      email: "bob@example.invalid",
    });
    assert.equal(cookie(await unknown.callback()), undefined);
    const link = await flow(f, {
      operation: "link",
      as: "bob",
      sub: "bob-sub",
      email: "bob@example.invalid",
    });
    assert.equal((await accepted(f, await link.callback())).user.id, "bob");
    const login = await flow(f, {
      operation: "start",
      sub: "bob-sub",
      email: "bob@example.invalid",
    });
    assert.equal((await accepted(f, await login.callback())).user.id, "bob");
    await f.db.execute(
      "UPDATE mail_users SET status='disabled' WHERE id='bob'",
    );
    assert.equal(
      cookie(
        await (
          await flow(f, {
            operation: "start",
            sub: "bob-sub",
            email: "bob@example.invalid",
          })
        ).callback(),
      ),
      undefined,
    );
  } finally {
    f.close();
  }
});

test("a matching email never merges users; an existing Google subject reuses its internal UUID", async () => {
  const f = await fixture();
  try {
    await root(f);
    await f.db.execute({
      sql: "INSERT INTO mail_auth_identities(id,user_id,provider,issuer,subject,verified_email) VALUES ('bound','bob','google',?,'bob-sub','bob@example.invalid')",
      args: [issuer],
    });
    const v = await invite(f, "bob@example.invalid");
    assert.equal(
      cookie(
        await (
          await flow(f, {
            token: v.token,
            sub: "another-sub",
            email: "bob@example.invalid",
          })
        ).callback(),
      ),
      undefined,
    );
    assert.equal(await count(f, "mail_users"), 2);
    const response = await (
      await flow(f, {
        token: v.token,
        sub: "bob-sub",
        email: "bob@example.invalid",
      })
    ).callback();
    assert.equal((await accepted(f, response)).user.id, "bob");
    assert.equal(await count(f, "mail_users"), 2);
    assert.equal(await count(f, "mail_auth_identities"), 1);
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_memberships WHERE user_id='bob'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    f.close();
  }
});

for (const reason of [
  "expired",
  "revoked",
  "wrong_email",
  "unverified",
  "bad_signature",
  "creator_revoked",
  "tenant_disabled",
] as const)
  test(
    "invitation rejects " + reason + " during callback without onboarding",
    async () => {
      const f = await fixture();
      try {
        await root(f);
        const v = await invite(f),
          g = await flow(f, { token: v.token });
        if (reason === "expired")
          await f.db.execute(
            "UPDATE mail_invitations SET expires_at='2000-01-01'",
          );
        if (reason === "revoked")
          await call(
            f,
            `admin/organizations/a/invitations/${v.id}/revoke`,
            "POST",
            {},
          );
        if (reason === "wrong_email")
          g.p.override.email = "wrong@example.invalid";
        if (reason === "unverified") g.p.override.email_verified = false;
        if (reason === "bad_signature") g.p.invalidSignature();
        if (reason === "creator_revoked")
          await f.db.execute("UPDATE mail_admin_grants SET status='revoked'");
        if (reason === "tenant_disabled")
          await f.db.execute(
            "UPDATE tenants SET status='disabled' WHERE id='a'",
          );
        assert.equal(cookie(await g.callback()), undefined);
        assert.equal(await count(f, "mail_users"), 2);
        assert.equal(await count(f, "mail_auth_identities"), 0);
        assert.equal(await count(f, "mail_memberships"), 2);
      } finally {
        f.close();
      }
    },
  );

test("revocation, explicit expiration and reissue are audited and scoped", async () => {
  const f = await fixture();
  try {
    await root(f);
    const v = await invite(f);
    assert.equal(
      (
        await call(
          f,
          `admin/organizations/b/invitations/${v.id}/revoke`,
          "POST",
          {},
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await (
          await call(
            f,
            `admin/organizations/a/invitations/${v.id}/revoke`,
            "POST",
            {},
          )
        ).json()
      ).changed,
      true,
    );
    assert.equal(
      (
        await (
          await call(
            f,
            `admin/organizations/a/invitations/${v.id}/revoke`,
            "POST",
            {},
          )
        ).json()
      ).changed,
      false,
    );
    const second = await invite(f);
    await f.db.execute({
      sql: "UPDATE mail_invitations SET expires_at='2000-01-01' WHERE id=?",
      args: [second.id],
    });
    const third = await invite(f);
    assert.notEqual(second.id, third.id);
    assert.equal(
      (
        await f.db.execute({
          sql: "SELECT state FROM mail_invitations WHERE id=?",
          args: [second.id],
        })
      ).rows[0].state,
      "expired",
    );
    assert.equal(
      (
        await call(
          f,
          `admin/organizations/a/invitations/${third.id}/expire`,
          "POST",
          {},
        )
      ).status,
      200,
    );
    const audit = JSON.stringify(
      (await f.db.execute("SELECT * FROM mail_administration_audit")).rows,
    );
    for (const item of [v, second, third])
      assert.ok(!audit.includes(item.token));
  } finally {
    f.close();
  }
});

test("a suspended membership cannot be restored through invitation, and initiating sessions are rechecked", async () => {
  const f = await fixture();
  try {
    await root(f);
    await f.db.execute(
      "INSERT INTO mail_memberships(tenant_id,user_id,status) VALUES ('a','bob','suspended')",
    );
    assert.equal(
      (
        await call(f, "admin/organizations/a/invitations", "POST", {
          email: "bob@example.invalid",
          userId: "bob",
        })
      ).status,
      409,
    );
    const v = await invite(f, "bob@example.invalid");
    assert.equal(
      cookie(
        await (
          await flow(f, {
            token: v.token,
            as: "bob",
            email: "bob@example.invalid",
          })
        ).callback(),
      ),
      undefined,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT status FROM mail_memberships WHERE tenant_id='a' AND user_id='bob'",
        )
      ).rows[0].status,
      "suspended",
    );
    await f.db.execute(
      "DELETE FROM mail_memberships WHERE tenant_id='a' AND user_id='bob'",
    );
    const g = await flow(f, {
        token: v.token,
        as: "bob",
        email: "bob@example.invalid",
      }),
      original = g.options.fetcher;
    g.options.fetcher = async (...args) => {
      const result = await original(...args);
      await f.db.execute(
        "UPDATE mail_sessions SET revoked_at='2026-01-01' WHERE user_id='bob'",
      );
      return result;
    };
    assert.equal(cookie(await g.callback()), undefined);
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_memberships WHERE tenant_id='a' AND user_id='bob'",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    f.close();
  }
});

test("concurrent acceptance consumes the invitation once across database connections", async () => {
  const f = await fixture(),
    other = createClient({ url: f.url, timeout: 3000 });
  try {
    await root(f);
    const v = await invite(f),
      one = await flow(f, { token: v.token }),
      two = await flow(f, { token: v.token, db: other });
    const responses = await Promise.all([one.callback(), two.callback()]);
    assert.equal(responses.filter((x) => cookie(x)).length, 1);
    assert.equal(await count(f, "mail_users"), 3);
    assert.equal(await count(f, "mail_auth_identities"), 1);
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_administration_audit WHERE action='invitation_accepted'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    other.close();
    f.close();
  }
});

test("audit failure rolls back user, membership, identity and invitation consumption", async () => {
  const f = await fixture();
  try {
    await root(f);
    const v = await invite(f);
    await f.db.execute(
      "CREATE TRIGGER fail_accept BEFORE INSERT ON mail_administration_audit WHEN NEW.action='invitation_accepted' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    assert.equal(
      cookie(await (await flow(f, { token: v.token })).callback()),
      undefined,
    );
    assert.equal(await count(f, "mail_users"), 2);
    assert.equal(await count(f, "mail_memberships"), 2);
    assert.equal(await count(f, "mail_auth_identities"), 0);
    assert.equal(
      (await f.db.execute("SELECT state FROM mail_invitations")).rows[0].state,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("session metadata preserves legacy sessions; only the user can revoke their own opaque session IDs", async () => {
  const f = await fixture();
  try {
    const old = await (await call(f, "session")).json();
    assert.equal(old.session.method, "legacy");
    assert.match(old.session.id, /^[a-f0-9]{32}$/);
    const login = await call(
        f,
        "login",
        "POST",
        { username: "alice", password: fixturePassword },
        "none",
      ),
      newCookie = cookie(login)!;
    const current = await (
      await call(f, "session", "GET", undefined, "none", { cookie: newCookie })
    ).json();
    assert.equal(current.session.method, "password");
    const listing = await (await call(f, "sessions")).json();
    assert.equal(listing.items.length, 2);
    assert.ok(!JSON.stringify(listing).includes("token_hash"));
    const bob = await (
      await call(f, "session", "GET", undefined, "bob")
    ).json();
    assert.equal(
      (await call(f, `sessions/${bob.session.id}/revoke`, "POST", {})).status,
      404,
    );
    assert.equal(
      (
        await call(
          f,
          `sessions/${current.session.id}/revoke`,
          "POST",
          {},
          "alice",
          { origin: "https://evil.invalid" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await call(f, `sessions/${current.session.id}/revoke`, "POST", {}))
        .status,
      200,
    );
    assert.equal(
      (
        await call(f, "session", "GET", undefined, "none", {
          cookie: newCookie,
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await (
          await call(f, `sessions/${current.session.id}/revoke`, "POST", {})
        ).json()
      ).changed,
      false,
    );
    const logout = await call(
      f,
      `sessions/${old.session.id}/revoke`,
      "POST",
      {},
    );
    assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await call(f, "session")).status, 401);
    assert.equal(
      (await call(f, "session", "GET", undefined, "bob")).status,
      200,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_auth_audit_log WHERE action='session_revoked'",
        )
      ).rows[0].n,
      2,
    );
  } finally {
    f.close();
  }
});

test("organization suspension and reactivation preserve global sessions and other organizations", async () => {
  const f = await fixture();
  try {
    await root(f);
    await f.db.execute(
      "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('a','bob')",
    );
    assert.equal(
      (
        await call(f, "admin/organizations/a/memberships/bob", "PUT", {
          status: "suspended",
        })
      ).status,
      200,
    );
    assert.equal(
      (await call(f, "session", "GET", undefined, "bob")).status,
      200,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT status FROM mail_memberships WHERE tenant_id='b' AND user_id='bob'",
        )
      ).rows[0].status,
      "active",
    );
    assert.equal(
      (
        await call(f, "admin/organizations/a/memberships/bob", "PUT", {
          status: "active",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(f, "admin/organizations/a/memberships/alice", "PUT", {
          status: "suspended",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(f, "admin/organizations/a/memberships/bob", "PUT", {
          status: "disabled",
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.db.execute("SELECT status FROM mail_users WHERE id='bob'"))
        .rows[0].status,
      "active",
    );
  } finally {
    f.close();
  }
});

test("invitation limits, pagination and origin validation bound organization onboarding", async () => {
  const f = await fixture();
  try {
    await root(f);
    assert.equal(
      (
        await call(
          f,
          "admin/organizations/a/invitations",
          "POST",
          { email: "new@example.invalid" },
          "alice",
          { origin: "https://foreign.invalid" },
        )
      ).status,
      403,
    );
    for (const email of ["one@example.invalid", "two@example.invalid"])
      await invite(f, email);
    const first = await (
      await call(f, "admin/organizations/a/invitations?limit=1")
    ).json();
    assert.ok(first.nextCursor);
    const second = await (
      await call(
        f,
        "admin/organizations/a/invitations?limit=1&cursor=" + first.nextCursor,
      )
    ).json();
    assert.notEqual(first.items[0].id, second.items[0].id);
    assert.equal(second.nextCursor, null);
    await f.db.batch(
      Array.from({ length: 98 }, (_, i) => ({
        sql: "INSERT INTO mail_invitations(id,tenant_id,email_normalized,token_hash,created_by,expires_at) VALUES (?,'a',?,?,'alice','2099-01-01')",
        args: [
          "bulk-" + i,
          "bulk-" + i + "@example.invalid",
          hash("bulk-" + i),
        ],
      })),
      "write",
    );
    assert.equal(
      (
        await call(f, "admin/organizations/a/invitations", "POST", {
          email: "over@example.invalid",
        })
      ).status,
      429,
    );
    assert.equal(await count(f, "mail_invitations"), 100);
    assert.equal(await count(f, "mail_users"), 2);
    assert.equal(
      (
        await googleOidcRequest(
          f.request(
            "oidc/google/invite",
            { method: "POST", body: '{"token":"short"}' },
            "none",
          ),
          "invite",
          f.db,
          { config, keyring: ring },
        )
      ).status,
      400,
    );
  } finally {
    f.close();
  }
});

test("an untargeted invitation with authenticated proof preserves the existing UUID", async () => {
  const f = await fixture();
  try {
    await root(f);
    const v = await invite(f, "bob@example.invalid");
    const response = await (
      await flow(f, {
        token: v.token,
        as: "bob",
        sub: "bob-sub",
        email: "bob@example.invalid",
      })
    ).callback();
    assert.equal((await accepted(f, response)).user.id, "bob");
    assert.equal(await count(f, "mail_users"), 2);
    assert.equal(await count(f, "mail_identity_grants"), 2);
    await f.db.execute(
      "UPDATE mail_memberships SET status='suspended' WHERE user_id='bob'",
    );
    const login = await (
      await flow(f, {
        operation: "start",
        sub: "bob-sub",
        email: "bob@example.invalid",
      })
    ).callback();
    assert.equal((await accepted(f, login)).user.id, "bob");
    assert.equal(
      (
        await (
          await call(f, "inbox", "GET", undefined, "none", {
            cookie: cookie(login)!,
          })
        ).json()
      ).identities.length,
      0,
    );
  } finally {
    f.close();
  }
});

test("a revoked Google binding cannot be bypassed with a fresh invitation", async () => {
  const f = await fixture();
  try {
    await root(f);
    await f.db.execute({
      sql: "INSERT INTO mail_auth_identities(id,user_id,provider,issuer,subject,verified_email,status) VALUES ('revoked','bob','google',?,'bob-sub','bob@example.invalid','disabled')",
      args: [issuer],
    });
    const v = await invite(f, "bob@example.invalid");
    assert.equal(
      cookie(
        await (
          await flow(f, {
            token: v.token,
            sub: "bob-sub",
            email: "bob@example.invalid",
          })
        ).callback(),
      ),
      undefined,
    );
    assert.equal(await count(f, "mail_users"), 2);
    assert.equal(
      (await f.db.execute("SELECT state FROM mail_invitations")).rows[0].state,
      "pending",
    );
  } finally {
    f.close();
  }
});

test("session revocation requires transactional audit and concurrent requests audit only one change", async () => {
  const f = await fixture(),
    other = createClient({ url: f.url, timeout: 3000 });
  try {
    const login = await call(
      f,
      "login",
      "POST",
      { username: "alice", password: fixturePassword },
      "none",
    );
    const s = await (
      await call(f, "session", "GET", undefined, "none", {
        cookie: cookie(login)!,
      })
    ).json();
    await f.db.execute(
      "CREATE TRIGGER fail_session_audit BEFORE INSERT ON mail_auth_audit_log WHEN NEW.action='session_revoked' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    assert.equal(
      (await call(f, `sessions/${s.session.id}/revoke`, "POST", {})).status,
      503,
    );
    assert.equal(
      (
        await call(f, "session", "GET", undefined, "none", {
          cookie: cookie(login)!,
        })
      ).status,
      200,
    );
    await f.db.execute("DROP TRIGGER fail_session_audit");
    const path = `sessions/${s.session.id}/revoke`;
    const responses = await Promise.all([
      call(f, path, "POST", {}),
      mailRequest(
        f.request(path, { method: "POST", body: "{}" }),
        path.split("/"),
        other,
      ),
    ]);
    const values = await Promise.all(
      responses.map(async (r) => {
        // Independent native SQLite connections may time out on a write lock.
        // A 503 must fail closed; retrying after release is a no-op, not a second audit.
        assert.ok([200, 503].includes(r.status));
        return r.json();
      }),
    );
    assert.equal(values.filter((x) => x.changed).length, 1);
    assert.equal(
      (await (await call(f, path, "POST", {})).json()).changed,
      false,
    );
    assert.equal(
      (
        await f.db.execute(
          "SELECT count(*) AS n FROM mail_auth_audit_log WHERE action='session_revoked'",
        )
      ).rows[0].n,
      1,
    );
  } finally {
    other.close();
    f.close();
  }
});

test("0008 is additive, preserves old session fields and supports the previous production writer", async () => {
  const root = await mkdtemp(
      join(process.env.TODOKU_TEST_TMPDIR!, "sessions-upgrade-"),
    ),
    dir = join(root, "migrations"),
    db = createClient({
      url: "file:" + join(root, "test.db").replaceAll("\\", "/"),
    });
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir);
    for (const name of (await readdir("migrations")).filter(
      (x) => x.endsWith(".sql") && !x.startsWith("0008"),
    ))
      await cp(join("migrations", name), join(dir, name));
    await migrate(db, dir);
    await db.execute(
      "INSERT INTO mail_users(id,username,password_hash) VALUES ('owner','owner','existing-hash')",
    );
    const token = randomBytes(32).toString("base64url");
    await db.execute({
      sql: "INSERT INTO mail_sessions(token_hash,user_id,expires_at) VALUES (?,'owner','2099-01-01')",
      args: [hash(token)],
    });
    await db.execute(
      "INSERT INTO mail_auth_audit_log(id,user_id,provider,action) VALUES ('before','owner','google','oidc_login')",
    );
    const sql =
        "SELECT token_hash,user_id,created_at,expires_at,revoked_at FROM mail_sessions ORDER BY token_hash",
      before = (await db.execute(sql)).rows;
    assert.deepEqual(await migrate(db, "migrations"), [
      "0008_mail_users_invitations_sessions",
    ]);
    assert.deepEqual((await db.execute(sql)).rows, before);
    const upgraded = (
      await db.execute("SELECT session_id,auth_method FROM mail_sessions")
    ).rows[0];
    assert.match(String(upgraded.session_id), /^[a-f0-9]{32}$/);
    assert.equal(upgraded.auth_method, "legacy");
    await db.execute(
      "INSERT INTO mail_sessions(token_hash,user_id,expires_at) VALUES ('old-writer','owner','2099-01-01')",
    );
    assert.equal(
      (
        await db.execute(
          "SELECT length(session_id) AS n FROM mail_sessions WHERE token_hash='old-writer'",
        )
      ).rows[0].n,
      32,
    );
    assert.equal(
      (await db.execute("SELECT details_json FROM mail_auth_audit_log")).rows[0]
        .details_json,
      "{}",
    );
    assert.equal(
      (await db.execute("SELECT count(*) AS n FROM mail_invitations")).rows[0]
        .n,
      0,
    );
    assert.deepEqual(await migrate(db, "migrations"), []);
    assert.equal(
      (await db.execute("PRAGMA integrity_check")).rows[0].integrity_check,
      "ok",
    );
    assert.equal((await db.execute("PRAGMA foreign_key_check")).rows.length, 0);
  } finally {
    db.close();
  }
});
