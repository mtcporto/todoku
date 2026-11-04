import { getDatabase } from "@/lib/database";
import { handleEventStatus } from "@/lib/event-status";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleEventStatus(request, (await context.params).id, getDatabase);
}
