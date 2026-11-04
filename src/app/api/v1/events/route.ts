import { getDatabase } from "@/lib/database";
import { handleEventRequest } from "@/lib/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handleEventRequest(request, getDatabase);
}
