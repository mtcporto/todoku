import { getDatabase } from "@/lib/database";
import { mailRequest } from "@/lib/mail/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ segments: string[] }> };
async function handle(request: Request, context: Context) {
  return mailRequest(request, (await context.params).segments, getDatabase());
}
export const GET = handle;
export const POST = handle;
