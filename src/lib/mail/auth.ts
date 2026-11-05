import {
  randomBytes,
  randomUUID,
  scrypt as derive,
  timingSafeEqual,
} from "node:crypto";
import type { Client } from "@libsql/client";
import { body, hash, json, MailError, transaction } from "./common.ts";
import { z } from "zod";
import { administrativeCapabilities } from "./admin-capabilities.ts";

const scrypt = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    derive(
      password,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt);
  return `scrypt$${salt}$${key.toString("hex")}`;
}
async function verify(password: string, stored: string) {
  const [, salt, key] = stored.split("$");
  const calculated = await scrypt(password, salt || "0".repeat(32));
  const expected = Buffer.from(key || "0".repeat(64), "hex");
  return (
    /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(stored) &&
    expected.length === calculated.length &&
    timingSafeEqual(expected, calculated)
  );
}
export function sameOrigin(request: Request) {
  const url = new URL(request.url);
  const allowed = [
    process.env.TODOKU_MAIL_ORIGIN,
    process.env.VERCEL_ENV === "preview" && process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : null,
  ];
  if (!process.env.VERCEL) allowed.push(url.origin);
  if (!allowed.includes(request.headers.get("origin")))
    throw new MailError("invalid_origin", 403);
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new MailError("invalid_origin", 403);
}
function cookieName(request: Request) {
  return new URL(request.url).protocol === "https:"
    ? "__Host-todoku_mail"
    : "todoku_mail";
}
function cookie(request: Request, token: string, maxAge: number) {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export const clearMailSession = (request: Request) => cookie(request, "", 0);
export function sessionToken(request: Request) {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${cookieName(request)}=`))
      ?.split("=")[1] ?? ""
  );
}
export async function requireUser(
  db: Pick<Client, "execute">,
  request: Request,
) {
  const token = sessionToken(request);
  if (!/^[a-zA-Z0-9_-]{43}$/.test(token))
    throw new MailError("unauthorized", 401);
  const row = (
    await db.execute({
      sql: `SELECT u.id,u.username FROM mail_sessions s JOIN mail_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.revoked_at IS NULL AND julianday(s.expires_at)>julianday('now') AND u.status='active'`,
      args: [hash(token)],
    })
  ).rows[0];
  if (!row) throw new MailError("unauthorized", 401);
  return { id: String(row.id), username: String(row.username) };
}
// Both password and OIDC use opaque, revocable sessions with the same grants.
export async function createMailSession(
  db: Pick<Client, "execute">,
  request: Request,
  userId: string,
  method: "password" | "google" = "password",
) {
  const token = randomBytes(32).toString("base64url");
  const result = await db.execute({
    sql: "INSERT INTO mail_sessions(token_hash,user_id,expires_at,session_id,auth_method) SELECT ?,id,?,?,? FROM mail_users WHERE id=? AND status='active'",
    args: [
      hash(token),
      new Date(Date.now() + 12 * 3_600_000).toISOString(),
      randomUUID(),
      method,
      userId,
    ],
  });
  if (result.rowsAffected !== 1) throw new MailError("unauthorized", 401);
  return cookie(request, token, 43_200);
}
export async function authRequest(
  db: Client,
  request: Request,
  operation: "login" | "logout" | "session",
) {
  if (operation === "session") {
    const user = await requireUser(db, request);
    const session = (
      await db.execute({
        sql: "SELECT session_id AS id,auth_method AS method,created_at AS createdAt,expires_at AS expiresAt FROM mail_sessions WHERE token_hash=? AND user_id=? AND revoked_at IS NULL",
        args: [hash(sessionToken(request)), user.id],
      })
    ).rows[0];
    if (!session) throw new MailError("unauthorized", 401);
    return json({
      user,
      session,
      administration: await administrativeCapabilities(db, user.id),
    });
  }
  sameOrigin(request);
  if (operation === "logout") {
    await db.execute({
      sql: "UPDATE mail_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash=?",
      args: [hash(sessionToken(request))],
    });
    return json({ loggedOut: true }, 200, {
      "set-cookie": cookie(request, "", 0),
    });
  }
  const input = z
    .strictObject({
      username: z.string().trim().toLowerCase().min(1).max(80),
      password: z.string().min(1).max(256),
    })
    .safeParse(JSON.parse(await body(request, 2048)));
  if (!input.success) throw new MailError("invalid_credentials", 401);
  const now = Date.now();
  const permitted = await transaction(db, async (tx) => {
    for (const [bucket, limit, windowMs] of [
      ["global", 30, 60_000],
      [hash(input.data.username), 6, 900_000],
    ] as const) {
      const row = (
        await tx.execute({
          sql: "SELECT attempts,resets_at FROM mail_login_limits WHERE bucket=?",
          args: [bucket],
        })
      ).rows[0];
      if (
        row &&
        Date.parse(String(row.resets_at)) > now &&
        Number(row.attempts) >= limit
      )
        return false;
      await tx.execute({
        sql: `INSERT INTO mail_login_limits(bucket,attempts,resets_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET
        attempts=CASE WHEN julianday(resets_at)<=julianday(?) THEN 1 ELSE attempts+1 END,
        resets_at=CASE WHEN julianday(resets_at)<=julianday(?) THEN excluded.resets_at ELSE resets_at END`,
        args: [
          bucket,
          new Date(now + windowMs).toISOString(),
          new Date(now).toISOString(),
          new Date(now).toISOString(),
        ],
      });
    }
    return true;
  });
  if (!permitted) throw new MailError("login_rate_limited", 429);
  const user = (
    await db.execute({
      sql: "SELECT id,password_hash,status FROM mail_users WHERE username=?",
      args: [input.data.username],
    })
  ).rows[0];
  const valid = await verify(
    input.data.password,
    String(user?.password_hash ?? ""),
  );
  if (!valid || !user || user.status !== "active")
    throw new MailError("invalid_credentials", 401);
  // Serialize with password rotation/disable; a completed rotation cannot create a stale session.
  const sessionCookie = await transaction(db, async (tx) => {
    const current = (
      await tx.execute({
        sql: "SELECT id FROM mail_users WHERE id=? AND status='active' AND password_hash=?",
        args: [user.id, user.password_hash],
      })
    ).rows[0];
    if (!current) throw new MailError("invalid_credentials", 401);
    return createMailSession(tx, request, String(user.id));
  });
  return json({ authenticated: true }, 200, {
    "set-cookie": sessionCookie,
  });
}
