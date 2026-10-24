import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { describe, mock } from "node:test";
import {
  extractYCloudEchoMessage,
  toSendResult,
  ycloudProvider as provider,
} from "./ycloud";
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

  test("id-less status transitions get distinct delivery ids", () => {
    const make = (status: string) =>
      JSON.stringify({
        type: "whatsapp.message.updated",
        createTime: "2026-01-01T00:00:00.000Z",
        whatsappMessage: {
          wamid: "wamid.status.same",
          status,
          updateTime: "2026-01-01T00:00:00.000Z",
        },
      });
    const [delivered] = provider.parseWebhook({ headers: {}, rawBody: make("delivered") });
    const [read] = provider.parseWebhook({ headers: {}, rawBody: make("read") });
    assert.notEqual(delivered.deliveryId, read.deliveryId);
    assert.match(delivered.deliveryId, /^ycloud:synth:/);
    assert.match(read.deliveryId, /^ycloud:synth:/);
  });

  test("id-less whatsappMessageUpdated status hashes the normalized envelope", () => {
    const make = (status: string, extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        type: "whatsapp.message.updated",
        createTime: "2026-01-01T00:00:00.000Z",
        whatsappMessageUpdated: {
          wamid: "wamid.updated.same",
          status,
          updateTime: "2026-01-01T00:00:00.000Z",
          ...extra,
        },
      });
    const [delivered] = provider.parseWebhook({ headers: {}, rawBody: make("delivered") });
    const [read] = provider.parseWebhook({ headers: {}, rawBody: make("read") });
    const [readAgain] = provider.parseWebhook({ headers: {}, rawBody: make("read") });
    assert.notEqual(delivered.deliveryId, read.deliveryId);
    assert.equal(read.deliveryId, readAgain.deliveryId);
    assert.match(read.deliveryId, /^ycloud:synth:/);
  });

  test("envelope without any id gets a deterministic ycloud:synth deliveryId", () => {
    const idLess = JSON.stringify({
      type: "whatsapp.inbound_message.received",
      whatsappInboundMessage: {
        from: "+15550001234",
        to: "+15550009999",
        sendTime: "2026-10-18T12:00:09.000Z",
        type: "text",
        text: { body: "sin event id ni wamid" },
      },
    });
    const [a] = provider.parseWebhook({ headers: {}, rawBody: idLess });
    const [b] = provider.parseWebhook({ headers: {}, rawBody: idLess });
    assert.match(a.deliveryId, /^ycloud:synth:[0-9a-f]{16}$/);
    assert.equal(a.deliveryId, b.deliveryId, "same payload must dedup to one key");
  });
});

