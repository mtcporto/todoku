import { getDatabase } from "@/lib/database";
import { sendingWebhook } from "@/lib/mail/send";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  context: { params: Promise<{ identityId: string }> },
) {
  return sendingWebhook(
    request,
    (await context.params).identityId,
    getDatabase(),
  );
}
