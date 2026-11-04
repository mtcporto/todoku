import { resolve } from "node:path";
import { getDatabase } from "../src/lib/database.ts";
import { migrate } from "../src/lib/migrations.ts";

// Deliberate confirmation prevents accidentally migrating another app's database.
const selected = process.argv[2];
const url = process.env.TURSO_DATABASE_URL;
if (!selected || selected !== url) {
  console.error("Usage: npm run db:migrate -- <exact TURSO_DATABASE_URL>. Inspect the selected database first.");
  process.exit(1);
}
const db = getDatabase();
try {
  const tables = await db.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
  const names = tables.rows.map((row) => String(row.name));
  if (names.length && !names.includes("schema_migrations")) {
    throw new Error("Unrecognized existing database; refusing migration");
  }
  const applied = await migrate(db, resolve("migrations"));
  console.log(JSON.stringify({ database: new URL(selected).hostname, applied }));
} catch {
  console.error("Migration failed. Database unchanged for the failed migration; inspect access, schema and migration history securely.");
  process.exitCode = 1;
} finally { db.close(); }
