import { getDatabase } from "@/lib/database";
import { handleWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ configurationId: string }> }) {
  return handleWebhook(request, (await context.params).configurationId, getDatabase);
}
