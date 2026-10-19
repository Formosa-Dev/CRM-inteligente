/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * Round-3 behavior tests over a mocked DB:
 * - legacy null-account conversation found via whatsapp_id (no 23505 loss)
 * - passive pipeline stamps two accounts on two separate conversations
 * - signed webhook envelope with two events is processed and aggregated
 * - Meta webhook fails closed without a Meta routing key
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it, mock } from "node:test";
import { NextRequest } from "next/server";

import { FakeDb, installFakeDb } from "./test-support/fake-db";
import { agentConfig, channelAccounts, leads, orders } from "@/db/schema";
import { ycloudProvider } from "./providers/ycloud";

const fake = new FakeDb();
const restore = installFakeDb(fake);

const ROUTE_SECRET = "whsec_round3_fixture";
const META_SECRET = "meta_round3_fixture";

fake.seed(channelAccounts, [
  {
    id: 1,
    tenantId: "default",
    provider: "ycloud",
    channel: "whatsapp",
    providerAccountId: "15550009999",
    senderAddress: "+15550009999",
    displayName: null,
    credentialsRef: "agent_config",
    agentConfigId: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);
fake.seed(agentConfig, [
  {
    id: 1,
    channel: null,
    channelAccountId: null,
    ycloudApiKey: "fake-ycloud-key",
    ycloudWebhookSecret: ROUTE_SECRET,
    metaAppSecret: META_SECRET,
    phoneNumber: "+15550009999",
    enabled: true,
    autoReply24h: false,
    autoReply24hMessage: null,
    webOrderRedirectEnabled: false,
    webOrderRedirectMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);

// Required after the `@/db` hook is installed.
const router = require("@/lib/channels/router") as typeof import("@/lib/channels/router");
const { handlePassiveChannelEvent } = require("./ingress") as typeof import("./ingress");
const { POST: whatsappPost } = require("@/app/api/whatsapp/webhook/route") as typeof import("@/app/api/whatsapp/webhook/route");
const { POST: metaPost } = require("@/app/api/meta/webhook/route") as typeof import("@/app/api/meta/webhook/route");
const { messenger } = require("@/lib/messaging") as typeof import("@/lib/messaging");

function sign(rawBody: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},s=${digest}`;
}

function account(id: number, channel: "instagram" | "whatsapp", provider: "zernio" | "ycloud") {
  return {
    id: String(id),
    tenantId: "default",
    provider,
    channel,
    providerAccountId: `acc-${id}`,
    senderAddress: `+1555000000${id}`,
    credentials: { apiKey: "test", webhookSecret: "" },
    status: "active" as const,
  };
}

describe("legacy null-account identity fallback", () => {
  it("finds a pre-migration row by whatsapp_id instead of losing it to 23505", async () => {
    fake.rows("conversations").push({
      id: 50,
      channel: "whatsapp",
      channelAccountId: null,
      whatsappId: "+15550007777",
      externalUserId: null,
      externalUserIdNormalized: null,
      customerName: null,
      customerPhone: null,
      status: "active",
    });

    const found = await router.findOrCreateConversation(
      "whatsapp",
      "+15550007777",
      undefined,
      undefined,
      null
    );

    assert.equal(found.id, 50);
    assert.equal(found.isNew, false);
    assert.equal(fake.rows("conversations").length, 1);
  });
});

describe("scoped credential fail-closed", () => {
  it("does not fall back to the global/env key when a scoped account key is blank", async () => {
    fake.rows("channel_accounts").push({
      id: 2,
      tenantId: "default",
      provider: "ycloud",
      channel: "whatsapp",
      providerAccountId: "15550002222",
      senderAddress: "+15550002222",
      displayName: null,
      credentialsRef: "agent_config",
      agentConfigId: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    fake.rows("agent_config").push({
      id: 2,
      channel: "whatsapp",
      channelAccountId: 2,
      ycloudApiKey: "",
      ycloudWebhookSecret: "",
      metaAppSecret: "",
      phoneNumber: "+15550002222",
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const { resolveChannelAccountByIdStrict } =
      require("./accounts") as typeof import("./accounts");
    const resolution = await resolveChannelAccountByIdStrict(2);
    assert.equal(resolution.kind, "mismatch");
    if (resolution.kind === "mismatch") {
      assert.match(resolution.reason, /no usable ycloudApiKey/);
    }
  });
});

describe("two-account pipeline", () => {
  it("keeps the same customer on two accounts in two account-stamped conversations", async () => {
    const event = (providerMessageId: string, provider: "zernio") => ({
      provider,
      deliveryId: `del-${providerMessageId}`,
      kind: "message.received" as const,
      direction: "inbound" as const,
      providerAccountId: "acc-1",
      providerConversationId: "thread-1",
      platformMessageId: providerMessageId,
      sender: { socialId: "customer-99", name: "Customer" },
      text: "hola",
      timestamp: "2026-01-01T00:00:00.000Z",
      raw: {},
    });

    const responseA = await handlePassiveChannelEvent(event("msg-a", "zernio"), {
      channel: "instagram",
      account: account(2, "instagram", "zernio"),
      channelAccountId: 2,
    });
    const responseB = await handlePassiveChannelEvent(event("msg-b", "zernio"), {
      channel: "instagram",
      account: account(3, "instagram", "zernio"),
      channelAccountId: 3,
    });

    assert.equal(responseA.status, 200);
    assert.equal(responseB.status, 200);
    const rows = fake
      .rows("conversations")
      .filter((row) => row.externalUserIdNormalized === "customer-99");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.channelAccountId).sort(),
      [2, 3]
    );
    const messages = fake
      .rows("chat_messages")
      .filter((row) => row.platformMessageId === "msg-a" || row.platformMessageId === "msg-b");
    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((row) => row.channelAccountId).sort(), [2, 3]);
  });
});

describe("two-event webhook route", () => {
  it("processes both signed status events and persists both", async () => {
    const events = [
      {
        provider: "ycloud" as const,
        deliveryId: "evt_status_1",
        kind: "message.status" as const,
        direction: "outbound" as const,
        providerAccountId: "15550009999",
        platformMessageId: "wamid.1",
        status: "delivered" as const,
        sender: {},
        timestamp: "2026-01-01T00:00:01.000Z",
        raw: { type: "whatsapp.message.updated" },
      },
      {
        provider: "ycloud" as const,
        deliveryId: "evt_status_2",
        kind: "message.status" as const,
        direction: "outbound" as const,
        providerAccountId: "15550009999",
        platformMessageId: "wamid.2",
        status: "read" as const,
        sender: {},
        timestamp: "2026-01-01T00:00:02.000Z",
        raw: { type: "whatsapp.message.updated" },
      },
    ];
    mock.method(ycloudProvider, "parseWebhook", () => events);
    try {
      const body = JSON.stringify({ type: "whatsapp.message.updated" });
      const response = await whatsappPost(
        new NextRequest("https://example.test/api/whatsapp/webhook", {
          method: "POST",
          body,
          headers: { "ycloud-signature": sign(body, ROUTE_SECRET) },
        })
      );
      const json = (await response.json()) as { processed?: number };
      assert.equal(response.status, 200);
      assert.equal(json.processed, 2);
      assert.equal(
        fake.rows("channel_events").filter((row) =>
          ["evt_status_1", "evt_status_2"].includes(String(row.deliveryId))
        ).length,
        2
      );
    } finally {
      mock.restoreAll();
    }
  });
});

describe("account-scoped delivery notification", () => {
  it("looks up the pending order through the event account's lead", async () => {
    fake.seed(leads, [
      { id: 1, phone: "+15550003001", channelAccountId: 1 },
      { id: 2, phone: "+15550003002", channelAccountId: 2 },
    ]);
    fake.seed(orders, [
      {
        id: 1,
        leadId: 1,
        phoneNumber: "+15550003001",
        customerName: "Account One",
        status: "pending",
        items: [],
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: 2,
        leadId: 2,
        phoneNumber: "+15550003002",
        customerName: "Account Two",
        status: "pending",
        items: [],
        createdAt: new Date("2026-01-02T00:00:00Z"),
      },
    ]);
    const sent: string[] = [];
    mock.method(messenger, "send", async (msg: { to: string }) => {
      sent.push(msg.to);
      return { ok: true as const, providerMessageId: "wamid.test", status: "sent" };
    });
    try {
      const one = await router.notifyCustomerDeliveryArrived("+15550009999", {
        account: account(1, "whatsapp", "ycloud"),
        channelAccountId: 1,
      });
      const two = await router.notifyCustomerDeliveryArrived("+15550009999", {
        account: account(2, "whatsapp", "ycloud"),
        channelAccountId: 2,
      });
      assert.equal(one.ok, true);
      assert.equal(two.ok, true);
      assert.deepEqual(sent, ["+15550003001", "+15550003002"]);
    } finally {
      mock.restoreAll();
    }
  });
});

describe("Meta webhook fail-closed routing", () => {
  it("skips a message whose payload has no Meta routing key", async () => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              field: "messages",
              value: {
                messages: [{ from: "+15550008888", id: "meta-msg-1", text: { body: "hola" } }],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${createHmac("sha256", META_SECRET).update(body).digest("hex")}`;
    const before = fake
      .rows("conversations")
      .filter((row) => row.customerPhone === "15550008888").length;
    const response = await metaPost(
      new NextRequest("https://example.test/api/meta/webhook", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": signature },
      })
    );
    assert.equal(response.status, 200);
    const after = fake
      .rows("conversations")
      .filter((row) => row.customerPhone === "15550008888").length;
    assert.equal(after, before);
  });
});

// Keep the hook alive for the whole file; node runs this process per file.
process.on("exit", restore);
