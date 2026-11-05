import { z } from "zod";
import { getDatabase } from "../src/lib/database.ts";
import { openSecret, sealSecret } from "../src/lib/secrets.ts";
import { audit, transaction } from "../src/lib/mail/common.ts";
import {
  sendingPolicy,
  sendingPolicySchema,
  updateSendingPolicy,
} from "../src/lib/mail/sending-policy.ts";

const [operation, tenant, identity, username] = process.argv.slice(2);
if (
  !tenant ||
  !identity ||
  !["grant", "revoke", "stage", "disable", "enable", "policy"].includes(
    operation,
  )
)
  throw new Error(
    "Usage: mail:sending <grant|revoke|stage|disable|enable|policy> <tenant> <identity> [username]",
  );
const db = getDatabase();
try {
  const row = (
    await db.execute({
      sql: "SELECT i.*,d.source_id,d.name FROM mail_identities i JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id WHERE i.tenant_id=? AND i.id=?",
      args: [tenant, identity],
    })
  ).rows[0];
  if (!row) throw new Error("Unknown identity");
  const scope = { tenantId: tenant, applicationId: "todoku-mail-send" };
  if (operation === "policy") {
    const result = await updateSendingPolicy(db, tenant, identity, {
      recipientPolicy: z
        .enum(["allowlist", "external"])
        .parse(process.env.TODOKU_MAIL_SEND_RECIPIENT_POLICY),
      allowedRecipients: JSON.parse(
        process.env.TODOKU_MAIL_SEND_RECIPIENTS ?? "[]",
      ),
      dailyLimit: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .parse(process.env.TODOKU_MAIL_SEND_DAILY_LIMIT),
    });
    console.log(
      JSON.stringify({
        operation,
        tenant,
        identity,
        ...result,
        externalEmails: 0,
      }),
    );
  } else if (operation === "grant" || operation === "revoke") {
    if (!username) throw new Error("Select an existing user grant");
    await transaction(db, async (tx) => {
      const result = await tx.execute({
        sql: "UPDATE mail_identity_grants SET can_send=?,can_manage=? WHERE tenant_id=? AND identity_id=? AND user_id IN (SELECT id FROM mail_users WHERE username=? AND status='active')",
        args: [
          operation === "grant" ? 1 : 0,
          operation === "grant" ? 1 : 0,
          tenant,
          identity,
          username,
        ],
      });
      if (result.rowsAffected !== 1) throw new Error("Existing grant required");
      await audit(
        tx,
        tenant,
        String(row.source_id),
        null,
        "sending_grant_" + operation,
      );
    });
  } else if (operation === "stage") {
    const key = z
      .string()
      .regex(/^re_[A-Za-z0-9_-]+$/)
      .parse(process.env.RESEND_MAIL_SENDING_KEY);
    const secret = z
      .string()
      .startsWith("whsec_")
      .min(30)
      .parse(process.env.RESEND_MAIL_SENDING_WEBHOOK_SECRET);
    const allow = z
      .array(z.email())
      .min(1)
      .max(10)
      .parse(JSON.parse(process.env.TODOKU_MAIL_SEND_RECIPIENTS ?? "[]"))
      .map((x) => x.toLowerCase());
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(process.env.TODOKU_MAIL_SEND_DAILY_LIMIT ?? 20);
    // An explicit dedicated variable is required; reject reuse of the Receiving key.
    const source = (
      await db.execute({
        sql: "SELECT encrypted_api_key FROM mail_sources WHERE tenant_id=? AND id=?",
        args: [tenant, row.source_id],
      })
    ).rows[0];
    if (
      source?.encrypted_api_key &&
      key ===
        openSecret(
          String(source.encrypted_api_key),
          { tenantId: tenant, applicationId: "todoku-mail" },
          String(row.source_id),
          "api_key",
        )
    )
      throw new Error("Use a separate sending credential");
    const sealed = sealSecret(key, scope, identity, "api_key"),
      webhook = sealSecret(secret, scope, identity, "webhook");
    if (
      openSecret(sealed, scope, identity, "api_key") !== key ||
      openSecret(webhook, scope, identity, "webhook") !== secret
    )
      throw new Error("Encryption validation failed");
    await transaction(db, async (tx) => {
      await tx.execute({
        sql: "INSERT INTO mail_sending_configurations(tenant_id,identity_id,encrypted_api_key,encrypted_webhook_secret,allowed_recipients_json,daily_limit,provider_domain_id,recipient_policy) VALUES (?,?,?,?,?,?,?,'allowlist') ON CONFLICT(tenant_id,identity_id) DO UPDATE SET status='disabled',encrypted_api_key=excluded.encrypted_api_key,encrypted_webhook_secret=excluded.encrypted_webhook_secret,allowed_recipients_json=excluded.allowed_recipients_json,daily_limit=excluded.daily_limit,provider_domain_id=excluded.provider_domain_id,recipient_policy='allowlist'",
        args: [
          tenant,
          identity,
          sealed,
          webhook,
          JSON.stringify(allow),
          limit,
          process.env.TODOKU_RESEND_DOMAIN_ID ?? null,
        ],
      });
      await audit(
        tx,
        tenant,
        String(row.source_id),
        null,
        "sending_staged",
        "round_trip_verified",
      );
    });
  } else if (operation === "enable") {
    if (
      process.env.TODOKU_MAIL_SENDING_AUTHORIZED !== "true" ||
      row.status !== "active"
    )
      throw new Error("Explicit authorization and active identity required");
    const config = (
      await db.execute({
        sql: "SELECT * FROM mail_sending_configurations WHERE tenant_id=? AND identity_id=?",
        args: [tenant, identity],
      })
    ).rows[0];
    if (
      !config?.encrypted_api_key ||
      !config.encrypted_webhook_secret ||
      !config.provider_domain_id
    )
      throw new Error("Stage dedicated configuration first");
    sendingPolicySchema.parse(sendingPolicy(config));
    openSecret(String(config.encrypted_api_key), scope, identity, "api_key");
    openSecret(
      String(config.encrypted_webhook_secret),
      scope,
      identity,
      "webhook",
    );
    const management = z
      .string()
      .regex(/^re_[A-Za-z0-9_-]+$/)
      .parse(process.env.RESEND_MANAGEMENT_KEY);
    const response = await fetch(
      `https://api.resend.com/domains/${encodeURIComponent(String(config.provider_domain_id))}`,
      {
        headers: { authorization: `Bearer ${management}` },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error("Domain inspection unavailable");
    const domain = await response.json();
    if (
      domain.name !== row.name ||
      domain.status !== "verified" ||
      domain.capabilities?.sending !== "enabled"
    )
      throw new Error("Sending domain unavailable");
    await transaction(db, async (tx) => {
      await tx.execute({
        sql: "UPDATE mail_sending_configurations SET status='enabled' WHERE tenant_id=? AND identity_id=?",
        args: [tenant, identity],
      });
      await audit(tx, tenant, String(row.source_id), null, "sending_enabled");
    });
  } else {
    await transaction(db, async (tx) => {
      await tx.execute({
        sql: "UPDATE mail_sending_configurations SET status='disabled' WHERE tenant_id=? AND identity_id=?",
        args: [tenant, identity],
      });
      await audit(tx, tenant, String(row.source_id), null, "sending_disabled");
    });
  }
  console.log(
    JSON.stringify({
      operation,
      tenant,
      identity,
      configured: true,
      externalEmails: 0,
    }),
  );
} catch {
  console.error(
    "Mail sending configuration failed. Check the selected identity, existing grants, dedicated private credentials and explicit authorization. No secret values were printed.",
  );
  process.exitCode = 1;
} finally {
  db.close();
}
