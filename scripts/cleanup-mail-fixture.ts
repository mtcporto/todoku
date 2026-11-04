import { readFile, unlink } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { getDatabase } from "../src/lib/database.ts";
import { FixtureStorage } from "../src/lib/mail/storage.ts";
import { audit, transaction } from "../src/lib/mail/common.ts";
const tenant = process.env.TODOKU_MAIL_FIXTURE_TENANT;
if (
  process.env.VERCEL ||
  !tenant ||
  !/^mail-fixture-[a-f0-9-]{36}$/.test(tenant) ||
  !process.env.TODOKU_MAIL_FIXTURE_DIRECTORY
)
  throw new Error("Select an explicit local fixture scope");
const db = getDatabase(),
  storage = new FixtureStorage(process.env.TODOKU_MAIL_FIXTURE_DIRECTORY);
try {
  await transaction(db, async (tx) => {
    await tx.execute({
      sql: "UPDATE tenants SET status='disabled' WHERE id=?",
      args: [tenant],
    });
    await tx.execute({
      sql: "UPDATE mail_sources SET status='disabled' WHERE tenant_id=? AND provider='fixture'",
      args: [tenant],
    });
    await tx.execute({
      sql: "UPDATE mail_users SET status='disabled' WHERE id IN (SELECT user_id FROM mail_identity_grants WHERE tenant_id=?)",
      args: [tenant],
    });
    await tx.execute({
      sql: "UPDATE mail_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id IN (SELECT user_id FROM mail_identity_grants WHERE tenant_id=?)",
      args: [tenant],
    });
    await tx.execute({
      sql: "UPDATE mail_messages SET state='expired',sender='',subject='',preview='',message_id=NULL WHERE tenant_id=?",
      args: [tenant],
    });
    await tx.execute({
      sql: "UPDATE mail_attachments SET filename='anexo expirado',content_type='application/octet-stream' WHERE tenant_id=?",
      args: [tenant],
    });
  });
  const objects = (
    await db.execute({
      sql: "SELECT o.* FROM mail_objects o JOIN mail_sources s ON s.tenant_id=o.tenant_id AND s.id=o.source_id WHERE o.tenant_id=? AND s.provider='fixture' AND o.state!='deleted'",
      args: [tenant],
    })
  ).rows;
  for (const object of objects) {
    await storage.delete(tenant, String(object.object_key));
    await db.execute({
      sql: "UPDATE mail_objects SET state='deleted' WHERE tenant_id=? AND id=?",
      args: [tenant, object.id],
    });
  }
  await audit(
    db,
    tenant,
    process.env.TODOKU_MAIL_FIXTURE_SOURCE ?? null,
    null,
    "fixture_cleaned",
  );
  const local = parseEnv(await readFile('.env.mail-fixture.local','utf8'));
  if(local.TODOKU_MAIL_FIXTURE_TENANT === tenant) await unlink('.env.mail-fixture.local');
  console.log(
    JSON.stringify({
      fixture: "disabled",
      credentials: "revoked",
      objectsDeleted: objects.length,
      audit: "retained",
    }),
  );
} finally {
  db.close();
}
