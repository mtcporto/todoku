import { parentPort, workerData } from "node:worker_threads";
import { createClient } from "@libsql/client";
import { runMailWorker } from "../../src/lib/mail/worker.ts";
import { FixtureStorage } from "../../src/lib/mail/storage.ts";
import { provider } from "./mail-fixture.ts";
const db = createClient({ url: workerData.url, timeout: 3000 });
try {
  const original = provider(workerData.message);
  const result = await runMailWorker(db, new FixtureStorage(workerData.root), {
    enabled: true,
    fixtures: true,
    provider: () => ({
      ...original,
      get: async (id) => {
        parentPort!.postMessage({ called: true });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return original.get(id);
      },
    }),
  });
  parentPort!.postMessage({ result });
} finally {
  db.close();
}
