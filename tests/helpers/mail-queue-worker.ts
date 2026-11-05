import { parentPort, workerData } from "node:worker_threads";
import { createClient } from "@libsql/client";
import { MemoryStorage } from "./mail-fixture.ts";
import { queueMail } from "../../src/lib/mail/send.ts";
const db = createClient({ url: workerData.url, timeout: 5000 });
const storage = new MemoryStorage();
storage.objects = workerData.objects;
try {
  const result = await queueMail(
    db,
    "alice",
    workerData.id,
    "ia",
    workerData.version,
    storage,
    true,
  );
  parentPort!.postMessage({ queued: result.queued });
} catch (error) {
  parentPort!.postMessage({
    queued: false,
    error: error instanceof Error ? error.message : "unknown",
  });
} finally {
  db.close();
}
