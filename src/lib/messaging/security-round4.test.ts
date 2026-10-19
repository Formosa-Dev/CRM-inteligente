/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * Round-4 behavior tests over a mocked DB:
 * - H1: the dashboard "trigger agent" action resolves the sender through the
 *   same send-account decision as outbound sends — account-scoped when
 *   provisioned, legacy only when truly unprovisioned, fail closed on
 *   ambiguous resolution.
 * - H2: inbound rate-limit, content-dedup, and buffer debounce keys are
 *   namespaced by the receiving channel account (NULL keeps legacy shape).
 * - H3: conversation-context lead writes stamp leads.channel_account_id so
 *   scoped order lookups attribute correctly.
 * - M1: the delivery notification sends as the bound account (blank scoped
 *   key fails explicitly) — never global/env credentials for a bound send.
 * - L4: order lifecycle reads scope to the conversation's account; legacy
 *   unbound stays phone-global.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it, mock } from "node:test";

import { FakeDb, installFakeDb } from "./test-support/fake-db";
import { agentConfig, products } from "@/db/schema";

const fake = new FakeDb();
const restoreDb = installFakeDb(fake);

// Extra module hooks for the surfaces under test. They chain onto the fake-db
// hook so every other specifier still resolves normally (with @/db faked).
const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const prevLoad = Module._load;
const bubblesCalls: Record<string, unknown>[] = [];
const warns: string[] = [];
const sends: { to: string; options: unknown }[] = [];
Module._load = function (request, parent, isMain): unknown {
  if (request === "@/auth") {
    return { auth: async () => ({ user: { id: "admin-1" } }) };
  }
  if (request === "next/cache") {
    return { revalidatePath: () => undefined };
  }
  if (request === "@/lib/whatsapp/agent") {
    return {
      runWhatsAppAgent: async () => ({ text: "agent reply", pendingMedia: [] }),
    };
  }
  if (request === "@/lib/buffer/response-sender") {
    return {
      sendWhatsAppBubbles: async (args: Record<string, unknown>) => {
        bubblesCalls.push(args);
        return { id: "wamid.round4" };
      },
    };
  }
  return prevLoad.call(this, request, parent, isMain);
};