describe("ycloud parseWebhook — route-parity pins", () => {
  // These pin the exact fields the webhook route consumed from the raw
  // envelope before parsing moved into the adapter. If a normalization
  // choice drifts from what the route used to read inline, one of these
  // must fail.

  test("inbound platformMessageId prefers message.id — the route's dedup key", () => {
    const [e] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        type: "whatsapp.inbound_message.received",
        id: "evt_par_1",
        whatsappInboundMessage: {
          id: "msg-id-preferred",
          wamid: "wamid-differs",
          from: "+15550001234",
          type: "text",
          text: { body: "hola" },
        },
      }),
    });
    assert.equal(e.platformMessageId, "msg-id-preferred");
  });

  test("inbound platformMessageId falls back to wamid when id is absent", () => {
    const [e] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        type: "whatsapp.inbound_message.received",
        id: "evt_par_2",
        whatsappInboundMessage: {
          wamid: "wamid-fallback-1",
          from: "+15550001234",
          type: "text",
          text: { body: "hola" },
        },
      }),
    });
    assert.equal(e.platformMessageId, "wamid-fallback-1");
  });

  test("echo platformMessageId is msg.id then envelope id — never wamid", () => {
    // Route deduped echoes with `msg.id || event.id`; wamid was never in the
    // chain. Both fixtures discriminate against a wamid-first regression.
    const [withMsgId] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        type: "whatsapp.message.echo",
        id: "evt_echo_1",
        whatsappMessage: {
          id: "msg-echo-id",
          wamid: "wamid-should-not-win",
          from: "+15550009999",
          to: "+15550001234",
          type: "text",
          text: { body: "hola" },
        },
      }),
    });
    assert.equal(withMsgId.platformMessageId, "msg-echo-id");

    const [noMsgId] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        type: "whatsapp.message.echo",
        id: "evt_echo_2",
        whatsappMessage: {
          wamid: "wamid-still-loses",
          from: "+15550009999",
          to: "+15550001234",
          type: "text",
          text: { body: "hola" },
        },
      }),
    });
    assert.equal(noMsgId.platformMessageId, "evt_echo_2");
  });

  test("echo maps customer → providerConversationId, bot → sender.phone (envelope fallbacks)", () => {
    const [e] = provider.parseWebhook({ headers: {}, rawBody: ECHO_EVENT });
    assert.equal(e.providerConversationId, "+15550001234");
    assert.equal(e.sender.phone, "+15550009999");

    // Route read `msg.to || event.to` / `msg.from || event.from` — the
    // envelope-level to/from must back-fill when the message omits them.
    const [fallback] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        type: "whatsapp.message.echo",
        id: "evt_echo_3",
        from: "+15550009999",
        to: "+15550001234",
        whatsappMessage: {
          id: "msg-echo-3",
          type: "text",
          text: { body: "operador" },
        },
      }),
    });
    assert.equal(fallback.providerConversationId, "+15550001234");
    assert.equal(fallback.sender.phone, "+15550009999");
  });

  test("inbound reply context maps to replyToMessageId (wamid first, then id)", () => {
    const base = {
      type: "whatsapp.inbound_message.received",
      id: "evt_reply_1",
      whatsappInboundMessage: {
        id: "msg-1",
        from: "+15550001234",
        type: "text",
        text: { body: "respuesta" },
      },
    };
    const [wamidCtx] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        ...base,
        whatsappInboundMessage: {
          ...base.whatsappInboundMessage,
          context: { wamid: "wamid-ctx", id: "id-ctx" },
        },
      }),
    });
    assert.equal(wamidCtx.replyToMessageId, "wamid-ctx");

    const [idCtx] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        ...base,
        whatsappInboundMessage: {
          ...base.whatsappInboundMessage,
          context: { id: "id-ctx" },
        },
      }),
    });
    assert.equal(idCtx.replyToMessageId, "id-ctx");
  });

  test("unsupported inbound types normalize to 'unknown' but stay message.received", () => {
    for (const msgType of ["contact", "order", "system"]) {
      const [e] = provider.parseWebhook({
        headers: {},
        rawBody: JSON.stringify({
          type: "whatsapp.inbound_message.received",
          id: `evt_un_${msgType}`,
          whatsappInboundMessage: {
            id: `msg-${msgType}`,
            from: "+15550001234",
            type: msgType,
          },
        }),
      });
      assert.equal(e.kind, "message.received", msgType);
      assert.equal(e.type, "unknown", msgType);
      // Route needs the raw envelope for the artifact gate and drops.
      assert.equal(e.platformMessageId, `msg-${msgType}`);
    }
  });

  test("sticker/reaction/interactive keep their type for downstream filtering", () => {
    for (const msgType of ["sticker", "reaction", "interactive"]) {
      const [e] = provider.parseWebhook({
        headers: {},
        rawBody: JSON.stringify({
          type: "whatsapp.inbound_message.received",
          id: `evt_t_${msgType}`,
          whatsappInboundMessage: {
            id: `msg-${msgType}`,
            from: "+15550001234",
            type: msgType,
          },
        }),
      });
      assert.equal(e.type, msgType);
    }
  });

  test("location inbound keeps type 'location' with coords reachable via raw", () => {
    const [e] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        type: "whatsapp.inbound_message.received",
        id: "evt_loc_1",
        whatsappInboundMessage: {
          id: "msg-loc",
          from: "+15550001234",
          type: "location",
          location: { latitude: -26.18, longitude: -58.17, name: "Plaza" },
        },
      }),
    });
    assert.equal(e.type, "location");
    assert.equal(e.kind, "message.received");
    const msg = (e.raw as { whatsappInboundMessage: Record<string, unknown> })
      .whatsappInboundMessage;
    assert.deepEqual(msg.location, {
      latitude: -26.18,
      longitude: -58.17,
      name: "Plaza",
    });
  });

  test("timestamp falls back message.sendTime → envelope sendTime → createTime", () => {
    const mk = (msg: Record<string, unknown>, env: Record<string, unknown>) =>
      provider.parseWebhook({
        headers: {},
        rawBody: JSON.stringify({
          type: "whatsapp.inbound_message.received",
          id: "evt_ts",
          ...env,
          whatsappInboundMessage: {
            id: "m1",
            from: "+15550001234",
            type: "text",
            text: { body: "x" },
            ...msg,
          },
        }),
      })[0];

    assert.equal(
      mk(
        { sendTime: "2026-01-01T00:00:03.000Z" },
        { sendTime: "2026-01-01T00:00:02.000Z", createTime: "2026-01-01T00:00:01.000Z" }
      ).timestamp,
      "2026-01-01T00:00:03.000Z"
    );
    assert.equal(
      mk({}, { sendTime: "2026-01-01T00:00:02.000Z", createTime: "2026-01-01T00:00:01.000Z" })
        .timestamp,
      "2026-01-01T00:00:02.000Z"
    );
    assert.equal(
      mk({}, { createTime: "2026-01-01T00:00:01.000Z" }).timestamp,
      "2026-01-01T00:00:01.000Z"
    );
  });

  test("echo without extractable message still yields a message.echo event", () => {
    // The route's artifact gate acks these before echo handling; the event
    // must carry kind so the gate path stays reachable.
    const [e] = provider.parseWebhook({
      headers: {},
      rawBody: JSON.stringify({
        type: "whatsapp.message.echo",
        id: "evt_empty_echo",
      }),
    });
    assert.equal(e.kind, "message.echo");
    assert.equal(e.deliveryId, "evt_empty_echo");
    assert.equal(e.platformMessageId, undefined);
    assert.equal(e.sender.phone, undefined);
    assert.equal(e.providerConversationId, undefined);
  });
});

