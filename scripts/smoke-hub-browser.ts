import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@libsql/client";
import { chromium } from "playwright";
import { migrate } from "../src/lib/migrations.ts";
import { passwordHash } from "../src/lib/mail/auth.ts";
import { hubRequest } from "../src/lib/hub/http.ts";
import { bootstrapHubAdministrator } from "../src/lib/hub/administration.ts";
import { provisionConfiguration } from "../src/lib/configurations.ts";
import { hashCredential } from "../src/lib/ingestion.ts";
import { handleEventRequest } from "../src/lib/http.ts";
import { runWorker } from "../src/lib/worker.ts";

const origin = new URL(process.env.TODOKU_UX_ORIGIN ?? "http://127.0.0.1:3039").origin;
const browser = await chromium.launch({ headless: true });
const evidence: object[] = [];
await mkdir(".vercel/hub-ui", { recursive: true });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const directory = await mkdtemp(join(process.env.TODOKU_TEST_TMPDIR!, "hub-"));
    const db = createClient({ url: `file:${join(directory, "test.db").replaceAll("\\", "/")}` });
    await db.execute("PRAGMA journal_mode=WAL");
    await migrate(db, "migrations");
    const owner = randomUUID(), applicationToken = randomBytes(32).toString("base64url");
    const password = "local-only-fixture-password";
    await db.batch([
      "INSERT INTO tenants(id) VALUES ('hub-a'),('hub-b')",
      "INSERT INTO applications(tenant_id,id) VALUES ('hub-a','pilot'),('hub-b','other')",
      { sql: "INSERT INTO mail_users(id,username,password_hash) VALUES (?,?,?)", args: [owner, "hub-owner", await passwordHash(password)] },
      { sql: "INSERT INTO application_credentials(tenant_id,application_id,id,token_hash) VALUES ('hub-a','pilot',?,?)", args: [randomUUID(), hashCredential(applicationToken)] },
    ], "write");
    await bootstrapHubAdministrator(db, "hub-a", owner, owner, true);
    await bootstrapHubAdministrator(db, "hub-b", owner, owner, true);
    await provisionConfiguration(db, { tenantId: "hub-a", applicationId: "pilot", senderEmail: "notificacoes@minhanota.app", senderName: "MinhaNota", mode: "dry_run" });
    const context = await browser.newContext({ viewport });
    const errors: string[] = [], writes: { path: string; payload: unknown; status: number }[] = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.name)));
    await context.route("**/*", async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== origin) { errors.push("external network request"); return route.abort(); }
      if (!url.pathname.startsWith("/api/")) return route.continue(
        process.env.VERCEL_OIDC_TOKEN && url.hostname.endsWith(".vercel.app")
          ? { headers: { ...req.headers(), "x-vercel-trusted-oidc-idp-token": process.env.VERCEL_OIDC_TOKEN } }
          : undefined,
      );
      if (!url.pathname.startsWith("/api/hub/")) { errors.push("unexpected API"); return route.abort(); }
      const path = url.pathname.slice("/api/hub/".length);
      const response = await hubRequest(new Request(req.url(), { method: req.method(), headers: await req.allHeaders(), ...(req.postData() ? { body: req.postData()! } : {}) }), path.split("/"), db);
      if (req.method() !== "GET") writes.push({ path, payload: JSON.parse(req.postData()!), status: response.status });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${origin}/hub`);
      await page.getByLabel("Usuário", { exact: true }).fill("hub-owner");
      await page.getByLabel("Senha", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Entrar", exact: true }).click();
      await page.getByRole("heading", { name: "Catálogo legado" }).waitFor();
      await page.getByRole("button", { name: "Preparar catálogo da aplicação" }).click();
      let dialog = page.getByRole("dialog");
      assert.ok((await dialog.innerText()).includes('"name": "pilot"'));
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      assert.equal(writes.length, 1); // login only
      await page.getByRole("button", { name: "Preparar catálogo da aplicação" }).click();
      await page.getByRole("button", { name: "Confirmar alteração" }).click();
      await page.getByRole("heading", { name: "Comunicações", exact: true }).waitFor();
      assert.equal((await db.execute("SELECT count(*) AS n FROM hub_event_bindings WHERE enabled=1")).rows[0].n, 0);
      await page.getByText("Criar template ou nova versão", { exact: true }).click();
      await page.getByLabel("Identificador do template", { exact: true }).fill("pilot.welcome");
      await page.getByLabel("Assunto", { exact: true }).fill("Assunto inicial");
      await page.getByLabel("Conteúdo", { exact: true }).fill("Olá {{firstName}}!");
      await page.getByLabel("Assunto", { exact: true }).fill("Assunto revisado");
      await page.getByRole("button", { name: "Revisar nova versão" }).click();
      dialog = page.getByRole("dialog");
      const expected = JSON.parse(await dialog.locator("pre").innerText());
      assert.equal(expected.subject, "Assunto revisado");
      assert.equal(await page.getByLabel("Assunto", { exact: true }).isDisabled(), true);
      // Native modal keyboard containment.
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest("dialog")), true);
      await dialog.getByRole("button", { name: "Confirmar alteração" }).click();
      await page.locator("strong").filter({ hasText: /^pilot\.welcome@1$/ }).waitFor();
      assert.deepEqual(writes.findLast(write => write.path.endsWith("/templates"))?.payload, expected);
      await page.getByRole("button", { name: "Habilitar user.welcome", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
      await page.getByRole("button", { name: "Desabilitar user.welcome", exact: true }).waitFor();
      await page.getByRole("button", { name: "Desabilitar user.welcome", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Cancelar", exact: true }).click();
      assert.equal((await db.execute("SELECT enabled FROM hub_event_bindings WHERE event_type='user.welcome'")).rows[0].enabled, 1);
      await page.getByText("Pré-visualizar template", { exact: true }).click();
      await page.getByRole("combobox", { name: /^Template para prévia/ }).selectOption("pilot.welcome@1");
      await page.getByRole("button", { name: "Gerar prévia sem envio" }).click();
      await page.getByLabel("Prévia renderizada").waitFor();
      assert.ok((await page.getByLabel("Prévia renderizada").innerText()).includes("Olá Exemplo!"));
      assert.equal((await db.execute("SELECT count(*) AS n FROM events")).rows[0].n, 0);
      await page.getByRole("heading", { name: "Biblioteca global", exact: true }).waitFor();
      await page.getByRole("button", { name: "Usar modelo minhanota.welcome", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
      await page.locator("strong").filter({ hasText: /^minhanota\.welcome@1$/ }).waitFor();
      assert.equal((await db.execute("SELECT template_id FROM hub_event_bindings WHERE event_type='user.welcome'")).rows[0].template_id, "welcome");
      await page.getByLabel("Nome da marca", { exact: true }).fill("MinhaNota");
      await page.getByLabel("Cor principal", { exact: true }).fill("#163b73");
      await page.getByLabel("Assinatura", { exact: true }).fill("Equipe MinhaNota — fixture");
      await page.getByRole("button", { name: "Revisar identidade visual" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Prévia de minhanota.welcome@1", exact: true }).click();
      await page.getByRole("button", { name: "Gerar prévia sem envio" }).click();
      await page.frameLocator('iframe[title="Prévia HTML do template"]').getByRole("heading", { name: "Bem-vindo ao MinhaNota!" }).waitFor();
      assert.equal(await page.frameLocator('iframe[title="Prévia HTML do template"]').getByRole("link", { name: "Acessar MinhaNota" }).getAttribute("href"), "https://minhanota.app");
      assert.equal(await page.frameLocator('iframe[title="Prévia HTML do template"]').locator("html").evaluate(element => element.scrollWidth > element.clientWidth), false);
      assert.ok((await page.getByLabel("Prévia renderizada").innerText()).includes("Equipe MinhaNota"));
      await page.getByRole("button", { name: "Personalizar minhanota.welcome@1", exact: true }).click();
      assert.equal(await page.getByLabel("Título visual", { exact: true }).inputValue(), "Bem-vindo ao MinhaNota!");
      await page.getByLabel("Título visual", { exact: true }).fill("Bem-vindo ao MinhaNota! — revisado");
      await page.getByRole("button", { name: "Revisar nova versão" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
      await page.locator("strong").filter({ hasText: /^minhanota\.welcome@2$/ }).waitFor();
      assert.equal((await db.execute("SELECT count(*) AS n FROM events")).rows[0].n, 0);
      assert.equal((await db.execute("SELECT count(*) AS n FROM delivery_attempts")).rows[0].n, 0);
      async function enqueue() {
        const response = await handleEventRequest(new Request(`${origin}/api/v1/events`, { method: "POST", headers: { authorization: `Bearer ${applicationToken}`, "content-type": "application/json" }, body: JSON.stringify({ id: randomUUID(), type: "user.welcome", occurredAt: new Date().toISOString(), tenantId: "hub-a", applicationId: "pilot", recipient: { email: "fixture@example.invalid" }, data: { firstName: "Private fixture name" }, idempotencyKey: randomUUID() }) }), () => db);
        assert.equal(response.status, 202);
        await db.execute("UPDATE outbox_messages SET available_at='2020-01-01T00:00:00Z'");
      }
      const workerOptions = { mode: "dry_run" as const, providerFactory: () => { throw new Error("No external transport"); } };
      await enqueue();
      assert.deepEqual((await runWorker(db, workerOptions)).states, ["dry_run"]);
      await enqueue();
      await page.getByRole("button", { name: "Desabilitar user.welcome", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Confirmar alteração" }).click();
      await page.getByRole("button", { name: "Habilitar user.welcome", exact: true }).waitFor();
      assert.deepEqual((await runWorker(db, workerOptions)).states, ["manual_review"]);
      await page.getByRole("button", { name: "Atualizar dados" }).click();
      await page.getByText("Falha: communication_disabled", { exact: true }).waitFor();
      assert.ok(!(await page.innerText("body")).includes("Private fixture name"));
      await page.screenshot({ path: `.vercel/hub-ui/${viewport.width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await page.getByRole("combobox", { name: /^Organização/ }).selectOption("hub-b");
      await page.getByRole("heading", { name: "Catálogo legado" }).waitFor();
      assert.equal(await page.locator("strong").filter({ hasText: /^pilot\.welcome@1$/ }).count(), 0);
      await db.execute("UPDATE hub_administrators SET status='revoked' WHERE tenant_id='hub-b'");
      await page.getByRole("button", { name: "Atualizar dados" }).click();
      await page.getByRole("alert").filter({ hasText: "não tem permissão" }).waitFor();
      await page.getByRole("button", { name: "Sair", exact: true }).click();
      await page.getByRole("heading", { name: "Entrar no Hub" }).waitFor();
      assert.ok((await db.execute("SELECT revoked_at FROM mail_sessions")).rows[0].revoked_at);
      assert.deepEqual(errors, []);
      evidence.push({ viewport, realHandlers: true, isolatedSqlite: true, loginLogout: true, catalogAdoptionDisabled: true, globalLibrary: true, copyPreservesBinding: true, applicationBranding: true, responsiveHtmlPreview: true, visualCustomizationCreatesVersion: true, confirmationMatchesRequest: true, editedForm: true, keyboardModal: true, cancellation: true, immutableTemplateVersion: true, previewNoEvent: true, messageStatusAndFailure: true, contentNotExposed: true, tenantSwitch: true, liveRevocation: true, horizontalOverflow: false, remoteMutations: 0, externalEmails: 0 });
    } finally { await context.close(); db.close(); }
  }
  await writeFile(".vercel/hub-ui/evidence.json", JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally { await browser.close(); }
