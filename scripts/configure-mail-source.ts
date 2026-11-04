import { Resend } from "resend";
import { getDatabase } from "../src/lib/database.ts";
import { sealSecret } from "../src/lib/secrets.ts";
import { audit, transaction } from "../src/lib/mail/common.ts";
const [operation, tenant, sourceId] = process.argv.slice(2);
if (!["enable", "disable"].includes(operation) || !tenant || !sourceId) {
  console.error("Usage: mail:source <enable|disable> <tenant> <source-id>");
  process.exit(1);
}
const db = getDatabase();
try {
  if (operation === "disable") {
    await transaction(db, async (tx) => {
      await tx.execute({
        sql: "UPDATE mail_sources SET status='disabled' WHERE tenant_id=? AND id=?",
        args: [tenant, sourceId],
      });
      await audit(tx, tenant, sourceId, null, "source_disabled");
    });
  } else {
    if (process.env.TODOKU_MAIL_DNS_AUTHORIZED !== "true")
      throw new Error("Explicit authorization required");
    const key = process.env.RESEND_APPLICATION_KEY ?? "",
      secret = process.env.RESEND_APPLICATION_WEBHOOK_SECRET ?? "",
      domainId = process.env.TODOKU_RESEND_DOMAIN_ID ?? "";
    if (
      !/^re_[a-zA-Z0-9_-]+$/.test(key) ||
      !secret.startsWith("whsec_") ||
      !domainId
    )
      throw new Error("Configuration unavailable");
    const domain = await new Resend(key).domains.get(domainId, {
      signal: AbortSignal.timeout(10_000),
    });
    if (
      domain.error ||
      !domain.data ||
      domain.data.status !== "verified" ||
      domain.data.capabilities?.receiving !== "enabled"
    )
      throw new Error("Receiving domain unavailable");
    const rows = (
      await db.execute({
        sql: "SELECT name FROM mail_domains WHERE tenant_id=? AND source_id=?",
        args: [tenant, sourceId],
      })
    ).rows;
    if (rows.length !== 1 || rows[0].name !== domain.data.name)
      throw new Error("Domain scope mismatch");
    const scope = { tenantId: tenant, applicationId: "todoku-mail" };
    await transaction(db, async (tx) => {
      await tx.execute({
        sql: "UPDATE mail_sources SET encrypted_api_key=?,encrypted_webhook_secret=?,status='active' WHERE tenant_id=? AND id=? AND provider='resend'",
        args: [
          sealSecret(key, scope, sourceId, "api_key"),
          sealSecret(secret, scope, sourceId, "webhook"),
          tenant,
          sourceId,
        ],
      });
      await tx.execute({
        sql: "UPDATE mail_domains SET status='active' WHERE tenant_id=? AND source_id=?",
        args: [tenant, sourceId],
      });
      await tx.execute({
        sql: "UPDATE mail_identities SET status='active' WHERE tenant_id=? AND domain_id IN (SELECT id FROM mail_domains WHERE tenant_id=? AND source_id=?)",
        args: [tenant, tenant, sourceId],
      });
      await audit(
        tx,
        tenant,
        sourceId,
        null,
        "source_enabled",
        "domain_verified",
      );
    });
  }
  console.log(JSON.stringify({ operation, sourceId, configured: true }));
} catch {
  console.error(
    "Mail source configuration failed. Inspect explicit authorization, verified receiving domain and private credentials securely.",
  );
  process.exitCode = 1;
} finally {
  db.close();
}
