import { getDatabase } from "@/lib/database";
import { hubRequest } from "@/lib/hub/http";

export const runtime = "nodejs";
async function handle(request: Request, context: { params: Promise<{ segments: string[] }> }) {
  try { return await hubRequest(request, (await context.params).segments, getDatabase()); }
  catch { return Response.json({ error: "hub_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } }); }
}
export const GET = handle;
export const POST = handle;
