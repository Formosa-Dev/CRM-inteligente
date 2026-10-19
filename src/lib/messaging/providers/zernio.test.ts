/**
 * Zernio adapter tests — deterministic fixtures, no network.
 *
 * Shapes follow docs.zernio.com MDX sources (webhooks/inbox.mdx,
 * messages/send-inbox-message.mdx, create-inbox-conversation.mdx):
 * envelope {id, event, timestamp, message|comment, conversation, account},
 * signature X-Zernio-Signature (hex HMAC-SHA256, raw body, no timestamp),
 * legacy X-Late-* aliases, conversation-scoped sends.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, mock } from "node:test";

import { zernioProvider } from "./zernio";
import type { ChannelAccount } from "../types";

const SECRET = "zernio-webhook-secret-test";
const API_KEY = "zrn_test_key";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function account(overrides: Partial<ChannelAccount> = {}): ChannelAccount {
  return {
    id: "7",
    tenantId: "default",
    provider: "zernio",
    channel: "instagram",
    providerAccountId: "zrn_acct_1",
    senderAddress: "@formosadev",
    credentials: { apiKey: API_KEY, webhookSecret: SECRET },
    status: "active",
    ...overrides,
  };
}

function igMessageReceived(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: "evt-msg-1",
    event: "message.received",
    timestamp: "2026-10-19T14:00:00Z",
    account: { id: "zrn_acct_1", accountId: "zrn_acct_1", platform: "instagram", username: "formosadev" },
    conversation: { id: "conv_zrn_9", participantId: "17841405823604595", participantName: "Martina", contactId: "ct_1" },
    message: {
      id: "zmsg_1",
      conversationId: "conv_zrn_9",
      platform: "instagram",
      platformMessageId: "mid.ig.42",
      direction: "incoming",
      text: "hola! sigue abierto el hackathon?",
      attachments: [],
      sender: { id: "17841405823604595", name: "Martina", username: "martina.ig" },
      sentAt: "2026-10-19T13:59:59.500Z",
      isRead: false,
      sentVia: null,
    },
    ...overrides,
  });
}

describe("zernio verifyWebhook", () => {
  const body = igMessageReceived();

  it("accepts a valid X-Zernio-Signature", () => {
    const res = zernioProvider.verifyWebhook({
      headers: { "x-zernio-signature": sign(body) },
      rawBody: body,
      secret: SECRET,
    });
    assert.equal(res.ok, true);
  });

  it("accepts the legacy X-Late-Signature alias", () => {
    const res = zernioProvider.verifyWebhook({
      headers: { "x-late-signature": sign(body) },
      rawBody: body,
      secret: SECRET,
    });
    assert.equal(res.ok, true);
  });

  it("rejects wrong signature / malformed header / missing secret", () => {
    assert.equal(
      zernioProvider.verifyWebhook({
        headers: { "x-zernio-signature": sign(body, "other-secret") },
        rawBody: body,
        secret: SECRET,
      }).ok,
      false
    );
    assert.equal(
      zernioProvider.verifyWebhook({
        headers: { "x-zernio-signature": "not-hex" },
        rawBody: body,
        secret: SECRET,
      }).reason,
      "malformed_signature_header"
    );
    assert.equal(
      zernioProvider.verifyWebhook({
        headers: { "x-zernio-signature": sign(body) },
        rawBody: body,
        secret: "",
      }).reason,
      "missing_secret"
    );
    assert.equal(
      zernioProvider.verifyWebhook({ headers: {}, rawBody: body, secret: SECRET }).reason,
      "missing_signature_header"
    );
  });
});

describe("zernio parseWebhook", () => {
  it("parses a phone-less instagram message.received (B5 gate)", () => {
    const body = igMessageReceived();
    const events = zernioProvider.parseWebhook({
      headers: {
        "x-zernio-event": "message.received",
        "x-zernio-event-id": "evt-msg-1",
      },
      rawBody: body,
    });
    assert.equal(events.length, 1);
    const e = events[0];
    assert.equal(e.provider, "zernio");
    assert.equal(e.deliveryId, "evt-msg-1");
    assert.equal(e.kind, "message.received");
    assert.equal(e.direction, "inbound");
    assert.equal(e.providerAccountId, "zrn_acct_1");
    assert.equal(e.providerConversationId, "conv_zrn_9");
    assert.equal(e.providerThreadId, "conv_zrn_9");
    assert.equal(e.platformMessageId, "mid.ig.42");
    assert.equal(e.sender.socialId, "17841405823604595");
    assert.equal(e.sender.phone, undefined, "IG sender.id is not a phone");
    assert.equal(e.sender.username, "martina.ig");
    assert.equal(e.sender.name, "Martina");
    assert.equal(e.type, "text");
    assert.equal(e.text, "hola! sigue abierto el hackathon?");
    assert.equal(e.timestamp, "2026-10-19T13:59:59.500Z");
    assert.equal((e.raw as { platform?: string }).platform, "instagram");
  });

  it("parses whatsapp inbound: phoneNumber→phone, BSUID, no socialId", () => {
    const body = JSON.stringify({
      id: "evt-wa-1",
      event: "message.received",
      timestamp: "2026-10-19T14:00:00Z",
      account: { accountId: "zrn_wa_1", platform: "whatsapp" },
      conversation: { id: "conv_wa_5", participantId: "5493704000000" },
      message: {
        id: "zmsg_wa",
        conversationId: "conv_wa_5",
        platform: "whatsapp",
        platformMessageId: "wamid.zrn.1",
        direction: "incoming",
        text: "quiero info",
        attachments: [],
        sender: {
          id: "5493704000000",
          phoneNumber: "+5493704000000",
          businessScopedUserId: "bsuid-xyz",
          whatsappUsername: "jane.shop",
        },
        sentAt: "2026-10-19T13:59:00Z",
      },
    });
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: body });
    assert.equal(e.kind, "message.received");
    assert.equal(e.sender.phone, "+5493704000000");
    assert.equal(e.sender.bsuid, "bsuid-xyz");
    assert.equal(e.sender.username, "jane.shop");
    assert.equal(e.sender.socialId, undefined, "whatsapp sender.id is the phone");
    assert.equal((e.raw as { platform?: string }).platform, "whatsapp");
  });

  it("echo (message.sent) keys by participantId, thread on providerThreadId", () => {
    const body = JSON.stringify({
      id: "evt-echo-1",
      event: "message.sent",
      timestamp: "2026-10-19T14:01:00Z",
      account: { accountId: "zrn_acct_1", platform: "instagram" },
      conversation: { id: "conv_zrn_9", participantId: "17841405823604595" },
      message: {
        id: "zmsg_out",
        conversationId: "conv_zrn_9",
        platform: "instagram",
        platformMessageId: "mid.ig.43",
        direction: "outgoing",
        text: "si! quedan lugares",
        attachments: [],
        sender: { id: "acct-platform-id", name: "Formosa.dev" },
        sentAt: "2026-10-19T14:00:59Z",
        sentVia: "api",
        source: "cloud_api",
      },
    });
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: body });
    assert.equal(e.kind, "message.echo");
    assert.equal(e.direction, "outbound");
    // Customer routing key — matches the inbound sender.id for ONE convo.
    assert.equal(e.providerConversationId, "17841405823604595");
    assert.equal(e.providerThreadId, "conv_zrn_9");
    assert.equal((e.raw as { echoOrigin?: string }).echoOrigin, "api");
    assert.equal(e.text, "si! quedan lugares");
  });

  it("human-app sends (whatsapp_business_app) carry no echoOrigin=api", () => {
    const body = JSON.stringify({
      id: "evt-echo-2",
      event: "message.sent",
      timestamp: "2026-10-19T14:01:00Z",
      account: { accountId: "zrn_wa_1", platform: "whatsapp" },
      conversation: { id: "conv_wa_5", participantId: "5493704000000" },
      message: {
        id: "zmsg_out2",
        conversationId: "conv_wa_5",
        platform: "whatsapp",
        platformMessageId: "wamid.zrn.2",
        direction: "outgoing",
        text: "manual reply",
        attachments: [],
        sender: { id: "5493704111111" },
        sentAt: "2026-10-19T14:00:59Z",
        sentVia: null,
        source: "whatsapp_business_app",
      },
    });
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: body });
    assert.equal(e.kind, "message.echo");
    assert.equal((e.raw as { echoOrigin?: string }).echoOrigin, undefined);
  });

  it("maps delivered/read/failed to message.status with status field", () => {
    for (const [event, status] of [
      ["message.delivered", "delivered"],
      ["message.read", "read"],
      ["message.failed", "failed"],
    ] as const) {
      const body = JSON.stringify({
        id: `evt-${event}`,
        event,
        timestamp: "2026-10-19T14:05:00Z",
        statusAt: "2026-10-19T14:04:59Z",
        account: { accountId: "zrn_wa_1", platform: "whatsapp" },
        conversation: { id: "conv_wa_5", participantId: "5493704000000" },
        message: {
          id: "zmsg_s",
          conversationId: "conv_wa_5",
          platform: "whatsapp",
          platformMessageId: "wamid.zrn.1",
          direction: "outgoing",
          text: null,
          attachments: [],
          sender: { id: "business" },
          sentAt: "2026-10-19T14:00:00Z",
        },
        ...(event === "message.failed" ? { error: { code: "131026", message: "not reachable" } } : {}),
      });
      const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: body });
      assert.equal(e.kind, "message.status");
      assert.equal(e.status, status, `status for ${event}`);
      assert.equal(e.platformMessageId, "wamid.zrn.1");
    }
  });

  it("parses comment.received with author identity", () => {
    const body = JSON.stringify({
      id: "evt-comment-1",
      event: "comment.received",
      timestamp: "2026-10-19T15:00:00Z",
      account: { accountId: "zrn_acct_1", platform: "instagram", username: "formosadev" },
      comment: {
        id: "cmt_99",
        postId: null,
        platformPostId: "igpost_77",
        platform: "instagram",
        text: "quiero participar!",
        author: { id: "1784999", username: "curiosa.ig", name: "Curiosa" },
        createdAt: "2026-10-19T14:59:59Z",
        isReply: false,
        parentCommentId: null,
      },
      post: { id: null, platformPostId: "igpost_77", content: "flyer", imageUrl: null, permalink: null },
    });
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: body });
    assert.equal(e.kind, "comment.received");
    assert.equal(e.direction, "inbound");
    assert.equal(e.platformMessageId, "cmt_99");
    assert.equal(e.sender.socialId, "1784999");
    assert.equal(e.sender.username, "curiosa.ig");
    assert.equal(e.text, "quiero participar!");
    assert.equal((e.raw as { platform?: string }).platform, "instagram");
  });

  it("maps account.disconnected to account.lifecycle", () => {
    const body = JSON.stringify({
      id: "evt-acct-1",
      event: "account.disconnected",
      timestamp: "2026-10-19T16:00:00Z",
      account: { accountId: "zrn_acct_1", platform: "instagram" },
    });
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: body });
    assert.equal(e.kind, "account.lifecycle");
    assert.equal(e.direction, "na");
    assert.equal(e.providerAccountId, "zrn_acct_1");
  });

  it("deliveryId prefers header, falls back to payload.id and legacy header, then synth", () => {
    const body = igMessageReceived();
    // header wins
    assert.equal(
      zernioProvider.parseWebhook({ headers: { "x-zernio-event-id": "H1" }, rawBody: body })[0]
        .deliveryId,
      "H1"
    );
    // legacy header
    assert.equal(
      zernioProvider.parseWebhook({ headers: { "x-late-event-id": "L1" }, rawBody: body })[0]
        .deliveryId,
      "L1"
    );
    // payload.id
    assert.equal(
      zernioProvider.parseWebhook({ headers: {}, rawBody: body })[0].deliveryId,
      "evt-msg-1"
    );
    // synth: deterministic, prefixed
    const noId = JSON.parse(body) as Record<string, unknown>;
    delete noId.id;
    const a = zernioProvider.parseWebhook({ headers: {}, rawBody: JSON.stringify(noId) })[0];
    const b = zernioProvider.parseWebhook({ headers: {}, rawBody: JSON.stringify(noId) })[0];
    assert.match(a.deliveryId, /^zernio:synth:[0-9a-f]{16}$/);
    assert.equal(a.deliveryId, b.deliveryId, "synth id must be deterministic");
  });

  it("attachments synthesize refreshUrl (re-mint endpoint), keep expiring url", () => {
    const body = igMessageReceived({
      message: {
        id: "zmsg_m",
        conversationId: "conv_zrn_9",
        platform: "instagram",
        platformMessageId: "mid.ig.99",
        direction: "incoming",
        text: null,
        attachments: [
          { type: "image", url: "https://cdn.fbsbx.com/signed?exp=1", mimeType: "image/jpeg" },
          { type: "share", originalType: "story_mention", url: "https://cdn.fbsbx.com/s?e=2" },
        ],
        sender: { id: "17841405823604595" },
        sentAt: "2026-10-19T13:59:59Z",
      },
    });
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: body });
    assert.equal(e.mediaRefs?.length, 2);
    const [first, second] = e.mediaRefs!;
    assert.equal(first.url, "https://cdn.fbsbx.com/signed?exp=1");
    assert.equal(first.mimeType, "image/jpeg");
    assert.equal(
      first.refreshUrl,
      "https://zernio.com/api/v1/inbox/conversations/conv_zrn_9/messages/mid.ig.99/attachments/0?accountId=zrn_acct_1"
    );
    assert.equal(
      second.refreshUrl,
      "https://zernio.com/api/v1/inbox/conversations/conv_zrn_9/messages/mid.ig.99/attachments/1?accountId=zrn_acct_1"
    );
    assert.equal(e.type, "image");
  });
});

describe("zernio sendMessage / sendTemplate", () => {
  it("sends into an existing thread via providerConversationId", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const restore = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ success: true, data: { messageId: "mid.out.1", conversationId: "conv_zrn_9" } }),
        { status: 200 }
      );
    });
    try {
      const res = await zernioProvider.sendMessage(account(), {
        to: "17841405823604595",
        type: "text",
        text: "hola!",
        providerConversationId: "conv_zrn_9",
        idempotencyKey: "idem-1",
      });
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.providerMessageId, "mid.out.1");
      assert.equal(
        calls[0].url,
        "https://zernio.com/api/v1/inbox/conversations/conv_zrn_9/messages"
      );
      const sent = JSON.parse(String(calls[0].init.body));
      assert.equal(sent.accountId, "zrn_acct_1");
      assert.equal(sent.message, "hola!");
      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers["Authorization"], `Bearer ${API_KEY}`);
      assert.equal(headers["Idempotency-Key"], "idem-1");
    } finally {
      restore.mock.restore();
    }
  });

  it("opens a conversation with participantId when no thread is stored", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const restore = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ success: true, data: { messageId: "mid.out.2", conversationId: "conv_new" } }),
        { status: 201 }
      );
    });
    try {
      const wa = account({ channel: "whatsapp", providerAccountId: "zrn_wa_1" });
      const res = await zernioProvider.sendMessage(wa, {
        to: "5493704000000",
        type: "text",
        text: "primera",
      });
      assert.equal(res.ok, true);
      assert.equal(calls[0].url, "https://zernio.com/api/v1/inbox/conversations");
      const sent = JSON.parse(String(calls[0].init.body));
      assert.equal(sent.accountId, "zrn_wa_1");
      assert.equal(sent.participantId, "5493704000000");
      assert.equal(sent.message, "primera");
    } finally {
      restore.mock.restore();
    }
  });

  it("sendTemplate uses template.elements in-thread, templateName on open", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const restore = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ success: true, data: { messageId: "mid.tpl" } }),
        { status: 200 }
      );
    });
    try {
      const wa = account({ channel: "whatsapp", providerAccountId: "zrn_wa_1" });
      const tpl = {
        name: "hackathon_welcome",
        language: "es",
        components: [
          { type: "body", parameters: [{ type: "text", text: "Martina" }] },
        ],
      };
      // In-thread: template object
      await zernioProvider.sendTemplate!(wa, {
        to: "5493704000000",
        type: "template",
        template: tpl,
        providerConversationId: "conv_wa_5",
      });
      let sent = JSON.parse(String(calls[0].init.body));
      assert.equal(sent.template.elements[0].name, "hackathon_welcome");
      assert.equal(sent.template.elements[0].language, "es");
      // First contact: templateName + flat params
      await zernioProvider.sendTemplate!(wa, {
        to: "5493704000000",
        type: "template",
        template: tpl,
      });
      sent = JSON.parse(String(calls[1].init.body));
      assert.equal(sent.templateName, "hackathon_welcome");
      assert.equal(sent.templateLanguage, "es");
      assert.deepEqual(sent.templateParams, ["Martina"]);
    } finally {
      restore.mock.restore();
    }
  });

  it("fails closed without credentials; maps 429 retryable and 400 not", async () => {
    const noKey = await zernioProvider.sendMessage(
      account({ credentials: { apiKey: "", webhookSecret: "" } }),
      { to: "x", type: "text", text: "hi" }
    );
    assert.equal(noKey.ok, false);
    assert.equal(noKey.retryable, false);

    let status = 429;
    const restore = mock.method(globalThis, "fetch", async () => {
      return new Response(JSON.stringify({ error: "boom", code: "rate" }), { status });
    });
    try {
      const r429 = await zernioProvider.sendMessage(account(), {
        to: "x",
        type: "text",
        text: "hi",
        providerConversationId: "c1",
      });
      assert.equal(r429.ok, false);
      assert.equal(r429.retryable, true);
      status = 400;
      const r400 = await zernioProvider.sendMessage(account(), {
        to: "x",
        type: "text",
        text: "hi",
        providerConversationId: "c1",
      });
      assert.equal(r400.ok, false);
      assert.equal(r400.retryable, false);
    } finally {
      restore.mock.restore();
    }
  });
});

describe("zernio resolveMedia", () => {
  it("fetches refreshUrl with Bearer and returns the re-minted url", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const restore = mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ data: { url: "https://cdn.fbsbx.com/fresh?token=9", mimeType: "image/png" } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });
    try {
      const out = await zernioProvider.resolveMedia!(account(), {
        refreshUrl:
          "https://zernio.com/api/v1/inbox/conversations/conv_zrn_9/messages/mid.ig.99/attachments/0?accountId=zrn_acct_1",
      });
      assert.equal(out.url, "https://cdn.fbsbx.com/fresh?token=9");
      assert.equal(out.mimeType, "image/png");
      const headers = calls[0].init.headers as Record<string, string>;
      assert.equal(headers["Authorization"], `Bearer ${API_KEY}`);
    } finally {
      restore.mock.restore();
    }
  });

  it("passes through a bare url and throws without apiKey", async () => {
    const out = await zernioProvider.resolveMedia!(account(), {
      url: "https://public.cdn/x.jpg",
    });
    assert.equal(out.url, "https://public.cdn/x.jpg");
    await assert.rejects(
      zernioProvider.resolveMedia!(
        account({ credentials: { apiKey: "", webhookSecret: "" } }),
        { refreshUrl: "https://zernio.com/api/v1/x" }
      ),
      /apiKey/
    );
  });
});
