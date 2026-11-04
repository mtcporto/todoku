import assert from "node:assert/strict";
import { test } from "node:test";
import { communicationEventSchema } from "../src/lib/events.ts";

const valid = {
  id: "bc3bd75e-fc71-4951-b566-c1505d06d613", type: "user.welcome",
  occurredAt: "2026-11-04T20:00:00Z", tenantId: "pixelvivo", applicationId: "minhanota",
  recipient: { email: "example@example.com" }, data: { firstName: "Exemplo" },
  idempotencyKey: "welcome-bc3bd75e",
};
test("accepts a typed event", () => { assert.equal(communicationEventSchema.safeParse(valid).success, true); });
test("rejects unknown top-level keys", () => { assert.equal(communicationEventSchema.safeParse({ ...valid, token: "secret" }).success, false); });
test("requires a tenant", () => { assert.equal(communicationEventSchema.safeParse({ ...valid, tenantId: "" }).success, false); });
test("requires valid email", () => { assert.equal(communicationEventSchema.safeParse({ ...valid, recipient: { email: "invalid" } }).success, false); });
