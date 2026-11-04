import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { Webhook } from "svix";
const origin = "http://127.0.0.1:3037";
if (process.env.VERCEL || process.env.TODOKU_MAIL_STORAGE !== "fixture")
  throw new Error("Run only with the explicit local fixture environment");
const events = JSON.parse(
  await readFile(".vercel/mail-fixtures/events.json", "utf8"),
) as { id: string; to: string[]; received_for: string[] }[];
for (const event of events) {
  const id = crypto.randomUUID(),
    date = new Date(),
    raw = JSON.stringify({
      type: "email.received",
      data: {
        email_id: event.id,
        to: event.to,
        received_for: event.received_for,
      },
    });
  const response = await fetch(
    `${origin}/api/webhooks/mail/resend/${process.env.TODOKU_MAIL_FIXTURE_SOURCE}`,
    {
      method: "POST",
      body: raw,
      headers: {
        "svix-id": id,
        "svix-timestamp": String(Math.floor(date.getTime() / 1000)),
        "svix-signature": new Webhook(
          process.env.TODOKU_MAIL_FIXTURE_WEBHOOK_SECRET!,
        ).sign(id, date, raw),
      },
    },
  );
  assert.equal(response.status, 200);
  const worker = await fetch(`${origin}/api/internal/mail-worker`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
  assert.equal(worker.status, 200);
  assert.ok(["completed", "idle"].includes((await worker.json()).state));
}
await mkdir(".vercel/mail-screenshots", { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors: string[] = [],
  external: string[] = [];
try {
  for (const [name, width, height] of [
    ["desktop", 1440, 960],
    ["mobile", 390, 844],
  ] as const) {
    const context = await browser.newContext({
      viewport: { width, height },
      locale: "pt-BR",
      timezoneId: "America/Fortaleza",
      acceptDownloads: true,
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (
        !request.url().startsWith(origin) &&
        !request.url().startsWith("about:")
      )
        external.push(request.url());
    });
    await page.goto(`${origin}/mail`);
    await page
      .getByLabel("Usuário", { exact: true })
      .fill(process.env.TODOKU_MAIL_USERNAME!);
    await page
      .getByLabel("Senha", { exact: true })
      .fill(process.env.TODOKU_MAIL_PASSWORD!);
    await page.getByRole("button", { name: "Entrar no Todoku Mail" }).click();
    await page.getByText("4 mensagens", { exact: true }).waitFor();
    await page
      .locator(".message-row")
      .filter({ hasText: "Documento para sua revisão" })
      .click();
    await page
      .locator(".reader-content h2")
      .filter({ hasText: "Documento para sua revisão" })
      .waitFor();
    await page
      .frameLocator("iframe")
      .getByText("Nenhum documento real", { exact: false })
      .waitFor();
    assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
    assert.equal(
      await page
        .frameLocator("iframe")
        .locator("img,script,iframe,svg")
        .count(),
      0,
    );
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("link", { name: /demonstracao.txt/ }).click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "demonstracao.txt");
    assert.equal(await download.failure(), null);
    await page
      .locator(".message-reader")
      .evaluate((element) => element.scrollTo({ top: 0 }));
    await page.screenshot({
      path: `.vercel/mail-screenshots/${name}-reader.png`,
      fullPage: true,
    });
    if (width < 650) {
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.getByRole("button", { name: "← Voltar" }).click();
    }
    await page
      .getByLabel("Identidade", { exact: true })
      .selectOption({ label: events[3].to[0] });
    await page.getByText("1 mensagem", { exact: true }).waitFor();
    await page.screenshot({
      path: `.vercel/mail-screenshots/${name}-inbox.png`,
      fullPage: true,
    });
    await page.getByLabel("Identidade", { exact: true }).selectOption("");
    await page.getByText("4 mensagens", { exact: true }).waitFor();
    await page
      .locator(".message-row")
      .filter({ hasText: "Re: Bem-vindo ao seu novo espaço" })
      .click();
    await page
      .getByRole("navigation", { name: "Mensagens da conversa" })
      .waitFor();
    assert.equal(await page.locator(".thread-list button").count(), 2);
    await page
      .getByRole("button", { name: "Sair", exact: true })
      .filter({ visible: true })
      .click();
    await page.getByRole("heading", { name: "Entre na sua caixa" }).waitFor();
    assert.equal(
      (await context.request.get(`${origin}/api/mail/inbox`)).status(),
      401,
    );
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    JSON.stringify({
      browser: "chromium",
      desktop: true,
      mobile: true,
      login: true,
      filters: true,
      reader: true,
      attachments: true,
      threads: true,
      logout: true,
      externalRequests: 0,
      externalMessages: 0,
    }),
  );
} finally {
  await browser.close();
}
