import { getDatabase } from "@/lib/database";
import { handleHealthRequest } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handleHealthRequest(getDatabase);
}
