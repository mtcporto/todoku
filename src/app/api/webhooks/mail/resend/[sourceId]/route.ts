import { getDatabase } from "@/lib/database";
import { mailWebhook } from "@/lib/mail/inbound";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ sourceId: string }> },
) {
  return mailWebhook(request, (await context.params).sourceId, getDatabase());
}
