import { createHash, randomUUID } from "node:crypto";
import type { Client, Transaction } from "@libsql/client";
import { z } from "zod";

export const limits = {
  webhook: 64 * 1024,
  body: 256 * 1024,
  raw: 8 * 1024 * 1024,
  attachment: 3 * 1024 * 1024,
  attachments: 5,
  total: 8 * 1024 * 1024,
};
export class MailError extends Error {
  readonly status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const json = (
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
) =>
  Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
export function address(value: string) {
  const match = value.trim().match(/^(?:[^<>\r\n]*<)?([^<>\s]+@[^<>\s]+)>?$/);
  const result = match?.[1].toLowerCase();
  if (!result || result.length > 254 || !z.email().safeParse(result).success)
    throw new MailError("invalid_address");
  return result;
}
export function filename(value: string) {
  return (
    value
      .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^\.+|\.+$/g, "")
      .slice(0, 120) || "anexo"
  );
}
export async function bytes(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > max)
    throw new MailError("download_failed", 503);
  const reader = response.body?.getReader();
  if (!reader) throw new MailError("download_failed", 503);
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new MailError("size_limit", 422);
      }
      parts.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Uint8Array(Buffer.concat(parts));
}
export async function body(request: Request, max: number) {
  let raw: Uint8Array;
  try {
    raw = await bytes(new Response(request.body), max);
  } catch (error) {
    if (error instanceof MailError && error.message === "size_limit")
      throw new MailError("payload_too_large", 413);
    throw error;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}
export async function transaction<T>(
  db: Client,
  work: (tx: Transaction) => Promise<T>,
) {
  const tx = await db.transaction("write");
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (error) {
    try {
      if (!tx.closed) await tx.rollback();
    } catch {}
    throw error;
  } finally {
    tx.close();
  }
}
export async function audit(
  db: Pick<Client, "execute"> | Transaction,
  tenant: string,
  source: string | null,
  event: string | null,
  action: string,
  code: string | null = null,
) {
  await db.execute({
    sql: "INSERT INTO mail_audit_log(tenant_id,id,source_id,event_id,action,code) VALUES (?,?,?,?,?,?)",
    args: [tenant, randomUUID(), source, event, action, code],
  });
}
