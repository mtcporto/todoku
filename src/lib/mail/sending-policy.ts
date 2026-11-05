import type { Client, Row } from "@libsql/client";
import { z } from "zod";
import { audit, MailError, transaction } from "./common.ts";
import { outboundLimits, type DraftContent } from "./outbound-common.ts";

const policyFields = z.strictObject({
  recipientPolicy: z.enum(["allowlist", "external"]),
  allowedRecipients: z
    .array(z.email().transform((x) => x.toLowerCase()))
    .max(10),
  dailyLimit: z.number().int().min(1).max(100),
});
export const sendingPolicySchema = policyFields.superRefine(
  (policy, context) => {
    if (
      (policy.recipientPolicy === "allowlist") !==
      policy.allowedRecipients.length > 0
    )
      context.addIssue({
        code: "custom",
        message:
          "Allowlist requires recipients; external policy requires an empty list",
      });
  },
);
export type SendingPolicy = z.infer<typeof sendingPolicySchema>;

export function sendingPolicy(configuration: Row) {
  return policyFields.parse({
    recipientPolicy: configuration.recipient_policy ?? "allowlist",
    allowedRecipients: JSON.parse(
      String(configuration.allowed_recipients_json),
    ),
    dailyLimit: Number(configuration.daily_limit),
  });
}

export function allowRecipients(content: DraftContent, configuration: Row) {
  const policy = sendingPolicy(configuration);
  const recipients = [
    ...content.envelope.to,
    ...content.envelope.cc,
    ...content.envelope.bcc,
  ];
  if (recipients.length > outboundLimits.recipients)
    throw new MailError("too_many_recipients", 422);
  if (
    !content.envelope.to.length ||
    (policy.recipientPolicy === "allowlist" &&
      recipients.some((x) => !policy.allowedRecipients.includes(x)))
  )
    throw new MailError("recipient_not_allowed", 403);
}

// Trusted operator service, shared with the future administration layer.
// An HTTP caller must authenticate and authorize a domain administrator first.
// This does not grant access, enable an identity, or replace credentials.
export async function updateSendingPolicy(
  db: Client,
  tenant: string,
  identity: string,
  input: SendingPolicy,
) {
  const next = sendingPolicySchema.parse(input);
  return transaction(db, async (tx) => {
    const row = (
      await tx.execute({
        sql: `SELECT c.*,d.source_id FROM mail_sending_configurations c
        JOIN mail_identities i ON i.tenant_id=c.tenant_id AND i.id=c.identity_id
        JOIN mail_domains d ON d.tenant_id=i.tenant_id AND d.id=i.domain_id
        WHERE c.tenant_id=? AND c.identity_id=?`,
        args: [tenant, identity],
      })
    ).rows[0];
    if (!row) throw new MailError("sending_not_configured", 404);
    const previous = sendingPolicy(row);
    if (JSON.stringify(previous) === JSON.stringify(next))
      return { changed: false, policy: next };
    await tx.execute({
      sql: "UPDATE mail_sending_configurations SET recipient_policy=?,allowed_recipients_json=?,daily_limit=? WHERE tenant_id=? AND identity_id=?",
      args: [
        next.recipientPolicy,
        JSON.stringify(next.allowedRecipients),
        next.dailyLimit,
        tenant,
        identity,
      ],
    });
    await audit(
      tx,
      tenant,
      String(row.source_id),
      null,
      "sending_policy_changed",
      JSON.stringify({ identityId: identity, previous, next }),
    );
    return { changed: true, policy: next };
  });
}
