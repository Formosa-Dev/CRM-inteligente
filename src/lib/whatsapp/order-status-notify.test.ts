/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "../messaging/test-support/fake-db";

const fake = new FakeDb();
const restoreDb = installFakeDb(fake);

const { sendOrderStatusNotification, resolveOrderNotificationPhone } =
  require("./order-status-notify") as typeof import("./order-status-notify");
const { leads, leadIdentities } =
  require("@/db/schema") as typeof import("@/db/schema");
import type {
  ChannelAccount,
  OutboundMessage,
  SendResult,
} from "@/lib/messaging/types";
import type { OrderStatusNotifyDeps as DepsAlias } from "./order-status-notify";

const ACCOUNT_A: ChannelAccount = {
  id: "1",
  tenantId: "default",
  provider: "ycloud",
  channel: "whatsapp",
  providerAccountId: "15550000001",
  senderAddress: "+15550000001",
  credentials: { apiKey: "a", webhookSecret: "" },
  status: "active",
};
const ACCOUNT_B: ChannelAccount = {
  ...ACCOUNT_A,
  id: "2",
  providerAccountId: "15550000002",
};

function deps(over: Partial<DepsAlias> = {}): DepsAlias {
  return {
    resolveBinding: async () => ({ kind: "unbound" }),
    resolveDefaultAccount: async () => ({ kind: "resolved", account: ACCOUNT_A }),
    send: async () => ({ ok: true, providerMessageId: "wamid.x", status: "sent" }),
    ...over,
  };
}

function seedConversation(over: Record<string, unknown>): void {
  fake.rows("conversations").push({
    id: 1,
    channel: "whatsapp",
    channelAccountId: null,
    whatsappId: null,
    externalUserId: "+15550001234",
    externalUserIdNormalized: "15550001234",
    customerPhone: "+15550001234",
    externalThreadId: null,
    status: "active",
    ...over,
  });
}

function seedGlobalConfig(over: Record<string, unknown> = {}): void {
  if (!fake.rows("agent_config").some((row) => row.id === 1)) {
    fake.rows("agent_config").push({
      id: 1,
      channel: null,
      channelAccountId: null,
      waTemplateFallback: null,
    });
  }
  if (Object.keys(over).length > 0) {
    Object.assign(
      fake.rows("agent_config").find((row) => row.id === 1)!,
      over
    );
  }
}

