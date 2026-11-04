import type { DeliveryProvider, SendInput, SendResult } from "./events.ts";

export class ResendProvider implements DeliveryProvider {
  readonly channel = "email" as const;
  readonly name = "resend";
  #apiKey: string;
  #fetcher: typeof fetch;
  constructor(apiKey: string, fetcher: typeof fetch = fetch) { this.#apiKey = apiKey; this.#fetcher = fetcher; }
  async send(input: SendInput): Promise<SendResult> {
    try {
      const response = await this.#fetcher("https://api.resend.com/emails", {
        method: "POST", headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json", "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify(input.message), signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      if (response.ok) {
        const body = await response.json();
        if (typeof body.id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(body.id)) return { kind: "accepted", providerMessageId: body.id };
        return { kind: "retryable", code: "invalid_provider_receipt", uncertain: true };
      }
      if (response.status === 429 || response.status >= 500) {
        const seconds = Number(response.headers.get("retry-after") ?? 0);
        return { kind: "retryable", code: response.status === 429 ? "provider_rate_limited" : "provider_unavailable", uncertain: response.status >= 500,
          retryAfterMs: Number.isFinite(seconds) ? Math.min(3_600_000, Math.max(0, seconds) * 1000) : 0 };
      }
      if (response.status === 409) return { kind: "review", code: "provider_idempotency_conflict" };
      return { kind: "permanent", code: "provider_rejected" };
    } catch { return { kind: "retryable", code: "provider_timeout_or_network", uncertain: true }; }
  }
}
