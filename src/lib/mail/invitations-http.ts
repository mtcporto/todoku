import type { Client } from "@libsql/client";
import { z } from "zod";
import { requireUser, sameOrigin } from "./auth.ts";
import { requireAdministration } from "./authorization.ts";
import { administrativeId } from "./administration.ts";
import { body, json, MailError, transaction } from "./common.ts";
import {
  createInvitation,
  endInvitation,
  invitationInput,
} from "./invitations.ts";

export async function invitationAdministration(
  request: Request,
  segments: string[],
  db: Client,
  tenant: string,
) {
  const url = new URL(request.url);
  if (request.method === "GET" && segments.length === 3) {
    const values = Object.fromEntries(url.searchParams);
    if (
      [...url.searchParams.keys()].some(
        (k) => url.searchParams.getAll(k).length > 1,
      )
    )
      throw new MailError("invalid_filter");
    const page = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: administrativeId.optional(),
      })
      .parse(values);
    const tx = await db.transaction("read");
    try {
      const actor = await requireUser(tx, request);
      await requireAdministration(tx, actor.id, tenant);
      const rows = (
        await tx.execute({
          sql: `SELECT id,email_normalized,target_user_id,created_by,created_at,expires_at,accepted_at,accepted_user_id,CASE WHEN state='pending' AND julianday(expires_at)<=julianday('now') THEN 'expired' ELSE state END AS state FROM mail_invitations WHERE tenant_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT ?`,
          args: [
            tenant,
            page.cursor ?? null,
            page.cursor ?? null,
            page.limit + 1,
          ],
        })
      ).rows;
      await tx.commit();
      return json({
        items: rows.slice(0, page.limit),
        nextCursor: rows.length > page.limit ? rows[page.limit - 1].id : null,
      });
    } finally {
      tx.close();
    }
  }
  if (request.method !== "POST")
    return json({ error: "method_not_allowed" }, 405);
  sameOrigin(request);
  if (url.search) throw new MailError("invalid_filter");
  if (segments.length === 3) {
    const input = invitationInput.parse(JSON.parse(await body(request, 2048)));
    return transaction(db, async (tx) => {
      const actor = await requireUser(tx, request);
      const invitation = await createInvitation(tx, tenant, actor.id, input);
      return json(
        {
          id: invitation.id,
          expiresAt: invitation.expiresAt,
          invitationUrl: url.origin + "/mail/invite#" + invitation.token,
        },
        201,
        { "referrer-policy": "no-referrer" },
      );
    });
  }
  if (segments.length !== 5 || !["revoke", "expire"].includes(segments[4]))
    throw new MailError("not_found", 404);
  const id = administrativeId.parse(segments[3]);
  if (request.body)
    z.strictObject({}).parse(JSON.parse(await body(request, 256)));
  return transaction(db, async (tx) => {
    const actor = await requireUser(tx, request);
    return json(
      await endInvitation(
        tx,
        tenant,
        actor.id,
        id,
        segments[4] === "revoke" ? "revoked" : "expired",
      ),
    );
  });
}
