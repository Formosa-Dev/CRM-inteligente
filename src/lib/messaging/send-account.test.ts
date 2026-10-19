import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideSendAccount, type SendAccountDeps } from "./send-account";
import type { ChannelAccount } from "./types";

const A: ChannelAccount = {
  id: "1",
  tenantId: "default",
  provider: "ycloud",
  channel: "whatsapp",
  providerAccountId: "15550000001",
  senderAddress: "+15550000001",
  credentials: { apiKey: "a", webhookSecret: "" },
  status: "active",
};
const B: ChannelAccount = { ...A, id: "2", providerAccountId: "15550000002", senderAddress: "+15550000002" };

function deps(over: Partial<SendAccountDeps> = {}): SendAccountDeps {
  return {
    resolveBinding: async () => ({ kind: "unbound" }),
    resolveDefaultAccount: async () => ({ kind: "resolved", account: A }),
    ...over,
  };
}

describe("decideSendAccount", () => {
  it("routes bound A and B conversations to their own accounts", async () => {
    const a = await decideSendAccount(
      "+15550001234",
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: A,
          conversationId: 101,
        }),
      })
    );
    const b = await decideSendAccount(
      "+15550001234",
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: B,
          conversationId: 202,
        }),
      })
    );
    assert.equal(a.kind, "send");
    assert.equal(b.kind, "send");
    if (a.kind === "send" && b.kind === "send") {
      assert.equal(a.channelAccountId, 1);
      assert.equal(b.channelAccountId, 2);
      assert.equal(a.conversationId, 101);
      assert.equal(b.conversationId, 202);
    }
  });

  it("uses the single active account only for unbound conversations", async () => {
    const d = await decideSendAccount("+15550001234", deps());
    assert.equal(d.kind, "send");
    if (d.kind === "send") assert.equal(d.channelAccountId, 1);
  });

  it("retries transient lookup failures and drops ambiguous/not-found", async () => {
    const retry = await decideSendAccount(
      "+15550001234",
      deps({
        resolveBinding: async () => ({
          kind: "error",
          error: new Error("db down"),
          retryable: true,
        }),
      })
    );
    assert.equal(retry.kind, "retry");

    const permanent = await decideSendAccount(
      "+15550001234",
      deps({
        resolveBinding: async () => ({
          kind: "error",
          error: new Error("bad"),
          retryable: false,
        }),
      })
    );
    assert.equal(permanent.kind, "drop");

    const ambiguous = await decideSendAccount(
      "+15550001234",
      deps({
        resolveBinding: async () => ({ kind: "ambiguous", accountIds: [1, 2] }),
      })
    );
    assert.equal(ambiguous.kind, "drop");

    const notFound = await decideSendAccount(
      "+15550001234",
      deps({
        resolveDefaultAccount: async () => ({ kind: "not-found", reason: "inactive" }),
      })
    );
    assert.equal(notFound.kind, "drop");
  });

  it("never falls back to a global account when the default is ambiguous", async () => {
    const d = await decideSendAccount(
      "+15550001234",
      deps({
        resolveDefaultAccount: async () => ({ kind: "ambiguous", reason: "two active" }),
      })
    );
    assert.deepEqual(d.kind, "drop");
  });

  it("keeps the legacy sender only when the channel is unprovisioned", async () => {
    const legacy = await decideSendAccount(
      "+15550001234",
      deps({ resolveDefaultAccount: async () => ({ kind: "unprovisioned" }) })
    );
    assert.equal(legacy.kind, "send");
    if (legacy.kind === "send") {
      assert.equal(legacy.account, undefined);
      assert.equal(legacy.channelAccountId, null);
    }
  });
});
