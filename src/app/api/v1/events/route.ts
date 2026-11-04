import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { communicationEventSchema } from "@/lib/events";

export const runtime = "nodejs";
const MAX_BODY_BYTES = 32 * 1024;

function constantTimeMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const configuredKey = process.env.TODOKU_INGEST_API_KEY;
  if (!configuredKey || configuredKey.length < 32) {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || !constantTimeMatch(authorization.slice(7), configuredKey)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    return NextResponse.json({ error: "unsupported_media_type" }, { status: 415 });
  }
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = communicationEventSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_event", issues: parsed.error.issues.map(({ path, code }) => ({ path, code })) }, { status: 422 });
  }

  // Fail closed: no durable store / idempotency / queue is configured yet.
  // An acknowledgement here would falsely imply the event had been accepted.
  return NextResponse.json({ error: "ingestion_not_configured", message: "Event validated, but durable ingestion is not available yet." }, { status: 503 });
}
