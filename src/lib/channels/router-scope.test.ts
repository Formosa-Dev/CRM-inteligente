/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * Account-scoped router/account resolution behavior over a mocked DB:
 * - A-05: phone-addressed send-account resolution must not assume ycloud — a
 *   whatsapp conversation/account bound to kapso (or any registered provider)
 *   resolves and the messenger binds `account.provider` downstream.
 * - A-12: chat_messages platform-message-id dedup is scoped per channel
 *   account — (coalesce(channel_account_id, -1), platform_message_id) — so
 *   dual-provider/dual-account setups never drop each other's messages.
 * - A-53/S2: a non-ycloud channel_accounts row with credentialsRef
 *   'agent_config' resolves provider credentials per FIELD across the
 *   scope chain (account → channel → global); blank on every scope plus
 *   env stays a strict mismatch (fail closed), never empty credentials.
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

describe("A-05 — send-account resolution is provider-agnostic", () => {
  function seedKapsoAccount(id: number): void {
    seedAccountRow({
      id,
      provider: "kapso",
      credentialsRef: "env:R05_KAPSO_",
    });
    process.env.R05_KAPSO_API_KEY = "kapso-key";
  }

  it("a whatsapp conversation bound to a kapso account resolves the sender", async () => {
    seedKapsoAccount(310);
    seedConversation({ id: 310, channelAccountId: 310 });
    try {
      const resolution = await resolveConversationAccountForPhone("+15550001234");
      assert.equal(resolution.kind, "resolved");
      if (resolution.kind === "resolved") {
        assert.equal(resolution.account.provider, "kapso");
        assert.equal(resolution.conversationId, 310);
      }
    } finally {
      delete process.env.R05_KAPSO_API_KEY;
    }
  });

  it("the single active whatsapp account wins even when it is not ycloud", async () => {
    process.env.R05_KAPSO_API_KEY = "kapso-key";
    try {
      const resolution = await resolveDefaultWhatsAppAccount();
      assert.equal(resolution.kind, "resolved");
      if (resolution.kind === "resolved") {
        assert.equal(resolution.account.provider, "kapso");
      }
    } finally {
      delete process.env.R05_KAPSO_API_KEY;
    }
  });

  it("a bound but missing account still fails closed", async () => {
    seedConversation({
      id: 311,
      channelAccountId: 999,
      externalUserId: "+15550007777",
      externalUserIdNormalized: "15550007777",
      customerPhone: "+15550007777",
    });
    const resolution = await resolveConversationAccountForPhone("+15550007777");
    assert.equal(resolution.kind, "unresolvable");
  });
});

describe("A-53/S2 — agent_config refs resolve per-field across the scope chain", () => {
  it("a kapso row resolves its scoped kapsoApiKeyEnc from the channel scope", async () => {
    seedAccountRow({ id: 301, provider: "kapso" });
    fake.rows("agent_config").push({
      id: 41,
      channel: "whatsapp",
      channelAccountId: null,
      kapsoApiKeyEnc: "kapso-channel-key",
      kapsoWebhookSecretEnc: "kapso-channel-secret",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const resolution = await resolveChannelAccountByIdStrict(301);
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind === "resolved") {
      assert.equal(resolution.account.credentials.apiKey, "kapso-channel-key");
      assert.equal(
        resolution.account.credentials.webhookSecret,
        "kapso-channel-secret"
      );
    }
  });

  it("a flag-only scoped row inherits fields it does not set (per-field merge)", async () => {
    seedAccountRow({ id: 303, provider: "zernio" });
    // Account row exists but carries no zernio fields; the whatsapp
    // channel-scope row above carries only kapso — the zernio key must come
    // from the global row, proving each field inherits independently.
    fake.rows("agent_config").push({
      id: 42,
      channel: "whatsapp",
      channelAccountId: 303,
      kapsoApiKeyEnc: "",
      enabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fake.rows("agent_config").push({
      id: 1,
      channel: null,
      channelAccountId: null,
      zernioApiKeyEnc: "zernio-global-key",
      zernioWebhookSecretEnc: "zernio-global-secret",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const resolution = await resolveChannelAccountByIdStrict(303);
    assert.equal(resolution.kind, "resolved");
    if (resolution.kind === "resolved") {
      assert.equal(resolution.account.credentials.apiKey, "zernio-global-key");
      assert.equal(
        resolution.account.credentials.webhookSecret,
        "zernio-global-secret"
      );
    }
  });

  it("blank on every scope and env is an explicit failure (fail closed)", async () => {
    seedAccountRow({ id: 305, provider: "kapso", channel: "sms" });
    delete process.env.KAPSO_API_KEY;
    delete process.env.KAPSO_ACCESS_TOKEN;
    const resolution = await resolveChannelAccountByIdStrict(305);
    assert.equal(resolution.kind, "mismatch");
    if (resolution.kind === "mismatch") {
      assert.match(resolution.reason, /kapso/);
      assert.match(resolution.reason, /no usable credential/);
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

describe("A-12 — platform_message_id dedup is account-scoped", () => {
  it("the same platform id persists once per account, never dropped", async () => {
    const a = await insertMessage(1, "user", "copy A", undefined, "wamid-shared", 7);
    const b = await insertMessage(2, "user", "copy B", undefined, "wamid-shared", 8);

    assert.equal(a.wasDuplicate, false);
    assert.equal(b.wasDuplicate, false);
    assert.notEqual(a.id, b.id, "account B's copy must persist, not alias A's");
  });

  it("a same-account duplicate returns the existing row", async () => {
    const again = await insertMessage(1, "user", "copy A2", undefined, "wamid-shared", 7);
    assert.equal(again.wasDuplicate, true);
    const first = fake
      .rows("chat_messages")
      .find((row) => row.platformMessageId === "wamid-shared" && row.channelAccountId === 7);
    assert.equal(again.id, first?.id);
  });

  it("isMessageDuplicate scopes reads to the owning partition", async () => {
    assert.equal(await isMessageDuplicate("wamid-shared", 7), true);
    assert.equal(await isMessageDuplicate("wamid-shared", 8), true);
    assert.equal(await isMessageDuplicate("wamid-shared", 9), false);
    // The legacy NULL partition only sees NULL-account rows.
    assert.equal(await isMessageDuplicate("wamid-shared", null), false);
    // Callers without account context keep the provider-wide read.
    assert.equal(await isMessageDuplicate("wamid-shared"), true);
  });

  it("NULL-account messages still dedup inside their own partition", async () => {
    const first = await insertMessage(3, "user", "legacy", undefined, "wamid-legacy", null);
    const dupe = await insertMessage(3, "user", "legacy again", undefined, "wamid-legacy", null);
    assert.equal(first.wasDuplicate, false);
    assert.equal(dupe.wasDuplicate, true);
    assert.equal(dupe.id, first.id);

    // An account-bound row with the same id is a different partition.
    const bound = await insertMessage(4, "user", "bound copy", undefined, "wamid-legacy", 7);
    assert.equal(bound.wasDuplicate, false);
    assert.equal(await isMessageDuplicate("wamid-legacy", null), true);
    assert.equal(await isMessageDuplicate("wamid-legacy", 7), true);
    assert.equal(await isMessageDuplicate("wamid-legacy", 8), false);
  });
});

// Keep the hook alive for the whole file; node runs this process per file.
process.on("exit", () => {
  restoreDb();
});
