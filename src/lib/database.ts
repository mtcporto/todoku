import { createClient } from "@libsql/client/web";
import type { Client } from "@libsql/client";

let client: Client | undefined;

export function getDatabase(): Client {
  if (client) return client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken || !/^(libsql|https):\/\//.test(url)) {
    throw new Error("Turso configuration unavailable");
  }
  client = createClient({ url, authToken });
  return client;
}

export async function isDatabaseReady(db: Client): Promise<boolean> {
  const result = await db.execute("SELECT version FROM schema_migrations WHERE version = '0002_delivery'");
  if (result.rows.length !== 1) return false;
  const tables = await db.execute(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (
    'tenants', 'applications', 'application_credentials', 'events', 'outbox_messages',
    'delivery_attempts', 'provider_webhook_events', 'audit_log', 'provider_configurations',
    'message_deliveries', 'delivery_audit_log', 'recipient_suppressions'
  )`);
  return Number(tables.rows[0].n) === 12;
}
