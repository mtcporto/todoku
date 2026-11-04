import { getDatabase } from "@/lib/database";
import { handleWorkerRequest } from "@/lib/worker-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) { return handleWorkerRequest(request, getDatabase); }
export async function POST(request: Request) { return handleWorkerRequest(request, getDatabase); }
