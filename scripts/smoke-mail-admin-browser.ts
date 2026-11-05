import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright";
import { fixture } from "../tests/helpers/mail-fixture.ts";
import { mailRequest } from "../src/lib/mail/http.ts";
import { googleOidcRequest } from "../src/lib/mail/google-oidc.ts";
import { hash } from "../src/lib/mail/common.ts";

// The rendered local/Preview UI calls real route handlers against isolated local
// fixtures. No Mail API request is forwarded to a deployed server or provider.
const origin = new URL(process.env.TODOKU_UX_ORIGIN ?? "http://127.0.0.1:3039")
  .origin;
const browser = await chromium.launch({ headless: true }),
  results: object[] = [];
await mkdir(".vercel/admin-ui", { recursive: true });
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function signIn(
  context: BrowserContext,
  f: Fixture,
  as: "alice" | "bob",
) {
  const value = f.request("", {}, as).headers.get("cookie")!.split("=")[1];
  await context.addCookies([
    {
      name: origin.startsWith("https:") ? "__Host-todoku_mail" : "todoku_mail",
      value,
      url: origin,
      httpOnly: true,
      secure: origin.startsWith("https:"),
      sameSite: "Strict",
    },
  ]);
}
async function bridge(context: BrowserContext, f: Fixture) {
  const errors: string[] = [],
    requests: { path: string; method: string; status: number }[] = [];
  context.on("page", (page) =>
    page.on("pageerror", (error) => errors.push(error.name)),
  );
  await context.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.origin !== origin) {
      errors.push("unexpected external request");
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
      !["session", "admin", "inbox", "logout"].includes(segments[0]) &&
      path !== "oidc/google/status"
    ) {
      errors.push("unexpected Mail operation");
      return route.abort();
    }
    const req = new Request(request.url(), {
      method: request.method(),
      headers: await request.allHeaders(),
      ...(request.postData() ? { body: request.postData()! } : {}),
    });
    const response =
      path === "oidc/google/status"
        ? await googleOidcRequest(req, "status", f.db, { config: null })
        : await mailRequest(req, segments, f.db, () => f.storage);
    requests.push({
      path: url.pathname + url.search,
      method: request.method(),
      status: response.status,
    });
    if (request.method() !== "GET")
      await new Promise((resolve) => setTimeout(resolve, 100));
    return route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  return { errors, requests };
}
async function ready(page: Page) {
  await page
    .getByRole("heading", { name: "Permissões sobre mensagens", exact: true })
    .waitFor();
}
async function confirm(page: Page) {
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Confirmar alteração", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden" });
  await ready(page);
}
async function selectGrant(page: Page, identity = "ia", user = "bob") {
  await page.getByLabel("Caixa postal").selectOption(identity);
  await page.getByLabel("Usuário", { exact: true }).selectOption(user);
  await page
    .getByRole("button", { name: "Revisar permissões", exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      !(
        Array.from(document.querySelectorAll("button")).find(
          (b) => b.textContent === "Revisar permissões",
        ) as HTMLButtonElement
      )?.disabled,
  );
}
const alerts = (page: Page) => page.locator('p[role="alert"]');
try {
  for (const [name, width, height] of [
    ["desktop", 1440, 960],
    ["mobile", 390, 844],
  ] as const) {
    const f = await fixture(),
      context = await browser.newContext({
        viewport: { width, height },
        locale: "pt-BR",
      });
    try {
      await f.db.batch(
        [
          "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope) VALUES ('root','a','alice','organization')",
          "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('a','bob'),('b','alice')",
          "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,domain_id) VALUES ('domain-b','b','alice','domain','db')",
          "UPDATE mail_identity_grants SET can_send=1,can_manage=1 WHERE user_id='alice'",
          "UPDATE mail_identities SET status='disabled' WHERE id='private'",
        ],
        "write",
      );
      // Force real pagination both in the member picker and the current-grant lookup.
      await f.db.batch(
        Array.from({ length: 101 }, (_, i) => {
          const id = "a-user-" + String(i).padStart(3, "0");
          return [
            `INSERT INTO mail_users(id,username,password_hash) VALUES ('${id}','${id}','!fixture')`,
            `INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('a','${id}')`,
            `INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_read) VALUES ('a','ia','${id}',0)`,
          ];
        }).flat(),
        "write",
      );
      const beforeUsers = Number(
        (await f.db.execute("SELECT count(*) AS n FROM mail_users")).rows[0].n,
      );
      const { errors, requests } = await bridge(context, f);
      await signIn(context, f, "alice");
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.goto(origin + "/mail");
      await page
        .getByRole("link", { name: "Administração do Mail", exact: true })
        .waitFor();
      await page
        .getByRole("link", { name: "Administração do Mail", exact: true })
        .click();
      await ready(page);
      assert.equal(
        await page.getByLabel("Organização atual").inputValue(),
        "a",
      );
      assert.equal(
        await page
          .getByRole("region", { name: "Caixas postais", exact: true })
          .getByText("Desativado", { exact: true })
          .count(),
        1,
      );
      const loadMembers = page.getByRole("button", {
        name: "Carregar mais usuários",
        exact: true,
      });
      while (await loadMembers.count()) {
        await loadMembers.click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent === "Carregar mais usuários" && b.disabled,
            ),
        );
      }
      await selectGrant(page);
      await page.getByLabel("Enviar mensagens", { exact: true }).check();
      await page
        .getByRole("button", { name: "Revisar permissões", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(
        await dialog
          .getByRole("button", { name: "Cancelar", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press("Escape");
      assert.equal(await dialog.count(), 0);
      assert.equal(
        await page
          .getByRole("button", { name: "Revisar permissões", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      assert.equal(
        (
          await f.db.execute(
            "SELECT count(*) AS n FROM mail_identity_grants WHERE user_id='bob' AND tenant_id='a'",
          )
        ).rows[0].n,
        0,
      );
      await page
        .getByRole("button", { name: "Revisar permissões", exact: true })
        .click();
      await f.db.execute(
        "CREATE TRIGGER fail_admin_write BEFORE INSERT ON mail_administration_audit WHEN NEW.action='content_grant_updated' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
      );
      await dialog
        .getByRole("button", { name: "Confirmar alteração", exact: true })
        .click();
      await dialog.locator("p[role=alert]").waitFor();
      assert.equal(
        (
          await f.db.execute(
            "SELECT count(*) AS n FROM mail_identity_grants WHERE user_id='bob' AND tenant_id='a'",
          )
        ).rows[0].n,
        0,
      );
      await dialog
        .getByRole("button", { name: "Cancelar", exact: true })
        .click();
      await f.db.execute("DROP TRIGGER fail_admin_write");
      await page
        .getByRole("button", { name: "Revisar permissões", exact: true })
        .click();
      const writesBefore = requests.filter(
        (r) =>
          r.path.endsWith("/mailboxes/ia/grants/bob") && r.method === "PUT",
      ).length;
      await dialog
        .getByRole("button", { name: "Confirmar alteração", exact: true })
        .evaluate((button) => {
          (button as HTMLButtonElement).click();
          (button as HTMLButtonElement).click();
        });
      await dialog.waitFor({ state: "hidden" });
      await ready(page);
      assert.equal(
        requests.filter(
          (r) =>
            r.path.endsWith("/mailboxes/ia/grants/bob") && r.method === "PUT",
        ).length,
        writesBefore + 1,
      );
      let grant = (
        await f.db.execute(
          "SELECT can_read,can_send,can_manage FROM mail_identity_grants WHERE user_id='bob' AND identity_id='ia'",
        )
      ).rows[0];
      assert.deepEqual(
        [grant.can_read, grant.can_send, grant.can_manage],
        [0, 1, 0],
      );
      // Reload pages and verify the editor preserves an existing send grant beyond
      // the first 100 entries instead of assuming an unloaded row has no permissions.
      while (await loadMembers.count()) {
        await loadMembers.click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent === "Carregar mais usuários" && b.disabled,
            ),
        );
      }
      await selectGrant(page);
      assert.equal(
        await page.getByLabel("Enviar mensagens", { exact: true }).isChecked(),
        true,
      );
      await page.getByLabel("Ler mensagens", { exact: true }).check();
      await page.getByLabel("Gerenciar mensagens", { exact: true }).check();
      await page
        .getByRole("button", { name: "Revisar permissões", exact: true })
        .click();
      await confirm(page);
      grant = (
        await f.db.execute(
          "SELECT can_read,can_send,can_manage FROM mail_identity_grants WHERE user_id='bob' AND identity_id='ia'",
        )
      ).rows[0];
      assert.deepEqual(
        [grant.can_read, grant.can_send, grant.can_manage],
        [1, 1, 1],
      );
      while (await loadMembers.count()) {
        await loadMembers.click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent === "Carregar mais usuários" && b.disabled,
            ),
        );
      }
      await page
        .getByRole("button", { name: "Suspender bob", exact: true })
        .click();
      await confirm(page);
      assert.equal(
        (
          await f.db.execute(
            "SELECT status FROM mail_memberships WHERE tenant_id='a' AND user_id='bob'",
          )
        ).rows[0].status,
        "suspended",
      );
      assert.equal(
        (
          await f.db.execute(
            "SELECT status FROM mail_memberships WHERE tenant_id='b' AND user_id='bob'",
          )
        ).rows[0].status,
        "active",
      );
      const bobSession = await mailRequest(
        f.request("session", {}, "bob"),
        ["session"],
        f.db,
      );
      assert.equal(bobSession.status, 200);
      while (await loadMembers.count()) {
        await loadMembers.click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent === "Carregar mais usuários" && b.disabled,
            ),
        );
      }
      await page
        .getByRole("button", { name: "Reativar bob", exact: true })
        .click();
      await confirm(page);
      while (await loadMembers.count()) {
        await loadMembers.click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent === "Carregar mais usuários" && b.disabled,
            ),
        );
      }
      await page
        .getByRole("button", { name: "Suspender alice", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Confirmar alteração", exact: true })
        .click();
      await dialog
        .getByText(
          "A organização precisa manter pelo menos um administrador ativo.",
          { exact: true },
        )
        .waitFor();
      await dialog
        .getByRole("button", { name: "Cancelar", exact: true })
        .click();
      // Find Bob's grant beyond the first visible page before revoking it.
      const loadGrants = page.getByRole("button", {
        name: "Carregar mais grants",
        exact: true,
      });
      while (await loadGrants.count()) {
        await loadGrants.click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent === "Carregar mais grants" && b.disabled,
            ),
        );
      }
      await page
        .getByRole("button", {
          name: "Revogar acesso de bob a inbox@a.example.invalid",
          exact: true,
        })
        .click();
      await confirm(page);
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
          await f.db.execute(
            "SELECT count(*) AS n FROM mail_identity_grants WHERE tenant_id='b' AND user_id='bob'",
          )
        ).rows[0].n,
        1,
      );
      await page.getByLabel("E-mail convidado").fill("guest@example.invalid");
      await page
        .getByRole("button", { name: "Revisar convite", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Cancelar", exact: true })
        .click();
      assert.equal(
        (await f.db.execute("SELECT count(*) AS n FROM mail_invitations"))
          .rows[0].n,
        0,
      );
      await page
        .getByRole("button", { name: "Revisar convite", exact: true })
        .click();
      await confirm(page);
      const link = await page
          .getByLabel("Link pessoal de uso único")
          .inputValue(),
        token = new URL(link).hash.slice(1);
      assert.equal(
        (await f.db.execute("SELECT token_hash FROM mail_invitations")).rows[0]
          .token_hash,
        hash(token),
      );
      assert.equal(
        Number(
          (await f.db.execute("SELECT count(*) AS n FROM mail_users")).rows[0]
            .n,
        ),
        beforeUsers,
      );
      assert.equal(
        (
          await f.db.execute(
            "SELECT count(*) AS n FROM mail_admin_grants WHERE tenant_id='a'",
          )
        ).rows[0].n,
        1,
      );
      await page.getByLabel("Organização atual").selectOption("b");
      await ready(page);
      assert.equal(
        await page.getByLabel("Link pessoal de uso único").count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "Convites", exact: true })
          .count(),
        0,
      );
      assert.ok(
        !(await page.locator("body").innerText()).includes(
          "guest@example.invalid",
        ),
      );
      assert.equal(
        await page.getByRole("button", { name: /Suspender / }).count(),
        0,
      );
      assert.equal(
        requests.filter((r) => r.path.includes("/organizations/b/invitations"))
          .length,
        0,
      );
      await page.getByLabel("Organização atual").selectOption("a");
      await ready(page);
      assert.equal(
        await page.getByLabel("Link pessoal de uso único").count(),
        0,
      );
      await page
        .getByRole("button", {
          name: "Revogar convite de guest@example.invalid",
          exact: true,
        })
        .click();
      await confirm(page);
      assert.equal(
        (await f.db.execute("SELECT state FROM mail_invitations")).rows[0]
          .state,
        "revoked",
      );
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.screenshot({
        path: ".vercel/admin-ui/" + name + ".png",
        fullPage: true,
      });
      await f.db.execute(
        "UPDATE mail_sessions SET revoked_at='2026-01-01' WHERE user_id='alice'",
      );
      await page
        .getByRole("button", { name: "Atualizar painel", exact: true })
        .click();
      await alerts(page).waitFor();
      assert.equal(
        await page
          .getByRole("region", { name: "Usuários", exact: true })
          .count(),
        0,
      );
      await context.clearCookies();
      await signIn(context, f, "bob");
      await page.goto(origin + "/mail/admin");
      await alerts(page)
        .filter({ hasText: "Você não tem acesso administrativo" })
        .waitFor();
      assert.equal(await page.getByLabel("Organização atual").count(), 0);
      // A scoped administrator with no content grant can revoke, but cannot mint
      // reading rights or mutate organizational memberships, including through fetch.
      await f.db.execute(
        "INSERT INTO mail_admin_grants(id,tenant_id,user_id,scope,identity_id) VALUES ('box','a','bob','mailbox','ia')",
      );
      await page.reload();
      await ready(page);
      while (await loadMembers.count()) {
        await loadMembers.click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (button) =>
                button.textContent === "Carregar mais usuários" &&
                button.disabled,
            ),
        );
      }
      assert.equal(
        await page
          .getByRole("heading", { name: "Convites", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.getByRole("button", { name: /Suspender / }).count(),
        0,
      );
      await selectGrant(page, "ia", "bob");
      await page.getByLabel("Ler mensagens", { exact: true }).check();
      await page
        .getByRole("button", { name: "Revisar permissões", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Confirmar alteração", exact: true })
        .click();
      await dialog
        .getByText(
          "Você não pode conceder permissões de conteúdo que não pode delegar nesta caixa.",
          { exact: true },
        )
        .waitFor();
      await page.keyboard.press("Escape");
      const denied = await page.evaluate(async () => ({
        membership: (
          await fetch("/api/mail/admin/organizations/a/memberships/alice", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: "suspended" }),
          })
        ).status,
        otherTenant: (await fetch("/api/mail/admin/organizations/b/domains"))
          .status,
      }));
      assert.deepEqual(denied, { membership: 403, otherTenant: 403 });
      const loadScopedGrants = page.getByRole("button", {
        name: "Carregar mais grants",
        exact: true,
      });
      while (await loadScopedGrants.count()) {
        await loadScopedGrants.click();
        await page.waitForFunction(
          () =>
            !Array.from(document.querySelectorAll("button")).some(
              (b) => b.textContent === "Carregar mais grants" && b.disabled,
            ),
        );
      }
      await page
        .getByRole("button", {
          name: "Revogar acesso de alice a inbox@a.example.invalid",
          exact: true,
        })
        .click();
      await confirm(page);
      assert.equal(
        (
          await f.db.execute(
            "SELECT count(*) AS n FROM mail_identity_grants WHERE tenant_id='a' AND user_id='alice'",
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await f.db.execute(
            "SELECT status FROM mail_admin_grants WHERE id='root'",
          )
        ).rows[0].status,
        "active",
      );
      await context.clearCookies();
      await page.reload();
      await alerts(page).filter({ hasText: "Sua sessão expirou" }).waitFor();
      assert.equal(await page.getByLabel("Organização atual").count(), 0);
      assert.deepEqual(errors, []);
      results.push({
        viewport: name,
        realHandlers: true,
        isolatedDatabase: true,
        backendDelegation: true,
        grantCreateUpdateRevoke: true,
        existingGrantBeyondFirst100Preserved: true,
        membershipSuspendReactivate: true,
        lastAdminProtected: true,
        invitationCreateRevoke: true,
        cancelHasNoMutation: true,
        oneTimeLinkClearedOnOrganizationChange: true,
        scopeIsolation: true,
        adminWithoutContent: true,
        sessionRevocation: true,
        nonAdminDenied: true,
        keyboardDialog: true,
        auditFailureFeedback: true,
        duplicateSubmitBlocked: true,
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
    ".vercel/admin-ui/evidence.json",
    JSON.stringify(results, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
