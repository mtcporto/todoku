import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import { z } from "zod";
import {
  requireUser,
  sameOrigin,
  sessionToken,
  clearMailSession,
} from "./auth.ts";
import { body, hash, json, MailError, transaction } from "./common.ts";

export async function sessionsRequest(
  request: Request,
  segments: string[],
  db: Client,
) {
  await requireUser(db, request);
  const url = new URL(request.url);
  if (request.method === "GET" && segments.length === 1) {
    if (
      [...url.searchParams.keys()].some(
        (k) => url.searchParams.getAll(k).length > 1,
      )
    )
      throw new MailError("invalid_filter");
    const page = z
      .strictObject({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        cursor: z
          .string()
          .regex(/^[a-f0-9-]{32,36}$/)
          .optional(),
      })
      .parse(Object.fromEntries(url.searchParams));
    const tx = await db.transaction("read");
    try {
      const user = await requireUser(tx, request);
      const rows = (
        await tx.execute({
          sql: "SELECT session_id AS id,auth_method AS method,created_at,expires_at,revoked_at,token_hash=? AS current FROM mail_sessions WHERE user_id=? AND (? IS NULL OR session_id>?) ORDER BY session_id LIMIT ?",
          args: [
            hash(sessionToken(request)),
            user.id,
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
  if (
    request.method !== "POST" ||
    segments.length !== 3 ||
    segments[2] !== "revoke"
  )
    return json({ error: "method_not_allowed" }, 405);
  sameOrigin(request);
  if (url.search) throw new MailError("invalid_filter");
  const id = z
    .string()
    .regex(/^[a-f0-9-]{32,36}$/)
    .parse(segments[1]);
  if (request.body)
    z.strictObject({}).parse(JSON.parse(await body(request, 256)));
  return transaction(db, async (tx) => {
    const user = await requireUser(tx, request);
    const row = (
      await tx.execute({
        sql: "SELECT revoked_at,token_hash=? AS current FROM mail_sessions WHERE session_id=? AND user_id=?",
        args: [hash(sessionToken(request)), id, user.id],
      })
    ).rows[0];
    if (!row) throw new MailError("not_found", 404);
    if (!row.revoked_at) {
      await tx.execute({
        sql: "UPDATE mail_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE session_id=? AND user_id=?",
        args: [id, user.id],
      });
      await tx.execute({
        sql: "INSERT INTO mail_auth_audit_log(id,user_id,provider,action,details_json) VALUES (?,?,'session','session_revoked',?)",
        args: [
          randomUUID(),
          user.id,
          JSON.stringify({ sessionId: id, current: !!row.current }),
        ],
      });
    }
    return json(
      { changed: !row.revoked_at, loggedOut: !!row.current },
      200,
      row.current ? { "set-cookie": clearMailSession(request) } : {},
    );
  });
}
