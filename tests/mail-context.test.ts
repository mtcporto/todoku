import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, message, provider } from "./helpers/mail-fixture.ts";
import { mailRequest } from "../src/lib/mail/http.ts";
import { runMailWorker } from "../src/lib/mail/worker.ts";

test("inbox tenant context narrows content without granting access or changing the authorized mailbox directory", async () => {
  const f = await fixture();
  const inbox = (query: string, as: "alice" | "bob" | "none" = "alice") =>
    mailRequest(
      f.request("inbox?" + query, {}, as),
      ["inbox"],
      f.db,
      () => f.storage,
    );
  try {
    for (const [address, source] of [
      ["inbox@a.example.invalid", f.source],
      ["inbox@b.example.invalid", f.otherSource],
    ] as const) {
      const value = message({
        to: [address],
        received_for: [address],
        subject: address,
      });
      await f.enqueue(value, source);
      await runMailWorker(f.db, f.storage, {
        enabled: true,
        fixtures: true,
        provider: () => provider(value),
      });
    }
    assert.equal((await inbox("tenant=b", "none")).status, 401);
    let data = await (await inbox("tenant=b")).json();
    assert.equal(data.messages.length, 0);
    assert.deepEqual(
      data.identities.map((i: { tenant_id: string }) => i.tenant_id),
      ["a"],
    );
    await f.db.batch(
      [
        "INSERT INTO mail_memberships(tenant_id,user_id) VALUES ('b','alice')",
        "INSERT INTO mail_identity_grants(tenant_id,identity_id,user_id,can_read) VALUES ('b','ib','alice',1)",
      ],
      "write",
    );
    for (const tenant of ["a", "b"]) {
      data = await (await inbox("tenant=" + tenant)).json();
      assert.equal(data.messages.length, 1);
      assert.equal(data.messages[0].subject, `inbox@${tenant}.example.invalid`);
      assert.deepEqual(
        data.identities.map((i: { tenant_id: string }) => i.tenant_id),
        ["a", "b"],
      );
      assert.equal(data.identities[0].domain_status, "active");
      assert.ok(!JSON.stringify(data).includes("encrypted_api_key"));
    }
    for (const query of [
      "tenant=a&domain=db",
      "tenant=b&identity=ia",
      "tenant=unknown",
      "tenant=%27%20OR%201%3D1--",
    ])
      assert.equal((await (await inbox(query)).json()).messages.length, 0);
    await f.db.execute(
      "UPDATE mail_memberships SET status='suspended' WHERE tenant_id='b' AND user_id='alice'",
    );
    data = await (await inbox("tenant=b")).json();
    assert.equal(data.messages.length, 0);
    assert.deepEqual(
      data.identities.map((i: { tenant_id: string }) => i.tenant_id),
      ["a"],
    );
    await f.db.execute(
      "UPDATE mail_identities SET status='disabled' WHERE id='ia'",
    );
    data = await (await inbox("tenant=a")).json();
    assert.equal(data.identities[0].status, "disabled");
    assert.equal(data.messages.length, 0);
    assert.equal((await inbox("tenant=" + "a".repeat(101))).status, 400);
    assert.equal((await inbox("tenant=a&tenant=b")).status, 400);
  } finally {
    f.close();
  }
});
