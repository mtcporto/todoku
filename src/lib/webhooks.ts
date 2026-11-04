import { randomUUID } from "node:crypto";
import { Webhook } from "svix";
import { z } from "zod";
import type { Client } from "@libsql/client";
import { configurationFromRow } from "./configurations.ts";
import { openSecret, type Keyring } from "./secrets.ts";
import { reconcileWebhooks } from "./delivery-status.ts";

const schema = z.object({ type: z.string().min(1).max(100), created_at: z.string().max(100), data: z.object({ email_id: z.string().min(1).max(100) }) });
const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function handleWebhook(request: Request, configId: string, database: () => Client, ring?: Keyring) {
  try {
    const db = database();
    const row = (await db.execute({ sql: "SELECT * FROM provider_configurations WHERE id = ?", args: [configId] })).rows[0];
    if (!row) return json({ error: "invalid_webhook" }, 401);
    const config = configurationFromRow(row);
    if (!config.encryptedWebhookSecret || config.webhookRevokedAt) return json({ error: "invalid_webhook" }, 401);
    const id = request.headers.get("svix-id") ?? "";
    const timestamp = request.headers.get("svix-timestamp") ?? "";
    const signature = request.headers.get("svix-signature") ?? "";
    if (!id || id.length > 200 || !timestamp || !signature) return json({ error: "invalid_webhook" }, 401);
    const reader = request.body?.getReader();
    if (!reader) return json({ error: "invalid_webhook" }, 400);
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > 256 * 1024) { await reader.cancel(); return json({ error: "payload_too_large" }, 413); }
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const raw = Buffer.concat(chunks).toString("utf8");
    let payload;
    const secret = openSecret(config.encryptedWebhookSecret, config, config.id, "webhook", ring);
    try {
      new Webhook(secret).verify(raw, { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signature });
      payload = schema.parse(JSON.parse(raw));
    }
    catch { return json({ error: "invalid_webhook" }, 401); }
    // Persist only verified lifecycle metadata, never arbitrary body/headers/secrets.
    const tx = await db.transaction("write");
    try {
      const result = await tx.execute({ sql: `INSERT INTO provider_webhook_events(tenant_id, application_id, id, provider, provider_event_id, event_type, payload_json, configuration_id)
        VALUES (?, ?, ?, 'resend', ?, ?, ?, ?) ON CONFLICT(tenant_id, application_id, provider, provider_event_id) DO NOTHING`,
        args: [config.tenantId, config.applicationId, randomUUID(), id, payload.type, JSON.stringify(payload), config.id] });
      await reconcileWebhooks(tx, config, config.id, payload.data.email_id);
      await tx.commit();
      return json({ received: true, duplicate: result.rowsAffected === 0 }, 200);
    } catch (error) { try { if (!tx.closed) await tx.rollback(); } catch {} throw error; } finally { tx.close(); }
  } catch { return json({ error: "webhook_unavailable" }, 503); }
}
