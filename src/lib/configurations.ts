import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Client, Transaction, Row } from "@libsql/client";
import { sealSecret, openSecret, type Keyring, type Scope } from "./secrets.ts";

export type Sql = Pick<Client, "execute"> | Transaction;
export type ProviderConfiguration = Scope & {
  id: string; mode: "dry_run" | "test"; status: string; senderEmail: string; senderName: string;
  domain: string; domainVerifiedAt: string | null; encryptedApiKey: string | null;
  encryptedWebhookSecret: string | null; webhookRevokedAt: string | null;
  allowedRecipients: string[]; sendLimit: number; sendCount: number;
};
export function configurationFromRow(row: Row): ProviderConfiguration {
  return { tenantId: String(row.tenant_id), applicationId: String(row.application_id), id: String(row.id),
    mode: z.enum(["dry_run", "test"]).parse(row.mode), status: String(row.status),
    senderEmail: String(row.sender_email), senderName: String(row.sender_name), domain: String(row.domain),
    domainVerifiedAt: row.domain_verified_at ? String(row.domain_verified_at) : null,
    encryptedApiKey: row.encrypted_api_key ? String(row.encrypted_api_key) : null,
    encryptedWebhookSecret: row.encrypted_webhook_secret ? String(row.encrypted_webhook_secret) : null,
    webhookRevokedAt: row.webhook_revoked_at ? String(row.webhook_revoked_at) : null,
    allowedRecipients: z.array(z.email()).parse(JSON.parse(String(row.allowed_recipients))),
    sendLimit: Number(row.send_limit), sendCount: Number(row.send_count) };
}
export async function activeConfiguration(db: Sql, scope: Scope) {
  const result = await db.execute({ sql: "SELECT * FROM provider_configurations WHERE tenant_id = ? AND application_id = ? AND status = 'active'", args: [scope.tenantId, scope.applicationId] });
  return result.rows[0] ? configurationFromRow(result.rows[0]) : null;
}
export async function deliveryAudit(db: Sql, scope: Scope, outboxId: string | null, action: string, detail: { code?: string; configurationId?: string; attempt?: number; state?: string } = {}) {
  await db.execute({ sql: "INSERT INTO delivery_audit_log(tenant_id, application_id, id, outbox_id, action, detail_json) VALUES (?, ?, ?, ?, ?, ?)",
    args: [scope.tenantId, scope.applicationId, randomUUID(), outboxId, action, JSON.stringify(detail)] });
}

const configurationInput = z.strictObject({
  id: z.uuid().optional(),
  tenantId: z.string().min(1).max(100), applicationId: z.string().min(1).max(100),
  mode: z.enum(["dry_run", "test"]), senderEmail: z.email(), senderName: z.string().regex(/^[^<>\r\n]{1,100}$/),
  allowedRecipients: z.array(z.email()).max(3).default([]), sendLimit: z.int().min(0).max(5).default(1),
  apiKey: z.string().regex(/^re_[a-zA-Z0-9_\-]+$/).optional(), webhookSecret: z.string().startsWith("whsec_").optional(),
  verifiedDomain: z.strictObject({ id: z.string().min(1), name: z.string().min(1), verifiedAt: z.iso.datetime() }).optional(),
});
export type ConfigurationInput = z.input<typeof configurationInput>;

export async function provisionConfiguration(db: Client, input: ConfigurationInput, ring?: Keyring) {
  const parsed = configurationInput.safeParse(input);
  if (!parsed.success) throw new Error("Invalid provider configuration");
  const data = parsed.data;
  const domain = data.senderEmail.split("@")[1].toLowerCase();
  if (data.mode === "test" && (!data.apiKey || !data.webhookSecret || !data.verifiedDomain ||
      data.verifiedDomain.name.toLowerCase() !== domain || !data.allowedRecipients.length)) throw new Error("Verified sending configuration required");
  const id = data.id ?? randomUUID();
  const encryptedApiKey = data.apiKey ? sealSecret(data.apiKey, data, id, "api_key", ring) : null;
  const encryptedWebhook = data.webhookSecret ? sealSecret(data.webhookSecret, data, id, "webhook", ring) : null;
  const tx = await db.transaction("write");
  try {
    await tx.execute({ sql: "UPDATE provider_configurations SET status = 'revoked', revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE tenant_id = ? AND application_id = ? AND status = 'active'", args: [data.tenantId, data.applicationId] });
    await tx.execute({ sql: `INSERT INTO provider_configurations(tenant_id, application_id, id, mode, sender_email, sender_name, domain,
      domain_verified_at, encrypted_api_key, encrypted_webhook_secret, allowed_recipients, send_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [data.tenantId, data.applicationId, id, data.mode, data.senderEmail, data.senderName, domain, data.verifiedDomain?.verifiedAt ?? null,
        encryptedApiKey, encryptedWebhook, JSON.stringify(data.allowedRecipients.map(email => email.toLowerCase())), data.sendLimit] });
    await deliveryAudit(tx, data, null, "configuration_created", { configurationId: id });
    await tx.commit();
    return { configurationId: id };
  } catch (error) { try { if (!tx.closed) await tx.rollback(); } catch {} throw error; } finally { tx.close(); }
}

export async function revokeConfiguration(db: Client, scope: Scope, id: string, revokeWebhook = false) {
  await db.batch([
    { sql: "UPDATE provider_configurations SET status = 'revoked', revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), webhook_revoked_at = CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE webhook_revoked_at END WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [revokeWebhook, scope.tenantId, scope.applicationId, id] },
    { sql: "INSERT INTO delivery_audit_log(tenant_id, application_id, id, action, detail_json) VALUES (?, ?, ?, 'configuration_revoked', ?)", args: [scope.tenantId, scope.applicationId, randomUUID(), JSON.stringify({ configurationId: id })] },
  ], "write");
}

export async function reencryptConfiguration(db: Client, scope: Scope, id: string, ring: Keyring) {
  const tx = await db.transaction("write");
  try {
    const row = (await tx.execute({ sql: "SELECT * FROM provider_configurations WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [scope.tenantId, scope.applicationId, id] })).rows[0];
    if (!row) throw new Error("Configuration unavailable");
    const config = configurationFromRow(row);
    const reencrypt = (value: string | null, purpose: "api_key" | "webhook") => value ? sealSecret(openSecret(value, scope, id, purpose, ring), scope, id, purpose, ring) : null;
    await tx.execute({ sql: "UPDATE provider_configurations SET encrypted_api_key = ?, encrypted_webhook_secret = ? WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [reencrypt(config.encryptedApiKey, "api_key"), reencrypt(config.encryptedWebhookSecret, "webhook"), scope.tenantId, scope.applicationId, id] });
    await deliveryAudit(tx, scope, null, "key_reencrypted", { configurationId: id });
    await tx.commit();
  } catch (error) { try { if (!tx.closed) await tx.rollback(); } catch {} throw error; } finally { tx.close(); }
}

export async function verifyResendDomain(managementKey: string, domainId: string, senderEmail: string, fetcher: typeof fetch = fetch) {
  const response = await fetcher(`https://api.resend.com/domains/${encodeURIComponent(domainId)}`, { headers: { authorization: `Bearer ${managementKey}` }, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Domain verification unavailable");
  const data = await response.json();
  if (data.id !== domainId || data.name !== senderEmail.split("@")[1] || data.status !== "verified" || data.capabilities?.sending === "disabled") throw new Error("Sender domain not verified");
  return { id: domainId, name: String(data.name), verifiedAt: new Date().toISOString() };
}
