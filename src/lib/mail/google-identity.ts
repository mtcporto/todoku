import { randomUUID } from "node:crypto";
import type { Transaction } from "@libsql/client";
import { MailError } from "./common.ts";

export const googleIssuer = "https://accounts.google.com";
export async function googleBinding(tx: Transaction, subject: string) {
  const row = (
    await tx.execute({
      sql: `SELECT a.user_id,a.status,u.status AS user_status FROM mail_auth_identities a JOIN mail_users u ON u.id=a.user_id WHERE a.provider='google' AND a.issuer=? AND a.subject=?`,
      args: [googleIssuer, subject],
    })
  ).rows[0];
  if (row && (row.status !== "active" || row.user_status !== "active"))
    throw new MailError("invalid_oidc", 401);
  return row;
}
// Caller must prove the internal user with its current session or existing binding.
// Email is a conflict check, never a lookup that selects an internal user to link.
export async function bindGoogleIdentity(
  tx: Transaction,
  user: string,
  subject: string,
  email: string,
) {
  const own = (
    await tx.execute({
      sql: "SELECT subject,status FROM mail_auth_identities WHERE user_id=? AND provider='google' AND issuer=?",
      args: [user, googleIssuer],
    })
  ).rows[0];
  const binding = await googleBinding(tx, subject);
  if (
    (own && (own.subject !== subject || own.status !== "active")) ||
    (binding && binding.user_id !== user)
  )
    throw new MailError("invalid_oidc", 401);
  if (binding) return;
  const conflict = (
    await tx.execute({
      sql: "SELECT id FROM mail_auth_identities WHERE provider='google' AND issuer=? AND lower(verified_email)=? AND user_id!=? LIMIT 1",
      args: [googleIssuer, email, user],
    })
  ).rows[0];
  if (conflict) throw new MailError("invalid_oidc", 401);
  await tx.execute({
    sql: "INSERT INTO mail_auth_identities(id,user_id,provider,issuer,subject,verified_email) VALUES (?,?,'google',?,?,?)",
    args: [randomUUID(), user, googleIssuer, subject, email],
  });
}
