import { parentPort, workerData } from "node:worker_threads";
import { createClient } from "@libsql/client";
import { handleEventRequest } from "../../src/lib/http.ts";

// Each worker has its own native connection and event loop, like separate app instances.
// The busy timeout can wait for the other worker without blocking its commit.
const db = createClient({ url: workerData.url, timeout: 3_000 });
try {
  const response = await handleEventRequest(new Request("http://localhost/api/v1/events", {
    method: "POST", headers: { authorization: `Bearer ${workerData.token}`, "content-type": "application/json" },
    body: JSON.stringify(workerData.payload),
  }), () => db);
  parentPort!.postMessage({ status: response.status, body: await response.json() });
} finally { db.close(); }
