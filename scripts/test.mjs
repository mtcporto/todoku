import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Native libSQL can retain Windows file handles until its process exits.
// The parent removes the isolated test directory only after all test processes exit.
const directory = await mkdtemp(join(tmpdir(), "todoku-tests-"));
try {
  const tests = (await readdir("tests")).filter((name) => name.endsWith(".test.ts")).map((name) => join("tests", name));
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", ...tests], {
    stdio: "inherit", env: { ...process.env, TODOKU_TEST_TMPDIR: directory },
  });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
