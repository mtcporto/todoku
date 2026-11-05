import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getDatabase } from "../src/lib/database.ts";
import { sealSecret } from "../src/lib/secrets.ts";
import { passwordHash } from "../src/lib/mail/auth.ts";
import { transaction } from "../src/lib/mail/common.ts";
if (process.env.VERCEL) throw new Error("Local fixtures only");
const db = getDatabase(),
  tenant = `mail-fixture-${randomUUID()}`,
  user = randomUUID(),
  source = randomUUID();
const input = resolve(".vercel/mail-fixtures/input"),
  storage = resolve(".vercel/mail-fixtures/storage");
try {
  if (existsSync(".env.mail-fixture.local"))
    throw new Error("Clean the previous fixture before provisioning another");
  await mkdir(input, { recursive: true });
  await mkdir(storage, { recursive: true });
  const password = randomBytes(24).toString("base64url"),
    secret = `whsec_${randomBytes(32).toString("base64")}`,
    stored = await passwordHash(password);
  const values = [];
  const localDomain = `${source.slice(0, 8)}.example.invalid`;
  for (const [index, subject, text, from] of [
    [
      0,
      "Bem-vindo ao seu novo espaço",
      "Seus e-mails agora têm um lugar para ficar. Esta é uma mensagem sintética para verificar a leitura segura.",
      "Equipe <equipe@example.invalid>",
    ],
    [
      1,
      "Re: Bem-vindo ao seu novo espaço",
      "Tudo pronto por aqui. Esta resposta verifica a organização de uma conversa.",
      "Marina <marina@example.invalid>",
    ],
    [
      2,
      "Documento para sua revisão",
      "O arquivo de demonstração está anexado. Nenhum documento real está sendo usado neste teste.",
      "Documentos <documentos@example.invalid>",
    ],
    [
      3,
      "Uma caixa, mais de uma identidade",
      "Você pode filtrar mensagens por domínio ou por identidade.",
      "Suporte <suporte@example.invalid>",
    ],
  ] as const) {
    const value = {
      id: randomUUID(),
      from,
      subject,
      to: [`${index === 3 ? "suporte" : "contato"}@${localDomain}`],
      received_for: [`${index === 3 ? "suporte" : "contato"}@${localDomain}`],
      cc: [],
      bcc: [],
      html: `<h2>${subject}</h2><p>${text}</p><img src="https://tracker.invalid/pixel"><script>window.parent.postMessage('unsafe','*')</script>`,
      text,
      message_id: `<mail-fixture-${index}@example.invalid>`,
      headers:
        index === 1
          ? { "in-reply-to": "<mail-fixture-0@example.invalid>" }
          : {},
      authentication: { dmarc: "pass" },
      raw: { download_url: "https://fixture.cloudfront.net/raw" },
      attachments:
        index === 2
          ? [
              {
                id: randomUUID(),
                filename: "demonstracao.txt",
                content_type: "text/plain",
                size: Buffer.byteLength(
                  "Arquivo sintético de demonstração do Todoku Mail.\n",
                ),
              },
            ]
          : [],
    };
    await writeFile(join(input, `${value.id}.json`), JSON.stringify(value));
    values.push(value);
  }
  await transaction(db, async (tx) => {
    await tx.execute({
      sql: "INSERT INTO tenants(id) VALUES (?)",
      args: [tenant],
    });
    await tx.execute({
      sql: "INSERT INTO mail_users(id,username,password_hash) VALUES (?,?,?)",
      args: [user, `fixture-${source.slice(0, 8)}`, stored],
    });
    await tx.execute({
      sql: "INSERT INTO mail_sources(tenant_id,id,provider,status,encrypted_webhook_secret) VALUES (?,?,'fixture','active',?)",
      args: [
        tenant,
        source,
        sealSecret(
          secret,
          { tenantId: tenant, applicationId: "todoku-mail" },
          source,
          "webhook",
        ),
      ],
    });
    const domain = randomUUID();
    await tx.execute({
      sql: "INSERT INTO mail_domains(tenant_id,id,source_id,name,status) VALUES (?,?,?,?,'active')",
      args: [tenant, domain, source, localDomain],
    });
    for (const [local, label] of [
      ["contato", "Contato"],
      ["suporte", "Suporte"],
    ]) {
      const id = randomUUID();
      await tx.execute({
        sql: "INSERT INTO mail_identities(tenant_id,id,domain_id,address,label,status) VALUES (?,?,?,?,?,'active')",
        args: [tenant, id, domain, `${local}@${localDomain}`, label],
      });
      await tx.execute({
        sql: "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_send,can_manage) VALUES (?,?,?,1,1)",
        args: [tenant, id, user],
      });
    }
  });
  await writeFile(
    ".env.mail-fixture.local",
    Object.entries({
      TODOKU_MAIL_STORAGE: "fixture",
      TODOKU_MAIL_FIXTURE_DIRECTORY: storage,
      TODOKU_MAIL_FIXTURE_INPUT_DIRECTORY: input,
      TODOKU_MAIL_RECEIVING_ENABLED: "true",
      TODOKU_MAIL_SENDING_ENABLED: "false",
      TODOKU_MAIL_ORIGIN: "http://127.0.0.1:3037",
      TODOKU_MAIL_USERNAME: `fixture-${source.slice(0, 8)}`,
      TODOKU_MAIL_PASSWORD: password,
      TODOKU_MAIL_FIXTURE_SOURCE: source,
      TODOKU_MAIL_FIXTURE_TENANT: tenant,
      TODOKU_MAIL_FIXTURE_WEBHOOK_SECRET: secret,
    })
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(".vercel/mail-fixtures/events.json", JSON.stringify(values));
  console.log(
    JSON.stringify({
      fixture: "prepared",
      messages: 4,
      externalMessages: 0,
      credentialsFile: ".env.mail-fixture.local",
    }),
  );
} catch {
  console.error(
    "Fixture setup failed; inspect schema and existing local fixture files.",
  );
  process.exitCode = 1;
} finally {
  db.close();
}
