import type { Transaction } from "@libsql/client";
import { deliveryAudit } from "./configurations.ts";
import type { Scope } from "./secrets.ts";

const states: Record<string, { state: string; rank: number }> = {
  "email.sent": { state: "sent", rank: 1 }, "email.failed": { state: "failed", rank: 2 },
  "email.delivered": { state: "delivered", rank: 3 }, "email.suppressed": { state: "suppressed", rank: 4 },
  "email.bounced": { state: "bounced", rank: 5 }, "email.complained": { state: "complained", rank: 6 },
};
const rank: Record<string, number> = Object.fromEntries(Object.values(states).map(item => [item.state, item.rank]));

export async function reconcileWebhooks(tx: Transaction, scope: Scope, configurationId: string, providerId: string) {
  const delivery = (await tx.execute({ sql: "SELECT outbox_id, state, request_json FROM message_deliveries WHERE tenant_id = ? AND application_id = ? AND configuration_id = ? AND provider_message_id = ?", args: [scope.tenantId, scope.applicationId, configurationId, providerId] })).rows[0];
  if (!delivery) return;
  const rows = (await tx.execute({ sql: "SELECT id, event_type FROM provider_webhook_events WHERE tenant_id = ? AND application_id = ? AND configuration_id = ? AND status = 'received' AND json_extract(payload_json, '$.data.email_id') = ? ORDER BY received_at, id", args: [scope.tenantId, scope.applicationId, configurationId, providerId] })).rows;
  let current = String(delivery.state);
  for (const event of rows) {
    const mapped = states[String(event.event_type)];
    if (mapped && mapped.rank > (rank[current] ?? 0)) {
      current = mapped.state;
      await tx.execute({ sql: "UPDATE message_deliveries SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE tenant_id = ? AND application_id = ? AND outbox_id = ?", args: [current, scope.tenantId, scope.applicationId, delivery.outbox_id] });
    }
    if (mapped && ["bounced", "complained", "suppressed"].includes(mapped.state)) {
      const email = String(JSON.parse(String(delivery.request_json)).to[0]).toLowerCase();
      await tx.execute({ sql: "INSERT INTO recipient_suppressions(tenant_id, application_id, email, reason) VALUES (?, ?, ?, ?) ON CONFLICT(tenant_id, application_id, email) DO UPDATE SET reason = CASE WHEN reason = 'complained' THEN reason ELSE excluded.reason END", args: [scope.tenantId, scope.applicationId, email, mapped.state] });
    }
    await tx.execute({ sql: "UPDATE provider_webhook_events SET status = 'processed', outbox_id = ?, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE tenant_id = ? AND application_id = ? AND id = ?", args: [delivery.outbox_id, scope.tenantId, scope.applicationId, event.id] });
    await deliveryAudit(tx, scope, String(delivery.outbox_id), "webhook", { state: current });
  }
}
