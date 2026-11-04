import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@libsql/client";

// Run explicitly with an operator-selected database, never in a request or build.
export async function migrate(db: Client, directory: string): Promise<string[]> {
  await db.execute("PRAGMA foreign_keys = ON");
  await db.execute(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
  const applied: string[] = [];
  for (const file of (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    const version = file.slice(0, -4);
    const source = await readFile(join(directory, file), "utf8");
    const checksum = createHash("sha256").update(source.replace(/\r\n/g, "\n")).digest("hex");
    const tx = await db.transaction("write");
    try {
      const existing = await tx.execute({ sql: "SELECT checksum FROM schema_migrations WHERE version = ?", args: [version] });
      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${version}`);
      } else {
        for (const sql of source.split("-- statement-breakpoint").filter((sql) => sql.trim())) await tx.execute(sql);
        await tx.execute({ sql: "INSERT INTO schema_migrations(version, checksum) VALUES (?, ?)", args: [version, checksum] });
        applied.push(version);
      }
      await tx.commit();
    } catch (error) {
      try { if (!tx.closed) await tx.rollback(); } catch { /* Preserve the original migration error. */ }
      throw error;
    } finally {
      // close() rolls back an uncommitted transaction, including any failed DDL.
      tx.close();
    }
  }
  return applied;
}
