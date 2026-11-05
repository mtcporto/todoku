import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// UI checks use intercepted requests. No invitation is issued and no Google or
// provider request is made; signed OIDC and database behavior have separate tests.
const origin = new URL(process.env.TODOKU_UX_ORIGIN ?? "http://127.0.0.1:3039")
  .origin;
const token = "a".repeat(43),
  browser = await chromium.launch({ headless: true }),
  results = [];
await mkdir(".vercel/invitations-ui", { recursive: true });
try {
  for (const [name, width, height] of [
    ["desktop", 1440, 960],
    ["mobile", 390, 844],
  ] as const) {
    const context = await browser.newContext({
        viewport: { width, height },
        locale: "pt-BR",
      }),
      page = await context.newPage();
    let signedIn = false,
      accepts = 0,
      handoff = false;
    const errors: string[] = [],
      unexpected: string[] = [];
    page.on("pageerror", (e) => errors.push(e.name));
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin === "https://accounts.google.com" && handoff)
        return route.fulfill({
          contentType: "text/plain",
          body: "Synthetic Google handoff",
        });
      if (url.origin !== origin) {
        unexpected.push(url.origin);
        return route.abort();
      }
      assert.ok(
        !url.href.includes(token),
        "invitation token must stay outside HTTP URLs",
      );
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
      if (url.pathname === "/api/mail/session")
        return route.fulfill({
          status: signedIn ? 200 : 401,
          json: signedIn
            ? { user: { username: "Existing fixture" } }
            : { error: "unauthorized" },
        });
      if (url.pathname === "/api/mail/oidc/google/invite") {
        accepts++;
        assert.equal(request.method(), "POST");
        assert.deepEqual(request.postDataJSON(), { token });
        return route.fulfill(
          handoff
            ? {
                json: {
                  authorizationUrl:
                    "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic",
                },
              }
            : { status: 401, json: { error: "invitation_unavailable" } },
        );
      }
      unexpected.push(request.method() + " " + url.pathname);
      return route.fulfill({ status: 500, json: { error: "unexpected" } });
    });
    await page.goto(origin + "/mail/invite");
    await page.locator("p[role='alert']").waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Aceitar com Google" })
        .isDisabled(),
      true,
    );
    await page.goto("about:blank");
    await page.goto(origin + "/mail/invite#" + token);
    const button = page.getByRole("button", { name: "Aceitar com Google" });
    await button.waitFor();
    await page.waitForFunction(
      () => !(document.querySelector("button") as HTMLButtonElement)?.disabled,
    );
    assert.equal(new URL(page.url()).hash, "");
    assert.ok(!(await page.locator("body").innerText()).includes(token));
    assert.equal(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    await button.focus();
    await page.keyboard.press("Enter");
    await page.locator("p[role='alert']").waitFor();
    assert.equal(accepts, 1);
    assert.equal(await button.isEnabled(), true);
    assert.match(await page.locator("p[role='alert']").innerText(), /expirado/);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: ".vercel/invitations-ui/" + name + ".png",
      fullPage: true,
    });
    signedIn = true;
    await page.goto("about:blank");
    await page.goto(origin + "/mail/invite#" + token);
    await page.getByText("Existing fixture", { exact: true }).waitFor();
    assert.match(
      await page.locator("body").innerText(),
      /preservará seu usuário interno/,
    );
    handoff = true;
    await page.getByRole("button", { name: "Aceitar com Google" }).click();
    await page.waitForURL("https://accounts.google.com/**");
    assert.equal(accepts, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpected, []);
    results.push({
      viewport: name,
      missingToken: true,
      fragmentCleared: true,
      noPersistentToken: true,
      expiredFeedback: true,
      keyboard: true,
      existingSession: true,
      syntheticHandoff: true,
      overflow: false,
    });
    await context.close();
  }
  await writeFile(
    ".vercel/invitations-ui/evidence.json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
