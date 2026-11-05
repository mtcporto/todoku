import type { Client } from "@libsql/client";
import { z } from "zod";
import { sameOrigin } from "./auth.ts";
import { audit, body, json, MailError, transaction } from "./common.ts";
import type { MailStorage } from "./storage.ts";
import { composeTemplate, draftSchema, saveDraft } from "./drafts.ts";
import { outboundLimits, rateLimit } from "./outbound-common.ts";
import { manageMessage } from "./authorization.ts";
import { queueMail } from "./send.ts";

export async function mailActions(
  request: Request,
  segments: string[],
  db: Client,
  user: string,
  storage: () => MailStorage | null,
): Promise<Response | null> {
  const [operation, id, action] = segments,
    url = new URL(request.url),
    identity = url.searchParams.get("identity");
  if (
    operation === "drafts" &&
    segments.length === 1 &&
    request.method === "POST"
  ) {
    sameOrigin(request);
    const input = draftSchema.parse(
      JSON.parse(await body(request, outboundLimits.requestBytes)),
    );
    return json(await saveDraft(db, user, storage(), input));
  }
  if (operation !== "messages" || !id || segments.length !== 3) return null;
  if (action === "compose" && request.method === "GET") {
    if (!identity) throw new MailError("identity_required", 422);
    const mode = z
      .enum(["reply", "reply-all", "forward"])
      .parse(url.searchParams.get("mode"));
    return json(await composeTemplate(db, user, id, identity, mode, storage()));
  }
  if (request.method !== "POST") return null;
  if (!["draft", "send", "trash", "restore", "purge"].includes(action))
    return null;
  sameOrigin(request);
  if (action === "draft") {
    const input = draftSchema.parse(
      JSON.parse(await body(request, outboundLimits.requestBytes)),
    );
    return json(await saveDraft(db, user, storage(), input, id));
  }
  if (!identity) throw new MailError("identity_required", 422);
  if (action === "send") {
    const input = z
      .strictObject({ version: z.int().min(1) })
      .parse(JSON.parse(await body(request, 128)));
    return json(
      await queueMail(db, user, id, identity, input.version, storage()),
      202,
    );
  }
  const message = await manageMessage(db, user, id, identity);
  await rateLimit(db, String(message.tenant_id), user, "folder-write", 30);
  const input = z
    .strictObject({ confirm: z.boolean().optional() })
    .parse(JSON.parse(await body(request, 128)));
  await transaction(db, async (tx) => {
    const current = await manageMessage(tx, user, id, identity);
    const job = (
      await tx.execute({
        sql: "SELECT id FROM mail_send_jobs WHERE tenant_id=? AND message_id=? AND state IN ('pending','sending','retry_wait','manual_review')",
        args: [current.tenant_id, id],
      })
    ).rows[0];
    if (job) throw new MailError("send_in_progress", 409);
    const now = new Date().toISOString();
    if (action === "trash") {
      if (current.folder === "trash") return;
      await tx.execute({
        sql: "UPDATE mail_message_recipients SET previous_folder=folder,folder='trash',trashed_at=? WHERE tenant_id=? AND identity_id=? AND message_id=? AND deleted_at IS NULL",
        args: [now, current.tenant_id, identity, id],
      });
    } else if (action === "restore") {
      if (current.folder !== "trash") throw new MailError("not_in_trash", 409);
      await tx.execute({
        sql: "UPDATE mail_message_recipients SET folder=COALESCE(previous_folder,'inbox'),previous_folder=NULL,trashed_at=NULL WHERE tenant_id=? AND identity_id=? AND message_id=? AND deleted_at IS NULL",
        args: [current.tenant_id, identity, id],
      });
    } else {
      if (current.folder !== "trash" || input.confirm !== true)
        throw new MailError("permanent_delete_confirmation_required", 409);
      await tx.execute({
        sql: "UPDATE mail_message_recipients SET deleted_at=? WHERE tenant_id=? AND identity_id=? AND message_id=? AND deleted_at IS NULL",
        args: [now, current.tenant_id, identity, id],
      });
      const remaining = (
        await tx.execute({
          sql: "SELECT count(*) AS n FROM mail_message_recipients WHERE tenant_id=? AND message_id=? AND deleted_at IS NULL",
          args: [current.tenant_id, id],
        })
      ).rows[0];
      if (!Number(remaining.n)) {
        await tx.execute({
          sql: "UPDATE mail_messages SET state='expired',sender='',subject='',preview='',message_id=NULL,expires_at=? WHERE tenant_id=? AND id=?",
          args: [now, current.tenant_id, id],
        });
        await tx.execute({
          sql: "UPDATE mail_objects SET expires_at=? WHERE tenant_id=? AND id IN (SELECT content_object_id FROM mail_messages WHERE tenant_id=? AND id=? UNION SELECT raw_object_id FROM mail_messages WHERE tenant_id=? AND id=? UNION SELECT object_id FROM mail_attachments WHERE tenant_id=? AND message_id=?)",
          args: [
            now,
            current.tenant_id,
            current.tenant_id,
            id,
            current.tenant_id,
            id,
            current.tenant_id,
            id,
          ],
        });
      }
    }
    await audit(
      tx,
      String(current.tenant_id),
      String(current.source_id),
      null,
      "message_" + action,
    );
  });
  return json({
    updated: true,
    cleanup: action === "purge" ? "scheduled" : null,
  });
}
