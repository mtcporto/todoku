import { Resend } from "resend";
import { z } from "zod";
import { bytes, limits, MailError } from "./common.ts";

export type InboundMessage = {
  id: string;
  from: string;
  subject: string;
  to: string[];
  received_for?: string[];
  cc: string[];
  bcc: string[];
  reply_to?: string[];
  html: string | null;
  text: string | null;
  message_id: string | null;
  headers: Record<string, string>;
  authentication?: { dmarc?: string } | null;
  raw: { download_url: string } | null;
  attachments: {
    id: string;
    filename: string | null;
    content_type: string;
    size: number;
  }[];
};
export interface InboundProvider {
  get(id: string): Promise<InboundMessage>;
  raw(message: InboundMessage): Promise<Uint8Array>;
  attachment(email: string, id: string): Promise<Uint8Array>;
}
const schema = z.object({
  id: z.uuid(),
  from: z.string().max(320),
  subject: z
    .string()
    .max(1000)
    .nullable()
    .transform((x) => x ?? ""),
  to: z.array(z.string()).max(50),
  received_for: z.array(z.string()).max(50).optional(),
  cc: z
    .array(z.string())
    .max(50)
    .nullish()
    .transform((x) => x ?? []),
  bcc: z
    .array(z.string())
    .max(50)
    .nullish()
    .transform((x) => x ?? []),
  reply_to: z
    .array(z.string().max(320))
    .max(50)
    .nullish()
    .transform((x) => x ?? []),
  html: z.string().max(limits.body).nullable(),
  text: z.string().max(limits.body).nullable(),
  message_id: z.string().max(1000).nullable(),
  headers: z
    .record(z.string(), z.string().max(8000))
    .nullable()
    .transform((x) => x ?? {}),
  authentication: z
    .object({ dmarc: z.string().optional() })
    .nullable()
    .optional(),
  raw: z
    .object({ download_url: z.url() })
    .nullish()
    .transform((x) => x ?? null),
  attachments: z
    .array(
      z.object({
        id: z.uuid(),
        filename: z.string().max(1000).nullable(),
        content_type: z.string().max(200),
        size: z.int().min(0).max(limits.attachment),
      }),
    )
    .max(limits.attachments),
});
export function validateMessage(value: unknown, id: string): InboundMessage {
  const parsed = schema.safeParse(value);
  if (!parsed.success || parsed.data.id !== id)
    throw new MailError("invalid_provider_content", 422);
  return parsed.data;
}

export class ResendInbound implements InboundProvider {
  #client: Resend;
  constructor(key: string) {
    this.#client = new Resend(key);
  }
  async get(id: string) {
    const { data, error } = await this.#client.emails.receiving.get(
      id,
      { html_format: "cid" },
      { signal: AbortSignal.timeout(10_000) },
    );
    if (error || !data) throw new MailError("provider_fetch_failed", 503);
    return validateMessage(data, id);
  }
  async #download(value: string, max: number) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !(
        url.hostname === "cdn.resend.app" ||
        url.hostname === "inbound-cdn.resend.com" ||
        /^[a-z0-9-]+\.cloudfront\.net$/.test(url.hostname)
      )
    )
      throw new MailError("untrusted_download_host", 422);
    return bytes(
      await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }),
      max,
    );
  }
  async raw(message: InboundMessage) {
    if (!message.raw) throw new MailError("mime_unavailable", 422);
    return this.#download(message.raw.download_url, limits.raw);
  }
  async attachment(email: string, id: string) {
    const { data, error } = await this.#client.emails.receiving.attachments.get(
      { emailId: email, id },
      { signal: AbortSignal.timeout(10_000) },
    );
    if (error || !data) throw new MailError("attachment_fetch_failed", 503);
    if (data.id !== id || data.size > limits.attachment)
      throw new MailError("invalid_attachment", 422);
    return this.#download(data.download_url, limits.attachment);
  }
}
