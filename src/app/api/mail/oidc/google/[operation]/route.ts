import { getDatabase } from "@/lib/database";
import { googleOidcRequest } from "@/lib/mail/google-oidc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ operation: string }> };
async function handle(request: Request, context: Context) {
  return googleOidcRequest(
    request,
    (await context.params).operation,
    getDatabase(),
  );
}
export const GET = handle;
export const POST = handle;
