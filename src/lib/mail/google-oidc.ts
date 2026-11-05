import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import * as oidc from "openid-client";
import { z } from "zod";
import { openSecret, sealSecret, type Keyring } from "../secrets.ts";
import {
  createMailSession,
  requireUser,
  sameOrigin,
  sessionToken,
} from "./auth.ts";
import { hash, json, MailError, transaction } from "./common.ts";

// Pinned to Google's published discovery metadata; no client-supplied issuer/URLs.
const google = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
};
const callbackPath = "/api/mail/oidc/google/callback";
const scope = { tenantId: "_auth", applicationId: "todoku-mail-oidc" };
const configSchema = z.object({
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().min(1).max(1000),
  origin: z.url(),
  ownerUserId: z.string().min(1).max(80),
  allowedEmail: z.email().transform((value) => value.toLowerCase()),
});
export type GoogleConfig = z.infer<typeof configSchema>;
type Options = {
  config?: GoogleConfig | null;
  fetcher?: oidc.CustomFetch;
  keyring?: Keyring;
};
const contextSchema = z.strictObject({
  verifier: z.string().min(43).max(128),
  nonce: z.string().length(43),
  state: z.string().length(43),
  clientId: z.string(),
  redirectUri: z.string(),
  ownerUserId: z.string(),
  allowedEmail: z.string(),
});
function configuration(options: Options): GoogleConfig | null {
  if (options.config === null) return null;
  if (!options.config && process.env.TODOKU_GOOGLE_OIDC_ENABLED !== "true")
    return null;
  const config = configSchema.parse(
    options.config ?? {
      clientId: process.env.TODOKU_GOOGLE_CLIENT_ID,
      clientSecret: process.env.TODOKU_GOOGLE_CLIENT_SECRET,
      origin: process.env.TODOKU_MAIL_ORIGIN,
      ownerUserId: process.env.TODOKU_GOOGLE_OWNER_USER_ID,
      allowedEmail: process.env.TODOKU_GOOGLE_ALLOWED_EMAIL,
    },
  );
  const url = new URL(config.origin);
  if (
    url.origin !== config.origin ||
    (url.protocol !== "https:" &&
      !(
        !process.env.VERCEL &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new MailError("oidc_unavailable", 503);
  return config;
}
function client(config: GoogleConfig, options: Options) {
  const value = new oidc.Configuration(google, config.clientId, {
    client_secret: config.clientSecret,
    id_token_signed_response_alg: "RS256",
  });
  value.timeout = 10;
  if (options.fetcher) value[oidc.customFetch] = options.fetcher;
  // Explicit signature verification, in addition to TLS and OIDC claim checks.
  oidc.enableNonRepudiationChecks(value);
  return value;
}
function attemptCookie(request: Request, value: string, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:";
  return `${secure ? "__Host-" : ""}todoku_oidc=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function attemptToken(request: Request) {
  const name =
    new URL(request.url).protocol === "https:"
      ? "__Host-todoku_oidc"
      : "todoku_oidc";
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(name + "="))
      ?.slice(name.length + 1) ?? ""
  );
}
function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}
async function authAudit(
  db: Pick<Client, "execute">,
  user: string | null,
  action: string,
) {
  await db.execute({
    sql: "INSERT INTO mail_auth_audit_log(id,user_id,provider,action) VALUES (?,?,'google',?)",
    args: [randomUUID(), user, action],
  });
}
async function start(
  db: Client,
  request: Request,
  config: GoogleConfig,
  options: Options,
  link: boolean,
) {
  sameOrigin(request);
  const user = link ? await requireUser(db, request) : null;
  if (user && user.id !== config.ownerUserId)
    throw new MailError("forbidden", 403);
  const token = randomBytes(32).toString("base64url"),
    key = hash(token);
  const state = oidc.randomState(),
    nonce = oidc.randomNonce();
  const verifier = oidc.randomPKCECodeVerifier(),
    redirectUri = config.origin + callbackPath;
  const encrypted = sealSecret(
    JSON.stringify({
      state,
      nonce,
      verifier,
      clientId: config.clientId,
      redirectUri,
      ownerUserId: config.ownerUserId,
      allowedEmail: config.allowedEmail,
    }),
    scope,
    key,
    "oidc_context",
    options.keyring,
  );
  const now = new Date().toISOString();
  await transaction(db, async (tx) => {
    const bucket = hash("oidc:google:start");
    const rate = (
      await tx.execute({
        sql: "SELECT attempts,resets_at FROM mail_login_limits WHERE bucket=?",
        args: [bucket],
      })
    ).rows[0];
    if (rate && String(rate.resets_at) > now && Number(rate.attempts) >= 30)
      throw new MailError("login_rate_limited", 429);
    await tx.execute({
      sql: `INSERT INTO mail_login_limits(bucket,attempts,resets_at) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET
        attempts=CASE WHEN resets_at<=? THEN 1 ELSE attempts+1 END,
        resets_at=CASE WHEN resets_at<=? THEN excluded.resets_at ELSE resets_at END`,
      args: [bucket, new Date(Date.now() + 60_000).toISOString(), now, now],
    });
    await tx.execute({
      sql: "DELETE FROM mail_oidc_attempts WHERE expires_at<=? OR token_hash=?",
      args: [now, hash(attemptToken(request))],
    });
    await tx.execute({
      sql: "INSERT INTO mail_oidc_attempts(token_hash,state_hash,encrypted_context,link_user_id,link_session_hash,expires_at) VALUES (?,?,?,?,?,?)",
      args: [
        key,
        hash(state),
        encrypted,
        user?.id ?? null,
        user ? hash(sessionToken(request)) : null,
        new Date(Date.now() + 600_000).toISOString(),
      ],
    });
  });
  const url = oidc.buildAuthorizationUrl(client(config, options), {
    redirect_uri: redirectUri,
    scope: "openid email",
    state,
    nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return redirect(url.href, [attemptCookie(request, token, 600)]);
}
async function callback(
  db: Client,
  request: Request,
  config: GoogleConfig,
  options: Options,
) {
  const url = new URL(request.url),
    token = attemptToken(request);
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    url.searchParams.getAll("state").length !== 1
  )
    throw new MailError("invalid_oidc", 401);
  const state = url.searchParams.get("state")!;
  if (!/^[A-Za-z0-9_-]{43}$/.test(state))
    throw new MailError("invalid_oidc", 401);
  // Atomic consumption precedes network I/O: concurrent/replayed callbacks cannot link twice.
  const attempt = (
    await db.execute({
      sql: "DELETE FROM mail_oidc_attempts WHERE token_hash=? AND state_hash=? AND expires_at>? RETURNING *",
      args: [hash(token), hash(state), new Date().toISOString()],
    })
  ).rows[0];
  if (!attempt) throw new MailError("invalid_oidc", 401);
  try {
    const context = contextSchema.parse(
      JSON.parse(
        openSecret(
          String(attempt.encrypted_context),
          scope,
          hash(token),
          "oidc_context",
          options.keyring,
        ),
      ),
    );
    if (
      context.clientId !== config.clientId ||
      context.redirectUri !== config.origin + callbackPath ||
      context.ownerUserId !== config.ownerUserId ||
      context.allowedEmail !== config.allowedEmail
    )
      throw new MailError("invalid_oidc", 401);
    const tokens = await oidc.authorizationCodeGrant(
      client(config, options),
      url,
      {
        pkceCodeVerifier: context.verifier,
        expectedState: context.state,
        expectedNonce: context.nonce,
        idTokenExpected: true,
      },
    );
    const claims = tokens.claims();
    if (
      !claims ||
      typeof claims.sub !== "string" ||
      !claims.sub.length ||
      claims.sub.length > 255 ||
      claims.email_verified !== true ||
      typeof claims.email !== "string" ||
      claims.email.toLowerCase() !== config.allowedEmail
    )
      throw new MailError("invalid_oidc", 401);
    const session = await transaction(db, async (tx) => {
      if (attempt.link_user_id) {
        // The normal session cookie is Strict and need not survive the Google redirect.
        // Revalidate the initiating session from its stored hash, including revocation/expiry.
        const owner = (
          await tx.execute({
            sql: "SELECT u.id FROM mail_users u JOIN mail_sessions s ON s.user_id=u.id WHERE u.id=? AND u.status='active' AND s.token_hash=? AND s.revoked_at IS NULL AND julianday(s.expires_at)>julianday('now')",
            args: [config.ownerUserId, attempt.link_session_hash],
          })
        ).rows[0];
        if (!owner || attempt.link_user_id !== owner.id)
          throw new MailError("invalid_oidc", 401);
        await tx.execute({
          sql: "INSERT INTO mail_auth_identities(id,user_id,provider,issuer,subject,verified_email) VALUES (?,?,'google',?,?,?) ON CONFLICT DO NOTHING",
          args: [
            randomUUID(),
            owner.id,
            google.issuer,
            claims.sub,
            config.allowedEmail,
          ],
        });
      }
      // No account creation or email-based fallback on sign-in. Email is only the pilot gate.
      const binding = (
        await tx.execute({
          sql: "SELECT user_id FROM mail_auth_identities WHERE provider='google' AND issuer=? AND subject=? AND status='active'",
          args: [google.issuer, claims.sub],
        })
      ).rows[0];
      if (!binding || binding.user_id !== config.ownerUserId)
        throw new MailError("invalid_oidc", 401);
      const value = await createMailSession(
        tx,
        request,
        String(binding.user_id),
      );
      if (attempt.link_session_hash)
        await tx.execute({
          sql: "UPDATE mail_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE token_hash=?",
          args: [attempt.link_session_hash],
        });
      await authAudit(
        tx,
        String(binding.user_id),
        attempt.link_user_id ? "oidc_linked" : "oidc_login",
      );
      return value;
    });
    // Access/ID tokens are discarded. They are never cookies, session values, or log fields.
    return redirect(config.origin + "/mail", [
      attemptCookie(request, "", 0),
      session,
    ]);
  } catch (error) {
    // Only a consumed, browser-bound attempt may append a denial; random callback
    // traffic cannot fill the audit table. No claims, tokens or provider errors.
    try {
      await authAudit(
        db,
        attempt.link_user_id ? String(attempt.link_user_id) : null,
        "oidc_denied",
      );
    } catch {}
    throw error;
  }
}
export async function googleOidcRequest(
  request: Request,
  operation: string,
  db: Client,
  options: Options = {},
) {
  let config: GoogleConfig | null = null;
  try {
    if (
      !(["status", "callback"].includes(operation)
        ? request.method === "GET"
        : ["start", "link"].includes(operation) && request.method === "POST")
    )
      return json({ error: "method_not_allowed" }, 405);
    config = configuration(options);
    if (operation === "status") {
      if (!config)
        return json({ enabled: false, canLink: false, linked: false });
      const migrated =
        (
          await db.execute(
            "SELECT version FROM schema_migrations WHERE version='0005_mail_oidc'",
          )
        ).rows.length === 1;
      if (!migrated)
        return json({ enabled: false, canLink: false, linked: false });
      let user = null;
      try {
        user = await requireUser(db, request);
      } catch (error) {
        if (!(error instanceof MailError) || error.status !== 401) throw error;
      }
      const linked =
        user?.id === config.ownerUserId &&
        (
          await db.execute({
            sql: "SELECT id FROM mail_auth_identities WHERE user_id=? AND provider='google' AND issuer=? AND status='active'",
            args: [user.id, google.issuer],
          })
        ).rows.length === 1;
      return json({
        enabled: true,
        canLink: user?.id === config.ownerUserId && !linked,
        linked: Boolean(linked),
      });
    }
    if (!config) throw new MailError("oidc_unavailable", 503);
    if (new URL(request.url).origin !== config.origin)
      throw new MailError("invalid_origin", 403);
    return operation === "callback"
      ? await callback(db, request, config, options)
      : await start(db, request, config, options, operation === "link");
  } catch (error) {
    if (operation === "callback") {
      return redirect(
        (config?.origin ?? new URL(request.url).origin) +
          "/mail?authError=google",
        [attemptCookie(request, "", 0)],
      );
    }
    return json(
      {
        error: error instanceof MailError ? error.message : "oidc_unavailable",
      },
      error instanceof MailError ? error.status : 503,
    );
  }
}
