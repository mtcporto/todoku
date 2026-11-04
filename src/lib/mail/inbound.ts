import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { Webhook } from "svix";
import { z } from "zod";
import { openSecret, type Keyring } from "../secrets.ts";
import {
  address,
  audit,
  body,
  json,
  limits,
  MailError,
  transaction,
} from "./common.ts";

const eventSchema = z.object({
  type: z.literal("email.received"),
  data: z.object({
    email_id: z.uuid(),
    to: z.array(z.string().max(320)).max(50),
    received_for: z.array(z.string().max(320)).max(50).optional(),
  }),
});
export async function mailWebhook(
  request: Request,
  sourceId: string,
  db: Client,
  options: { enabled?: boolean; fixtures?: boolean; keyring?: Keyring } = {},
) {
  try {
    if (
      !(options.enabled ?? process.env.TODOKU_MAIL_RECEIVING_ENABLED === "true")
    )
      return json({ error: "receiving_disabled" }, 503);
    const source = (
      await db.execute({
        sql: "SELECT s.* FROM mail_sources s JOIN tenants t ON t.id=s.tenant_id WHERE s.id=? AND s.status='active' AND t.status='active'",
        args: [sourceId],
      })
    ).rows[0];
    const fixtures =
      options.fixtures ??
      (!process.env.VERCEL && process.env.TODOKU_MAIL_STORAGE === "fixture");
    if (
      !source ||
      !source.encrypted_webhook_secret ||
      (source.provider === "fixture" && !fixtures)
    )
      return json({ error: "invalid_webhook" }, 401);
    const raw = await body(request, limits.webhook);
    const id = request.headers.get("svix-id") ?? "";
    if (!id || id.length > 200) return json({ error: "invalid_webhook" }, 401);
    const scope = {
      tenantId: String(source.tenant_id),
      applicationId: "todoku-mail",
    };
    const secret = openSecret(
      String(source.encrypted_webhook_secret),
      scope,
      sourceId,
      "webhook",
      options.keyring,
    );
    try {
      new Webhook(secret).verify(raw, {
        "svix-id": id,
        "svix-timestamp": request.headers.get("svix-timestamp") ?? "",
        "svix-signature": request.headers.get("svix-signature") ?? "",
      });
    } catch {
      return json({ error: "invalid_webhook" }, 401);
    }
    const parsed = eventSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return json({ error: "unsupported_event" }, 422);
    const event = parsed.data;
    // Envelope destinations are authoritative when supplied; never route from sender, subject or arbitrary headers.
    const destinations = [
      ...new Set(
        (event.data.received_for?.length
          ? event.data.received_for
          : event.data.to
        ).map(address),
      ),
    ];
    const receipt = await transaction(db, async (tx) => {
      const existing = (
        await tx.execute({
          sql: "SELECT id FROM mail_ingestion_events WHERE tenant_id=? AND source_id=? AND (provider_event_id=? OR provider_email_id=?)",
          args: [scope.tenantId, sourceId, id, event.data.email_id],
        })
      ).rows[0];
      if (existing) return { received: true, duplicate: true };
      const now = new Date().toISOString();
      const count = (
        await tx.execute({
          sql: "SELECT count(*) AS n FROM mail_ingestion_events WHERE tenant_id=? AND source_id=? AND received_at>=?",
          args: [
            scope.tenantId,
            sourceId,
            new Date(Date.now() - 86_400_000).toISOString(),
          ],
        })
      ).rows[0];
      const pending = (
        await tx.execute({
          sql: "SELECT count(*) AS n FROM mail_ingestion_events WHERE tenant_id=? AND state IN ('pending','processing','retry_wait')",
          args: [scope.tenantId],
        })
      ).rows[0];
      if (
        Number(count.n) >= Number(source.daily_limit) ||
        Number(pending.n) >= 100
      )
        throw new MailError("inbound_quota", 429);
      const identities = (
        await tx.execute({
          sql: `SELECT i.id,i.address FROM mail_identities i JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id
        JOIN mail_sources s ON s.tenant_id=d.tenant_id AND s.id=d.source_id JOIN tenants t ON t.id=s.tenant_id
        WHERE d.tenant_id=? AND d.source_id=? AND d.status='active' AND i.status='active' AND s.status='active' AND t.status='active'`,
          args: [scope.tenantId, sourceId],
        })
      ).rows.filter((row) => destinations.includes(String(row.address)));
      const jobId = randomUUID();
      await tx.execute({
        sql: "INSERT INTO mail_ingestion_events(tenant_id,id,source_id,provider_event_id,provider_email_id,state,targets_json,available_at,received_at,last_error_code) VALUES (?,?,?,?,?,?,?,?,?,?)",
        args: [
          scope.tenantId,
          jobId,
          sourceId,
          id,
          event.data.email_id,
          identities.length ? "pending" : "rejected",
          JSON.stringify(identities.map((row) => String(row.id))),
          now,
          now,
          identities.length ? null : "destination_not_authorized",
        ],
      });
      await audit(
        tx,
        scope.tenantId,
        sourceId,
        jobId,
        identities.length ? "received" : "rejected",
        identities.length ? null : "destination_not_authorized",
      );
      return { received: true, duplicate: false };
    });
    return json(receipt);
  } catch (error) {
    return json(
      {
        error:
          error instanceof MailError ? error.message : "inbound_unavailable",
      },
      error instanceof MailError ? error.status : 503,
    );
  }
}
