import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { describe, mock } from "node:test";
import { KAPSO_MEDIA_DOMAINS, kapsoProvider as provider } from "./kapso";
import type { ChannelAccount } from "../types";

const SECRET = "kapsowhsec_test_fixture_secret";
const PHONE_NUMBER_ID = "998877665544";

function sign(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

function headers(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "x-webhook-event": "whatsapp.message.received",
    "x-idempotency-key": "dlv_test_0001",
    "x-webhook-payload-version": "v2",
    ...overrides,
  };
}

const ACCOUNT: ChannelAccount = {
  id: "acct_kapso_test",
  provider: "kapso",
  channel: "whatsapp",
  providerAccountId: PHONE_NUMBER_ID,
  senderAddress: "+15550002222",
  credentials: { apiKey: "fake-kapso-key", webhookSecret: SECRET },
  status: "active",
  tenantId: "default",
};

// Fixture shapes per docs.kapso.ai/docs/platform/webhooks/message-events.md
// (v2 payloads, event name in X-Webhook-Event). All identifiers/phones/names
// are synthetic test data.

const RECEIVED_TEXT = JSON.stringify({
  message: {
    id: "wamid.TESTKAPSOINBOUND0001",
    timestamp: "1730092800",
    type: "text",
    from: "15550001111",
    from_user_id: "US.1111222233334444",
    from_parent_user_id: "US.ENT.555566667777",
    username: "@fixtureuser",
    text: { body: "hola, quiero hacer un pedido" },
    kapso: {
      direction: "inbound",
      status: "received",
      processing_status: "pending",
      origin: "cloud_api",
      has_media: false,
      content: "hola, quiero hacer un pedido",
    },
  },
  conversation: {
    id: "conv_test_1",
    contact_name: "Fixture Contact",
    phone_number: "15550001111",
    business_scoped_user_id: "US.1111222233334444",
    parent_business_scoped_user_id: "US.ENT.555566667777",
    username: "@fixtureuser",
    status: "active",
    phone_number_id: PHONE_NUMBER_ID,
  },
  is_new_conversation: true,
  phone_number_id: PHONE_NUMBER_ID,
});

const RECEIVED_IMAGE = JSON.stringify({
  message: {
    id: "wamid.TESTKAPSOINBOUND0002",
    timestamp: "1730092860",
    type: "image",
    from: "15550001111",
    image: { id: "media_test_kapso_1", caption: "foto del pedido" },
    kapso: {
      direction: "inbound",
      status: "received",
      processing_status: "pending",
      has_media: true,
      media_url: "https://api.kapso.ai/media/test-fixture-1",
      media_data: {
        url: "https://api.kapso.ai/media/test-fixture-1",
        filename: "foto.jpg",
        content_type: "image/jpeg",
        byte_size: 204800,
      },
      message_type_data: { caption: "foto del pedido" },
    },
  },
  conversation: {
    id: "conv_test_1",
    contact_name: "Fixture Contact",
    phone_number: "15550001111",
    phone_number_id: PHONE_NUMBER_ID,
  },
  is_new_conversation: false,
  phone_number_id: PHONE_NUMBER_ID,
});

const RECEIVED_BSUID_ONLY = JSON.stringify({
  message: {
    id: "wamid.TESTKAPSOINBOUND0003",
    timestamp: "1730092920",
    type: "text",
    from_user_id: "US.999988887777",
    text: { body: "sin teléfono" },
    kapso: { direction: "inbound", status: "received" },
  },
  conversation: {
    id: "conv_test_2",
    contact_name: "Bsuid Contact",
    business_scoped_user_id: "US.999988887777",
    phone_number_id: PHONE_NUMBER_ID,
  },
  phone_number_id: PHONE_NUMBER_ID,
});

const SENT_EVENT = JSON.stringify({
  message: {
    id: "wamid.TESTKAPSOECHO0004",
    timestamp: "1730092980",
    type: "text",
    to: "15550001111",
    text: { body: "respuesta manual del negocio" },
    kapso: {
      direction: "outbound",
      status: "sent",
      processing_status: "completed",
      origin: "business_app",
      statuses: [
        { id: "wamid.TESTKAPSOECHO0004", status: "sent", timestamp: "1730092980" },
      ],
    },
  },
  conversation: {
    id: "conv_test_1",
    contact_name: "Fixture Contact",
    phone_number: "15550001111",
    phone_number_id: PHONE_NUMBER_ID,
  },
  is_new_conversation: false,
  phone_number_id: PHONE_NUMBER_ID,
});

