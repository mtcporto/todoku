import { createHash, timingSafeEqual } from "node:crypto";
import type { Client } from "@libsql/client";
import { runWorker } from "./worker.ts";

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
export async function handleWorkerRequest(request: Request, database: () => Client) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return json({ error: "worker_unavailable" }, 503);
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (!timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`))) return json({ error: "unauthorized" }, 401);
  let configurationId: string | undefined;
  if (request.method === "POST") {
    if (process.env.TODOKU_TEST_SEND_ENABLED !== "true" || process.env.VERCEL_ENV === "preview") return json({ error: "test_sending_disabled" }, 403);
    try {
      const text = await request.text();
      if (text.length > 256) return json({ error: "invalid_request" }, 400);
      const body = JSON.parse(text);
      if (!/^[a-f0-9-]{36}$/.test(body.configurationId) || Object.keys(body).length !== 1) return json({ error: "invalid_request" }, 400);
      configurationId = body.configurationId;
    } catch { return json({ error: "invalid_request" }, 400); }
  }
  try {
    return json(await runWorker(database(), { mode: configurationId ? "test" : "dry_run", configurationId }), 200);
  } catch {
    return json({ error: "worker_unavailable" }, 503);
  }
}
