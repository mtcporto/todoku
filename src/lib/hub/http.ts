import { z } from "zod";
import type { Client } from "@libsql/client";
import { requireUser, sameOrigin, authRequest } from "../mail/auth.ts";
import { body, json, MailError } from "../mail/common.ts";
import { TemplateError } from "../templates.ts";
import { hubCatalog, mutateHub, requireHubAdministrator, scopeId } from "./administration.ts";

export async function hubRequest(request: Request, segments: string[], db: Client) {
  try {
    if (segments.length === 1 && ["login", "logout"].includes(segments[0])) {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      return await authRequest(db, request, segments[0] as "login" | "logout");
    }
    const user = await requireUser(db, request);
    if (!(await db.execute("SELECT 1 FROM schema_migrations WHERE version='0009_hub_operations'")).rows.length) return json({ error: "hub_setup_required" }, 503);
    if (segments.length === 1 && segments[0] === "session" && request.method === "GET") {
      const tenants = (await db.execute({ sql: `SELECT h.tenant_id AS id FROM hub_administrators h JOIN tenants t ON t.id=h.tenant_id WHERE h.user_id=? AND h.status='active' AND t.status='active' ORDER BY h.tenant_id`, args: [user.id] })).rows;
      return json({ user, tenants });
    }
    const [resource, tenant, apps, application, collection] = segments;
    if (resource !== "tenants" || !scopeId.safeParse(tenant).success || apps !== "applications" || segments.length > 5 || (application && !scopeId.safeParse(application).success)) return json({ error: "not_found" }, 404);
    await requireHubAdministrator(db, request, tenant);
    if (request.method === "GET" && !collection) return json(await hubCatalog(db, tenant, application));
    if (request.method === "GET" && application && collection === "events") {
      const page = z.coerce.number().int().min(0).max(10000).parse(new URL(request.url).searchParams.get("page") ?? "0");
      const events = (await db.execute({ sql: `SELECT e.id,e.event_type AS eventType,e.created_at AS createdAt,o.status AS queueStatus,d.state AS deliveryState,d.mode,o.attempt_count AS attempts,d.last_error_code AS error
        FROM events e JOIN outbox_messages o ON o.tenant_id=e.tenant_id AND o.application_id=e.application_id AND o.event_id=e.id
        LEFT JOIN message_deliveries d ON d.tenant_id=o.tenant_id AND d.application_id=o.application_id AND d.outbox_id=o.id
        WHERE e.tenant_id=? AND e.application_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT 26 OFFSET ?`, args: [tenant, application, page * 25] })).rows;
      const audit = (await db.execute({ sql: "SELECT action,details_json AS details,created_at AS createdAt FROM hub_administration_audit WHERE tenant_id=? AND application_id=? ORDER BY created_at DESC,id DESC LIMIT 25", args: [tenant, application] })).rows;
      const deliveryAudit = (await db.execute({ sql: "SELECT outbox_id AS outboxId,action,detail_json AS details,created_at AS createdAt FROM delivery_audit_log WHERE tenant_id=? AND application_id=? ORDER BY created_at DESC,id DESC LIMIT 25", args: [tenant, application] })).rows;
      return json({ events: events.slice(0, 25), hasMore: events.length > 25, page, audit, deliveryAudit });
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    sameOrigin(request);
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? "")) return json({ error: "unsupported_media_type" }, 415);
    let input: unknown;
    try { input = JSON.parse(await body(request, 16 * 1024)); } catch (error) {
      if (error instanceof MailError) throw error;
      return json({ error: "invalid_json" }, 400);
    }
    const operation = !application ? "create-application" : ({ catalog: "adopt-catalog", templates: "template", bindings: "binding", preview: "preview" } as Record<string, string>)[collection];
    if (!operation) return json({ error: "not_found" }, 404);
    return json(await mutateHub(db, request, tenant, application, operation, input));
  } catch (error) {
    if (error instanceof MailError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return json({ error: "invalid_input" }, 422);
    if (error instanceof TemplateError) return json({ error: error.message }, 422);
    return json({ error: "hub_unavailable" }, 503);
  }
}
