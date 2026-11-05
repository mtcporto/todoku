import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type { CustomFetch } from "openid-client";
import {
  googleOidcRequest,
  type GoogleConfig,
} from "../src/lib/mail/google-oidc.ts";
import { authRequest, requireUser } from "../src/lib/mail/auth.ts";
import { mailRequest } from "../src/lib/mail/http.ts";
import { hash } from "../src/lib/mail/common.ts";
import { migrate } from "../src/lib/migrations.ts";
import { resolve } from "node:path";
import {
  fixture,
  fixturePassword,
  ring,
  message,
  provider as inboundProvider,
} from "./helpers/mail-fixture.ts";
import { runMailWorker } from "../src/lib/mail/worker.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const config: GoogleConfig = {
  origin: "https://todoku.test",
  clientId: "fixture.apps.googleusercontent.com",
  clientSecret: "private-oauth-fixture",
  ownerUserId: "alice",
  allowedEmail: "owner@example.invalid",
};
const issuer = "https://accounts.google.com";
type Fixture = Awaited<ReturnType<typeof fixture>>;
function provider() {
  let authorization: URL;
  const override: Record<string, unknown> = {};
  let invalidSignature = false,
    tokenCalls = 0,
    jwksCalls = 0;
  const fetcher: CustomFetch = async (url, init) => {
    assert.equal(init.redirect, "manual");
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      jwksCalls++;
      return Response.json({
        keys: [
          {
            ...keys.publicKey.export({ format: "jwk" }),
            kid: "fixture-key",
            alg: "RS256",
            use: "sig",
          },
        ],
      });
    }
    assert.equal(url, "https://oauth2.googleapis.com/token");
    tokenCalls++;
    const body = new URLSearchParams(init.body as URLSearchParams);
    assert.equal(body.get("client_id"), config.clientId);
    assert.equal(body.get("client_secret"), config.clientSecret);
    assert.equal(
      body.get("redirect_uri"),
      config.origin + "/api/mail/oidc/google/callback",
    );
    assert.equal(body.get("grant_type"), "authorization_code");
    assert.equal(body.get("code"), "valid-code");
    assert.equal(
      createHash("sha256")
        .update(body.get("code_verifier")!)
        .digest("base64url"),
      authorization.searchParams.get("code_challenge"),
    );
    const now = Math.floor(Date.now() / 1000);
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwt = [
      encoded({ alg: "RS256", kid: "fixture-key" }),
      encoded({
        iss: issuer,
        aud: config.clientId,
        sub: "google-owner-sub",
        iat: now,
        exp: now + 600,
        nonce: authorization.searchParams.get("nonce"),
        email: config.allowedEmail,
        email_verified: true,
        ...override,
      }),
    ].join(".");
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(jwt),
      invalidSignature ? otherKeys.privateKey : keys.privateKey,
    ).toString("base64url");
    return Response.json({
      access_token: "unused-provider-access-token",
      token_type: "Bearer",
      expires_in: 600,
      id_token: jwt + "." + signature,
    });
  };
  return {
    fetcher,
    override,
    get tokenCalls() {
      return tokenCalls;
    },
    get jwksCalls() {
      return jwksCalls;
    },
    invalidSignature: () => {
      invalidSignature = true;
    },
    setAuthorization: (url: URL) => {
      authorization = url;
    },
  };
}
async function begin(
  f: Fixture,
  operation: "link" | "start" = "link",
  p = provider(),
) {
  const options = { config, keyring: ring, fetcher: p.fetcher };
  const response = await googleOidcRequest(
    f.request(
      "oidc/google/" + operation,
      { method: "POST" },
      operation === "link" ? "alice" : "none",
    ),
    operation,
    f.db,
    options,
  );
  assert.equal(response.status, 303);
  const url = new URL(response.headers.get("location")!);
  p.setAuthorization(url);
  const cookie = response.headers.getSetCookie()[0].split(";")[0];
  const callback = (
    parameters: Record<string, string> = {},
    cookieOverride = cookie,
  ) => {
    const query = new URLSearchParams({
      code: "valid-code",
      state: url.searchParams.get("state")!,
      ...parameters,
    });
    return googleOidcRequest(
      new Request(config.origin + "/api/mail/oidc/google/callback?" + query, {
        headers: { cookie: cookieOverride, "sec-fetch-site": "cross-site" },
      }),
      "callback",
      f.db,
      options,
    );
  };
  return { response, url, cookie, callback, options, provider: p };
}
function sessionCookie(response: Response) {
  return response.headers
    .getSetCookie()
    .find((x) => x.startsWith("__Host-todoku_mail="))
    ?.split(";")[0];
}
async function linked(f: Fixture) {
  const flow = await begin(f);
  const response = await flow.callback();
  assert.equal(response.headers.get("location"), config.origin + "/mail");
  assert.ok(sessionCookie(response));
  return { flow, response };
}
async function denied(f: Fixture, response: Response) {
  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    config.origin + "/mail?authError=google",
  );
  assert.equal(sessionCookie(response), undefined);
  assert.equal(
    (await f.db.execute("SELECT count(*) AS n FROM mail_auth_identities"))
      .rows[0].n,
    0,
  );
}

