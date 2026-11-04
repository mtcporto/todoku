import { randomBytes, randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { getDatabase, isDatabaseReady } from "../src/lib/database.ts";
import { hashCredential } from "../src/lib/ingestion.ts";

const [tenantId, applicationId] = process.argv.slice(2);
if (!tenantId || !applicationId || ![tenantId, applicationId].every((id) => /^[a-zA-Z0-9_-]{1,100}$/.test(id))) {
  console.error("Usage: npm run db:provision -- <tenant-id> <application-id>");
  process.exit(1);
}
const db = getDatabase();
const filename = `.env.credential.${tenantId}.${applicationId}.local`;
const token = randomBytes(32).toString("base64url");
let fileCreated = false;
try {
  if (!await isDatabaseReady(db)) throw new Error("Schema unavailable");
  // Exclusive file creation prevents overwriting a credential. Never print the token.
  await writeFile(filename, `TODOKU_APPLICATION_TOKEN=${token}\n`, { flag: "wx", mode: 0o600 });
  fileCreated = true;
  await db.batch([
    { sql: "INSERT INTO tenants(id) VALUES (?) ON CONFLICT(id) DO NOTHING", args: [tenantId] },
    { sql: "INSERT INTO applications(tenant_id, id) VALUES (?, ?) ON CONFLICT(tenant_id, id) DO NOTHING", args: [tenantId, applicationId] },
    { sql: "INSERT INTO application_credentials(tenant_id, application_id, id, token_hash) VALUES (?, ?, ?, ?)", args: [tenantId, applicationId, randomUUID(), hashCredential(token)] },
  ], "write");
  console.log(`Credential stored in ignored local file ${filename}. Only its SHA-256 hash was stored in Turso.`);
} catch {
  if (fileCreated) await unlink(filename);
  console.error("Provisioning failed. Inspect schema, access or an existing credential file securely.");
  process.exitCode = 1;
} finally { db.close(); }