const DELIVERED_EVENT = JSON.stringify({
  message: {
    id: "wamid.TESTKAPSOECHO0004",
    timestamp: "1730093040",
    type: "text",
    to: "15550001111",
    text: { body: "respuesta manual del negocio" },
    kapso: {
      direction: "outbound",
      status: "delivered",
      statuses: [
        { id: "wamid.TESTKAPSOECHO0004", status: "sent", timestamp: "1730092980" },
        { id: "wamid.TESTKAPSOECHO0004", status: "delivered", timestamp: "1730093040" },
      ],
    },
  },
  conversation: {
    id: "conv_test_1",
    phone_number: "15550001111",
    phone_number_id: PHONE_NUMBER_ID,
  },
  is_new_conversation: false,
  phone_number_id: PHONE_NUMBER_ID,
});

const IDENTITY_CHANGED = JSON.stringify({
  contact: {
    id: "contact_test_1",
    wa_id: "15550001111",
    profile_name: "Fixture Contact",
    business_scoped_user_id: "US.1111222233334444",
  },
  previous: { business_scoped_user_id: "US.OLD.00000001" },
  phone_number_id: PHONE_NUMBER_ID,
});

const CONVERSATION_INACTIVE = JSON.stringify({
  conversation: {
    id: "conv_test_1",
    phone_number: "15550001111",
    status: "active",
    phone_number_id: PHONE_NUMBER_ID,
  },
  inactivity: { minutes: 60 },
  phone_number_id: PHONE_NUMBER_ID,
});

const BATCH_ENVELOPE = JSON.stringify({
  type: "whatsapp.message.received",
  batch: true,
  data: [
    {
      message: {
        id: "wamid.TESTKAPSOBATCH001",
        timestamp: "1730093100",
        type: "text",
        from: "15550001111",
        text: { body: "primero" },
        kapso: { direction: "inbound", status: "received" },
      },
      conversation: { id: "conv_test_1", phone_number: "15550001111", phone_number_id: PHONE_NUMBER_ID },
      phone_number_id: PHONE_NUMBER_ID,
    },
    {
      message: {
        id: "wamid.TESTKAPSOBATCH002",
        timestamp: "1730093101",
        type: "text",
        from: "15550001111",
        text: { body: "segundo" },
        kapso: { direction: "inbound", status: "received" },
      },
      conversation: { id: "conv_test_1", phone_number: "15550001111", phone_number_id: PHONE_NUMBER_ID },
      phone_number_id: PHONE_NUMBER_ID,
    },
  ],
  batch_info: { size: 2 },
});

