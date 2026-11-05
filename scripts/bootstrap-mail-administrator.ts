import { getDatabase } from "../src/lib/database.ts";
import { bootstrapAdministrator } from "../src/lib/mail/authorization.ts";

const [tenant, user, actor] = process.argv.slice(2);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
if (!tenant || !uuid.test(user ?? "") || !uuid.test(actor ?? "")) {
  console.error(
    "Usage: mail:admin:bootstrap -- <tenant> <existing user UUID> <actor UUID>; requires TODOKU_MAIL_ADMIN_BOOTSTRAP_CONFIRMED=true",
  );
  process.exit(1);
}
const db = getDatabase();
try {
  console.log(
    JSON.stringify(
      await bootstrapAdministrator(
        db,
        tenant,
        user,
        actor,
        process.env.TODOKU_MAIL_ADMIN_BOOTSTRAP_CONFIRMED === "true",
      ),
    ),
  );
} catch {
  console.error(
    "Administrator bootstrap refused. Check explicit authorization, existing UUID and membership privately.",
  );
  process.exitCode = 1;
} finally {
  db.close();
}
