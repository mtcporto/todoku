import { randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { getDatabase } from "../src/lib/database.ts";
import { passwordHash } from "../src/lib/mail/auth.ts";
import { hash, transaction } from "../src/lib/mail/common.ts";
const username = process.argv[2];
if (!username || !/^[a-z0-9_-]{1,80}$/.test(username)) {
  console.error("Usage: mail:password <username>");
  process.exit(1);
}
const db = getDatabase(),
  file = `.env.mail-access.rotated.${Date.now()}.local`;
let written = false;
try {
  const password = randomBytes(24).toString("base64url"),
    stored = await passwordHash(password);
  await writeFile(
    file,
    `TODOKU_MAIL_USERNAME=${username}\nTODOKU_MAIL_PASSWORD=${password}\nTODOKU_MAIL_URL=https://todoku.com.br/mail\n`,
    { flag: "wx", mode: 0o600 },
  );
  written = true;
  await transaction(db, async (tx) => {
    const user = (
      await tx.execute({
        sql: "SELECT id FROM mail_users WHERE username=?",
        args: [username],
      })
    ).rows[0];
    if (!user) throw new Error("Unavailable user");
    await tx.execute({
      sql: "UPDATE mail_users SET password_hash=? WHERE id=?",
      args: [stored, user.id],
    });
    await tx.execute({
      sql: "UPDATE mail_sessions SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=?",
      args: [user.id],
    });
    await tx.execute({
      sql: "DELETE FROM mail_login_limits WHERE bucket=?",
      args: [hash(username)],
    });
  });
  console.log(
    JSON.stringify({
      passwordRotated: true,
      sessionsRevoked: true,
      credentialsFile: file,
    }),
  );
} catch {
  if (written) await unlink(file);
  console.error("Password rotation failed. No credential values are printed.");
  process.exitCode = 1;
} finally {
  db.close();
}