describe("kapso verifyWebhook — raw-body-hmac fixtures", () => {
  test("accepts a valid X-Webhook-Signature (hex HMAC-SHA256 of raw body)", () => {
    const res = provider.verifyWebhook({
      headers: { "x-webhook-signature": sign(RECEIVED_TEXT, SECRET) },
      rawBody: RECEIVED_TEXT,
      secret: SECRET,
    });
    assert.deepEqual(res, { ok: true });
  });

  test("rejects a signature made with the wrong secret", () => {
    const res = provider.verifyWebhook({
      headers: { "x-webhook-signature": sign(RECEIVED_TEXT, "wrong-secret") },
      rawBody: RECEIVED_TEXT,
      secret: SECRET,
    });
    assert.deepEqual(res, { ok: false, reason: "signature_mismatch" });
  });

  test("rejects a tampered body", () => {
    const res = provider.verifyWebhook({
      headers: { "x-webhook-signature": sign(RECEIVED_TEXT, SECRET) },
      rawBody: RECEIVED_TEXT.replace("hola", "CHAU"),
      secret: SECRET,
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "signature_mismatch");
  });

  test("rejects a missing signature header", () => {
    const res = provider.verifyWebhook({
      headers: {},
      rawBody: RECEIVED_TEXT,
      secret: SECRET,
    });
    assert.deepEqual(res, { ok: false, reason: "missing_signature_header" });
  });

  test("rejects missing secret (fail closed)", () => {
    const res = provider.verifyWebhook({
      headers: { "x-webhook-signature": sign(RECEIVED_TEXT, SECRET) },
      rawBody: RECEIVED_TEXT,
      secret: "",
    });
    assert.deepEqual(res, { ok: false, reason: "missing_secret" });
  });

  test("rejects malformed signature values", () => {
    for (const bad of ["garbage", "zz".repeat(32), "abc123"]) {
      const res = provider.verifyWebhook({
        headers: { "x-webhook-signature": bad },
        rawBody: RECEIVED_TEXT,
        secret: SECRET,
      });
      assert.equal(res.ok, false, `signature '${bad}' must fail`);
      assert.equal(res.reason, "malformed_signature_header");
    }
  });

  test("header lookup is case-insensitive; sha256= prefix tolerated", () => {
    const res = provider.verifyWebhook({
      headers: { "X-Webhook-Signature": `sha256=${sign(RECEIVED_TEXT, SECRET)}` },
      rawBody: RECEIVED_TEXT,
      secret: SECRET,
    });
    assert.deepEqual(res, { ok: true });
  });
});

describe("kapso parseWebhook — NormalizedInboundEvent fixtures", () => {
  test("whatsapp.message.received maps to message.received / inbound", () => {
    const events = provider.parseWebhook({
      headers: headers(),
      rawBody: RECEIVED_TEXT,
    });
    assert.equal(events.length, 1);
    const e = events[0];

    assert.equal(e.provider, "kapso");
    assert.equal(e.deliveryId, "dlv_test_0001");
    assert.equal(e.kind, "message.received");
    assert.equal(e.direction, "inbound");
    assert.equal(e.providerAccountId, PHONE_NUMBER_ID);
    assert.equal(e.providerConversationId, "conv_test_1");
    // C6: bare wamid — no provider namespace.
    assert.equal(e.platformMessageId, "wamid.TESTKAPSOINBOUND0001");
    assert.equal(e.sender.phone, "15550001111");
    assert.equal(e.sender.bsuid, "US.1111222233334444");
    assert.equal(e.sender.parentBsuid, "US.ENT.555566667777");
    assert.equal(e.sender.username, "@fixtureuser");
    assert.equal(e.sender.name, "Fixture Contact");
    assert.equal(e.type, "text");
    assert.equal(e.text, "hola, quiero hacer un pedido");
    assert.equal(e.timestamp, new Date(1730092800 * 1000).toISOString());
    // Channel hint stamped for resolveEventChannel (registry routes
    // whatsapp → ycloud; kapso events carry their own hint).
    assert.equal((e.raw as { channel: string }).channel, "whatsapp");
  });

  test("BSUID-only inbound keeps bsuid without a phone (C: bsuid first-class)", () => {
    const [e] = provider.parseWebhook({
      headers: headers(),
      rawBody: RECEIVED_BSUID_ONLY,
    });
    assert.equal(e.sender.phone, undefined);
    assert.equal(e.sender.bsuid, "US.999988887777");
    assert.equal(e.sender.name, "Bsuid Contact");
    assert.equal(e.platformMessageId, "wamid.TESTKAPSOINBOUND0003");
  });

  test("image inbound exposes kapso media_url in mediaRefs and caption as text", () => {
    const [e] = provider.parseWebhook({
      headers: headers(),
      rawBody: RECEIVED_IMAGE,
    });
    assert.equal(e.type, "image");
    assert.equal(e.text, "foto del pedido");
    assert.deepEqual(e.mediaRefs, [
      {
        id: "media_test_kapso_1",
        url: "https://api.kapso.ai/media/test-fixture-1",
        mimeType: "image/jpeg",
        filename: "foto.jpg",
      },
    ]);
  });

  test("whatsapp.message.sent maps to message.echo / outbound", () => {
    const [e] = provider.parseWebhook({
      headers: headers({ "x-webhook-event": "whatsapp.message.sent" }),
      rawBody: SENT_EVENT,
    });
    assert.equal(e.kind, "message.echo");
    assert.equal(e.direction, "outbound");
    assert.equal(e.platformMessageId, "wamid.TESTKAPSOECHO0004");
    // Echo routing key = the customer (message.to), like ycloud.
    assert.equal(e.providerConversationId, "15550001111");
    assert.equal(e.text, "respuesta manual del negocio");
  });

  test("whatsapp.message.delivered maps to message.status / outbound", () => {
    const [e] = provider.parseWebhook({
      headers: headers({ "x-webhook-event": "whatsapp.message.delivered" }),
      rawBody: DELIVERED_EVENT,
    });
    assert.equal(e.kind, "message.status");
    assert.equal(e.direction, "outbound");
    assert.equal(e.status, "delivered");
    assert.equal(e.platformMessageId, "wamid.TESTKAPSOECHO0004");
  });

  test("batched envelope flattens data[] into one event per item", () => {
    const events = provider.parseWebhook({
      headers: headers({
        "x-webhook-batch": "true",
        "x-batch-size": "2",
        "x-idempotency-key": "dlv_batch_9",
      }),
      rawBody: BATCH_ENVELOPE,
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].platformMessageId, "wamid.TESTKAPSOBATCH001");
    assert.equal(events[1].platformMessageId, "wamid.TESTKAPSOBATCH002");
    assert.equal(events[0].text, "primero");
    assert.equal(events[1].text, "segundo");
    // Items share the delivery idempotency key but get distinct dedup keys.
    assert.equal(events[0].deliveryId, "dlv_batch_9:wamid.TESTKAPSOBATCH001");
    assert.equal(events[1].deliveryId, "dlv_batch_9:wamid.TESTKAPSOBATCH002");
  });

  test("whatsapp.contact.identity_changed maps to account.lifecycle", () => {
    const [e] = provider.parseWebhook({
      headers: headers({ "x-webhook-event": "whatsapp.contact.identity_changed" }),
      rawBody: IDENTITY_CHANGED,
    });
    assert.equal(e.kind, "account.lifecycle");
    assert.equal(e.direction, "na");
    assert.equal(e.providerAccountId, PHONE_NUMBER_ID);
    assert.equal(e.sender.phone, "15550001111");
  });

  test("whatsapp.conversation.inactive maps to other / na", () => {
    const [e] = provider.parseWebhook({
      headers: headers({ "x-webhook-event": "whatsapp.conversation.inactive" }),
      rawBody: CONVERSATION_INACTIVE,
    });
    assert.equal(e.kind, "other");
    assert.equal(e.direction, "na");
    assert.equal(e.deliveryId, "dlv_test_0001");
  });

  test("unknown event names map to kind 'other'", () => {
    const [e] = provider.parseWebhook({
      headers: headers({ "x-webhook-event": "whatsapp.thread.standby" }),
      rawBody: JSON.stringify({ phone_number_id: PHONE_NUMBER_ID, standby: { kind: "status" } }),
    });
    assert.equal(e.kind, "other");
    assert.equal(e.direction, "na");
  });

  test("non-object or invalid bodies produce an empty array", () => {
    for (const body of ["not-json", '"str"', "42", "null", "[1,2]"]) {
      assert.deepEqual(
        provider.parseWebhook({ headers: headers(), rawBody: body }),
        [],
        `body ${body} must yield no events`
      );
    }
  });

  test("missing X-Idempotency-Key falls back to a deterministic kapso:synth id", () => {
    const noKey = headers();
    delete noKey["x-idempotency-key"];
    const [a] = provider.parseWebhook({ headers: noKey, rawBody: RECEIVED_TEXT });
    const [b] = provider.parseWebhook({ headers: noKey, rawBody: RECEIVED_TEXT });
    assert.match(a.deliveryId, /^kapso:synth:[0-9a-f]{16}$/);
    assert.equal(a.deliveryId, b.deliveryId);
  });
});

describe("kapso sendMessage — Graph-proxy wire shape", () => {
  test("posts Meta Graph shape to the proxy with X-API-Key", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "15550001111", wa_id: "15550001111" }],
          messages: [{ id: "wamid.TESTSEND0001" }],
        })
      );
    });
    try {
      const res = await provider.sendMessage(ACCOUNT, {
        to: "+15550001111",
        type: "text",
        text: "tu pedido llegó",
        idempotencyKey: "out-test-1",
      });
      assert.deepEqual(res, {
        ok: true,
        providerMessageId: "wamid.TESTSEND0001",
        status: "sent",
      });
    } finally {
      mock.restoreAll();
    }

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `https://api.kapso.ai/meta/whatsapp/v24.0/${PHONE_NUMBER_ID}/messages`
    );
    const sentHeaders = calls[0].init?.headers as Record<string, string>;
    assert.equal(sentHeaders["X-API-Key"], "fake-kapso-key");
    assert.equal(sentHeaders["Idempotency-Key"], "out-test-1");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "15550001111",
      type: "text",
      text: { body: "tu pedido llegó" },
    });
  });

  test("BSUID recipients go through `recipient`, not `to`", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.BS1" }] }));
    });
    try {
      const res = await provider.sendMessage(ACCOUNT, {
        to: "US.1111222233334444",
        type: "text",
        text: "hola",
      });
      assert.equal(res.ok, true);
    } finally {
      mock.restoreAll();
    }
    assert.equal(body?.recipient, "US.1111222233334444");
    assert.equal(body?.to, undefined);
  });

  test("fails closed with no fetch when credentials are missing", async () => {
    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("{}");
    });
    try {
      for (const account of [
        { ...ACCOUNT, credentials: { apiKey: "", webhookSecret: "" } },
        { ...ACCOUNT, providerAccountId: "" },
      ]) {
        const res = await provider.sendMessage(account, {
          to: "15550001111",
          type: "text",
          text: "hola",
        });
        assert.equal(res.ok, false);
        if (!res.ok) assert.equal(res.retryable, false);
      }
      assert.equal(fetched, false);
    } finally {
      mock.restoreAll();
    }
  });

  test("retryable classification: 4xx false, 5xx/429/network true", async () => {
    const send = () =>
      provider.sendMessage(ACCOUNT, { to: "15550001111", type: "text", text: "hola" });

    mock.method(globalThis, "fetch", async () => new Response("bad", { status: 400 }));
    let res = await send();
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, false);
    mock.restoreAll();

    mock.method(globalThis, "fetch", async () => new Response("err", { status: 503 }));
    res = await send();
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, true);
    mock.restoreAll();

    mock.method(globalThis, "fetch", async () => new Response("rl", { status: 429 }));
    res = await send();
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, true);
    mock.restoreAll();

    mock.method(globalThis, "fetch", async () => {
      throw new Error("socket hangup");
    });
    res = await send();
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, true);
    mock.restoreAll();
  });

  test("replyToMessageId maps to Graph context.message_id", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.R1" }] }));
    });
    try {
      await provider.sendMessage(ACCOUNT, {
        to: "15550001111",
        type: "text",
        text: "respuesta",
        replyToMessageId: "wamid.ORIGINAL1",
      });
    } finally {
      mock.restoreAll();
    }
    assert.deepEqual(body?.context, { message_id: "wamid.ORIGINAL1" });
  });
});

