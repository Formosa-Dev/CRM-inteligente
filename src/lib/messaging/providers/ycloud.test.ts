import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { describe } from "node:test";
import { ycloudProvider as provider } from "./ycloud";
import type { ChannelAccount } from "../types";

const SECRET = "whsec_test_fixture_secret";
const NOW = Math.floor(Date.now() / 1000);

function sign(rawBody: string, secret: string, timestamp = NOW): string {
  const s = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},s=${s}`;
}

const ACCOUNT: ChannelAccount = {
  id: "acct_test",
  provider: "ycloud",
  channel: "whatsapp",
  providerAccountId: "15550009999",
  senderAddress: "+15550009999",
  credentials: { apiKey: "fake-api-key", webhookSecret: SECRET },
  status: "active",
  tenantId: "default",
  isDefault: true,
  displayAddress: "+15550009999",
};

// Recorded fixture shapes per docs.ycloud.com/reference/webhook-events-payloads.
// All identifiers/phones/names are synthetic test data.

const INBOUND_TEXT_EVENT = JSON.stringify({
  type: "whatsapp.inbound_message.received",
  id: "evt_01TESTINBOUND0000000001",
  apiVersion: "v2",
  createTime: "2026-10-18T12:00:00.000Z",
  whatsappInboundMessage: {
    id: "wamid.TESTFAKEINBOUND0000000001",
    wamid: "wamid.TESTFAKEINBOUND0000000001",
    wabaId: "123456789012345",
    from: "+15550001234",
    fromUserId: "15550001234.TESTBSUID000001",
    fromParentUserId: "15550001234.TESTPARENTBSUID1",
    customerProfile: { name: "Test User", username: "testuser" },
    to: "+15550009999",
    sendTime: "2026-10-18T12:00:01.000Z",
    type: "text",
    text: { body: "hola, quiero hacer un pedido" },
  },
});

const INBOUND_IMAGE_EVENT = JSON.stringify({
  type: "whatsapp.inbound_message.received",
  id: "evt_01TESTINBOUND0000000002",
  whatsappInboundMessage: {
    id: "wamid.TESTFAKEINBOUND0000000002",
    wamid: "wamid.TESTFAKEINBOUND0000000002",
    wabaId: "123456789012345",
    from: "+15550001234",
    to: "+15550009999",
    sendTime: "2026-10-18T12:00:02.000Z",
    type: "image",
    image: {
      id: "media_test_0002",
      link: "https://cdn.ycloud.com/media/media_test_0002.jpg",
      mime_type: "image/jpeg",
      file_name: "foto.jpg",
      caption: "mi pedido en foto",
    },
  },
});

const ECHO_EVENT = JSON.stringify({
  type: "whatsapp.message.echo",
  id: "evt_01TESTECHO0000000000003",
  createTime: "2026-10-18T12:00:03.000Z",
  whatsappMessage: {
    id: "wamid.TESTFAKEECHO00000000000003",
    wamid: "wamid.TESTFAKEECHO00000000000003",
    wabaId: "123456789012345",
    from: "+15550009999",
    to: "+15550001234",
    sendTime: "2026-10-18T12:00:03.500Z",
    type: "text",
    text: { body: "respuesta manual desde WhatsApp Business" },
  },
});

const SMB_ECHO_EVENT = JSON.stringify({
  type: "whatsapp.smb.message.echoes",
  id: "evt_01TESTSMBECHO00000000004",
  whatsappSmbMessageEcho: {
    id: "wamid.TESTFAKESMBECHO00000000004",
    wamid: "wamid.TESTFAKESMBECHO00000000004",
    from: "+15550009999",
    to: "+15550001234",
    sendTime: "2026-10-18T12:00:04.000Z",
    type: "text",
    text: { body: "eco smb" },
  },
});

const STATUS_EVENT = JSON.stringify({
  type: "whatsapp.message.updated",
  id: "evt_01TESTSTATUS00000000005",
  createTime: "2026-10-18T12:00:05.000Z",
  whatsappMessage: {
    id: "wamid.TESTFAKESTATUS00000000005",
    wamid: "wamid.TESTFAKESTATUS00000000005",
    wabaId: "123456789012345",
    status: "read",
    updateTime: "2026-10-18T12:00:05.000Z",
  },
});

describe("ycloud verifyWebhook — timestamped-hmac fixtures", () => {
  test("accepts a valid t,s signature", () => {
    const res = provider.verifyWebhook({
      headers: { "ycloud-signature": sign(INBOUND_TEXT_EVENT, SECRET) },
      rawBody: INBOUND_TEXT_EVENT,
      secret: SECRET,
    });
    assert.deepEqual(res, { ok: true });
  });

  test("rejects a signature made with the wrong secret", () => {
    const res = provider.verifyWebhook({
      headers: {
        "ycloud-signature": sign(INBOUND_TEXT_EVENT, "wrong-secret"),
      },
      rawBody: INBOUND_TEXT_EVENT,
      secret: SECRET,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "signature_mismatch");
  });

  test("rejects a tampered body", () => {
    const header = sign(INBOUND_TEXT_EVENT, SECRET);
    const res = provider.verifyWebhook({
      headers: { "ycloud-signature": header },
      rawBody: INBOUND_TEXT_EVENT.replace("hola", "CHAU"),
      secret: SECRET,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "signature_mismatch");
  });

  test("rejects an expired timestamp beyond the 300s tolerance", () => {
    const expired = NOW - 400;
    const res = provider.verifyWebhook({
      headers: {
        "ycloud-signature": sign(INBOUND_TEXT_EVENT, SECRET, expired),
      },
      rawBody: INBOUND_TEXT_EVENT,
      secret: SECRET,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "expired_timestamp");
  });

  test("rejects a malformed signature header", () => {
    for (const header of ["garbage", "t=abc", "s=deadbeef", "t=,s=", ""]) {
      const res = provider.verifyWebhook({
        headers: { "ycloud-signature": header },
        rawBody: INBOUND_TEXT_EVENT,
        secret: SECRET,
      });
      assert.equal(res.ok, false, `header '${header}' must fail`);
      if (header === "") {
        assert.equal(res.reason, "missing_signature_header");
      } else {
        assert.equal(res.reason, "malformed_signature_header");
      }
    }
  });

  test("rejects when the secret is missing (fail closed)", () => {
    const res = provider.verifyWebhook({
      headers: { "ycloud-signature": sign(INBOUND_TEXT_EVENT, SECRET) },
      rawBody: INBOUND_TEXT_EVENT,
      secret: "",
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "missing_secret");
  });

  test("header lookup is case-insensitive", () => {
    const res = provider.verifyWebhook({
      headers: { "YCloud-Signature": sign(INBOUND_TEXT_EVENT, SECRET) },
      rawBody: INBOUND_TEXT_EVENT,
      secret: SECRET,
    });
    assert.deepEqual(res, { ok: true });
  });
});

describe("ycloud parseWebhook — NormalizedInboundEvent fixtures", () => {
  test("inbound text message maps to message.received / inbound", () => {
    const events = provider.parseWebhook({
      headers: {},
      rawBody: INBOUND_TEXT_EVENT,
    });
    assert.equal(events.length, 1);
    const e = events[0];

    assert.equal(e.provider, "ycloud");
    assert.equal(e.deliveryId, "evt_01TESTINBOUND0000000001");
    assert.equal(e.kind, "message.received");
    assert.equal(e.direction, "inbound");
    assert.equal(e.providerAccountId, "123456789012345");
    assert.equal(e.platformMessageId, "wamid.TESTFAKEINBOUND0000000001");
    assert.equal(e.sender.phone, "+15550001234");
    assert.equal(e.sender.bsuid, "15550001234.TESTBSUID000001");
    assert.equal(e.sender.parentBsuid, "15550001234.TESTPARENTBSUID1");
    assert.equal(e.sender.name, "Test User");
    assert.equal(e.sender.username, "testuser");
    assert.equal(e.type, "text");
    assert.equal(e.text, "hola, quiero hacer un pedido");
    assert.equal(e.timestamp, "2026-10-18T12:00:01.000Z");
    assert.equal(
      (e.raw as { type: string }).type,
      "whatsapp.inbound_message.received"
    );
  });

  test("inbound image message exposes mediaRefs and caption text", () => {
    const [e] = provider.parseWebhook({
      headers: {},
      rawBody: INBOUND_IMAGE_EVENT,
    });
    assert.equal(e.kind, "message.received");
    assert.equal(e.type, "image");
    assert.equal(e.text, "mi pedido en foto");
    assert.deepEqual(e.mediaRefs, [
      {
        id: "media_test_0002",
        url: "https://cdn.ycloud.com/media/media_test_0002.jpg",
        mimeType: "image/jpeg",
        filename: "foto.jpg",
      },
    ]);
  });

  test("whatsapp.message.echo maps to message.echo / outbound", () => {
    const [e] = provider.parseWebhook({ headers: {}, rawBody: ECHO_EVENT });
    assert.equal(e.kind, "message.echo");
    assert.equal(e.direction, "outbound");
    assert.equal(e.deliveryId, "evt_01TESTECHO0000000000003");
    assert.equal(e.platformMessageId, "wamid.TESTFAKEECHO00000000000003");
    assert.equal(e.sender.phone, "+15550009999");
    assert.equal(e.type, "text");
    assert.equal(e.text, "respuesta manual desde WhatsApp Business");
    assert.equal(e.timestamp, "2026-10-18T12:00:03.500Z");
  });

  test("whatsapp.smb.message.echoes maps to message.echo / outbound", () => {
    const [e] = provider.parseWebhook({
      headers: {},
      rawBody: SMB_ECHO_EVENT,
    });
    assert.equal(e.kind, "message.echo");
    assert.equal(e.direction, "outbound");
    assert.equal(e.platformMessageId, "wamid.TESTFAKESMBECHO00000000004");
    assert.equal(e.text, "eco smb");
  });

  test("whatsapp.message.updated maps to message.status", () => {
    const [e] = provider.parseWebhook({ headers: {}, rawBody: STATUS_EVENT });
    assert.equal(e.kind, "message.status");
    assert.equal(e.direction, "outbound");
    assert.equal(e.status, "read");
    assert.equal(e.platformMessageId, "wamid.TESTFAKESTATUS00000000005");
    assert.equal(e.providerAccountId, "123456789012345");
  });

  test("unrecognized event types map to kind 'other' keeping deliveryId", () => {
    const events = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        type: "whatsapp.smb.history",
        id: "evt_other_1",
      }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "other");
    assert.equal(events[0].direction, "na");
    assert.equal(events[0].deliveryId, "evt_other_1");
  });

  test("non-object or invalid bodies produce an empty array", () => {
    for (const body of ["not-json", '"str"', "42", "null", "[1,2]"]) {
      assert.deepEqual(
        provider.parseWebhook({ headers: {}, rawBody: body }),
        [],
        `body ${body} must yield no events`
      );
    }
  });
});

describe("ycloud sendMessage — contract surface", () => {
  test("rejects text sends without text without calling upstream", async () => {
    const res = await provider.sendMessage(ACCOUNT, {
      to: "+15550001234",
      type: "text",
    });
    assert.deepEqual(res, {
      ok: false,
      error: "text message requires msg.text",
      retryable: false,
    });
  });

  test("rejects image/document sends without mediaUrl", async () => {
    for (const type of ["image", "document"] as const) {
      const res = await provider.sendMessage(ACCOUNT, {
        to: "+15550001234",
        type,
      });
      assert.equal(res.ok, false, `${type} without mediaUrl must fail`);
      if (!res.ok) assert.equal(res.retryable, false);
    }
  });

  test("rejects unsupported outbound types", async () => {
    for (const type of ["template", "interactive"] as const) {
      const res = await provider.sendMessage(ACCOUNT, {
        to: "+15550001234",
        type,
      });
      assert.equal(res.ok, false, `${type} must be rejected for now`);
      if (!res.ok) assert.equal(res.retryable, false);
    }
  });
});

describe("ycloud resolveMedia — contract surface", () => {
  test("returns a provided ref.url directly", async () => {
    const res = await provider.resolveMedia!(ACCOUNT, {
      url: "https://cdn.ycloud.com/media/x.jpg",
    });
    assert.deepEqual(res, { url: "https://cdn.ycloud.com/media/x.jpg" });
  });

  test("throws without id/url and without apiKey", async () => {
    await assert.rejects(provider.resolveMedia!(ACCOUNT, {}), /requires ref/);
    await assert.rejects(
      provider.resolveMedia!(
        {
          ...ACCOUNT,
          credentials: { apiKey: "", webhookSecret: SECRET },
        },
        { id: "media_1" }
      ),
      /requires account.credentials.apiKey/
    );
  });
});
