import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
const directory = await mkdtemp(join(tmpdir(), "todoku-profile-ui-"));
try {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/smoke-mail-profile-browser.ts"],
    {
      stdio: "inherit",
      env: { ...process.env, TODOKU_TEST_TMPDIR: directory },
    },
  );
  process.exitCode = result.status ?? 1;
} finally {
  if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
    throw new Error("Unexpected test directory");
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
