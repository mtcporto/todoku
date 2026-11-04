import type { Client } from "@libsql/client";
import { authenticate, IngestionError } from "./ingestion.ts";

export async function handleEventStatus(request: Request, id: string, database: () => Client) {
  const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
  const token = request.headers.get("authorization")?.match(/^Bearer ([\x21-\x7e]{32,512})$/)?.[1];
  if (!token) return json({ error: "unauthorized" }, 401);
  try {
    const db = database();
    const scope = await authenticate(db, token);
    const result = await db.execute({ sql: `SELECT e.id, o.status AS queue_status, d.state, d.mode, d.last_error_code, d.provider_message_id, o.attempt_count
      FROM events e JOIN outbox_messages o ON o.tenant_id = e.tenant_id AND o.application_id = e.application_id AND o.event_id = e.id
      LEFT JOIN message_deliveries d ON d.tenant_id = o.tenant_id AND d.application_id = o.application_id AND d.outbox_id = o.id
      WHERE e.tenant_id = ? AND e.application_id = ? AND e.id = ?`, args: [scope.tenantId, scope.applicationId, id] });
    const row = result.rows[0];
    if (!row) return json({ error: "not_found" }, 404);
    return json({ eventId: row.id, queueStatus: row.queue_status, deliveryState: row.state, mode: row.mode,
      attempts: row.attempt_count, error: row.last_error_code, providerMessageId: row.provider_message_id }, 200);
  } catch (error) {
    return json({ error: error instanceof IngestionError ? error.message : "service_unavailable" }, error instanceof IngestionError ? error.status : 503);
  }
}
