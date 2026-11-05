import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Page } from "playwright";

// UI contract test: every Mail API request is intercepted. No login, database,
// object storage, webhook or provider is contacted, even in a deployed preview.
const origin = new URL(process.env.TODOKU_UX_ORIGIN ?? "http://127.0.0.1:3039")
  .origin;
const output = ".vercel/composer-ux";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results: object[] = [];
async function footerVisible(page: Page) {
  await page.waitForFunction(() => {
    const backdrop = document.querySelector(".composer-backdrop");
    return (
      backdrop &&
      backdrop.getBoundingClientRect().height <=
        (visualViewport?.height ?? innerHeight) + 1
    );
  });
  const layout = await page.getByRole("dialog").evaluate((dialog) => {
    const footer = dialog.querySelector("footer")!.getBoundingClientRect();
    const scroll = dialog
      .querySelector(".composer-scroll")!
      .getBoundingClientRect();
    return {
      top: footer.top,
      bottom: footer.bottom,
      scrollBottom: scroll.bottom,
      height: window.visualViewport?.height ?? innerHeight,
      offset: window.visualViewport?.offsetTop ?? 0,
      overflow:
        document.documentElement.scrollWidth > innerWidth ||
        dialog.scrollWidth > dialog.clientWidth,
    };
  });
  assert(
    layout.top >= layout.offset &&
      layout.bottom <= layout.height + layout.offset + 1,
    JSON.stringify(layout),
  );
  assert(layout.scrollBottom <= layout.top + 1, "footer must not cover fields");
  assert.equal(layout.overflow, false);
  for (const button of await page
    .getByRole("dialog")
    .locator(".composer-footer-actions button")
    .all()) {
    const box = await button.boundingBox();
    assert(
      box &&
        box.y >= layout.top &&
        box.y + box.height <= layout.height + layout.offset + 1,
      "actions must remain visible",
    );
  }
}
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
    const pageErrors: string[] = [],
      unexpected: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const identity = "fixture-identity",
      id = "a".repeat(64),
      attachmentId = "b".repeat(64);
    let draft: Record<string, any> | null = null;
    let saveCalls = 0,
      sendCalls = 0,
      sendingEnabled = false,
      failSend = false;
    let releaseFirstSave: () => void;
    let markFirstSaveStarted: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => {
      markFirstSaveStarted = resolve;
    });
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== new URL(origin).origin) {
        unexpected.push(url.hostname);
        await route.abort();
        return;
      }
      if (!url.pathname.startsWith("/api/mail/")) {
        await route.continue(
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
        return;
      }
      const respond = (body: unknown, status = 200) =>
        route.fulfill({ status, json: body });
      if (url.pathname === "/api/mail/session")
        return respond({ user: { username: "UX fixture" } });
      if (url.pathname === "/api/mail/inbox") {
        const folder = url.searchParams.get("folder");
        return respond({
          identities: [
            {
              id: identity,
              address: "contato@fixture.invalid",
              label: "Contato fixture",
              domain_id: "fixture-domain",
              domain: "fixture.invalid",
              status: "active",
              receiving_status: "active",
              can_send: 1,
              can_manage: 1,
              sending_configured: 1,
            },
          ],
          messages:
            draft && folder === (draft.queued ? "sent" : "drafts")
              ? [
                  {
                    id,
                    sender: "contato@fixture.invalid",
                    subject: draft.subject,
                    preview: draft.text,
                    received_at: "2026-11-05T15:00:00Z",
                    is_read: 1,
                    attachment_count: draft.attachments.length,
                    identities: "contato@fixture.invalid",
                    identity_id: identity,
                    direction: "outbound",
                    delivery_status: draft.queued ? "queued" : "draft",
                  },
                ]
              : [],
          nextCursor: null,
          receivingEnabled: true,
          storageReady: true,
          fixture: true,
          sendingEnabled,
        });
      }
      if (
        request.method() === "POST" &&
        (url.pathname === "/api/mail/drafts" || url.pathname.endsWith("/draft"))
      ) {
        saveCalls++;
        const body = request.postDataJSON();
        if (saveCalls === 1)
          await new Promise<void>((resolve) => {
            releaseFirstSave = resolve;
            markFirstSaveStarted();
          });
        await new Promise((resolve) => setTimeout(resolve, 160));
        draft = {
          ...body,
          id,
          version: (draft?.version ?? 0) + 1,
          attachments: body.attachments.map((file: any) => ({
            id: attachmentId,
            filename: file.filename ?? "documento.txt",
            size: file.content
              ? Buffer.from(file.content, "base64").length
              : 12,
          })),
        };
        return respond({
          id,
          version: draft!.version,
          saved: true,
          attachments: draft!.attachments,
        });
      }
      if (url.pathname.endsWith("/send")) {
        sendCalls++;
        await new Promise((resolve) => setTimeout(resolve, 160));
        if (failSend) return respond({ error: "recipient_not_allowed" }, 403);
        assert(draft);
        draft.queued = true;
        return respond({ queued: true }, 202);
      }
      if (url.pathname.endsWith("/read")) return respond({ read: true });
      if (url.pathname === `/api/mail/messages/${id}` && draft)
        return respond({
          ...draft,
          identityId: identity,
          sender: "contato@fixture.invalid",
          receivedAt: "2026-11-05T15:00:00Z",
          authentication: "",
          folder: "drafts",
          direction: "outbound",
          deliveryStatus: "draft",
          canSend: true,
          canManage: true,
          document: null,
          thread: [],
        });
      unexpected.push(request.method() + " " + url.pathname);
      return respond({ error: "unexpected_ui_request" }, 500);
    });
    await page.goto(origin + "/mail");
    const write = page.getByRole("button", { name: "Escrever", exact: true });
    await write.click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    assert.equal(
      await dialog.getByLabel("Cc", { exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await dialog.getByLabel("Cco", { exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Enviar", exact: true })
        .isDisabled(),
      true,
    );
    await footerVisible(page);
    await page.screenshot({
      path: `${output}/${name}-new.png`,
      fullPage: true,
    });
    await dialog
      .getByLabel("Para", { exact: true })
      .fill("destino@example.invalid");
    await dialog.getByRole("button", { name: "Cc", exact: true }).click();
    await dialog
      .getByLabel("Cc", { exact: true })
      .fill("copia@example.invalid");
    await dialog.getByRole("button", { name: "Cco", exact: true }).click();
    await dialog
      .getByLabel("Cco", { exact: true })
      .fill("privado@example.invalid");
    await dialog.getByRole("button", { name: "Cco", exact: true }).click();
    assert.equal(
      await dialog.getByLabel("Cco", { exact: true }).isVisible(),
      false,
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Cco (1)", exact: true })
        .getAttribute("aria-expanded"),
      "false",
    );
    await dialog
      .getByLabel("Assunto", { exact: true })
      .fill(`Compositor ${name}`);
    await dialog
      .getByLabel("Mensagem", { exact: true })
      .fill("Conteúdo sintético preservado.\n".repeat(30));
    await dialog.getByLabel("Selecionar anexos").setInputFiles([
      {
        name: "documento.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("anexo seguro"),
      },
      {
        name: "remover.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("remover"),
      },
    ]);
    await dialog.getByRole("button", { name: "Remover remover.txt" }).click();
    assert.equal(
      await dialog.getByRole("button", { name: "Remover remover.txt" }).count(),
      0,
    );
    await dialog.getByLabel("Selecionar anexos").setInputFiles({
      name: "grande.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(2 * 1024 * 1024 + 1),
    });
    await dialog
      .getByRole("alert")
      .filter({ hasText: "cinco arquivos" })
      .waitFor();
    await footerVisible(page);
    assert.equal(
      await dialog
        .getByRole("button", { name: "Remover documento.txt" })
        .count(),
      1,
    );
    // Escape and Close preserve dirty content when the user rejects dismissal.
    page.once("dialog", (prompt) => prompt.dismiss());
    await dialog.getByLabel("Mensagem", { exact: true }).press("Escape");
    assert.equal(await dialog.isVisible(), true);
    assert.match(
      await dialog.getByLabel("Mensagem", { exact: true }).inputValue(),
      /Conteúdo sintético/,
    );
    assert.equal(
      await page.evaluate(() =>
        window.dispatchEvent(new Event("beforeunload", { cancelable: true })),
      ),
      false,
    );
    await dialog.getByRole("button", { name: "Salvar rascunho" }).click();
    await firstSaveStarted;
    await page.keyboard.press("Tab");
    assert.equal(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
    );
    await page.keyboard.press("Shift+Tab");
    assert.equal(
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      ),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(await dialog.isVisible(), true);
    releaseFirstSave!();
    await dialog.getByText("Rascunho salvo.", { exact: true }).waitFor();
    assert.equal(saveCalls, 1);
    assert.equal(sendCalls, 0);
    assert.deepEqual(draft!.bcc, ["privado@example.invalid"]);
    await footerVisible(page);
    await page.screenshot({
      path: `${output}/${name}-saved.png`,
      fullPage: true,
    });
    await dialog.getByRole("button", { name: "Fechar composição" }).click();
    assert.equal(
      await write.evaluate((button) => button === document.activeElement),
      true,
    );
    await page
      .getByRole("navigation", { name: "Pastas" })
      .getByRole("button", { name: "Rascunhos", exact: true })
      .click();
    await page
      .locator(".message-row")
      .filter({ hasText: `Compositor ${name}` })
      .click();
    await page
      .getByRole("button", { name: "Editar rascunho", exact: true })
      .click();
    await dialog.waitFor();
    assert.equal(
      await dialog.getByLabel("Cco", { exact: true }).isVisible(),
      true,
    );
    assert.equal(
      await dialog.getByLabel("Cco", { exact: true }).inputValue(),
      "privado@example.invalid",
    );
    assert.equal(
      await dialog.getByLabel("Cc", { exact: true }).inputValue(),
      "copia@example.invalid",
    );
    assert.equal(
      await dialog
        .getByRole("button", { name: "Remover documento.txt" })
        .count(),
      1,
    );
    await footerVisible(page);
    await page.screenshot({ path: `${output}/${name}-reopened.png`, fullPage: true });
    // Chromium viewport reduction exercises VisualViewport resize and internal
    // scrolling. It does not claim to emulate an actual iOS/Android keyboard.
    await page.setViewportSize({
      width,
      height: name === "mobile" ? 430 : 540,
    });
    await dialog.getByLabel("Mensagem", { exact: true }).focus();
    await dialog
      .locator(".composer-scroll")
      .evaluate((element) => (element.scrollTop = element.scrollHeight));
    await footerVisible(page);
    await page.screenshot({
      path: `${output}/${name}-reduced-viewport.png`,
      fullPage: true,
    });
    const save = dialog.getByRole("button", {
      name: "Salvar rascunho",
      exact: true,
    });
    await save.focus();
    await page.keyboard.press("Tab");
    assert.equal(
      await dialog
        .getByRole("button", { name: "Fechar composição" })
        .evaluate((button) => button === document.activeElement),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    await page.setViewportSize({ width, height });
    await page
      .getByRole("button", { name: "Editar rascunho", exact: true })
      .click();
    await dialog
      .getByLabel("Mensagem", { exact: true })
      .fill("Rascunho editado e salvo novamente.");
    await dialog
      .getByRole("button", { name: "Salvar rascunho", exact: true })
      .click();
    await dialog.getByText("Rascunho salvo.", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Fechar composição" }).click();
    assert.equal(
      await write.evaluate((button) => button === document.activeElement),
      true,
    );
    await page
      .locator(".message-row")
      .filter({ hasText: `Compositor ${name}` })
      .click();
    // Enabling only the browser fixture exercises sending feedback and locking;
    // the /send request remains intercepted and cannot contact a provider.
    sendingEnabled = true;
    await page.getByRole("button", { name: "Atualizar caixa" }).click();
    await page
      .getByRole("button", { name: "Editar rascunho", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Enviar", exact: true }).waitFor();
    failSend = true;
    await dialog.getByRole("button", { name: "Enviar", exact: true }).click();
    await dialog
      .getByRole("alert")
      .filter({ hasText: "lista autorizada" })
      .waitFor();
    assert.equal(await dialog.isVisible(), true);
    assert.equal(sendCalls, 1);
    await footerVisible(page);
    failSend = false;
    await dialog
      .getByRole("button", { name: "Enviar", exact: true })
      .evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
    await page.getByText(/Mensagem enfileirada\. Acompanhe/).waitFor();
    assert.equal(sendCalls, 2);
    assert.equal(saveCalls, 4);
    assert.equal(await dialog.count(), 0);
    assert.equal(
      await write.evaluate((button) => button === document.activeElement),
      true,
    );
    await page.getByText("Na fila", { exact: true }).waitFor();
    assert.equal(await page.getByText("Entregue", { exact: true }).count(), 0);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unexpected, []);
    results.push({
      viewport: name,
      width,
      height,
      pausedSending: true,
      collapsibleRecipients: true,
      draftReopened: true,
      bccPreserved: true,
      attachmentRemoval: true,
      oversizedFileRejected: true,
      fixedFooter: true,
      reducedViewport: true,
      dirtyDismissalProtected: true,
      focusTrap: true,
      focusTrapWhileSaving: true,
      returnFocusAfterOpenerUnmounts: true,
      beforeUnloadProtection: true,
      queueFailurePreservesDraft: true,
      duplicateSubmitBlocked: true,
      queueNotDelivery: true,
      actualExternalEmails: 0,
    });
    await context.close();
  }
  const report = {
    checkedAt: new Date().toISOString(),
    origin,
    mockedMailApi: true,
    results,
    limitation:
      "Viewport reduction tested; actual mobile OS keyboard requires device verification.",
  };
  await writeFile(
    `${output}/results.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
