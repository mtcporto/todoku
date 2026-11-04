import { parentPort, workerData } from "node:worker_threads";
import { createClient } from "@libsql/client";
import { runWorker } from "../../src/lib/worker.ts";
const db = createClient({ url: workerData.url, timeout: 3_000 });
try {
  const result = await runWorker(db, { mode: "test", configurationId: workerData.configId, keyring: workerData.ring,
    providerFactory: () => ({ channel: "email", name: "fixture", async send() { return { kind: "accepted", providerMessageId: workerData.providerId }; } }) });
  parentPort!.postMessage(result.processed);
} finally { db.close(); }
