/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * A-02: triggerAgentForConversation must require the admin role and resolve
 * the recipient FROM the conversation row — a viewer session (or a forged
 * `customerPhone` argument) must never drive a real outbound send.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";
import { agentConfig } from "@/db/schema";

const fake = new FakeDb();
installFakeDb(fake);

const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const prevLoad = Module._load;
const bubblesCalls: Record<string, unknown>[] = [];
const agentCalls: Record<string, unknown>[] = [];
let session: unknown = { user: { id: "1", role: "admin" } };

Module._load = function (request, parent, isMain): unknown {
  if (request === "@/auth") {
    return { auth: async () => session };
  }
  if (request === "next/cache") {
    return { revalidatePath: () => undefined };
  }
  if (request === "@/lib/whatsapp/agent") {
    return {
      runWhatsAppAgent: async (args: Record<string, unknown>) => {
        agentCalls.push(args);
        return { text: "agent reply", pendingMedia: [] };
      },
    };
  }
  if (request === "@/lib/buffer/response-sender") {
    return {
      sendWhatsAppBubbles: async (args: Record<string, unknown>) => {
        bubblesCalls.push(args);
        return { id: "wamid.a02" };
      },
    };
  }
  return prevLoad.call(this, request, parent, isMain);
};

const { triggerAgentForConversation } =
  require("./dashboard-actions-server") as typeof import("./dashboard-actions-server");

// Truly unprovisioned install: no channel_accounts, legacy global creds.
fake.seed(agentConfig, [
  {
    id: 1,
    channel: null,
    channelAccountId: null,
    ycloudApiKey: "global-key",
    ycloudWebhookSecret: "",
    metaAppSecret: "",
    phoneNumber: "+10000000001",
    enabled: true,
    autoReply24h: false,
    webOrderRedirectEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);

function seedConversation(
  id: number,
  phone: string | null,
  channelAccountId: number | null = null
): void {
  fake.rows("conversations").push({
    id,
    channel: "whatsapp",
    channelAccountId,
    whatsappId: phone,
    externalUserId: phone,
    externalUserIdNormalized: phone?.replace(/\D/g, "") ?? null,
    customerName: `Cust ${id}`,
    customerPhone: phone,
    status: "active",
  });
  fake.rows("chat_messages").push({
    id: id * 10,
    conversationId: id,
    role: "user",
    content: "hola",
    createdAt: new Date(),
  });
}

describe("A-02 — triggerAgentForConversation", () => {
  it("rejects anonymous callers before touching the conversation", async () => {
    session = null;
    const before = bubblesCalls.length;
    const result = await triggerAgentForConversation(1, "+15550111");
    assert.deepEqual(result, { success: false, message: "No autorizado" });
    assert.equal(bubblesCalls.length, before);
  });

  it("rejects a viewer session — a read role must not send messages", async () => {
    session = { user: { id: "2", role: "viewer" } };
    const before = bubblesCalls.length;
    const result = await triggerAgentForConversation(1, "+15550111");
    assert.deepEqual(result, { success: false, message: "No autorizado" });
    assert.equal(bubblesCalls.length, before);
  });

  it("sends to the stored recipient even when the client forges customerPhone", async () => {
    session = { user: { id: "1", role: "admin" } };
    seedConversation(1, "+15550999");
    const before = bubblesCalls.length;

    const result = await triggerAgentForConversation(1, "+1999FORGED");

    assert.equal(result.success, true);
    const sent = bubblesCalls.at(-1);
    assert.ok(bubblesCalls.length > before);
    assert.equal(sent?.to, "+15550999");
    // The agent itself also sees only the stored identity.
    assert.equal(agentCalls.at(-1)?.customerPhone, "+15550999");
  });

  it("fails closed when the conversation does not exist", async () => {
    session = { user: { id: "1", role: "admin" } };
    const before = bubblesCalls.length;
    const result = await triggerAgentForConversation(999, "+15550111");
    assert.equal(result.success, false);
    assert.match(result.message, /no encontrada/i);
    assert.equal(bubblesCalls.length, before);
  });

  it("fails closed when the conversation has no resolvable recipient", async () => {
    session = { user: { id: "1", role: "admin" } };
    seedConversation(2, null);
    const before = bubblesCalls.length;

    const result = await triggerAgentForConversation(2, "+15550111");

    assert.equal(result.success, false);
    assert.match(result.message, /destinatario/i);
    assert.equal(bubblesCalls.length, before);
  });
});
