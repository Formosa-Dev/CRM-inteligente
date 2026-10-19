import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  sendOrderStatusNotification,
  type OrderStatusNotifyDeps,
} from "./order-status-notify";
import type { ChannelAccount, SendResult } from "@/lib/messaging/types";

const ACCOUNT_A: ChannelAccount = {
  id: "1",
  tenantId: "default",
  provider: "ycloud",
  channel: "whatsapp",
  providerAccountId: "15550000001",
  senderAddress: "+15550000001",
  credentials: { apiKey: "a", webhookSecret: "" },
  status: "active",
};
const ACCOUNT_B: ChannelAccount = { ...ACCOUNT_A, id: "2", providerAccountId: "15550000002" };

function deps(over: Partial<OrderStatusNotifyDeps> = {}): OrderStatusNotifyDeps {
  return {
    resolveBinding: async () => ({ kind: "unbound" }),
    resolveDefaultAccount: async () => ({ kind: "resolved", account: ACCOUNT_A }),
    send: async () => ({ ok: true, providerMessageId: "wamid.x", status: "sent" }),
    ...over,
  };
}

describe("sendOrderStatusNotification", () => {
  it("sends through the conversation's bound account", async () => {
    const seen: { account?: ChannelAccount }[] = [];
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: ACCOUNT_B,
          conversationId: 7,
        }),
        send: async (_msg, opts) => {
          seen.push({ account: opts.account });
          return { ok: true, providerMessageId: "wamid.b", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.providerMessageId, "wamid.b");
      assert.equal(res.conversationId, 7);
      assert.equal(res.channelAccountId, 2);
    }
    assert.equal(seen[0].account?.id, "2");
  });

  it("routes replies for account A and account B to their own senders", async () => {
    const sentTo: string[] = [];
    const send = async (
      _msg: { to: string; type: "text"; text: string },
      opts: { channel?: "whatsapp"; account?: ChannelAccount }
    ): Promise<SendResult> => {
      sentTo.push(opts.account?.id ?? "none");
      return { ok: true, providerMessageId: "wamid.x", status: "sent" };
    };
    const depsFor = (account: ChannelAccount): OrderStatusNotifyDeps =>
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account,
          conversationId: account.id === "1" ? 101 : 202,
        }),
        send,
      });

    await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "A" },
      depsFor(ACCOUNT_A)
    );
    await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "B" },
      depsFor(ACCOUNT_B)
    );
    assert.deepEqual(sentTo, ["1", "2"]);
  });

  it("uses the single active account only when the conversation is unbound", async () => {
    const seen: { account?: ChannelAccount }[] = [];
    const res = await sendOrderStatusNotification(
      { phoneNumber: "+15550001234", message: "listo" },
      deps({
        send: async (_msg, opts) => {
          seen.push({ account: opts.account });
          return { ok: true, providerMessageId: "wamid.a", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.channelAccountId, 1);
    assert.equal(seen[0].account?.id, "1");
  });

  it("fails closed on ambiguous accounts instead of sending globally", async () => {
    let sent = false;
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({ kind: "ambiguous", accountIds: [1, 2] }),
        send: async () => {
          sent = true;
          return { ok: true, providerMessageId: "x", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, false);
    assert.equal(sent, false);
    if (!res.ok) assert.match(res.error, /multiple accounts/);
  });

  it("surfaces bound-account and send failures to the caller", async () => {
    const unresolvable = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({
          kind: "unresolvable",
          accountId: 9,
          reason: "missing/inactive",
        }),
      })
    );
    assert.equal(unresolvable.ok, false);

    const failed: SendResult = { ok: false, error: "502 upstream", retryable: true };
    const sendFailure = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({ send: async () => failed })
    );
    assert.deepEqual(sendFailure, {
      ok: false,
      error: "502 upstream",
      retryable: true,
    });
  });

  it("surfaces a transient binding failure as retryable", async () => {
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({
          kind: "error",
          error: new Error("db down"),
          retryable: true,
        }),
      })
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, true);
  });
});
