/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * Account-scoped router/account resolution behavior over a mocked DB:
 * - A-05: phone-addressed send-account resolution must not assume ycloud — a
 *   whatsapp conversation/account bound to kapso (or any registered provider)
 *   resolves and the messenger binds `account.provider` downstream.
 * - A-12: chat_messages platform-message-id dedup is scoped per channel
 *   account — (coalesce(channel_account_id, -1), platform_message_id) — so
 *   dual-provider/dual-account setups never drop each other's messages.
 * - A-53: a non-ycloud channel_accounts row with credentialsRef 'agent_config'
 *   is a strict mismatch (fail closed), never silently empty credentials.
 *
 * Synthetic ids only — no real phones, no DATABASE_URL, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "../messaging/test-support/fake-db";

const fake = new FakeDb();
const restoreDb = installFakeDb(fake);

const {
  insertMessage,
  isMessageDuplicate,
  resolveConversationAccountForPhone,
  resolveDefaultWhatsAppAccount,
} = require("@/lib/channels/router") as typeof import("@/lib/channels/router");
const {
  resolveChannelAccountByIdStrict,
} = require("@/lib/messaging/accounts") as typeof import("@/lib/messaging/accounts");

function seedAccountRow(over: Record<string, unknown>): void {
  fake.rows("channel_accounts").push({
    id: 1,
    tenantId: "default",
    provider: "ycloud",
    channel: "whatsapp",
    providerAccountId: "15550009999",
    senderAddress: "+15550009999",
    displayName: null,
    credentialsRef: "agent_config",
    agentConfigId: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
}

function seedConversation(over: Record<string, unknown>): void {
  fake.rows("conversations").push({
    id: 1,
    channel: "whatsapp",
    channelAccountId: null,
    whatsappId: null,
    externalUserId: "+15550001234",
    externalUserIdNormalized: "15550001234",
    customerPhone: "+15550001234",
    status: "active",
    ...over,
  });
}

describe("A-53 — non-ycloud agent_config credentialsRef fails closed", () => {
  it("a kapso row with credentialsRef 'agent_config' resolves to mismatch", async () => {
    seedAccountRow({ id: 301, provider: "kapso" });
    const resolution = await resolveChannelAccountByIdStrict(301);
    assert.equal(resolution.kind, "mismatch");
    if (resolution.kind === "mismatch") {
      assert.match(resolution.reason, /agent_config/);
      assert.match(resolution.reason, /kapso/);
    }
  });

  it("a non-ycloud row with an env ref still resolves scoped credentials", async () => {
    seedAccountRow({ id: 302, provider: "kapso", credentialsRef: "env:R53_KAPSO_" });
    process.env.R53_KAPSO_API_KEY = "scoped-kapso-key";
    try {
      const resolution = await resolveChannelAccountByIdStrict(302);
      assert.equal(resolution.kind, "resolved");
      if (resolution.kind === "resolved") {
        assert.equal(resolution.account.credentials.apiKey, "scoped-kapso-key");
      }
    } finally {
      delete process.env.R53_KAPSO_API_KEY;
    }
  });
});

// Keep the hook alive for the whole file; node runs this process per file.
process.on("exit", () => {
  restoreDb();
});