test("Google OIDC is off by default and password access works with an unmigrated OIDC schema", async () => {
  const f = await fixture();
  try {
    await f.db.execute("DROP TABLE mail_oidc_attempts");
    await f.db.execute("DROP TABLE mail_auth_identities");
    await f.db.execute(
      "DELETE FROM schema_migrations WHERE version='0005_mail_oidc'",
    );
    const off = await googleOidcRequest(
      f.request("oidc/google/status", {}, "none"),
      "status",
      f.db,
      { config: null },
    );
    assert.equal((await off.json()).enabled, false);
    const unmigrated = await googleOidcRequest(
      f.request("oidc/google/status", {}, "none"),
      "status",
      f.db,
      { config },
    );
    assert.equal((await unmigrated.json()).enabled, false);
    const login = await authRequest(
      f.db,
      f.request(
        "login",
        {
          method: "POST",
          body: JSON.stringify({
            username: "alice",
            password: fixturePassword,
          }),
        },
        "none",
      ),
      "login",
    );
    assert.equal(login.status, 200);
    assert.ok(sessionCookie(login));
  } finally {
    f.close();
  }
});

test("Google OIDC first link preserves internal user and grants, rotates the session and encrypts temporary secrets", async () => {
  const f = await fixture();
  try {
    const oldCookie = f.request("session").headers.get("cookie")!;
    const before = (
      await f.db.execute(
        "SELECT * FROM mail_identity_grants ORDER BY tenant_id,identity_id,user_id",
      )
    ).rows;
    const flow = await begin(f);
    assert.equal(flow.url.origin, issuer);
    assert.equal(flow.url.searchParams.get("scope"), "openid email");
    assert.equal(flow.url.searchParams.get("code_challenge_method"), "S256");
    assert.ok(!flow.url.searchParams.has("client_secret"));
    const cookie = flow.response.headers.getSetCookie()[0];
    for (const attr of [
      "__Host-todoku_oidc=",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/",
      "Max-Age=600",
    ])
      assert.ok(cookie.includes(attr));
    const row = (await f.db.execute("SELECT * FROM mail_oidc_attempts"))
      .rows[0];
    assert.notEqual(row.token_hash, flow.cookie.split("=")[1]);
    assert.ok(
      !String(row.encrypted_context).includes(
        flow.url.searchParams.get("nonce")!,
      ),
    );
    const response = await flow.callback();
    assert.equal(response.headers.get("location"), config.origin + "/mail");
    const newCookie = sessionCookie(response)!;
    assert.notEqual(oldCookie, newCookie);
    assert.ok(
      response.headers
        .getSetCookie()
        .find((x) => x.startsWith("__Host-todoku_mail="))!
        .includes("SameSite=Strict"),
    );
    assert.deepEqual(
      await requireUser(
        f.db,
        f.request("session", { headers: { cookie: newCookie } }, "none"),
      ),
      { id: "alice", username: "alice" },
    );
    await assert.rejects(
      requireUser(
        f.db,
        f.request("session", { headers: { cookie: oldCookie } }),
      ),
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_users")).rows[0].n,
      2,
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_oidc_attempts"))
        .rows[0].n,
      0,
    );
    assert.deepEqual(
      (
        await f.db.execute(
          "SELECT * FROM mail_identity_grants ORDER BY tenant_id,identity_id,user_id",
        )
      ).rows,
      before,
    );
    assert.equal(flow.provider.jwksCalls, 1);
    assert.equal(
      (await f.db.execute("SELECT action FROM mail_auth_audit_log")).rows[0]
        .action,
      "oidc_linked",
    );
    await assert.rejects(
      f.db.execute("UPDATE mail_auth_audit_log SET action='tampered'"),
    );
    await assert.rejects(f.db.execute("DELETE FROM mail_auth_audit_log"));
    const link = (await f.db.execute("SELECT * FROM mail_auth_identities"))
      .rows[0];
    assert.equal(link.user_id, "alice");
    assert.equal(link.subject, "google-owner-sub");
    assert.ok(!JSON.stringify(link).includes("unused-provider-access-token"));
  } finally {
    f.close();
  }
});

