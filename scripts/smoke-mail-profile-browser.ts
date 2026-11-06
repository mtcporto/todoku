import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";
import { fixture, message, provider } from "../tests/helpers/mail-fixture.ts";
import { mailRequest } from "../src/lib/mail/http.ts";
import { googleOidcRequest } from "../src/lib/mail/google-oidc.ts";
import { runMailWorker } from "../src/lib/mail/worker.ts";
import { hash } from "../src/lib/mail/common.ts";
const origin = new URL(process.env.TODOKU_UX_ORIGIN ?? "http://127.0.0.1:3039")
  .origin;
const browser = await chromium.launch({ headless: true }),
  results: object[] = [];
await mkdir(".vercel/profile-ui", { recursive: true });
async function profileReady(page: Page) {
  await page
    .getByRole("heading", { name: "Seu acesso", exact: true })
    .waitFor();
}
async function loadAllSessions(page: Page) {
  while (
    await page
      .getByRole("button", { name: "Carregar mais sessões", exact: true })
      .count()
  ) {
    await page
      .getByRole("button", { name: "Carregar mais sessões", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll("button")).some(
          (b) => b.textContent === "Carregando…",
        ),
    );
  }
}
async function profileMethod(page: Page) {
  return page
    .locator(".profile-facts div")
    .filter({ has: page.getByText("Método da sessão atual", { exact: true }) })
    .locator("dd")
    .innerText();
}
try {
  for (const [viewport, width, height] of [
    ["desktop", 1440, 960],
    ["mobile", 390, 844],
  ] as const) {
    const f = await fixture(),
      context = await browser.newContext({
        viewport: { width, height },
        locale: "pt-BR",
      });
    const errors: string[] = [],
      writes: string[] = [];
    let googleAvailable = true,
      failSessions = false,
      failInbox = false;
    try {
      await f.db.batch(
        [
          "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('b','alice')",
          "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_read) VALUES ('b','ib','alice',1),('a','private','alice',0)",
          "UPDATE mail_identities SET status='disabled' WHERE id='private'",
          "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope) VALUES ('root','a','alice','organization')",
          "INSERT INTO mail_auth_identities(id,user_id,provider,issuer,subject,verified_email) VALUES ('google-a','alice','google','https://accounts.google.com','alice-sub','alice@example.invalid')",
          "UPDATE mail_sessions SET auth_method='password' WHERE user_id='alice'",
          ...Array.from({ length: 27 }, (_, i) => ({
            sql: "INSERT INTO mail_sessions(token_hash,session_id,user_id,auth_method,created_at,expires_at) VALUES (?,?,'alice',?,'2026-01-01T01:00:00Z','2099-01-01T01:00:00Z')",
            args: ["fixture-" + i, randomUUID(), i === 0 ? "legacy" : "google"],
          })),
        ],
        "write",
      );
      for (const [address, source] of [
        ["inbox@a.example.invalid", f.source],
        ["inbox@b.example.invalid", f.otherSource],
      ] as const) {
        const value = message({
          to: [address],
          received_for: [address],
          subject: "Conversa " + address,
        });
        await f.enqueue(value, source);
        await runMailWorker(f.db, f.storage, {
          enabled: true,
          fixtures: true,
          provider: () => provider(value),
        });
      }
      const token = f.request("").headers.get("cookie")!.split("=")[1];
      await context.addCookies([
        {
          name: origin.startsWith("https:")
            ? "__Host-todoku_mail"
            : "todoku_mail",
          value: token,
          url: origin,
          httpOnly: true,
          secure: origin.startsWith("https:"),
          sameSite: "Strict",
        },
      ]);
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== origin) {
          errors.push("unexpected external request");
          return route.abort();
        }
        if (
          !url.pathname.startsWith("/api/mail/") &&
          (url.pathname.startsWith("/api/") ||
            !["GET", "HEAD"].includes(request.method()))
        ) {
          errors.push("unexpected remote operation");
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
        const path = url.pathname.slice("/api/mail/".length),
          segments = path.split("/");
        if (
          !["session", "sessions", "inbox", "admin", "logout"].includes(
            segments[0],
          ) &&
          path !== "oidc/google/status"
        ) {
          errors.push("unexpected Mail operation");
          return route.abort();
        }
        if (request.method() !== "GET") writes.push(path);
        if (path === "sessions" && failSessions)
          return route.fulfill({ status: 503, json: { error: "unavailable" } });
        const req = new Request(request.url(), {
          method: request.method(),
          headers: await request.allHeaders(),
          ...(request.postData() ? { body: request.postData()! } : {}),
        });
        if (path === "inbox" && failInbox)
          return route.fulfill({ status: 503, json: { error: "unavailable" } });
        const response =
          path === "oidc/google/status"
            ? await googleOidcRequest(req, "status", f.db, {
                config: googleAvailable
                  ? {
                      origin,
                      clientId: "fixture.apps.googleusercontent.com",
                      clientSecret: "!fixture-only",
                      ownerUserId: "alice",
                      allowedEmail: "alice@example.invalid",
                    }
                  : null,
              })
            : await mailRequest(req, segments, f.db, () => f.storage);
        if (request.method() !== "GET")
          await new Promise((resolve) => setTimeout(resolve, 100));
        return route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: await response.text(),
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on("pageerror", (e) => errors.push(e.name));
      await page.goto(origin + "/mail");
      const profileMenu = page.locator(".account-menu summary");
      await profileMenu.waitFor();
      await profileMenu.focus();
      await page.keyboard.press("Enter");
      await page
        .getByRole("link", { name: "Meu perfil e sessões", exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const r = document
          .querySelector(".account-popover")!
          .getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth;
      });
      await page.keyboard.press("Escape");
      assert.equal(
        await profileMenu.evaluate((el) => el === document.activeElement),
        true,
      );
      assert.equal(
        await page.locator(".account-menu").getAttribute("open"),
        null,
      );
      await page.getByLabel("Organização", { exact: true }).selectOption("b");
      await page.getByRole("button", { name: /Conversa inbox@b/ }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: /Conversa inbox@a/ }).count(),
        0,
      );
      assert.ok(
        (await page.locator(".mail-context").innerText()).includes(
          "Organização: b",
        ),
      );
      await page.getByLabel("Organização", { exact: true }).selectOption("a");
      await page
        .getByLabel("Caixa postal", { exact: true })
        .selectOption("private");
      await page
        .getByText("Esta caixa ou seu domínio está desativado.", {
          exact: false,
        })
        .waitFor();
      assert.equal(await page.locator(".message-row").count(), 0);
      await page.getByLabel("Caixa postal", { exact: true }).selectOption("ia");
      await f.db.execute(
        "UPDATE mail_identity_grants SET can_read=0,can_send=1 WHERE user_id='alice' AND identity_id='ia'",
      );
      await page
        .getByRole("button", { name: "Atualizar caixa", exact: true })
        .click();
      await page
        .getByText(
          "Você não tem permissão para ler as mensagens desta caixa.",
          { exact: false },
        )
        .waitFor();
      await page.screenshot({
        path: `.vercel/profile-ui/mail-${viewport}.png`,
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      failInbox = true;
      await page
        .getByRole("button", { name: "Atualizar caixa", exact: true })
        .click();
      await page
        .getByRole("alert")
        .filter({
          hasText: "Não foi possível carregar a caixa. Tente atualizar.",
        })
        .waitFor();
      assert.equal(await page.locator(".message-row").count(), 0);
      failInbox = false;
      await page
        .getByRole("button", { name: "Atualizar caixa", exact: true })
        .click();
      await page
        .getByText(
          "Você não tem permissão para ler as mensagens desta caixa.",
          { exact: false },
        )
        .waitFor();
      await profileMenu.click();
      await page
        .getByRole("link", { name: "Meu perfil e sessões", exact: true })
        .click();
      await profileReady(page);
      assert.equal(await profileMethod(page), "Senha");
      await page.getByText("Conta Google vinculada", { exact: true }).waitFor();
      while (
        await page
          .getByRole("button", { name: "Carregar mais sessões", exact: true })
          .count()
      ) {
        await page
          .getByRole("button", { name: "Carregar mais sessões", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent === "Carregando…",
            ),
        );
      }
      assert.equal(await page.locator(".profile-sessions li").count(), 28);
      assert.equal(
        await page.getByText("Método não registrado", { exact: true }).count(),
        1,
      );
      const ownList = await (
        await mailRequest(f.request("sessions"), ["sessions"], f.db)
      ).json();
      assert.equal(ownList.items.length, 28);
      assert.ok(
        ownList.items.every(
          (s: object) => !JSON.stringify(s).includes("token_hash"),
        ),
      );
      const bob = String(
        (
          await f.db.execute(
            "SELECT session_id FROM mail_sessions WHERE user_id='bob'",
          )
        ).rows[0].session_id,
      );
      assert.equal(
        await page.evaluate(
          async (id) =>
            (
              await fetch("/api/mail/sessions/" + id + "/revoke", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
              })
            ).status,
          bob,
        ),
        404,
      );
      assert.equal(
        (
          await f.db.execute(
            "SELECT revoked_at FROM mail_sessions WHERE user_id='bob'",
          )
        ).rows[0].revoked_at,
        null,
      );
      const button = page
        .getByRole("button", { name: "Encerrar sessão", exact: true })
        .first();
      await button.click();
      const dialog = page.getByRole("dialog");
      assert.equal(
        await dialog
          .getByRole("button", { name: "Cancelar", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      const beforeCancel = writes.length;
      await page.keyboard.press("Escape");
      assert.equal(writes.length, beforeCancel);
      assert.equal(
        await button.evaluate((el) => el === document.activeElement),
        true,
      );
      await button.click();
      await dialog
        .getByRole("button", { name: "Confirmar alteração", exact: true })
        .evaluate((el) => {
          (el as HTMLButtonElement).click();
          (el as HTMLButtonElement).click();
        });
      await dialog.waitFor({ state: "hidden" });
      await profileReady(page);
      assert.equal(writes.length, beforeCancel + 1);
      assert.equal(
        (
          await f.db.execute(
            "SELECT count(*) AS n FROM mail_auth_audit_log WHERE action='session_revoked'",
          )
        ).rows[0].n,
        1,
      );
      // Method comes from this session, even while the same Google binding exists.
      for (const [method, label] of [
        ["google", "Google OIDC"],
        ["legacy", "Método não registrado"],
      ]) {
        await f.db.execute({
          sql: "UPDATE mail_sessions SET auth_method=? WHERE token_hash=?",
          args: [method, hash(token)],
        });
        await page
          .getByRole("button", { name: "Atualizar perfil", exact: true })
          .click();
        await profileReady(page);
        await page.waitForFunction(
          (expected) =>
            Array.from(document.querySelectorAll(".profile-facts dt")).find(
              (el) => el.textContent === "Método da sessão atual",
            )?.nextElementSibling?.textContent === expected,
          label,
        );
        assert.equal(await profileMethod(page), label);
      }
      googleAvailable = false;
      await page
        .getByRole("button", { name: "Atualizar perfil", exact: true })
        .click();
      await profileReady(page);
      await page
        .getByText("Login Google indisponível no momento.", { exact: true })
        .waitFor();
      failSessions = true;
      await page
        .getByRole("button", { name: "Atualizar perfil", exact: true })
        .click();
      await page.locator('p[role="alert"]').waitFor();
      assert.equal(await page.locator(".profile-sessions li").count(), 0);
      failSessions = false;
      await page
        .getByRole("button", { name: "Atualizar perfil", exact: true })
        .click();
      await profileReady(page);
      await page.screenshot({
        path: `.vercel/profile-ui/${viewport}.png`,
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.locator(".account-menu summary").click();
      await page
        .getByRole("link", { name: "Administração do Mail", exact: true })
        .click();
      await page
        .getByRole("heading", {
          name: "Permissões sobre mensagens",
          exact: true,
        })
        .waitFor();
      await page.locator(".account-menu summary").click();
      await page
        .getByRole("link", { name: "Meu perfil e sessões", exact: true })
        .click();
      await profileReady(page);
      await loadAllSessions(page);
      await page
        .getByRole("button", { name: "Encerrar sessão atual", exact: true })
        .click();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Confirmar alteração", exact: true })
        .click();
      await page.waitForURL(origin + "/mail");
      await page
        .getByRole("button", { name: "Entrar no Todoku Mail" })
        .waitFor();
      assert.equal(
        (await mailRequest(f.request("session"), ["session"], f.db)).status,
        401,
      );
      await page.goto(origin + "/mail/profile");
      await page
        .getByRole("alert")
        .filter({ hasText: "Sua sessão expirou ou foi revogada" })
        .waitFor();
      const bobToken = f
        .request("", {}, "bob")
        .headers.get("cookie")!
        .split("=")[1];
      await context.addCookies([
        {
          name: origin.startsWith("https:")
            ? "__Host-todoku_mail"
            : "todoku_mail",
          value: bobToken,
          url: origin,
          secure: origin.startsWith("https:"),
          httpOnly: true,
        },
      ]);
      await f.db.execute(
        "DELETE FROM mail_identity_grants WHERE user_id='bob'",
      );
      await page.goto(origin + "/mail/profile");
      await profileReady(page);
      await page.locator(".account-menu summary").click();
      assert.equal(
        await page
          .getByRole("link", { name: "Administração do Mail", exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("link", { name: "Caixa de entrada", exact: true })
        .click();
      await page
        .getByText("Nenhuma caixa disponível para este acesso.", {
          exact: true,
        })
        .waitFor({ state: width < 850 ? "attached" : "visible" });
      await page.locator(".account-menu summary").click();
      await page
        .locator(".account-popover")
        .getByRole("button", { name: "Sair", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Entrar no Todoku Mail" })
        .waitFor();
      assert.deepEqual(errors, []);
      assert.ok(
        writes.every(
          (path) => /^sessions\/[^/]+\/revoke$/.test(path) || path === "logout",
        ),
      );
      results.push({
        viewport,
        realHandlers: true,
        isolatedDatabase: true,
        currentMethodFromServer: true,
        googleBindingIndependent: true,
        legacyCompatible: true,
        ownSessionsOnly: true,
        pagination: true,
        cancelAndFocus: true,
        duplicateSubmitBlocked: true,
        revokeOtherAndCurrent: true,
        audit: true,
        tenantContext: true,
        inactiveMailboxAndReadDenied: true,
        adminNavigation: true,
        noGrantsAndNonAdmin: true,
        expiredSession: true,
        horizontalOverflow: false,
        remoteMutations: 0,
        externalEmails: 0,
      });
    } finally {
      await context.close();
      f.close();
    }
  }
  await writeFile(
    ".vercel/profile-ui/evidence.json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
