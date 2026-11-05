import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Run smoke:mail:browser first to ingest the isolated inbound fixtures.
const origin = "http://127.0.0.1:3037";
if (process.env.VERCEL || process.env.TODOKU_MAIL_STORAGE !== "fixture")
  throw new Error("Explicit local fixture environment required");
await mkdir(".vercel/mail-screenshots", { recursive: true });
const browser = await chromium.launch({ headless: true }),
  results = [];
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    locale: "pt-BR",
    timezoneId: "America/Fortaleza",
  });
  const page = await context.newPage(),
    errors: string[] = [],
    external: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (
      !request.url().startsWith(origin) &&
      !request.url().startsWith("about:")
    )
      external.push(new URL(request.url()).hostname);
  });
  await page.goto(origin + "/mail");
  await page
    .getByLabel("Usuário", { exact: true })
    .fill(process.env.TODOKU_MAIL_USERNAME!);
  await page
    .getByLabel("Senha", { exact: true })
    .fill(process.env.TODOKU_MAIL_PASSWORD!);
  await page.getByRole("button", { name: "Entrar no Todoku Mail" }).click();
  await page.locator(".message-row").first().waitFor();
  for (const [name, width, height] of [
    ["desktop", 1440, 960],
    ["mobile", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const subject = `MVP2 ${name} ${Date.now()}`,
      folders = page.getByRole("navigation", { name: "Pastas" });
    await page.getByRole("button", { name: "Escrever", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await dialog
      .getByLabel("Para", { exact: true })
      .fill("external@example.invalid");
    await dialog.getByRole("button", { name: "Cc", exact: true }).click();
    await dialog.getByRole("button", { name: "Cco", exact: true }).click();
    await dialog
      .getByLabel("Cc", { exact: true })
      .fill("carbon@example.invalid");
    await dialog
      .getByLabel("Cco", { exact: true })
      .fill("hidden@example.invalid");
    await dialog.getByLabel("Assunto", { exact: true }).fill(subject);
    await dialog
      .getByLabel("Mensagem", { exact: true })
      .fill("Somente conteúdo sintético. Nenhum envio externo.");
    await dialog.getByLabel("Anexar arquivos").setInputFiles({
      name: "sintetico.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("fixture anexo"),
    });
    assert.equal(
      await dialog
        .getByRole("button", { name: "Enviar", exact: true })
        .isDisabled(),
      true,
    );
    await dialog.getByRole("button", { name: "Salvar rascunho" }).click();
    await dialog.getByText("Rascunho salvo.", { exact: true }).waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `.vercel/mail-screenshots/mvp2-composer-${name}.png`,
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Fechar composição" }).click();
    await folders
      .getByRole("button", { name: "Rascunhos", exact: true })
      .click();
    await page.locator(".message-row").filter({ hasText: subject }).click();
    await page
      .locator(".reader-content h2")
      .filter({ hasText: subject })
      .waitFor();
    await page.getByRole("button", { name: "Editar rascunho" }).click();
    await dialog.getByLabel("Cco", { exact: true }).waitFor();
    assert.equal(
      await dialog.getByLabel("Cco", { exact: true }).inputValue(),
      "hidden@example.invalid",
    );
    assert.equal(await dialog.getByText(/sintetico.txt/).count(), 1);
    await dialog
      .getByLabel("Mensagem", { exact: true })
      .fill("Rascunho atualizado de forma durável.");
    await dialog.getByRole("button", { name: "Salvar rascunho" }).click();
    await dialog.getByText("Rascunho salvo.", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Fechar composição" }).click();
    await page.locator(".message-row").filter({ hasText: subject }).click();
    await page
      .getByText("Rascunho atualizado de forma durável.", { exact: true })
      .last()
      .waitFor();
    await page.getByRole("button", { name: "Excluir", exact: true }).click();
    await folders.getByRole("button", { name: "Lixeira", exact: true }).click();
    await page.locator(".message-row").filter({ hasText: subject }).click();
    await page.getByRole("button", { name: "Restaurar", exact: true }).click();
    await folders
      .getByRole("button", { name: "Rascunhos", exact: true })
      .click();
    await page.locator(".message-row").filter({ hasText: subject }).click();
    await page.getByRole("button", { name: "Excluir", exact: true }).click();
    await folders.getByRole("button", { name: "Lixeira", exact: true }).click();
    await page.locator(".message-row").filter({ hasText: subject }).click();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Excluir definitivamente" }).click();
    await page.locator(".reader-empty").waitFor({ state: "attached" });
    await folders
      .getByRole("button", { name: "Recebidos", exact: true })
      .click();
    await page
      .locator(".message-row")
      .filter({ hasText: "Documento para sua revisão" })
      .click();
    await page.getByRole("button", { name: "Responder a todos" }).click();
    await dialog.waitFor();
    assert.ok(
      (
        await dialog.getByLabel("Assunto", { exact: true }).inputValue()
      ).startsWith("Re:"),
    );
    assert.equal(
      await dialog.getByLabel("Cco", { exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await dialog.getByLabel("Cco", { exact: true }).inputValue(),
      "",
    );
    await dialog.getByRole("button", { name: "Fechar composição" }).click();
    await page.getByRole("button", { name: "Encaminhar", exact: true }).click();
    await dialog.waitFor();
    assert.equal(
      await dialog.getByLabel("Para", { exact: true }).inputValue(),
      "",
    );
    assert.equal(await dialog.getByText(/demonstracao.txt/).count(), 1);
    await dialog.getByRole("button", { name: "Fechar composição" }).click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.screenshot({
      path: `.vercel/mail-screenshots/mvp2-reader-${name}.png`,
      fullPage: true,
    });
    results.push({
      viewport: name,
      width,
      height,
      compose: true,
      draftReopened: true,
      privateAttachment: true,
      bccPreservedInOwnDraft: true,
      replyAll: true,
      forward: true,
      trash: true,
      restore: true,
      purgeConfirmed: true,
      sendDisabled: true,
      horizontalOverflow: false,
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  const result = {
    checkedAt: new Date().toISOString(),
    results,
    pageErrors: errors.length,
    externalContentRequests: external.length,
    externalEmails: 0,
  };
  await writeFile(
    ".vercel/mail-mvp2-browser.json",
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result));
  await context.close();
} finally {
  await browser.close();
}
