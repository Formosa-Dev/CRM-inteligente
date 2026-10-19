import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveUnboundWhatsAppSend,
  selectBoundConversationId,
} from "./router";
import type { ChannelAccount } from "@/lib/messaging/types";

const ACCOUNT: ChannelAccount = {
  id: "9",
  tenantId: "default",
  provider: "ycloud",
  channel: "whatsapp",
  providerAccountId: "15550009999",
  senderAddress: "+15550009999",
  credentials: { apiKey: "key", webhookSecret: "" },
  status: "active",
};

describe("selectBoundConversationId", () => {
  it("returns the row bound to the selected account, not a legacy row", () => {
    const rows = [
      { id: 10, channelAccountId: null },
      { id: 11, channelAccountId: 7 },
    ];
    assert.equal(selectBoundConversationId(rows, 7), 11);
  });

  it("returns undefined when no row is bound to the account", () => {
    assert.equal(
      selectBoundConversationId([{ id: 10, channelAccountId: null }], 7),
      undefined
    );
  });
});

describe("resolveUnboundWhatsAppSend", () => {
  const legacy = async () => ({
    kind: "resolved" as const,
    credentials: { apiKey: "legacy", senderAddress: "+15550001111" },
  });

  it("prefers the account bound to the phone", async () => {
    const result = await resolveUnboundWhatsAppSend("+15550001234", {
      resolveBinding: async () => ({
        kind: "resolved",
        account: ACCOUNT,
        conversationId: 10,
      }),
      resolveDefaultAccount: async () => ({ kind: "unprovisioned" }),
      resolveLegacyCredentials: legacy,
    });
    assert.equal(result.kind, "account");
  });

  it("uses the single active account for an unbound conversation", async () => {
    const result = await resolveUnboundWhatsAppSend("+15550001234", {
      resolveBinding: async () => ({ kind: "unbound" }),
      resolveDefaultAccount: async () => ({ kind: "resolved", account: ACCOUNT }),
      resolveLegacyCredentials: legacy,
    });
    assert.equal(result.kind, "account");
  });

  it("only reaches legacy credentials when the channel is unprovisioned", async () => {
    const result = await resolveUnboundWhatsAppSend("+15550001234", {
      resolveBinding: async () => ({ kind: "unbound" }),
      resolveDefaultAccount: async () => ({ kind: "unprovisioned" }),
      resolveLegacyCredentials: legacy,
    });
    assert.deepEqual(result, {
      kind: "legacy",
      credentials: { apiKey: "legacy", senderAddress: "+15550001111" },
    });
  });

  it("hard-fails ambiguous/not-found/db-error instead of using global credentials", async () => {
    const cases = [
      { kind: "ambiguous" as const, accountIds: [1, 2] },
      { kind: "unresolvable" as const, accountId: 2, reason: "inactive" },
      { kind: "error" as const, error: new Error("down"), retryable: true },
    ];
    for (const binding of cases) {
      const result = await resolveUnboundWhatsAppSend("+15550001234", {
        resolveBinding: async () => binding,
        resolveDefaultAccount: async () => ({ kind: "resolved", account: ACCOUNT }),
        resolveLegacyCredentials: legacy,
      });
      assert.equal(result.kind, "fail", binding.kind);
    }

    const notFound = await resolveUnboundWhatsAppSend("+15550001234", {
      resolveBinding: async () => ({ kind: "unbound" }),
      resolveDefaultAccount: async () => ({ kind: "not-found", reason: "inactive" }),
      resolveLegacyCredentials: legacy,
    });
    assert.equal(notFound.kind, "fail");
  });

  it("fails when an unprovisioned channel has no usable legacy key", async () => {
    const result = await resolveUnboundWhatsAppSend("+15550001234", {
      resolveBinding: async () => ({ kind: "unbound" }),
      resolveDefaultAccount: async () => ({ kind: "unprovisioned" }),
      resolveLegacyCredentials: async () => ({
        kind: "missing",
        reason: "blank scoped ycloudApiKey",
      }),
    });
    assert.equal(result.kind, "fail");
  });
});
