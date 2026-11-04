import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { MailError } from "./common.ts";
import {
  validateMessage,
  type InboundProvider,
  type InboundMessage,
} from "./provider.ts";

// The explicit local fixture mode never runs on Vercel and never calls a provider.
export class FixtureInbound implements InboundProvider {
  #root: string;
  constructor() {
    if (
      process.env.VERCEL ||
      process.env.TODOKU_MAIL_STORAGE !== "fixture" ||
      !process.env.TODOKU_MAIL_FIXTURE_INPUT_DIRECTORY
    )
      throw new MailError("fixture_disabled", 503);
    this.#root = resolve(process.env.TODOKU_MAIL_FIXTURE_INPUT_DIRECTORY);
  }
  async get(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new MailError("invalid_fixture");
    const raw = await readFile(join(this.#root, `${id}.json`), "utf8");
    if (raw.length > 1024 * 1024) throw new MailError("size_limit", 422);
    return validateMessage(JSON.parse(raw), id);
  }
  async raw(value: InboundMessage) {
    return Buffer.from(
      `From: ${value.from}\r\nTo: ${value.to.join(", ")}\r\nSubject: ${value.subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${value.text ?? ""}`,
    );
  }
  async attachment() {
    return Buffer.from("Arquivo sintético de demonstração do Todoku Mail.\n");
  }
}
