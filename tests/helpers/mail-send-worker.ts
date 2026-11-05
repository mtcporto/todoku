import { parentPort, workerData } from "node:worker_threads";
import { createClient } from "@libsql/client";
import { runMailSendWorker } from "../../src/lib/mail/send.ts";
import { MemoryStorage } from "./mail-fixture.ts";
const db = createClient({ url: workerData.url, timeout: 3000 });
const storage = new MemoryStorage();
storage.objects = new Map(workerData.objects);
try {
  const result = await runMailSendWorker(db, storage, {
    enabled: true,
    provider: () => ({
      send: async () => {
        parentPort!.postMessage({ called: true });
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { kind: "accepted", id: workerData.providerId };
      },
    }),
  });
  parentPort!.postMessage({ result });
} finally {
  db.close();
}
