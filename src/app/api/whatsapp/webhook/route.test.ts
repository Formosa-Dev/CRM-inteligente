import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { POST } from "./route";

const SECRET = "whsec_route_test_fixture";

function sign(body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},s=${digest}`;
}

function request(body: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://example.test/api/whatsapp/webhook", {
    method: "POST",
    body,
    headers,
  });
}

let previousSecret: string | undefined;

beforeEach(() => {
  previousSecret = process.env.YCLOUD_WEBHOOK_SECRET;
  process.env.YCLOUD_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env.YCLOUD_WEBHOOK_SECRET;
  else process.env.YCLOUD_WEBHOOK_SECRET = previousSecret;
});

describe("canonical WhatsApp webhook HTTP statuses", () => {
  it("rejects a missing signature with 401", async () => {
    const res = await POST(request("{}"));
    assert.equal(res.status, 401);
  });

  it("rejects a raw body whose signature does not match with 401", async () => {
    const body = JSON.stringify({ type: "whatsapp.inbound_message.received" });
    const res = await POST(
      request(body, { "ycloud-signature": sign(body.replace("inbound", "tampered")) })
    );
    assert.equal(res.status, 401);
  });

  it("does not ack a signed event when account resolution is unavailable", async () => {
    const body = JSON.stringify({ hello: "world" });
    const res = await POST(request(body, { "ycloud-signature": sign(body) }));
    // Parsed as an "other" event; without DATABASE_URL account resolution is a
    // transient failure, which must be retryable rather than acked.
    assert.equal(res.status, 503);
  });

  it("returns a retryable status (not 200) when account resolution cannot reach the DB", async () => {
    const body = JSON.stringify({
      type: "whatsapp.inbound_message.received",
      id: "evt_route_1",
      whatsappInboundMessage: {
        id: "wamid_route_1",
        from: "+15550001234",
        to: "+15550009999",
        type: "text",
        text: { body: "hola" },
      },
    });
    const res = await POST(request(body, { "ycloud-signature": sign(body) }));
    assert.equal(res.status, 503);
  });
});
