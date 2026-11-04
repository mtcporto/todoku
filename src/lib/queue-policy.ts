// No sender/worker runs in this release. An expired lease is not proof of non-delivery.
export function retryDecision(input: {
  attempts: number;
  maxAttempts: number;
  outcome: "transient_not_sent" | "permanent" | "ambiguous";
  now: number;
  jitter: number;
}) {
  if (!Number.isInteger(input.attempts) || input.attempts < 1 ||
      !Number.isInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 10 ||
      !Number.isFinite(input.now) || input.jitter < 0 || input.jitter > 1 || !Number.isFinite(input.jitter)) {
    throw new Error("Invalid retry parameters");
  }
  if (input.outcome === "ambiguous") return { status: "manual_review" as const };
  if (input.outcome === "permanent" || input.attempts >= input.maxAttempts) return { status: "dead" as const };
  const delay = Math.min(3_600_000, 30_000 * 2 ** (input.attempts - 1) * (1 + input.jitter));
  return { status: "retry_wait" as const, availableAt: new Date(input.now + delay).toISOString() };
}
