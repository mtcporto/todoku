import { getDatabase } from "../src/lib/database.ts";
import { bootstrapHubAdministrator } from "../src/lib/hub/administration.ts";

const [tenant, user, actor] = process.argv.slice(2);
const db = getDatabase();
try {
  console.log(JSON.stringify(await bootstrapHubAdministrator(db, tenant, user, actor, process.env.TODOKU_HUB_ADMIN_BOOTSTRAP_CONFIRMED === "true")));
} catch {
  console.error("Hub bootstrap refused. Use an explicitly authorized tenant, existing user UUID and actor UUID; never an email-derived role.");
  process.exitCode = 1;
} finally { db.close(); }
