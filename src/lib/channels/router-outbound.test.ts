/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * S5 outbound-correctness behavior for sendOutboundMessage:
 * - the outbound fact is persisted BEFORE provider delivery (queued →
 *   sent/failed), never an invisible reply;
 * - operator sends stamp sender_kind:'operator' + the session user id;
 * - the 24h customer window gates whatsapp text sends — outside it the
 *   configured fallback template goes out instead;
 * - media sends keep their ungated shape; failed deliveries stamp 'failed'
 *   and surface to the caller.
 *
 * messenger.send is stubbed — no provider/network access. Synthetic ids only.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "../messaging/test-support/fake-db";

const fake = new FakeDb();
const restoreDb = installFakeDb(fake);

const { sendOutboundMessage } =
  require("@/lib/channels/router") as typeof import("@/lib/channels/router");
const { messenger } =
  require("@/lib/messaging") as typeof import("@/lib/messaging");
import type { OutboundMessage, SendResult } from "@/lib/messaging/types";

function seedAccount(over: Record<string, unknown>): void {
  fake.rows("channel_accounts").push({
    id: 1,
    tenantId: "default",
    provider: "ycloud",
    channel: "whatsapp",
    providerAccountId: "15550009999",
    senderAddress: "+15550009999",
    displayName: null,
    credentialsRef: "env:ROUTER_OUT_",
    agentConfigId: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
}

function seedConversation(over: Record<string, unknown>): void {
  fake.rows("conversations").push({
    id: 500,
    channel: "whatsapp",
    channelAccountId: 1,
    whatsappId: null,
    externalUserId: "+15550001234",
    externalUserIdNormalized: "15550001234",
    customerPhone: "+15550001234",
    externalThreadId: null,
    status: "active",
    ...over,
  });
}

function seedInbound(
  conversationId: number,
  createdAt: Date,
  extra: Record<string, unknown> = {}
): void {
  fake.rows("chat_messages").push({
    id: fake.rows("chat_messages").length + 1,
    conversationId,
    role: "user",
    direction: "inbound",
    senderKind: "customer",
    content: "inbound",
    createdAt,
    ...extra,
  });
}

type SendStub = (msg: OutboundMessage) => Promise<SendResult>;

function withStubbedSend(result: SendResult | SendStub): {
  sent: OutboundMessage[];
  restore: () => void;
} {
  const sent: OutboundMessage[] = [];
  const original = messenger.send;
  messenger.send = (async (msg: OutboundMessage) => {
    sent.push(msg);
    return typeof result === "function" ? result(msg) : result;
  }) as typeof messenger.send;
  return { sent, restore: () => (messenger.send = original) };
}

function messagesFor(conversationId: number): Record<string, unknown>[] {
  return fake
    .rows("chat_messages")
    .filter((row) => row.conversationId === conversationId);
}

describe("sendOutboundMessage — persist-before-send + attribution (S5)", () => {
  it("persists the operator reply queued, then stamps sent + provider id", async () => {
    process.env.ROUTER_OUT_API_KEY = "key";
    seedAccount({ id: 1 });
    seedConversation({ id: 501 });
    seedInbound(501, new Date());
    const { sent, restore } = withStubbedSend({
      ok: true,
      providerMessageId: "pm-out-1",
      status: "sent",
    });
    try {
      await sendOutboundMessage(501, "hola operador", "human", undefined, undefined, {
        operatorRef: "user-9",
      });
    } finally {
      restore();
      delete process.env.ROUTER_OUT_API_KEY;
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "text");
    assert.equal(sent[0].to, "+15550001234");

    const rows = messagesFor(501);
    const outbound = rows.find((row) => row.direction === "outbound");
    assert.ok(outbound, "the outbound fact must be persisted");
    assert.equal(outbound.role, "assistant"); // legacy role squash preserved
    assert.equal(outbound.senderKind, "operator");
    assert.equal(outbound.senderRef, "user-9");
    assert.equal(outbound.deliveryState, "sent");
    assert.equal(outbound.platformMessageId, "pm-out-1");
    assert.equal(outbound.contentType, "text");
    assert.equal(outbound.content, "hola operador");

    const conv = fake.rows("conversations").find((row) => row.id === 501);
    assert.ok(conv?.humanOverrideUntil instanceof Date, "human override set");
  });

  it("stamps failed when the provider rejects the send", async () => {
    process.env.ROUTER_OUT_API_KEY = "key";
    seedAccount({ id: 2 });
    seedConversation({ id: 502, channelAccountId: 2 });
    seedInbound(502, new Date());
    const { restore } = withStubbedSend({
      ok: false,
      error: "provider boom",
      retryable: false,
    });
    try {
      await assert.rejects(
        sendOutboundMessage(502, "hola", "human", undefined, undefined, {
          operatorRef: "user-9",
        }),
        /provider boom/
      );
    } finally {
      restore();
      delete process.env.ROUTER_OUT_API_KEY;
    }
    const outbound = messagesFor(502).find((row) => row.direction === "outbound");
    assert.equal(outbound?.deliveryState, "failed");
    // The row is stamped BEFORE delivery — a failed send never looks sent.
    assert.notEqual(outbound?.platformMessageId, "pm-out-1");
  });

  it("sends the configured fallback template outside the 24h window", async () => {
    process.env.ROUTER_OUT_API_KEY = "key";
    seedAccount({ id: 3 });
    seedConversation({ id: 503, channelAccountId: 3 });
    // Legacy pre-migration inbound row (no sender columns) still opens the
    // window only within 24h — 48h ago is closed.
    fake.rows("chat_messages").push({
      id: 9001,
      conversationId: 503,
      role: "user",
      content: "viejo",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    fake.rows("agent_config").push({
      id: 60,
      channel: null,
      channelAccountId: 3,
      waTemplateFallback: "estado_pedido",
    });
    const { sent, restore } = withStubbedSend({
      ok: true,
      providerMessageId: "pm-tpl",
      status: "sent",
    });
    try {
      await sendOutboundMessage(503, "tu pedido está listo", "human");
    } finally {
      restore();
      delete process.env.ROUTER_OUT_API_KEY;
    }
    assert.equal(sent[0].type, "template");
    assert.deepEqual(sent[0].template, {
      name: "estado_pedido",
      language: "es_AR",
    });
    const outbound = messagesFor(503).find((row) => row.direction === "outbound");
    assert.match(
      String(outbound?.content),
      /^\[template:estado_pedido\]/
    );
    assert.equal(outbound?.deliveryState, "sent");
  });

  it("keeps the text send when the window is closed and no template exists", async () => {
    process.env.ROUTER_OUT_API_KEY = "key";
    seedAccount({ id: 4 });
    seedConversation({ id: 504, channelAccountId: 4 });
    seedInbound(504, new Date(Date.now() - 30 * 60 * 60 * 1000));
    const { sent, restore } = withStubbedSend({
      ok: true,
      providerMessageId: "pm-txt",
      status: "sent",
    });
    try {
      await sendOutboundMessage(504, "seguro?", "human");
    } finally {
      restore();
      delete process.env.ROUTER_OUT_API_KEY;
    }
    // Honest degrade: the text is attempted (no configured fallback) and the
    // persisted fact records the literal content, not a fake template claim.
    assert.equal(sent[0].type, "text");
    const outbound = messagesFor(504).find((row) => row.direction === "outbound");
    assert.equal(outbound?.content, "seguro?");
  });

  it("media sends bypass the window gate and stamp image contentType", async () => {
    process.env.ROUTER_OUT_API_KEY = "key";
    seedAccount({ id: 5 });
    seedConversation({ id: 505, channelAccountId: 5 });
    // No inbound at all — a media send must not be template-squashed.
    const { sent, restore } = withStubbedSend({
      ok: true,
      providerMessageId: "pm-img",
      status: "sent",
    });
    try {
      await sendOutboundMessage(
        505,
        "foto del pedido",
        "human",
        "https://media.example/pedido.jpg",
        "image",
        { operatorRef: "user-9" }
      );
    } finally {
      restore();
      delete process.env.ROUTER_OUT_API_KEY;
    }
    assert.equal(sent[0].type, "image");
    assert.equal(sent[0].mediaUrl, "https://media.example/pedido.jpg");
    const outbound = messagesFor(505).find((row) => row.direction === "outbound");
    assert.equal(outbound?.contentType, "image");
    assert.equal(outbound?.deliveryState, "sent");
  });

  it("drops a whatsapp send bound to another channel's account", async () => {
    process.env.ROUTER_OUT_API_KEY = "key";
    seedAccount({ id: 6, channel: "telegram" });
    seedConversation({ id: 506, channelAccountId: 6 });
    const { sent, restore } = withStubbedSend({
      ok: true,
      providerMessageId: "pm-x",
      status: "sent",
    });
    try {
      await assert.rejects(
        sendOutboundMessage(506, "hola", "human"),
        /account_provider_mismatch|not resolvable/
      );
    } finally {
      restore();
      delete process.env.ROUTER_OUT_API_KEY;
    }
    assert.equal(sent.length, 0, "a mismatched account must never send");
    const outbound = messagesFor(506).find((row) => row.direction === "outbound");
    assert.equal(outbound?.deliveryState, "failed");
  });
});

// Keep the hook alive for the whole file; node runs this process per file.
process.on("exit", () => {
  restoreDb();
});
