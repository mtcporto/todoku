import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { R2Storage, objectKey } from "../src/lib/mail/storage.ts";

// Synthetic bytes only; no database, email content, or public bucket access.
const account = process.env.TODOKU_R2_ACCOUNT_ID ?? "";
const bucket = process.env.TODOKU_R2_BUCKET ?? "";
const requests: { method: string; status: number }[] = [];
const storage = new R2Storage(
  {
    account,
    bucket,
    accessKeyId: process.env.TODOKU_R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.TODOKU_R2_SECRET_ACCESS_KEY ?? "",
  },
  async (input, init) => {
    const response = await fetch(input, init);
    requests.push({
      method: input instanceof Request ? input.method : (init?.method ?? "GET"),
      status: response.status,
    });
    return response;
  },
);
const tenant = "todoku-storage-smoke";
const key = objectKey(tenant, "r2-proof", randomUUID(), "synthetic.bin");
const value = new TextEncoder().encode(`Todoku synthetic R2 proof ${randomUUID()}`);
let uploaded = false;
try {
  // Mark first: a timeout can happen after the provider accepted the upload.
  uploaded = true;
  await storage.put(tenant, key, value);
  assert.deepEqual(await storage.get(tenant, key), value);
  const anonymous = await fetch(
    `https://${account}.r2.cloudflarestorage.com/${bucket}/${key}`,
    { redirect: "error", signal: AbortSignal.timeout(10_000) },
  );
  assert.equal(anonymous.status, 403);
} finally {
  if (uploaded) await storage.delete(tenant, key);
}
await assert.rejects(() => storage.get(tenant, key));
assert.deepEqual(requests.map((request) => request.method), ["PUT", "GET", "DELETE", "GET"]);
assert.equal(requests.at(-1)?.status, 404);
console.log(JSON.stringify({
  bucket,
  syntheticBytes: value.length,
  sha256: createHash("sha256").update(value).digest("hex"),
  requests,
  anonymousAccess: "denied",
  objectDeleted: true,
  externalEmails: 0,
}));
