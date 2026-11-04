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
  send(input: { to: string; subject: string; html: string; idempotencyKey: string }): Promise<{ providerMessageId: string }>;
}
