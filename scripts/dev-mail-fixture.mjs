import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
if (process.env.VERCEL) throw new Error("Local fixtures only");
Object.assign(
  process.env,
  parseEnv(readFileSync(".env.local", "utf8")),
  parseEnv(readFileSync(".env.mail-fixture.local", "utf8")),
);
// Avoid forwarding --env-file through Next dev's NODE_OPTIONS.
process.argv = [
  process.execPath,
  "next",
  "dev",
  "--hostname",
  "127.0.0.1",
  "--port",
  "3037",
];
await import("next/dist/bin/next");
