/**
 * Unit tests for the S12 unified-ingress seam (node:test — runs via
 * `npm run test:agents`). Pure/logic coverage only: no DB, no network.
 *
 * With no DATABASE_URL, account resolution is a transient DB failure: it must
 * surface (503 at the route) instead of silently resolving to a placeholder.
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
  eventConversationExternalUserId,
  eventSelfAddresses,
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

describe("resolveIngressContext (no DB)", () => {
  it("surfaces a transient account-resolution failure instead of a placeholder", async () => {
    await assert.rejects(() =>
      resolveIngressContext(
        ycloudProvider,
        makeEvent({ providerAccountId: "waba-123" })
      )
    );
  });

  it("does not ack a foreign channel by falling back to another sender", async () => {
    await assert.rejects(() =>
      resolveIngressContext(
        ycloudProvider,
        makeEvent({ raw: { channel: "instagram" }, providerAccountId: "acc-9" })
      )
    );
  });
});

describe("business self-address candidates", () => {
  it("uses only the business side of an echo/status envelope", () => {
    const echo = makeEvent({
      kind: "message.echo",
      direction: "outbound",
      sender: { phone: "+15550009999" },
      raw: {
        whatsappMessage: { from: "+15550009999", to: "+15550001234" },
      },
    });
    assert.deepEqual(eventSelfAddresses(echo), ["+15550009999"]);

    const status = makeEvent({
      kind: "message.status",
      direction: "outbound",
      sender: {},
      raw: {
        whatsappMessageUpdated: { from: "+15550009999", to: "+15550001234" },
      },
    });
    assert.deepEqual(eventSelfAddresses(status), ["+15550009999"]);
  });

  it("uses the business `to` for inbound messages", () => {
    const inbound = makeEvent({
      raw: { whatsappInboundMessage: { from: "+15550001234", to: "+15550009999" } },
    });
    assert.deepEqual(eventSelfAddresses(inbound), ["+15550009999"]);
  });
});

describe("logAckedWithoutPersistence", () => {
  it("does not throw", () => {
    logAckedWithoutPersistence(makeEvent({ kind: "message.status" }), "test");
  });
});

describe("passive conversation identity", () => {
  it("keys echoes by providerConversationId, never the business phone", () => {
    const echo = makeEvent({
      kind: "message.echo",
      direction: "outbound",
      sender: { phone: "+15550009999" },
      providerConversationId: "+15550001234",
    });
    assert.equal(eventConversationExternalUserId(echo), "+15550001234");
  });

  it("does not fall back to the business phone when an echo has no customer id", () => {
    const echo = makeEvent({
      kind: "message.echo",
      direction: "outbound",
      sender: { phone: "+15550009999" },
    });
    assert.equal(eventConversationExternalUserId(echo), undefined);
  });

  it("keys inbound messages by the sender", () => {
    assert.equal(
      eventConversationExternalUserId(makeEvent({ sender: { phone: "+15550001234" } })),
      "+15550001234"
    );
  });
});
