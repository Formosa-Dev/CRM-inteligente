import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { matchesAssistantBubble, splitIntoBubbles } from "./response-sender";

// A-04: a >250-char reply goes out as N sends; each bubble's echo must be
// recognized as ours even though only one providerMessageId is persisted.

const LONG_REPLY = [
  "Genial, te armo el pedido. La crispy sale $4500 y la doble $6200.",
  "El delivery tarda unos 40 minutos aproximadamente.",
  "¿Me confirmás la dirección así lo mando? Con efectivo o transferencia.",
].join("\n\n");

describe("matchesAssistantBubble — multi-bubble own-echo detection (A-04)", () => {
  it("matches the full stored content verbatim", () => {
    assert.equal(matchesAssistantBubble("hola, ¿qué pedís?", "hola, ¿qué pedís?"), true);
  });

  it("matches every individual bubble of a multi-bubble reply", () => {
    const bubbles = splitIntoBubbles(LONG_REPLY);
    assert.ok(bubbles.length > 1, "fixture must split into several bubbles");
    for (const bubble of bubbles) {
      assert.equal(matchesAssistantBubble(LONG_REPLY, bubble), true);
    }
  });

  it("does not match content that was never sent", () => {
    assert.equal(matchesAssistantBubble(LONG_REPLY, "mensaje escrito a mano por el dueño"), false);
    assert.equal(matchesAssistantBubble(LONG_REPLY, ""), false);
    assert.equal(matchesAssistantBubble("", "cualquier cosa"), false);
  });

  it("matches after markdown/bullet normalization (echoes carry the sent text)", () => {
    const stored = "**Precio:** $4500\n\n- una crispy\n- una doble";
    // The stored markdown was stripped before sending — the echo carries
    // the normalized bubble, which must still match the stored content.
    const sent = splitIntoBubbles(stored);
    for (const bubble of sent) {
      assert.equal(matchesAssistantBubble(stored, bubble), true);
    }
  });

  it("trims the incoming echo text before comparing", () => {
    assert.equal(matchesAssistantBubble("hola", "  hola  "), true);
  });
});

describe("providerConversationId threading (A-14)", () => {
  it("sendWhatsAppBubbles accepts providerConversationId and forwards it on every bubble", () => {
    const sender = readFileSync("src/lib/buffer/response-sender.ts", "utf8");
    const fn = sender.slice(sender.indexOf("export async function sendWhatsAppBubbles"));
    assert.match(fn, /providerConversationId\?: string;/);
    const sendCall = fn.slice(fn.indexOf("messenger.send"));
    assert.match(sendCall, /providerConversationId: params\.providerConversationId/);
  });

  it("every send in the turn dispatcher carries the stored externalThreadId", () => {
    const pipeline = readFileSync("src/lib/messaging/inbound-pipeline.ts", "utf8");
    // S3: the send logic lives in the registered turn dispatcher — the buffer
    // callback and the durable-queue drain both route through it.
    const cbStart = pipeline.indexOf("whatsAppInboundTurnDispatcher: InboundTurnDispatcher");
    const cb = pipeline.slice(cbStart, pipeline.indexOf("setInboundTurnDispatcher(", cbStart));
    // The callback re-reads the persisted provider thread id...
    assert.match(cb, /externalThreadId: conversations\.externalThreadId/);
    assert.match(cb, /replyThreadId = convBinding\?\.externalThreadId/);
    // ...and every outbound send (text bubbles + pending media) uses it.
    const bubbleCalls = cb.match(/sendWhatsAppBubbles\({[^}]*}/g) ?? [];
    assert.ok(bubbleCalls.length >= 2, "expected seller + customer bubble sends");
    for (const call of bubbleCalls) {
      assert.match(call, /providerConversationId: replyThreadId/);
    }
    const mediaCall = cb.slice(cb.indexOf("messenger.send"));
    assert.match(mediaCall, /providerConversationId: replyThreadId/);
  });
});

describe("handleEcho wires the fragment check (A-04)", () => {
  it("the echo handler matches against assistant bubbles, not only the whole row", () => {
    const pipeline = readFileSync("src/lib/messaging/inbound-pipeline.ts", "utf8");
    const echoStart = pipeline.indexOf("async function handleEcho");
    const echoEnd = pipeline.indexOf("async function handleDeliveryNotification", echoStart);
    const echo = pipeline.slice(echoStart, echoEnd);
    assert.match(echo, /matchesAssistantBubble\(recent\.content, displayText\)/);
    // The check must run before the human-override write.
    const matchAt = echo.indexOf("matchesAssistantBubble(");
    const overrideAt = echo.indexOf("humanOverrideUntil: overrideUntil");
    assert.ok(matchAt !== -1 && overrideAt !== -1 && matchAt < overrideAt);
  });
});