describe("sendOrderStatusNotification", () => {
  it("sends through the conversation's bound account", async () => {
    seedConversation({ id: 7, channelAccountId: 2 });
    const seen: { account?: ChannelAccount }[] = [];
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: ACCOUNT_B,
          conversationId: 7,
        }),
        send: async (_msg, opts) => {
          seen.push({ account: opts.account });
          return { ok: true, providerMessageId: "wamid.b", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.providerMessageId, "wamid.b");
      assert.equal(res.conversationId, 7);
      assert.equal(res.channelAccountId, 2);
    }
    assert.equal(seen[0].account?.id, "2");
  });

  it("routes replies for account A and account B to their own senders", async () => {
    const sentTo: string[] = [];
    const send = async (
      _msg: OutboundMessage,
      opts: { channel?: "whatsapp"; account?: ChannelAccount }
    ): Promise<SendResult> => {
      sentTo.push(opts.account?.id ?? "none");
      return { ok: true, providerMessageId: "wamid.x", status: "sent" };
    };
    const depsFor = (account: ChannelAccount): DepsAlias =>
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account,
          conversationId: account.id === "1" ? 101 : 202,
        }),
        send,
      });

    await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "A" },
      depsFor(ACCOUNT_A)
    );
    await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "B" },
      depsFor(ACCOUNT_B)
    );
    assert.deepEqual(sentTo, ["1", "2"]);
  });

  it("uses the single active account only when the conversation is unbound", async () => {
    const seen: { account?: ChannelAccount }[] = [];
    const res = await sendOrderStatusNotification(
      { phoneNumber: "+15550001234", message: "listo" },
      deps({
        send: async (_msg, opts) => {
          seen.push({ account: opts.account });
          return { ok: true, providerMessageId: "wamid.a", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.channelAccountId, 1);
    assert.equal(seen[0].account?.id, "1");
  });

  it("fails closed on ambiguous accounts instead of sending globally", async () => {
    let sent = false;
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({ kind: "ambiguous", accountIds: [1, 2] }),
        send: async () => {
          sent = true;
          return { ok: true, providerMessageId: "x", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, false);
    assert.equal(sent, false);
    if (!res.ok) assert.match(res.error, /multiple accounts/);
  });

  it("fails closed when the bound account belongs to another channel", async () => {
    let sent = false;
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: { ...ACCOUNT_A, id: "55", channel: "telegram" },
          conversationId: 55,
        }),
        send: async () => {
          sent = true;
          return { ok: true, providerMessageId: "x", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, false);
    assert.equal(sent, false);
    if (!res.ok) {
      assert.equal(res.error, "account_provider_mismatch");
      assert.equal(res.retryable, false);
    }
  });

  it("surfaces bound-account and send failures to the caller", async () => {
    const unresolvable = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({
          kind: "unresolvable",
          accountId: 9,
          reason: "missing/inactive",
        }),
      })
    );
    assert.equal(unresolvable.ok, false);

    const failed: SendResult = { ok: false, error: "502 upstream", retryable: true };
    const sendFailure = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({ send: async () => failed })
    );
    assert.deepEqual(sendFailure, {
      ok: false,
      error: "502 upstream",
      retryable: true,
    });
  });

  it("surfaces a transient binding failure as retryable", async () => {
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo" },
      deps({
        resolveBinding: async () => ({
          kind: "error",
          error: new Error("db down"),
          retryable: true,
        }),
      })
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.retryable, true);
  });

  it("rejects non-phone destinations instead of sending", async () => {
    const res = await sendOrderStatusNotification(
      { phoneNumber: "sin-telefono-x", message: "listo" },
      deps()
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error, "invalid_phone");
  });
});