test("Google OIDC subsequent sign-in uses issuer/sub, retains tenant isolation and accepts normal session revocation", async () => {
  const f = await fixture();
  try {
    await linked(f);
    const flow = await begin(f, "start"),
      response = await flow.callback();
    assert.equal(response.headers.get("location"), config.origin + "/mail");
    const cookie = sessionCookie(response)!;
    const otherMessage = message({
      to: ["inbox@b.example.invalid"],
      received_for: ["inbox@b.example.invalid"],
    });
    await f.enqueue(otherMessage, f.otherSource);
    assert.equal(
      (
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          keyring: ring,
          provider: () => inboundProvider(otherMessage),
        })
      ).state,
      "completed",
    );
    const otherId = String(
      (
        await f.db.execute({
          sql: "SELECT id FROM mail_messages WHERE source_id=?",
          args: [f.otherSource],
        })
      ).rows[0].id,
    );
    const inbox = await mailRequest(
      f.request("inbox", { headers: { cookie } }, "none"),
      ["inbox"],
      f.db,
      () => f.storage,
    );
    assert.equal(inbox.status, 200);
    const data = await inbox.json();
    assert.deepEqual(
      data.identities.map((x: { id: string }) => x.id),
      ["ia"],
    );
    const other = await mailRequest(
      f.request("inbox?identity=ib", { headers: { cookie } }, "none"),
      ["inbox"],
      f.db,
      () => f.storage,
    );
    assert.equal(other.status, 200);
    assert.deepEqual((await other.json()).messages, []);
    const forbidden = await mailRequest(
      f.request("messages/" + otherId, { headers: { cookie } }, "none"),
      ["messages", otherId],
      f.db,
      () => f.storage,
    );
    assert.equal(forbidden.status, 404);
    await f.db.execute({
      sql: "UPDATE mail_sessions SET revoked_at='2026-01-01' WHERE token_hash=?",
      args: [hash(cookie.split("=")[1])],
    });
    await assert.rejects(
      requireUser(f.db, f.request("session", { headers: { cookie } }, "none")),
    );
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_auth_identities"))
        .rows[0].n,
      1,
    );
  } finally {
    f.close();
  }
});

test("Google OIDC does not bootstrap by email or grant mailbox access", async () => {
  const f = await fixture();
  try {
    const flow = await begin(f, "start");
    await denied(f, await flow.callback());
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_users")).rows[0].n,
      2,
    );
    const second = await begin(f);
    second.provider.override.email = "someone-else@example.invalid";
    await denied(f, await second.callback());
    // Even a linked user with no grants receives no mailbox permissions.
    await linked(f);
    await f.db.execute(
      "DELETE FROM mail_identity_grants WHERE user_id='alice'",
    );
    const again = await begin(f, "start"),
      response = await again.callback();
    const inbox = await mailRequest(
      f.request(
        "inbox",
        { headers: { cookie: sessionCookie(response)! } },
        "none",
      ),
      ["inbox"],
      f.db,
      () => f.storage,
    );
    assert.deepEqual((await inbox.json()).identities, []);
  } finally {
    f.close();
  }
});

