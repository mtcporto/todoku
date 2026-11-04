import type { Client } from "@libsql/client";
import { communicationEventSchema } from "./events.ts";
import { authenticate, ingestEvent, IngestionError } from "./ingestion.ts";
import { isDatabaseReady } from "./database.ts";

const MAX_BODY_BYTES = 32 * 1024;
type DatabaseProvider = () => Client;

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "5" } : {}) } });
}

async function readBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new IngestionError("payload_too_large", 413);
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    if (error instanceof IngestionError) throw error;
    throw new IngestionError("invalid_body", 400);
  } finally { reader.releaseLock(); }
}

export async function handleEventRequest(request: Request, database: DatabaseProvider) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer ([\x21-\x7e]{32,512})$/)?.[1];
  if (!token) return json({ error: "unauthorized" }, 401);
  try {
    const db = database();
    await authenticate(db, token);
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get("content-type") ?? "")) {
      return json({ error: "unsupported_media_type" }, 415);
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large" }, 413);
    }
    const raw = await readBody(request);
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return json({ error: "invalid_json" }, 400); }
    const parsed = communicationEventSchema.safeParse(payload);
    if (!parsed.success) {
      return json({ error: "invalid_event", issues: parsed.error.issues.map(({ path, code }) => ({ path, code })) }, 422);
    }
    const accepted = await ingestEvent(db, token, parsed.data);
    return json(accepted, 202);
  } catch (error) {
    if (error instanceof IngestionError) return json({ error: error.message }, error.status);
    // Database errors can contain URLs, SQL arguments or credentials. Never return/log them.
    return json({ error: "service_unavailable" }, 503);
  }
}

export async function handleHealthRequest(database: DatabaseProvider) {
  try {
    if (await isDatabaseReady(database())) {
      return json({ service: "todoku", status: "ready", ingestion: "durable", delivery: "disabled" }, 200);
    }
  } catch { /* Report readiness without configuration details. */ }
  return json({ service: "todoku", status: "unavailable", ingestion: "unavailable", delivery: "disabled" }, 503);
}
