import assert from "node:assert/strict";
const origin = new URL(process.argv[2] ?? "https://todoku.com.br");
if (
  origin.protocol !== "https:" ||
  origin.pathname !== "/" ||
  origin.username ||
  origin.password
)
  throw new Error("Select an HTTPS origin");
const extra: Record<string, string> = {};
if (origin.hostname.endsWith(".vercel.app") && process.env.VERCEL_OIDC_TOKEN)
  extra["x-vercel-trusted-oidc-idp-token"] = process.env.VERCEL_OIDC_TOKEN;
const call = (path: string, init: RequestInit = {}) =>
  fetch(new URL(path, origin), {
    ...init,
    headers: {
      origin: origin.origin,
      "content-type": "application/json",
      ...extra,
      ...init.headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
let cookie = "";
try {
  assert.equal((await call("/mail")).status, 200);
  assert.equal((await call("/api/mail/inbox")).status, 401);
  assert.equal(
    (
      await call("/api/mail/login", {
        method: "POST",
        headers: { origin: "https://attacker.invalid" },
        body: "{}",
      })
    ).status,
    403,
  );
  const login = await call("/api/mail/login", {
    method: "POST",
    body: JSON.stringify({
      username: process.env.TODOKU_MAIL_USERNAME,
      password: process.env.TODOKU_MAIL_PASSWORD,
    }),
  });
  assert.equal(login.status, 200);
  const rawCookie = login.headers.get("set-cookie")!;
  assert.ok(rawCookie.includes("Secure"));
  assert.ok(rawCookie.includes("HttpOnly"));
  cookie = rawCookie.split(";")[0];
  const inbox = await call("/api/mail/inbox", { headers: { cookie } });
  assert.equal(inbox.status, 200);
  const data = await inbox.json();
  assert.equal(data.receivingEnabled, false);
  assert.equal(data.storageReady, false);
  assert.equal(data.fixture, false);
  assert.equal(data.messages.length, 0);
  assert.equal(data.identities.length, 2);
  const worker = await call("/api/internal/mail-worker", {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(worker.status, 200);
  assert.equal((await worker.json()).state, "receiving_disabled");
  const notifications = await call("/api/internal/worker", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    body: JSON.stringify({
      configurationId: "8ed86af4-bb79-481b-8b85-ce240762160e",
    }),
  });
  assert.equal(notifications.status, 403);
  assert.equal(
    (await call("/api/mail/logout", { method: "POST", headers: { cookie } }))
      .status,
    200,
  );
  assert.equal(
    (await call("/api/mail/session", { headers: { cookie } })).status,
    401,
  );
  cookie = "";
  console.log(
    JSON.stringify({
      origin: origin.origin,
      authentication: true,
      identities: 2,
      privateInbox: true,
      receiving: "disabled",
      storage: "unconfigured",
      notifications: "blocked",
      externalMessages: 0,
    }),
  );
} finally {
  if (cookie)
    await call("/api/mail/logout", { method: "POST", headers: { cookie } });
}