for (const [name, claims, invalidSignature] of [
  ["wrong issuer", { iss: "https://evil.example.invalid" }, false],
  ["wrong audience", { aud: "another-client" }, false],
  [
    "wrong authorized party",
    { aud: [config.clientId, "another"], azp: "another" },
    false,
  ],
  ["expired token", { iat: 1, exp: 2 }, false],
  ["wrong nonce", { nonce: "wrong-nonce" }, false],
  ["unverified email", { email_verified: false }, false],
  ["string verification flag", { email_verified: "true" }, false],
  ["missing subject", { sub: "" }, false],
  ["invalid signature", {}, true],
] as const)
  test(
    "Google OIDC rejects " + name + " without creating an account or session",
    async () => {
      const f = await fixture();
      try {
        const flow = await begin(f);
        Object.assign(flow.provider.override, claims);
        if (invalidSignature) flow.provider.invalidSignature();
        await denied(f, await flow.callback());
        assert.equal(
          (await f.db.execute("SELECT count(*) AS n FROM mail_sessions"))
            .rows[0].n,
          2,
        );
      } finally {
        f.close();
      }
    },
  );

test("Google OIDC rejects missing browser cookie, wrong state, duplicate state, expired context and revoked initiating session", async () => {
  const f = await fixture();
  try {
    const flow = await begin(f);
    await denied(f, await flow.callback({}, ""));
    await denied(f, await flow.callback({ state: "x".repeat(43) }));
    const duplicateUrl =
      config.origin +
      "/api/mail/oidc/google/callback?code=valid-code&state=" +
      flow.url.searchParams.get("state") +
      "&state=x";
    await denied(
      f,
      await googleOidcRequest(
        new Request(duplicateUrl, { headers: { cookie: flow.cookie } }),
        "callback",
        f.db,
        flow.options,
      ),
    );
    assert.equal(flow.provider.tokenCalls, 0);
    await f.db.execute("UPDATE mail_oidc_attempts SET expires_at='2000-01-01'");
    await denied(f, await flow.callback());
    assert.equal(flow.provider.tokenCalls, 0);
    const again = await begin(f);
    await f.db.execute(
      "UPDATE mail_sessions SET revoked_at='2026-01-01' WHERE user_id='alice'",
    );
    await denied(f, await again.callback());
  } finally {
    f.close();
  }
});

test("Google OIDC consumes callbacks atomically and rejects replay and disabled bindings", async () => {
  const f = await fixture();
  try {
    const flow = await begin(f);
    const responses = await Promise.all([flow.callback(), flow.callback()]);
    assert.equal(
      responses.filter(
        (x) => x.headers.get("location") === config.origin + "/mail",
      ).length,
      1,
    );
    assert.equal(flow.provider.tokenCalls, 1);
    const replay = await flow.callback();
    assert.ok(replay.headers.get("location")!.includes("authError=google"));
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_auth_identities"))
        .rows[0].n,
      1,
    );
    // Login must not reassign a subject that was disabled or mapped to another user.
    await f.db.execute("UPDATE mail_auth_identities SET status='disabled'");
    const again = await begin(f, "start");
    const response = await again.callback();
    assert.equal(sessionCookie(response), undefined);
  } finally {
    f.close();
  }
});

test("Google OIDC cannot claim another user's subject or replace an existing owner's Google account", async () => {
  const f = await fixture();
  try {
    await f.db.execute({
      sql: "INSERT INTO mail_auth_identities(id,user_id,provider,issuer,subject,verified_email) VALUES ('other-binding','bob','google',?,?,?)",
      args: [issuer, "google-owner-sub", config.allowedEmail],
    });
    const first = await begin(f);
    assert.equal(sessionCookie(await first.callback()), undefined);
    assert.equal((await f.db.execute("SELECT user_id FROM mail_auth_identities")).rows[0].user_id, "bob");
    await f.db.execute("DELETE FROM mail_auth_identities");
    await f.db.execute({
      sql: "INSERT INTO mail_auth_identities(id,user_id,provider,issuer,subject,verified_email) VALUES ('owner-binding','alice','google',?,?,?)",
      args: [issuer, "existing-different-subject", config.allowedEmail],
    });
    const second = await begin(f);
    assert.equal(sessionCookie(await second.callback()), undefined);
    assert.equal((await f.db.execute("SELECT subject FROM mail_auth_identities")).rows[0].subject, "existing-different-subject");
  } finally { f.close(); }
});

