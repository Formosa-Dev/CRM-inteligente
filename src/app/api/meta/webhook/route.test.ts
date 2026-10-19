import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";

import { GET, POST, metaMessageToInboundEvent } from "./route";

// Env must be set before the first getIntegrationSecrets() call — the module
// caches for 30s once resolved. getIntegrationSecrets reads env lazily inside
// the function, so assignment at module top (before any test runs) suffices.
process.env.META_APP_SECRET = "test-meta-app-secret";
process.env.META_WEBHOOK_VERIFY_TOKEN = "test-verify-token";

const SECRET = "test-meta-app-secret";

function signedPost(body: unknown): NextRequest {
  const raw = JSON.stringify(body);
  return new NextRequest("https://example.test/api/meta/webhook", {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`,
    },
  });
}

function metaEnvelope(messages: unknown[], phoneNumberId = "123456789") {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "5491111111111",
                phone_number_id: phoneNumberId,
              },
              contacts: [{ profile: { name: "Ana" }, wa_id: "5492222222222" }],
              messages,
            },
          },
        ],
      },
    ],
  };
}

describe("metaMessageToInboundEvent", () => {
  it("normalizes a Meta text message for the shared pipeline", () => {
    const msg = { id: "wamid.ABC", from: "5492222222222", timestamp: "1700000000" };
    const event = metaMessageToInboundEvent(msg, {
      providerAccountId: "123456789",
      senderName: "Ana",
      text: "hola",
      provider: "ycloud",
    });

    assert.equal(event.provider, "ycloud");
    assert.equal(event.kind, "message.received");
    assert.equal(event.direction, "inbound");
    assert.equal(event.deliveryId, "meta:wamid.ABC");
    assert.equal(event.platformMessageId, "wamid.ABC");
    assert.equal(event.providerAccountId, "123456789");
    assert.deepEqual(event.sender, { phone: "5492222222222", name: "Ana" });
    assert.equal(event.type, "text");
    assert.equal(event.text, "hola");
    assert.equal(event.timestamp, new Date(1700000000 * 1000).toISOString());
    // The pipeline reads the provider message off raw.whatsappInboundMessage.
    assert.equal(
      (event.raw as Record<string, unknown>).whatsappInboundMessage,
      msg
    );
    // Without the envelope type the shared pipeline drops the event as a
    // protocol artifact (isProtocolArtifact requires the inbound type).
    assert.equal(
      (event.raw as Record<string, unknown>).type,
      "whatsapp.inbound_message.received"
    );
  });

  it("synthesizes a deterministic deliveryId when the wamid is absent", () => {
    const msg = { from: "5492222222222", timestamp: "1700000000" };
    const a = metaMessageToInboundEvent(msg, {
      providerAccountId: "1",
      text: "hola",
      provider: "ycloud",
    });
    const b = metaMessageToInboundEvent(msg, {
      providerAccountId: "1",
      text: "hola",
      provider: "ycloud",
    });
    assert.match(a.deliveryId, /^meta:synth:[0-9a-f]{24}$/);
    assert.equal(a.deliveryId, b.deliveryId);
    assert.equal(a.platformMessageId, undefined);
  });
});

describe("GET /api/meta/webhook", () => {
  it("echoes the challenge for the configured verify token", async () => {
    const res = await GET(
      new NextRequest(
        "https://example.test/api/meta/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=CH42"
      )
    );
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "CH42");
  });

  it("rejects a wrong verify token", async () => {
    const res = await GET(
      new NextRequest(
        "https://example.test/api/meta/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CH42"
      )
    );
    assert.equal(res.status, 403);
  });
});

describe("POST /api/meta/webhook", () => {
  it("rejects an unsigned envelope", async () => {
    const res = await POST(
      new NextRequest("https://example.test/api/meta/webhook", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
    );
    assert.equal(res.status, 401);
  });

  it("rejects a wrongly-signed envelope", async () => {
    const req = new NextRequest("https://example.test/api/meta/webhook", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=deadbeef",
      },
    });
    assert.equal((await POST(req)).status, 401);
  });

  it("acks a signed envelope with no messages", async () => {
    const res = await POST(signedPost({ object: "whatsapp_business_account", entry: [] }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, processed: 0 });
  });

  it("reaches the pipeline: a signed message returns retryable 503 without a DB", async () => {
    const res = await POST(
      signedPost(
        metaEnvelope([
          {
            id: "wamid.TEST1",
            from: "5492222222222",
            timestamp: "1700000000",
            type: "text",
            text: { body: "hola" },
          },
        ])
      )
    );
    // Signature OK → envelope parsed → strict account resolution hits the
    // (absent) DB → ChannelAccountResolutionError is retryable → 503 so Meta
    // redelivers. Pre-fix this route would have persisted nothing and acked.
    assert.equal(res.status, 503);
  });
});
