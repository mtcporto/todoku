import { z } from "zod";

export const communicationEventSchema = z.strictObject({
  id: z.uuid(),
  type: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/).max(120),
  occurredAt: z.iso.datetime({ offset: true }),
  tenantId: z.string().min(1).max(100),
  applicationId: z.string().min(1).max(100),
  trafficType: z.enum(["transactional", "marketing"]).default("transactional"),
  recipient: z.strictObject({ email: z.email().max(254) }),
  data: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(8).max(200),
});

export type CommunicationEvent = z.infer<typeof communicationEventSchema>;
export type DeliveryChannel = "email";
export type DeliveryStatus = "accepted" | "queued" | "sent" | "delivered" | "failed";

export interface DeliveryProvider {
  readonly channel: DeliveryChannel;
  readonly name: string;
  send(input: SendInput): Promise<SendResult>;
}

export type EmailMessage = { from: string; to: string[]; subject: string; text: string; html: string };
export type SendInput = { message: EmailMessage; idempotencyKey: string };
export type SendResult =
  | { kind: "accepted"; providerMessageId: string }
  | { kind: "retryable"; code: string; uncertain: boolean; retryAfterMs?: number }
  | { kind: "permanent" | "review"; code: string };