fake.seed(agentConfig, [
  {
    id: 1,
    channel: null,
    channelAccountId: null,
    ycloudApiKey: "global-key",
    ycloudWebhookSecret: "",
    metaAppSecret: "",
    phoneNumber: "+10000000001",
    deliveryPhoneNumber: "+15550004444",
    enabled: true,
    autoReply24h: false,
    webOrderRedirectEnabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
]);
fake.seed(products, [
  {
    id: 1,
    name: "Hamburguesa Simple",
    price: "150.00",
    available: true,
    comingSoon: false,
    stock: 50,
  },
]);

// Required after the hooks are installed.
const router = require("@/lib/channels/router") as typeof import("@/lib/channels/router");
const { triggerAgentForConversation } = require("@/app/(admin)/admin/dashboard-actions-server") as typeof import("@/app/(admin)/admin/dashboard-actions-server");
const { messenger } = require("@/lib/messaging") as typeof import("@/lib/messaging");
const { captureLeadIfNew } = require("@/lib/whatsapp/lead-capture") as typeof import("@/lib/whatsapp/lead-capture");
const { createCreateOrderTool } = require("@/lib/whatsapp/tools/create-order") as typeof import("@/lib/whatsapp/tools/create-order");
const { DrizzleOrderLifecycleRepository } = require("@/lib/whatsapp/order-lifecycle") as typeof import("@/lib/whatsapp/order-lifecycle");
const { accountScopedInboundKey } = require("./inbound-keys") as typeof import("./inbound-keys");
const { BufferManager } = require("@/lib/buffer/manager") as typeof import("@/lib/buffer/manager");
const { persistChannelEvent } = require("@/lib/messaging/channel-events") as typeof import("@/lib/messaging/channel-events");
const { runWithAgentConfigScope } = require("@/lib/agent-config-scope") as typeof import("@/lib/agent-config-scope");
const { getOrderStatusTool, cancelOrderTool } = require("@/lib/whatsapp/tools/order-management-tools") as typeof import("@/lib/whatsapp/tools/order-management-tools");
const { getClientHistoryTool } = require("@/lib/whatsapp/tools/client-tools") as typeof import("@/lib/whatsapp/tools/client-tools");

// Shared send/warn spies for the whole file — every outbound notification and
// explicit failure is observable. Per-test baselines isolate the cases.
mock.method(console, "warn", (...args: unknown[]) => {
  warns.push(args.map(String).join(" "));
});
mock.method(
  messenger,
  "send",
  async (msg: { to: string }, options: unknown) => {
    sends.push({ to: msg.to, options });
    return { ok: true as const, providerMessageId: "wamid.r4", status: "sent" };
  }
);

function seedConversation(
  id: number,
  phone: string,
  channelAccountId: number | null
): void {
  fake.rows("conversations").push({
    id,
    channel: "whatsapp",
    channelAccountId,
    whatsappId: phone,
    externalUserId: phone,
    externalUserIdNormalized: phone.replace(/\D/g, ""),
    customerName: `Cust ${id}`,
    customerPhone: phone,
    // FakeDb returns raw rows without applying select aliasing; create-order
    // reads `.phone` from `{ phone: conversations.customerPhone }`.
    phone,
    status: "active",
  });
}

function seedInboundMessage(conversationId: number, id: number): void {
  fake.rows("chat_messages").push({
    id,
    conversationId,
    role: "user",
    content: "hola",
    createdAt: new Date(),
  });
}

function seedAccountRow(id: number): void {
  fake.rows("channel_accounts").push({
    id,
    tenantId: "default",
    provider: "ycloud",
    channel: "whatsapp",
    providerAccountId: `1555000${id}`,
    senderAddress: `+1555000${id}`,
    displayName: null,
    credentialsRef: "agent_config",
    agentConfigId: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function seedScopedConfig(
  id: number,
  channelAccountId: number,
  ycloudApiKey: string
): void {
  fake.rows("agent_config").push({
    id,
    channel: "whatsapp",
    channelAccountId,
    ycloudApiKey,
    ycloudWebhookSecret: "",
    metaAppSecret: "",
    phoneNumber: `+1555000${channelAccountId}`,
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

/** Bounded wait for the fire-and-forget notification to reach its verdict. */
async function until(cond: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return cond();
}

async function runCreateOrder(conversationId: number, phone: string): Promise<string> {
  const tool = createCreateOrderTool(conversationId, undefined, {
    // planOrderCreation only proceeds when the current turn is an explicit
    // order that names the model-supplied items.
    turnText: "quiero 1 hamburguesa simple",
  });
  const execute = tool.execute as (
    input: unknown,
    options: unknown
  ) => Promise<unknown>;
  return String(
    await execute(
      {
        customerName: "Cliente",
        orderType: "hamburguesas",
        items: [{ name: "Hamburguesa Simple", quantity: 1 }],
        customerPhone: phone,
        address: "Calle Falsa 123",
      },
      { toolCallId: "round4", messages: [] }
    )
  );
}

describe("H2 — account-scoped inbound keys", () => {
  it("keeps the exact legacy shape for a NULL account", () => {
    assert.equal(accountScopedInboundKey(null, "5493704868421"), "5493704868421");
    assert.equal(accountScopedInboundKey(undefined, "5493704868421"), "5493704868421");
    const phone = "5493704868421";
    assert.equal(
      `wa-inbound:${accountScopedInboundKey(null, phone)}`,
      `wa-inbound:${phone}`
    );
  });

  it("namespaces keys per channel account", () => {
    const first = accountScopedInboundKey(1, "5493704868421");
    const second = accountScopedInboundKey(2, "5493704868421");
    assert.equal(first, "acct1:5493704868421");
    assert.equal(second, "acct2:5493704868421");
    assert.notEqual(first, second);
    assert.notEqual(first, "5493704868421");
  });

  it("keeps buffered/debounced state isolated per account", async () => {
    const msg = { content: "hola", messageId: "m1", timestamp: Date.now() };
    await BufferManager.enqueue("whatsapp", "acct1:+15550001", msg);
    assert.equal(await BufferManager.hasNewMessages("whatsapp", "acct1:+15550001"), true);
    assert.equal(await BufferManager.hasNewMessages("whatsapp", "acct2:+15550001"), false);
    assert.equal(await BufferManager.hasNewMessages("whatsapp", "+15550001"), false);

    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "acct1:+15550001", "dup"), false);
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "acct1:+15550001", "dup"), true);
    assert.equal(await BufferManager.isContentDuplicate("whatsapp", "acct2:+15550001", "dup"), false);
  });

  it("the pipeline applies the scoped key to rate-limit, dedup, and buffer", () => {
    const src = readFileSync("src/lib/messaging/inbound-pipeline.ts", "utf8");
    assert.match(src, /accountScopedInboundKey\(channelAccountId, phone\)/);
    assert.match(src, /accountScopedInboundKey\(channelAccountId, customerPhone\)/);
    assert.match(src, /checkRateLimit\(`wa-inbound:\$\{phoneKey\}`\)/);
    assert.match(src, /BufferManager\.isContentDuplicate\("whatsapp", customerKey/);
    assert.match(src, /BufferManager\.enqueue\("whatsapp", customerKey/);
    assert.match(src, /scheduleBufferProcessing\("whatsapp", customerKey/);
  });
});

describe("H1 — dashboard trigger resolves the shared send-account decision", () => {
  it("legacy unprovisioned send keeps the exact credential path", async () => {
    // No channel_accounts rows yet — the genuinely unprovisioned install.
    seedConversation(101, "+15550101", null);
    seedInboundMessage(101, 1001);

    const result = await triggerAgentForConversation(101, "+15550101");
    assert.equal(result.success, true);
    const args = bubblesCalls.at(-1);
    assert.equal(args?.apiKey, "global-key");
    assert.equal(args?.from, "+10000000001");
    assert.equal(args?.account, undefined);
  });

  it("a single provisioned account sends AS that account, not global creds", async () => {
    seedAccountRow(10);
    seedConversation(102, "+15550102", null);
    seedInboundMessage(102, 1002);

    const result = await triggerAgentForConversation(102, "+15550102");
    assert.equal(result.success, true);
    const args = bubblesCalls.at(-1);
    const sent = args?.account as { id?: string } | undefined;
    assert.equal(sent?.id, "10");
    assert.equal(args?.apiKey, "");
  });

  it("ambiguous provisioning fails closed — no silent global-credential send", async () => {
    seedAccountRow(11); // now two active whatsapp accounts, no routing key
    seedConversation(103, "+15550103", null);
    seedInboundMessage(103, 1003);
    const before = bubblesCalls.length;

    const result = await triggerAgentForConversation(103, "+15550103");
    assert.equal(result.success, false);
    assert.match(result.message, /remitente seguro/i);
    assert.equal(bubblesCalls.length, before);
  });

  it("a bound conversation sends as its bound account", async () => {
    seedConversation(105, "+15550105", 10);
    seedInboundMessage(105, 1005);

    const result = await triggerAgentForConversation(105, "+15550105");
    assert.equal(result.success, true);
    const args = bubblesCalls.at(-1);
    const sent = args?.account as { id?: string } | undefined;
    assert.equal(sent?.id, "10");
  });

  it("a bound but unresolvable account fails instead of degrading", async () => {
    seedConversation(104, "+15550104", 999);
    seedInboundMessage(104, 1004);
    const before = bubblesCalls.length;

    const result = await triggerAgentForConversation(104, "+15550104");
    assert.equal(result.success, false);
    assert.match(result.message, /no es resoluble/);
    assert.equal(bubblesCalls.length, before);
  });
});

describe("H3 — conversation-context writes stamp leads.channel_account_id", () => {
  it("captureLeadIfNew stamps the receiving account on insert", async () => {
    const created = await captureLeadIfNew("+15550777", "Nuevo", "hola", 7);
    assert.equal(created.isNew, true);
    const lead = fake.rows("leads").find((row) => row.id === created.leadId);
    assert.equal(lead?.channelAccountId, 7);
  });

  it("a re-contact through a different account moves the ownership", async () => {
    await captureLeadIfNew("+15550777", "Nuevo", "otra vez", 8);
    const lead = fake.rows("leads").find((row) => row.phone === "15550777");
    assert.equal(lead?.channelAccountId, 8);
  });

  it("a NULL account context never writes the column", async () => {
    await captureLeadIfNew("+15550778", "Legacy", "hola", null);
    const lead = fake.rows("leads").find((row) => row.phone === "15550778");
    assert.equal(lead?.channelAccountId, null);
  });

  it("conversation auto-link stamps the bound account on the lead", async () => {
    fake.rows("leads").push({
      id: 30,
      phone: "15550779",
      channelAccountId: null,
      conversationId: null,
    });
    const conv = await router.findOrCreateConversation(
      "whatsapp",
      "+15550779",
      "X",
      "+15550779",
      9
    );
    const lead = fake.rows("leads").find((row) => row.id === 30);
    assert.equal(lead?.conversationId, conv.id);
    assert.equal(lead?.channelAccountId, 9);
  });

  it("a captured lead makes its order visible only to the owning account", async () => {
    await captureLeadIfNew("+15550400", "Uno", "hola", 20);
    await captureLeadIfNew("+15550401", "Dos", "hola", 21);
    const leadOne = fake.rows("leads").find((row) => row.phone === "15550400");
    const leadTwo = fake.rows("leads").find((row) => row.phone === "15550401");
    // FakeDb joins merge `{...order, ...lead}` — a lead `status` would shadow
    // the order's status inside the pending-orders predicate. Strip it here;
    // a real join only projects the selected order columns.
    delete leadOne?.status;
    delete leadTwo?.status;
    fake.rows("orders").push(
      { id: 40, leadId: leadOne?.id, phoneNumber: "15550400", status: "pending" },
      { id: 41, leadId: leadTwo?.id, phoneNumber: "15550401", status: "pending" }
    );
    const baseline = sends.length;

    const first = await router.notifyCustomerDeliveryArrived("+15550009999", {
      channelAccountId: 20,
      apiKey: "k",
      senderAddress: "+155500020",
    });
    const second = await router.notifyCustomerDeliveryArrived("+15550009999", {
      channelAccountId: 21,
      apiKey: "k",
      senderAddress: "+155500021",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(sends.slice(baseline).map((send) => send.to), [
      "15550400",
      "15550401",
    ]);
  });
});

describe("M1 — delivery notification resolves the conversation's sender", () => {
  it("bound conversation + blank scoped key fails explicitly, never global/env", async () => {
    seedAccountRow(20);
    seedScopedConfig(20, 20, "");
    seedConversation(201, "+15550201", 20);
    fake.rows("leads").push({ id: 50, phone: "15550201", channelAccountId: 20, status: "contacted" });
    const sendBase = sends.length;
    const warnBase = warns.length;

    const text = await runCreateOrder(201, "+15550201");
    assert.match(text, /Pedido #/);
    await until(
      () =>
        sends.length > sendBase ||
        warns.slice(warnBase).some((w) => w.includes("[delivery]"))
    );
    const deliveryWarn = warns
      .slice(warnBase)
      .find((w) => w.includes("[delivery]"));
    assert.match(deliveryWarn ?? "", /not resolvable|no usable ycloudApiKey/);
    assert.equal(sends.length, sendBase);
  });

  it("bound conversation + valid scoped key sends as that account", async () => {
    seedAccountRow(21);
    seedScopedConfig(21, 21, "key-account-21");
    seedConversation(202, "+15550202", 21);
    // Lead owned by a different account — the order write must restamp it.
    fake.rows("leads").push({ id: 51, phone: "15550202", channelAccountId: 20, status: "contacted" });
    const sendBase = sends.length;
    const warnBase = warns.length;

    const text = await runCreateOrder(202, "+15550202");
    assert.match(text, /Pedido #/);
    await until(
      () =>
        sends.length > sendBase ||
        warns.slice(warnBase).some((w) => w.includes("[delivery]"))
    );
    const sent = sends[sendBase];
    assert.equal(sent?.to, "+15550004444");
    const options = sent?.options as { channel?: string; account?: { id?: string } };
    assert.equal(options?.channel, "whatsapp");
    assert.equal(options?.account?.id, "21");
    // H3: the order-taking account owns the lead afterwards.
    const lead = fake.rows("leads").find((row) => row.id === 51);
    assert.equal(lead?.channelAccountId, 21);
  });

  it("unbound conversation + ambiguous provisioning fails closed", async () => {
    // Accounts 20 and 21 are active — no routing key can pick a sender.
    seedConversation(203, "+15550203", null);
    fake.rows("leads").push({ id: 52, phone: "15550203", channelAccountId: null, status: "contacted" });
    const sendBase = sends.length;
    const warnBase = warns.length;

    const text = await runCreateOrder(203, "+15550203");
    assert.match(text, /Pedido #/);
    await until(
      () =>
        sends.length > sendBase ||
        warns.slice(warnBase).some((w) => w.includes("[delivery]"))
    );
    const deliveryWarn = warns
      .slice(warnBase)
      .find((w) => w.includes("[delivery]"));
    assert.match(deliveryWarn ?? "", /no safe WhatsApp sender/);
    assert.equal(sends.length, sendBase);
  });

  it("unbound conversation + truly unprovisioned channel keeps legacy creds", async () => {
    // Remove every account row — the genuinely unprovisioned install.
    fake.rows("channel_accounts").length = 0;
    seedConversation(204, "+15550204", null);
    fake.rows("leads").push({ id: 53, phone: "15550204", channelAccountId: null, status: "contacted" });
    const sendBase = sends.length;
    const warnBase = warns.length;

    const text = await runCreateOrder(204, "+15550204");
    assert.match(text, /Pedido #/);
    await until(
      () =>
        sends.length > sendBase ||
        warns.slice(warnBase).some((w) => w.includes("[delivery]"))
    );
    const sent = sends[sendBase];
    assert.equal(sent?.to, "+15550004444");
    const options = sent?.options as { credentials?: { apiKey?: string; senderAddress?: string } };
    assert.equal(options?.credentials?.apiKey, "global-key");
    assert.equal(options?.credentials?.senderAddress, "+10000000001");
  });
});

describe("L3 — channel_events delivery dedup is account-scoped", () => {
  const statusEvent = (deliveryId: string) => ({
    provider: "ycloud" as const,
    deliveryId,
    kind: "message.status" as const,
    direction: "outbound" as const,
    providerAccountId: "155500020",
    sender: {},
    status: "delivered" as const,
    timestamp: new Date("2026-02-01").toISOString(),
    raw: {},
  });

  it("same provider delivery id persists per account, dedupes within it", async () => {
    const first = await persistChannelEvent(statusEvent("evt-shared-1"), {
      channel: "whatsapp",
      channelAccountId: 20,
    });
    const second = await persistChannelEvent(statusEvent("evt-shared-1"), {
      channel: "whatsapp",
      channelAccountId: 21,
    });
    const duplicate = await persistChannelEvent(statusEvent("evt-shared-1"), {
      channel: "whatsapp",
      channelAccountId: 20,
    });
    const legacy = await persistChannelEvent(statusEvent("evt-shared-1"), {
      channel: "whatsapp",
      // no channelAccountId — the NULL/legacy partition
    });
    const legacyDuplicate = await persistChannelEvent(statusEvent("evt-shared-1"), {
      channel: "whatsapp",
    });

    assert.equal(first.kind, "persisted");
    assert.equal(second.kind, "persisted", "another account must not dedup away the same delivery id");
    assert.equal(duplicate.kind, "duplicate", "same account must still dedup");
    assert.equal(legacy.kind, "persisted", "legacy NULL lives in its own partition");
    assert.equal(legacyDuplicate.kind, "duplicate", "legacy NULL partition still dedups");
  });

  it("the additive migration scopes the index by account", () => {
    const migration = readFileSync(
      "drizzle/0019_channel_events_scoped_delivery.sql",
      "utf8"
    );
    assert.match(migration, /channel_account_id/i);
    assert.match(migration, /coalesce/i);
    assert.match(migration, /channel_events_provider_delivery_uq/);
    // The shipped 0017 migration is left untouched.
    const shipped = readFileSync("drizzle/0017_channel_events.sql", "utf8");
    assert.match(shipped, /channel_events_provider_delivery_uq/);
  });
});

describe("L4 — order lifecycle reads scope to the conversation's account", () => {
  it("findActiveOrder only sees orders owned by the scoped account", async () => {
    fake.rows("leads").push(
      { id: 60, phone: "15550300", channelAccountId: 30 },
      { id: 61, phone: "15550300", channelAccountId: 31 }
    );
    fake.rows("orders").push(
      { id: 60, leadId: 60, phoneNumber: "15550300", status: "pending", createdAt: new Date("2026-01-01") },
      { id: 61, leadId: 61, phoneNumber: "15550300", status: "preparing", createdAt: new Date("2026-01-02") }
    );
    const repository = new DrizzleOrderLifecycleRepository();

    const forA = await repository.findActiveOrder("15550300", 30);
    const forB = await repository.findActiveOrder("15550300", 31);
    const forOther = await repository.findActiveOrder("15550300", 99);
    const legacy = await repository.findActiveOrder("15550300", null);

    // The merged join row surfaces the owning lead id as attribution proof.
    const leadIdOf = (row: typeof forA) =>
      (row as { leadId?: number } | null)?.leadId;
    assert.equal(leadIdOf(forA), 60);
    assert.equal(leadIdOf(forB), 61);
    assert.equal(forOther, null);
    assert.equal(leadIdOf(legacy), 60, "legacy keeps the phone-global view");
  });

  it("the agent customer context joins orders through the owning lead", () => {
    const src = readFileSync("src/lib/whatsapp/agent.ts", "utf8");
    const joins = src.match(/innerJoin\(leads, eq\(orders\.leadId, leads\.id\)\)/g) ?? [];
    assert.ok(joins.length >= 3, "preferences/recent/pending order reads must be account-scoped");
    assert.match(src, /eq\(leads\.channelAccountId, scopeAccountId\)/);
  });
});

describe("L4 — agent tools keep order reads inside the account scope", () => {
  const scope40 = { channel: "whatsapp" as const, channelAccountId: 40 };
  const legacyScope = { channel: "whatsapp" as const, channelAccountId: null };

  function execTool(
    t: { execute?: unknown },
    input: unknown
  ): Promise<string> {
    const run = t.execute as (
      input: unknown,
      options: unknown
    ) => Promise<unknown>;
    return run(input, { toolCallId: "r4", messages: [] }).then(String);
  }

  it("getOrderStatus by orderId never surfaces another account's order", async () => {
    fake.rows("leads").push(
      { id: 70, phone: "15550600", channelAccountId: 40, name: "Propio", status: "new" },
      { id: 71, phone: "15550600", channelAccountId: 41, name: "Ajeno", status: "new" }
    );
    fake.rows("orders").push(
      { id: 70, leadId: 70, phoneNumber: "15550600", status: "pending", items: [], customerName: "A", createdAt: new Date("2026-02-01") },
      { id: 71, leadId: 71, phoneNumber: "15550600", status: "pending", items: [], customerName: "B", createdAt: new Date("2026-02-02") }
    );

    const own = await runWithAgentConfigScope(scope40, () =>
      execTool(getOrderStatusTool, { orderId: 70 })
    );
    assert.match(own, /Pedido #70/);

    const foreign = await runWithAgentConfigScope(scope40, () =>
      execTool(getOrderStatusTool, { orderId: 71 })
    );
    assert.match(foreign, /No encontré ningún pedido/);

    const legacy = await runWithAgentConfigScope(legacyScope, () =>
      execTool(getOrderStatusTool, { orderId: 71 })
    );
    assert.match(legacy, /Pedido #71/, "unbound scope keeps the global read");
  });

  it("cancelOrder under a bound scope cannot mutate a foreign order", async () => {
    const blocked = await runWithAgentConfigScope(scope40, () =>
      execTool(cancelOrderTool, { orderId: 71, reason: "x" })
    );
    assert.match(blocked, /No encontré ese pedido/);
    const foreign = fake.rows("orders").find((row) => row.id === 71);
    assert.equal(foreign?.status, "pending");

    const own = await runWithAgentConfigScope(scope40, () =>
      execTool(cancelOrderTool, { orderId: 70, reason: "ya no" })
    );
    assert.match(own, /cancelado/i);
    assert.equal(fake.rows("orders").find((row) => row.id === 70)?.status, "cancelled");
  });

  it("getClientHistory only exposes the owning account's lead and orders", async () => {
    fake.rows("orders").push({
      id: 72,
      leadId: 70,
      phoneNumber: "15550600",
      status: "delivered",
      items: [{ name: "Hamburguesa Simple", quantity: 1 }],
      customerName: "A",
      createdAt: new Date("2026-02-03"),
    });

    const bound = await runWithAgentConfigScope(scope40, () =>
      execTool(getClientHistoryTool, { phone: "+15550600" })
    );
    assert.match(bound, /Propio/);
    // Orders 70 and 72 are owned by lead 70 (account 40) — order 71 belongs
    // to account 41 and must not appear. (FakeDb merges join rows, so row ids
    // reflect the lead; the count is the meaningful signal here.)
    assert.match(bound, /📦 2 pedido\(s\)/);
    assert.doesNotMatch(bound, /Ajeno/);

    const legacy = await runWithAgentConfigScope(legacyScope, () =>
      execTool(getClientHistoryTool, { phone: "+15550600" })
    );
    // Legacy scope still sees every row for the shared phone.
    assert.match(legacy, /#71/);
    assert.match(legacy, /#72/);
  });
});

// Keep the hooks alive for the whole file; node runs this process per file.
process.on("exit", () => {
  Module._load = prevLoad;
  restoreDb();
});
