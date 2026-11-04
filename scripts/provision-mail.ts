import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { getDatabase } from "../src/lib/database.ts";
import { passwordHash } from "../src/lib/mail/auth.ts";
import { audit, transaction } from "../src/lib/mail/common.ts";

const [tenant, username] = process.argv.slice(2);
if (
  !tenant ||
  !username ||
  ![tenant, username].every((x) => /^[a-z0-9_-]{1,80}$/.test(x))
) {
  console.error("Usage: npm run mail:provision -- <tenant> <username>");
  process.exit(1);
}
const db = getDatabase(),
  file = ".env.mail-access.local";
let created = false;
try {
  const password = randomBytes(24).toString("base64url"),
    stored = await passwordHash(password),
    user = randomUUID(),
    source = randomUUID(),
    domain = randomUUID();
  await writeFile(
    file,
    `TODOKU_MAIL_USERNAME=${username}\nTODOKU_MAIL_PASSWORD=${password}\nTODOKU_MAIL_URL=https://todoku.com.br/mail\n`,
    { flag: "wx", mode: 0o600 },
  );
  created = true;
  await transaction(db, async (tx) => {
    await tx.execute({
      sql: "INSERT INTO tenants(id) VALUES (?) ON CONFLICT(id) DO NOTHING",
      args: [tenant],
    });
    await tx.execute({
      sql: "INSERT INTO mail_users(id,username,password_hash) VALUES (?,?,?)",
      args: [user, username, stored],
    });
    await tx.execute({
      sql: "INSERT INTO mail_sources(tenant_id,id,provider,status) VALUES (?,?,'resend','disabled')",
      args: [tenant, source],
    });
    await tx.execute({
      sql: "INSERT INTO mail_domains(tenant_id,id,source_id,name,status) VALUES (?,?,?,'todoku.com.br','disabled')",
      args: [tenant, domain, source],
    });
    for (const [local, label] of [
      ["contato", "Contato"],
      ["suporte", "Suporte"],
    ]) {
      const id = randomUUID();
      await tx.execute({
        sql: "INSERT INTO mail_identities(tenant_id,id,domain_id,address,label,status) VALUES (?,?,?,?,?,'disabled')",
        args: [tenant, id, domain, `${local}@todoku.com.br`, label],
      });
      await tx.execute({
        sql: "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id) VALUES (?,?,?)",
        args: [tenant, id, user],
      });
    }
    await audit(
      tx,
      tenant,
      source,
      null,
      "pilot_provisioned",
      "receiving_disabled",
    );
  });
  console.log(
    JSON.stringify({
      pilot: "todoku.com.br",
      identities: 2,
      receiving: "disabled",
      credentialsFile: file,
      sourceId: source,
    }),
  );
} catch {
  if (created) await unlink(file);
  console.error(
    "Mail provisioning failed. Check schema, existing pilot and private credential file; no secret values are printed.",
  );
  process.exitCode = 1;
} finally {
  db.close();
}
