import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  notifyDeliveryArrived,
  type DeliveryNotifyDeps,
} from "./delivery-notify";

function deps(over: Partial<DeliveryNotifyDeps> = {}): DeliveryNotifyDeps {
  return {
    findPendingOrder: async () => null,
    send: async () => ({ ok: true, providerMessageId: "wamid.x", status: "sent" }),
    ...over,
  };
}

describe("notifyDeliveryArrived", () => {
  it("notifies the delivery number when no order is pending", async () => {
    const sent: { to: string; text: string; audience: string }[] = [];
    const res = await notifyDeliveryArrived(
      "+15550009999",
      deps({
        send: async (to, text, audience) => {
          sent.push({ to, text, audience });
          return { ok: true, providerMessageId: "wamid.d", status: "sent" };
        },
      })
    );
    assert.deepEqual(res, { ok: true, customerPhone: null });
    assert.equal(sent[0]?.audience, "delivery");
    assert.equal(sent[0]?.to, "+15550009999");
  });

  it("notifies the customer for the pending order", async () => {
    const sent: { to: string; audience: string }[] = [];
    const res = await notifyDeliveryArrived(
      "+15550009999",
      deps({
        findPendingOrder: async () => ({
          phoneNumber: "+15550001234",
          customerName: "Ana",
        }),
        send: async (to, _text, audience) => {
          sent.push({ to, audience });
          return { ok: true, providerMessageId: "wamid.c", status: "sent" };
        },
      })
    );
    assert.deepEqual(res, { ok: true, customerPhone: "+15550001234" });
    assert.deepEqual(sent, [{ to: "+15550001234", audience: "customer" }]);
  });

  it("propagates retryable send failures instead of swallowing them", async () => {
    const res = await notifyDeliveryArrived(
      "+15550009999",
      deps({
        send: async () => ({ ok: false, error: "502 upstream", retryable: true }),
      })
    );
    assert.deepEqual(res, {
      ok: false,
      error: "502 upstream",
      retryable: true,
    });
  });

  it("reports pending-order lookup failure as retryable", async () => {
    const res = await notifyDeliveryArrived(
      "+15550009999",
      deps({
        findPendingOrder: async () => {
          throw new Error("db down");
        },
      })
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, true);
  });
});