describe("sendOrderStatusNotification — idempotency + window + persistence (S5)", () => {
  it("uses a deterministic order-status idempotency key", async () => {
    const keys: (string | undefined)[] = [];
    await sendOrderStatusNotification(
      { phoneNumber: "15550009999", message: "listo", orderId: 42, status: "ready" },
      deps({
        send: async (msg) => {
          keys.push(msg.idempotencyKey);
          return { ok: true, providerMessageId: "wamid.k", status: "sent" };
        },
      })
    );
    assert.equal(keys[0], "order-status:42:ready");
  });

  it("sends free-form text inside the 24h customer window", async () => {
    seedConversation({ id: 900, channelAccountId: 1 });
    fake.rows("chat_messages").push({
      id: 900,
      conversationId: 900,
      role: "user",
      direction: "inbound",
      senderKind: "customer",
      content: "hola",
      createdAt: new Date(),
    });
    const seen: OutboundMessage[] = [];
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo", orderId: 43, status: "ready" },
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: ACCOUNT_A,
          conversationId: 900,
        }),
        send: async (msg) => {
          seen.push(msg);
          return { ok: true, providerMessageId: "wamid.in", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, true);
    assert.equal(seen[0].type, "text");
  });

  it("sends the configured template outside the 24h window", async () => {
    seedConversation({ id: 901, channelAccountId: 77 });
    fake.rows("chat_messages").push({
      id: 901,
      conversationId: 901,
      role: "user",
      direction: "inbound",
      senderKind: "customer",
      content: "viejo",
      createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });
    fake.rows("agent_config").push({
      id: 50,
      channel: null,
      channelAccountId: 77,
      waTemplateFallback: { name: "estado_pedido", language: "es_AR" },
    });
    const seen: OutboundMessage[] = [];
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo", orderId: 44, status: "ready" },
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: { ...ACCOUNT_A, id: "77" },
          conversationId: 901,
        }),
        send: async (msg) => {
          seen.push(msg);
          return { ok: true, providerMessageId: "wamid.t", status: "sent" };
        },
      })
    );
    assert.equal(res.ok, true);
    assert.equal(seen[0].type, "template");
    assert.deepEqual(seen[0].template, {
      name: "estado_pedido",
      language: "es_AR",
    });
    const persisted = fake
      .rows("chat_messages")
      .find((row) => row.conversationId === 901 && row.role === "system");
    assert.equal(persisted?.senderKind, "agent");
    assert.equal(persisted?.senderRef, "order-status-notify");
    assert.equal(persisted?.deliveryState, "sent");
    assert.match(String(persisted?.content), /\[template:estado_pedido\]/);
  });

  it("persists an agent-stamped outbound fact for sent and failed sends", async () => {
    seedConversation({ id: 902, channelAccountId: 1 });
    const before = fake.rows("chat_messages").length;
    const res = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo", orderId: 45, status: "ready" },
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: ACCOUNT_A,
          conversationId: 902,
        }),
        send: async () => ({
          ok: true,
          providerMessageId: "wamid.persist-45",
          status: "sent",
        }),
      })
    );
    assert.equal(res.ok, true);
    const rows = fake
      .rows("chat_messages")
      .filter((row) => row.conversationId === 902);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].role, "system");
    assert.equal(rows[0].direction, "outbound");
    assert.equal(rows[0].senderKind, "agent");
    assert.equal(rows[0].senderRef, "order-status-notify");
    assert.equal(rows[0].deliveryState, "sent");
    assert.equal(fake.rows("chat_messages").length, before + 1);

    const failed = await sendOrderStatusNotification(
      { phoneNumber: "15550001234", message: "listo", orderId: 46, status: "cancelled" },
      deps({
        resolveBinding: async () => ({
          kind: "resolved",
          account: ACCOUNT_A,
          conversationId: 902,
        }),
        send: async () => ({ ok: false, error: "down", retryable: false }),
      })
    );
    assert.equal(failed.ok, false);
    const failedRow = fake
      .rows("chat_messages")
      .filter((row) => row.conversationId === 902 && row.deliveryState === "failed");
    assert.equal(failedRow.length, 1);
    assert.equal(failedRow[0].senderKind, "agent");
  });
});

describe("resolveOrderNotificationPhone", () => {
  it("resolves lead identity → lead phone → order phone, newest first", async () => {
    fake.seed(leads, [
      { id: 10, phone: "+5491111111111" },
      { id: 11, phone: null },
    ]);
    // A BSUID identity is never digit-stripped into a destination; the
    // newest PHONE-shaped identity wins. FakeDb does not sort, so seed order
    // puts the phone-shaped row first like the real ORDER BY would.
    fake.seed(leadIdentities, [
      {
        id: 2,
        leadId: 10,
        channel: "whatsapp",
        externalId: "+5492222222222",
        createdAt: new Date("2024-06-01"),
      },
      {
        id: 1,
        leadId: 10,
        channel: "whatsapp",
        externalId: "bsuid-2",
        createdAt: new Date("2024-01-01"),
      },
    ]);
    const phone = await resolveOrderNotificationPhone({
      id: 1,
      leadId: 10,
      phoneNumber: "+5493333333333",
    });
    assert.equal(phone, "5492222222222");

    // Lead without usable identities → leads.phone.
    fake.seed(leadIdentities, []);
    assert.equal(
      await resolveOrderNotificationPhone({
        id: 2,
        leadId: 10,
        phoneNumber: "+5493333333333",
      }),
      "5491111111111"
    );

    // No lead → the order's own phone column.
    assert.equal(
      await resolveOrderNotificationPhone({
        id: 3,
        leadId: null,
        phoneNumber: "+5494444444444",
      }),
      "+5494444444444"
    );
  });
});

seedGlobalConfig();

// Keep the hook alive for the whole file; node runs this process per file.
process.on("exit", () => {
  restoreDb();
});