describe("kapso sendTemplate — WA first-contact capability", () => {
  test("sends a Graph template payload", async () => {
    let body: Record<string, unknown> | undefined;
    mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ messages: [{ id: "wamid.T1" }] }));
    });
    try {
      const res = await provider.sendTemplate!(ACCOUNT, {
        to: "15550001111",
        type: "template",
        template: { name: "order_confirm", language: "es_AR" },
      });
      assert.equal(res.ok, true);
    } finally {
      mock.restoreAll();
    }
    assert.deepEqual(body?.template, {
      name: "order_confirm",
      language: { code: "es_AR" },
    });
    assert.equal(body?.type, "template");
  });
});

describe("kapso resolveMedia — Graph media flow via proxy", () => {
  test("passes through an already-resolved url", async () => {
    const res = await provider.resolveMedia!(ACCOUNT, {
      url: "https://api.kapso.ai/media/test-fixture-1",
    });
    assert.deepEqual(res, { url: "https://api.kapso.ai/media/test-fixture-1" });
  });

  test("resolves media metadata through the proxy with X-API-Key", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/test",
          mime_type: "image/jpeg",
        })
      );
    });
    try {
      const res = await provider.resolveMedia!(ACCOUNT, { id: "media_test_kapso_1" });
      assert.equal(res.url, "https://lookaside.fbsbx.com/whatsapp_business/attachments/test");
      assert.equal(res.mimeType, "image/jpeg");
    } finally {
      mock.restoreAll();
    }
    assert.equal(
      calls[0].url,
      `https://api.kapso.ai/meta/whatsapp/v24.0/media_test_kapso_1?phone_number_id=${PHONE_NUMBER_ID}`
    );
    const sentHeaders = calls[0].init?.headers as Record<string, string>;
    assert.equal(sentHeaders["X-API-Key"], "fake-kapso-key");
  });

  test("throws when credentials are missing (no env fallback)", async () => {
    const account = { ...ACCOUNT, credentials: { apiKey: "", webhookSecret: "" } };
    await assert.rejects(() => provider.resolveMedia!(account, { id: "m1" }));
  });
});

describe("kapso media allowlist seam (C12)", () => {
  test("KAPSO_MEDIA_DOMAINS names only kapso-resolvable hosts", () => {
    assert.deepEqual(KAPSO_MEDIA_DOMAINS, ["api.kapso.ai", "lookaside.fbsbx.com"]);
  });
});
