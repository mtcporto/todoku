import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "todoku-consumer-"));
try {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/smoke-hub-consumer.ts", ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, TODOKU_TEST_TMPDIR: directory } });
  process.exitCode = result.status ?? 1;
} finally {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unexpected fixture directory");
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