describe("extractYCloudEchoMessage — route-owned echo field access", () => {
  test("finds the message via candidate keys", () => {
    for (const key of [
      "whatsappMessage",
      "whatsappSmbMessageEcho",
      "whatsappSmbMessageEchoes",
      "smbMessage",
      "message",
      "whatsappMessageEcho",
    ]) {
      const msg = { from: "+1", to: "+2", type: "text" };
      assert.equal(
        extractYCloudEchoMessage({ [key]: msg }),
        msg,
        `key ${key}`
      );
    }
  });

  test("dynamic fallback picks any dict carrying to/from", () => {
    const msg = { from: "+1", type: "audio", audio: { id: "a1" } };
    assert.equal(extractYCloudEchoMessage({ customKey: msg }), msg);
    assert.equal(
      extractYCloudEchoMessage({ type: "whatsapp.message.echo", id: "e1" }),
      undefined
    );
  });
});

describe("toSendResult — retryable classification", () => {
  test("4xx client errors are not retryable", () => {
    for (const err of [
      "YCloud error 400: bad request",
      "YCloud error 422: invalid phone",
    ]) {
      const res = toSendResult({ ok: false, error: err });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.retryable, false, err);
    }
  });

  test("5xx and network failures stay retryable (transient class)", () => {
    for (const err of [
      "YCloud error 500: upstream",
      "Fetch error: socket hangup",
      "Max retries exceeded",
    ]) {
      const res = toSendResult({ ok: false, error: err });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.retryable, true, err);
    }
  });

  test("429 rate-limits are retryable — a throttle, not a rejection", () => {
    const res = toSendResult({ ok: false, error: "YCloud error 429: rate limited" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, true);
  });

  test("missing credentials/config is not retryable", () => {
    const res = toSendResult({
      ok: false,
      error: "Missing YCLOUD_API_KEY or WHATSAPP_PHONE_NUMBER",
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, false);
  });

  test("success maps wamid to providerMessageId", () => {
    assert.deepEqual(toSendResult({ ok: true, wamid: "wamid.X" }), {
      ok: true,
      providerMessageId: "wamid.X",
      status: "sent",
    });
    assert.deepEqual(toSendResult({ ok: true }), {
      ok: true,
      providerMessageId: "",
      status: "sent",
    });
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

  test("429 from sendDirectly is retryable, other 4xx are not", async () => {
    for (const [status, retryable] of [
      [429, true],
      [400, false],
      [503, true],
    ] as const) {
      mock.method(
        globalThis,
        "fetch",
        async () => new Response("upstream says no", { status })
      );
      try {
        const res = await provider.sendMessage(ACCOUNT, {
          to: "+15550001234",
          type: "text",
          text: "hola",
        });
        assert.equal(res.ok, false, `status ${status}`);
        if (!res.ok) {
          assert.equal(res.retryable, retryable, `status ${status}`);
        }
      } finally {
        mock.restoreAll();
      }
    }
  });
});

describe("ycloud sendTemplate — Meta-shaped sendDirectly templates", () => {
  test("rejects templates without name/language without calling upstream", async () => {
    const res = await provider.sendTemplate!(ACCOUNT, {
      to: "+15550001234",
      type: "template",
      template: { name: "", language: "es_AR" },
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /template\.name and msg\.template\.language/);
      assert.equal(res.retryable, false);
    }
  });

  test("sends the Meta-shaped template body with scoped credentials", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "wamid.TPL1", status: "sent" }));
    });
    try {
      const res = await provider.sendTemplate!(ACCOUNT, {
        to: "+15550001234",
        type: "template",
        template: {
          name: "order_confirm",
          language: "es_AR",
          components: [
            { type: "body", parameters: [{ type: "text", text: "Martina" }] },
          ],
        },
        idempotencyKey: "tpl-idem-1",
      });
      assert.deepEqual(res, {
        ok: true,
        providerMessageId: "wamid.TPL1",
        status: "sent",
      });
    } finally {
      mock.restoreAll();
    }
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.ycloud.com/v2/whatsapp/messages/sendDirectly"
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["X-API-Key"], "fake-api-key");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      from: "+15550009999",
      to: "+15550001234",
      type: "template",
      template: {
        name: "order_confirm",
        language: { code: "es_AR", policy: "deterministic" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "Martina" }] },
        ],
      },
      externalId: "tpl-idem-1",
    });
  });

  test("429 from sendDirectly is retryable", async () => {
    mock.method(
      globalThis,
      "fetch",
      async () => new Response("throttled", { status: 429 })
    );
    try {
      const res = await provider.sendTemplate!(ACCOUNT, {
        to: "+15550001234",
        type: "template",
        template: { name: "order_confirm", language: "es_AR" },
      });
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.match(res.error, /429/);
        assert.equal(res.retryable, true);
      }
    } finally {
      mock.restoreAll();
    }
  });

  test("a real account without scoped apiKey fails closed", async () => {
    const res = await provider.sendTemplate!(
      { ...ACCOUNT, id: "42", credentials: { apiKey: "", webhookSecret: SECRET } },
      {
        to: "+15550001234",
        type: "template",
        template: { name: "order_confirm", language: "es_AR" },
      }
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /no scoped ycloud apiKey/);
      assert.equal(res.retryable, false);
    }
  });

  test("a credential-less placeholder account cannot delegate template sends", async () => {
    const res = await provider.sendTemplate!(
      {
        ...ACCOUNT,
        id: "whatsapp:agent-config",
        senderAddress: "",
        credentials: { apiKey: "", webhookSecret: "" },
      },
      {
        to: "+15550001234",
        type: "template",
        template: { name: "order_confirm", language: "es_AR" },
      }
    );
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.error, /'template'/);
      assert.equal(res.retryable, false);
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