test("Google OIDC rechecks session revocation after the provider exchange and user suspension before sign-in", async () => {
  const f = await fixture();
  try {
    const flow = await begin(f), fetcher = flow.options.fetcher;
    flow.options.fetcher = async (url, init) => {
      const result = await fetcher(url, init);
      if (url === "https://oauth2.googleapis.com/token") await f.db.execute("UPDATE mail_sessions SET revoked_at='2026-01-01' WHERE user_id='alice'");
      return result;
    };
    await denied(f, await flow.callback());
    assert.equal((await f.db.execute("SELECT action FROM mail_auth_audit_log")).rows[0].action, "oidc_denied");
    await f.db.execute({
      sql: "INSERT INTO mail_auth_identities(id,user_id,provider,issuer,subject,verified_email) VALUES ('owner-binding','alice','google',?,?,?)",
      args: [issuer, "google-owner-sub", config.allowedEmail],
    });
    const login = await begin(f, "start");await f.db.execute("UPDATE mail_users SET status='disabled' WHERE id='alice'");
    assert.equal(sessionCookie(await login.callback()), undefined);
  } finally { f.close(); }
});

test("Google OIDC blocks cross-origin starts, wrong methods, non-owner linking and invalid origins", async () => {
  const f = await fixture();
  try {
    const options = { config, keyring: ring };
    for (const headers of [
      { origin: "https://evil.example.invalid" },
      { "sec-fetch-site": "cross-site" },
    ] as Record<string, string>[])
      assert.equal(
        (
          await googleOidcRequest(
            f.request("oidc/google/link", { method: "POST", headers }),
            "link",
            f.db,
            options,
          )
        ).status,
        403,
      );
    assert.equal(
      (
        await googleOidcRequest(
          f.request("oidc/google/link", { method: "POST" }, "bob"),
          "link",
          f.db,
          options,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await googleOidcRequest(
          f.request("oidc/google/link", { method: "POST" }, "none"),
          "link",
          f.db,
          options,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await googleOidcRequest(
          f.request("oidc/google/start"),
          "start",
          f.db,
          options,
        )
      ).status,
      405,
    );
    const wrong = new Request(
      "https://alias.example.invalid/api/mail/oidc/google/start",
      { method: "POST", headers: { origin: config.origin } },
    );
    assert.equal(
      (await googleOidcRequest(wrong, "start", f.db, options)).status,
      403,
    );
    const bad = await googleOidcRequest(
      f.request("oidc/google/status"),
      "status",
      f.db,
      { config: { ...config, origin: "https://todoku.test/evil" } },
    );
    assert.equal(bad.status, 503);
    const before = (
      await f.db.execute("SELECT count(*) AS n FROM mail_oidc_attempts")
    ).rows[0].n;
    assert.equal(before, 0);
  } finally {
    f.close();
  }
});

test("Google OIDC start budget is bounded and migration is additive and idempotent", async () => {
  const f = await fixture();
  try {
    const before = (await f.db.execute("SELECT * FROM mail_users ORDER BY id"))
      .rows;
    assert.deepEqual(await migrate(f.db, resolve("migrations")), []);
    assert.deepEqual(
      (await f.db.execute("SELECT * FROM mail_users ORDER BY id")).rows,
      before,
    );
    await f.db.execute({
      sql: "INSERT INTO mail_login_limits(bucket,attempts,resets_at) VALUES (?,30,?)",
      args: [
        hash("oidc:google:start"),
        new Date(Date.now() + 60000).toISOString(),
      ],
    });
    const response = await googleOidcRequest(
      f.request("oidc/google/start", { method: "POST" }, "none"),
      "start",
      f.db,
      { config, keyring: ring },
    );
    assert.equal(response.status, 429);
    assert.equal(
      (await f.db.execute("SELECT count(*) AS n FROM mail_oidc_attempts"))
        .rows[0].n,
      0,
    );
  } finally {
    f.close();
  }
});
