/**
 * Unit tests for the S12 unified-ingress seam (node:test — runs via
 * `npm run test:agents`). Pure/logic coverage only: no DB, no network.
 *
 * `resolveIngressContext` is exercised on the degraded path: with no
 * DATABASE_URL the channel_accounts query throws inside resolveChannelAccount,
 * which falls back to the agent_config placeholder for registered channels —
 * that degraded-resolution contract is what these tests pin down.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  channelForProvider,
  CHANNEL_KINDS,
  isChannelKind,
  isProviderId,
  PROVIDER_IDS,
} from "./registry";
import { ycloudProvider } from "./providers/ycloud";
import {
  channelAccountRowId,
  logAckedWithoutPersistence,
  resolveEventChannel,
  resolveIngressContext,
  resolveWebhookSecret,
} from "./ingress";
import type { NormalizedInboundEvent } from "./types";

function makeEvent(
  overrides: Partial<NormalizedInboundEvent> = {}
): NormalizedInboundEvent {
  return {
    provider: "ycloud",
    deliveryId: "del-1",
    kind: "message.received",
    direction: "inbound",
    providerAccountId: "",
    type: "text",
    text: "hola",
    sender: { phone: "5493704000000" },
    timestamp: "2026-01-01T00:00:00.000Z",
    raw: { type: "whatsapp.inbound_message.received" },
    ...overrides,
  };
}

describe("registry constants + guards", () => {
  it("exposes the provider contract ids", () => {
    assert.deepEqual(PROVIDER_IDS, ["ycloud", "zernio", "kapso"]);
    assert.ok(isProviderId("ycloud"));
    assert.ok(isProviderId("zernio"));
    assert.ok(!isProviderId("meta"));
    assert.ok(!isProviderId(""));
  });

  it("exposes the channel kinds", () => {
    assert.deepEqual(CHANNEL_KINDS, [
      "whatsapp",
      "instagram",
      "facebook",
      "telegram",
      "sms",
      "reddit",
    ]);
    assert.ok(isChannelKind("instagram"));
    assert.ok(!isChannelKind("myspace"));
  });

  it("inverts the channel→provider map", () => {
    assert.equal(channelForProvider("ycloud"), "whatsapp");
    assert.equal(channelForProvider("zernio"), undefined);
    assert.equal(channelForProvider("kapso"), undefined);
  });
});

describe("resolveWebhookSecret", () => {
  it("reads <PROVIDER>_WEBHOOK_SECRET for non-ycloud providers", async () => {
    process.env.ZERNIO_WEBHOOK_SECRET = "zernio-test-secret";
    try {
      assert.equal(await resolveWebhookSecret("zernio"), "zernio-test-secret");
    } finally {
      delete process.env.ZERNIO_WEBHOOK_SECRET;
    }
  });

  it("returns empty string when the env var is absent", async () => {
    delete process.env.KAPSO_WEBHOOK_SECRET;
    assert.equal(await resolveWebhookSecret("kapso"), "");
  });
});

describe("channelAccountRowId", () => {
  it("maps numeric row ids", () => {
    assert.equal(channelAccountRowId({
      id: "42",
      tenantId: "t",
      provider: "ycloud",
      channel: "whatsapp",
      providerAccountId: "waba-1",
      senderAddress: "",
      credentials: { apiKey: "", webhookSecret: "" },
      status: "active",
    }), 42);
  });

  it("returns undefined for placeholder/undefined accounts", () => {
    assert.equal(channelAccountRowId(undefined), undefined);
    assert.equal(channelAccountRowId({
      id: "whatsapp:agent-config",
      tenantId: "t",
      provider: "ycloud",
      channel: "whatsapp",
      providerAccountId: "",
      senderAddress: "",
      credentials: { apiKey: "", webhookSecret: "" },
      status: "active",
    }), undefined);
  });
});

describe("resolveEventChannel", () => {
  it("prefers an explicit channel hint on raw", () => {
    const event = makeEvent({
      raw: { channel: "instagram", type: "comment.received" },
    });
    assert.equal(resolveEventChannel(ycloudProvider, event), "instagram");
  });

  it("falls back to the registry inverse for ycloud", () => {
    assert.equal(resolveEventChannel(ycloudProvider, makeEvent()), "whatsapp");
  });

  it("ignores invalid channel hints", () => {
    const event = makeEvent({ raw: { platform: "myspace" } });
    assert.equal(resolveEventChannel(ycloudProvider, event), "whatsapp");
  });
});

describe("resolveIngressContext (degraded DB)", () => {
  it("resolves whatsapp events to the legacy placeholder account", async () => {
    const ctx = await resolveIngressContext(
      ycloudProvider,
      makeEvent({ providerAccountId: "waba-123" })
    );
    assert.ok(ctx);
    assert.equal(ctx.channel, "whatsapp");
    assert.equal(ctx.account.id, "whatsapp:agent-config");
    assert.equal(ctx.channelAccountId, undefined);
  });

  it("fails closed for channels with no registered provider", async () => {
    const ctx = await resolveIngressContext(
      ycloudProvider,
      makeEvent({ raw: { channel: "instagram" }, providerAccountId: "acc-9" })
    );
    assert.equal(ctx, undefined);
  });
});

describe("logAckedWithoutPersistence", () => {
  it("does not throw", () => {
    logAckedWithoutPersistence(makeEvent({ kind: "message.status" }), "test");
  });
});
