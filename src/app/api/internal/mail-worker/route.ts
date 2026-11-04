import { getDatabase } from "@/lib/database";
import { mailWorkerRequest } from "@/lib/mail/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  return mailWorkerRequest(request, getDatabase);
}
