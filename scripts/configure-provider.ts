import { getDatabase } from "../src/lib/database.ts";
import { provisionConfiguration, revokeConfiguration, reencryptConfiguration, verifyResendDomain } from "../src/lib/configurations.ts";
import { serverKeyring } from "../src/lib/secrets.ts";

const [operation, tenantId, applicationId, configurationId] = process.argv.slice(2);
if (!["dry-run", "test", "revoke", "reencrypt"].includes(operation) || !tenantId || !applicationId) {
  console.error("Usage: npm run db:provider -- <dry-run|test|revoke|reencrypt> <tenant> <application> [configuration-id]");
  process.exit(1);
}
const db = getDatabase();
try {
  const scope = { tenantId, applicationId };
  if (operation === "revoke") {
    if (!configurationId) throw new Error("Configuration required");
    await revokeConfiguration(db, scope, configurationId, process.env.TODOKU_REVOKE_WEBHOOK === "true");
    console.log(JSON.stringify({ revoked: configurationId }));
  } else if (operation === "reencrypt") {
    if (!configurationId) throw new Error("Configuration required");
    await reencryptConfiguration(db, scope, configurationId, serverKeyring());
    console.log(JSON.stringify({ reencrypted: configurationId }));
  } else if (operation === "dry-run") {
    console.log(JSON.stringify(await provisionConfiguration(db, { ...scope, mode: "dry_run", senderEmail: "dry-run@example.invalid", senderName: "Todoku" })));
  } else {
    const senderEmail = process.env.TODOKU_SENDER_EMAIL ?? "";
    const managementKey = process.env.RESEND_MANAGEMENT_KEY ?? "";
    const domainId = process.env.TODOKU_RESEND_DOMAIN_ID ?? "";
    if (!managementKey || !senderEmail || !domainId || process.env.TODOKU_TEST_AUTHORIZED !== "true") throw new Error("Confirmed test authorization and domain credentials required");
    const verifiedDomain = await verifyResendDomain(managementKey, domainId, senderEmail);
    console.log(JSON.stringify(await provisionConfiguration(db, { ...scope, id: configurationId, mode: "test", senderEmail,
      senderName: process.env.TODOKU_SENDER_NAME ?? "Todoku", allowedRecipients: JSON.parse(process.env.TODOKU_TEST_RECIPIENTS ?? "[]"),
      sendLimit: 1, apiKey: process.env.RESEND_APPLICATION_KEY, webhookSecret: process.env.RESEND_APPLICATION_WEBHOOK_SECRET, verifiedDomain })));
  }
} catch {
  console.error("Provider configuration failed; inspect scope, authorization, verified domain and server credentials securely. No secret values are printed.");
  process.exitCode = 1;
} finally { db.close(); }
