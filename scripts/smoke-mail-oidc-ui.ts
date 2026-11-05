import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// UI contract only. The protocol suite validates signed JWTs separately.
// Every Mail request is intercepted; no credentials, provider or live DB is used.
const origin = new URL(process.env.TODOKU_UX_ORIGIN ?? "http://127.0.0.1:3039")
  .origin;
await mkdir(".vercel/oidc-ui", { recursive: true });
const browser = await chromium.launch({ headless: true }),
  results = [];
try {
  for (const [name, width, height] of [
    ["desktop", 1440, 960],
    ["mobile", 390, 844],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: "pt-BR",
    });
    const page = await context.newPage();
    let signedIn = false,
      enabled = true,
      linked = false,
      statusFailed = false,
      passwordLogins = 0,
      links = 0;
    const unexpected: string[] = [],
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.name));
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) {
        unexpected.push(url.origin);
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/mail/"))
        return route.continue(
          process.env.VERCEL_OIDC_TOKEN
            ? {
                headers: {
                  ...request.headers(),
                  "x-vercel-trusted-oidc-idp-token":
                    process.env.VERCEL_OIDC_TOKEN,
                },
              }
            : undefined,
        );
      const json = (body: unknown, status = 200) =>
        route.fulfill({ status, json: body });
      if (url.pathname === "/api/mail/session")
        return signedIn
          ? json({ user: { username: "Owner fixture" } })
          : json({ error: "unauthorized" }, 401);
      if (url.pathname === "/api/mail/oidc/google/status")
        return statusFailed
          ? json({ error: "oidc_unavailable" }, 503)
          : json({
              enabled,
              canLink: signedIn && !linked,
              linked: signedIn && linked,
            });
      if (url.pathname === "/api/mail/login") {
        passwordLogins++;
        assert.equal(request.method(), "POST");
        assert.equal(request.postDataJSON().username, "owner-fixture");
        signedIn = true;
        return json({ authenticated: true });
      }
      if (url.pathname === "/api/mail/logout") {
        signedIn = false;
        return json({ loggedOut: true });
      }
      if (url.pathname === "/api/mail/oidc/google/link") {
        links++;
        assert.equal(request.method(), "POST");
        return route.fulfill({
          status: 303,
          headers: { location: origin + "/mail?authError=google" },
        });
      }
      if (url.pathname === "/api/mail/inbox")
        return json({
          identities: [],
          messages: [],
          nextCursor: null,
          receivingEnabled: false,
          storageReady: false,
          fixture: true,
          sendingEnabled: false,
        });
      unexpected.push(request.method() + " " + url.pathname);
      return json({ error: "unexpected_request" }, 500);
    });
    await page.goto(origin + "/mail");
    await page
      .getByRole("button", { name: "Entrar com Google", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Entrar no Todoku Mail" }).count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Entrar com Google", exact: true })
        .evaluate((el) => el.closest("form")?.method),
      "post",
    );
    await page.screenshot({
      path: `.vercel/oidc-ui/login-${name}.png`,
      fullPage: true,
    });
    await page.getByLabel("Usuário", { exact: true }).fill("owner-fixture");
    await page
      .getByLabel("Senha", { exact: true })
      .fill("synthetic-ui-password");
    await page.getByRole("button", { name: "Entrar no Todoku Mail" }).click();
    await page
      .getByRole("button", { name: "Vincular Google", exact: true })
      .waitFor();
    assert.equal(passwordLogins, 1);
    await page
      .getByRole("button", { name: "Vincular Google", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Não foi possível concluir o acesso Google" })
      .waitFor();
    assert.equal(links, 1);
    await page.getByRole("button", { name: "Escrever", exact: true }).waitFor();
    linked = true;
    await page.reload();
    await page.getByText("Google vinculado", { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Vincular Google", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `.vercel/oidc-ui/linked-${name}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Sair", exact: true })
      .filter({ visible: true })
      .click();
    await page.getByLabel("Usuário", { exact: true }).waitFor();
    enabled = false;
    await page.reload();
    await page.getByRole("button", { name: "Entrar no Todoku Mail" }).waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Entrar com Google", exact: true })
        .count(),
      0,
    );
    statusFailed = true;
    await page.reload();
    await page.getByRole("button", { name: "Entrar no Todoku Mail" }).waitFor();
    assert.equal(
      await page.getByLabel("Senha", { exact: true }).isEnabled(),
      true,
    );
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    results.push({
      viewport: name,
      passwordFallback: true,
      googleButton: true,
      linkRequiresPost: true,
      failedLinkPreservesSession: true,
      linkedStatus: true,
      disabledOrUnavailablePreservesPassword: true,
      horizontalOverflow: false,
      externalRequests: 0,
    });
    await context.close();
  }
  const result = {
    checkedAt: new Date().toISOString(),
    results,
    externalEmails: 0,
    liveGoogleLogin: false,
  };
  await writeFile(
    ".vercel/oidc-ui/result.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
