import { AwsClient } from "aws4fetch";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { bytes, hash, limits, MailError } from "./common.ts";

export interface MailStorage {
  readonly durable: boolean;
  put(tenant: string, key: string, value: Uint8Array): Promise<void>;
  get(tenant: string, key: string): Promise<Uint8Array>;
  delete(tenant: string, key: string): Promise<void>;
}
export function objectKey(
  tenant: string,
  source: string,
  email: string,
  part: string,
) {
  return `mail/${hash(tenant)}/${hash(source)}/${hash(email)}/${hash(part)}`;
}
export function checkKey(tenant: string, key: string) {
  if (
    !/^mail\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(
      key,
    ) ||
    !key.startsWith(`mail/${hash(tenant)}/`)
  )
    throw new MailError("invalid_object", 404);
}
export class R2Storage implements MailStorage {
  readonly durable = true;
  #client: AwsClient;
  #base: string;
  #fetcher: typeof fetch;
  constructor(
    config: {
      account: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    },
    fetcher: typeof fetch = fetch,
  ) {
    if (
      !/^[a-f0-9]{32}$/.test(config.account) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.accessKeyId ||
      !config.secretAccessKey
    )
      throw new MailError("storage_unavailable", 503);
    this.#base = `https://${config.account}.r2.cloudflarestorage.com/${config.bucket}/`;
    this.#client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: "s3",
      region: "auto",
      retries: 0,
    });
    this.#fetcher = fetcher;
  }
  async #request(
    tenant: string,
    key: string,
    method: string,
    value?: Uint8Array,
  ) {
    checkKey(tenant, key);
    const request = await this.#client.sign(this.#base + key, {
      method,
      body: value ? Buffer.from(value) : undefined,
      headers: { "content-type": "application/octet-stream" },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const response = await this.#fetcher(request);
    if (!(response.ok || (method === "DELETE" && response.status === 404)))
      throw new MailError("storage_unavailable", 503);
    return response;
  }
  async put(tenant: string, key: string, value: Uint8Array) {
    if (value.length > limits.raw) throw new MailError("size_limit", 422);
    await this.#request(tenant, key, "PUT", value);
  }
  async get(tenant: string, key: string) {
    return bytes(await this.#request(tenant, key, "GET"), limits.raw);
  }
  async delete(tenant: string, key: string) {
    await this.#request(tenant, key, "DELETE");
  }
}
// Explicit local testing only. Never a fallback for R2 or a Vercel filesystem.
export class FixtureStorage implements MailStorage {
  readonly durable = false;
  #root: string;
  constructor(root: string) {
    this.#root = resolve(root);
  }
  #path(tenant: string, key: string) {
    checkKey(tenant, key);
    const path = resolve(this.#root, key);
    if (!path.startsWith(this.#root + sep))
      throw new MailError("invalid_object", 404);
    return path;
  }
  async put(tenant: string, key: string, value: Uint8Array) {
    const path = this.#path(tenant, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  }
  async get(tenant: string, key: string) {
    return new Uint8Array(await readFile(this.#path(tenant, key)));
  }
  async delete(tenant: string, key: string) {
    await rm(this.#path(tenant, key), { force: true });
  }
}
export function mailStorage(): MailStorage | null {
  if (process.env.TODOKU_MAIL_STORAGE === "r2")
    return new R2Storage({
      account: process.env.TODOKU_R2_ACCOUNT_ID ?? "",
      bucket: process.env.TODOKU_R2_BUCKET ?? "",
      accessKeyId: process.env.TODOKU_R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.TODOKU_R2_SECRET_ACCESS_KEY ?? "",
    });
  if (
    !process.env.VERCEL &&
    process.env.TODOKU_MAIL_STORAGE === "fixture" &&
    process.env.TODOKU_MAIL_FIXTURE_DIRECTORY
  )
    return new FixtureStorage(process.env.TODOKU_MAIL_FIXTURE_DIRECTORY);
  return null;
}
