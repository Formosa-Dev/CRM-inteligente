/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * Round-5 behavior tests over a mocked DB:
 * - HIGH: customer object authorization — the ambient agent scope carries the
 *   server-side normalized conversation customerPhone; every customer-facing
 *   order/lead tool uses it instead of model-supplied orderId/phone so one
 *   customer can never read or mutate another customer's objects, under a
 *   bound account scope AND under the legacy NULL scope. Scopes WITHOUT a
 *   customerPhone (internal/admin callers) keep the legacy arg behavior.
 * - MEDIUM: YCloud scoped credentials fail closed — a channel_accounts row
 *   whose `env:` ref resolves to nothing, or whose ref is unknown
 *   (`vault:`, typos), is a strict resolution mismatch; a real (numeric-id)
 *   account with an empty apiKey fails before any delegated global send.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

import { FakeDb, installFakeDb } from "./test-support/fake-db";

const fake = new FakeDb();
const restoreDb = installFakeDb(fake);

// @/lib/ycloud exports are non-configurable getters (esbuild __export), so
// mock.method can't touch them — intercept the specifier instead, exactly
// like security-round4 hooks @/lib/whatsapp/agent. Must be installed BEFORE
// the messenger → provider chain binds the module.
const sendTextCalls: unknown[][] = [];
const sendImageCalls: unknown[][] = [];
const sendDocumentCalls: unknown[][] = [];
const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const prevLoad = Module._load;
Module._load = function (request, parent, isMain): unknown {
  if (request === "@/lib/ycloud") {
    return {
      sendText: async (...args: unknown[]) => {
        sendTextCalls.push(args);
        return { ok: true, wamid: "wamid.legacy" };
      },
      sendImage: async (...args: unknown[]) => {
        sendImageCalls.push(args);
        return { ok: true };
      },
      sendDocument: async (...args: unknown[]) => {
        sendDocumentCalls.push(args);
        return { ok: true };
      },
    };
  }
  return prevLoad.call(this, request, parent, isMain);
};

const { runWithAgentConfigScope, resolveScopeForConversation } =
  require("@/lib/agent-config-scope") as typeof import("@/lib/agent-config-scope");
const {
  resolveChannelAccountByIdStrict,
} = require("@/lib/messaging/accounts") as typeof import("@/lib/messaging/accounts");
const { messenger } = require("@/lib/messaging") as typeof import("@/lib/messaging");
const {
  getOrderStatusTool,
  addToOrderTool,
  updateOrderTool,
  cancelOrderTool,
} = require("@/lib/whatsapp/tools/order-management-tools") as typeof import("@/lib/whatsapp/tools/order-management-tools");
const {
  suggestProductsTool,
  getClientHistoryTool,
} = require("@/lib/whatsapp/tools/client-tools") as typeof import("@/lib/whatsapp/tools/client-tools");
const { saveAddressTool } = require("@/lib/whatsapp/tools/kitchen-tools") as typeof import("@/lib/whatsapp/tools/kitchen-tools");

function execTool(t: { execute?: unknown }, input: unknown): Promise<string> {
  const run = t.execute as (
    input: unknown,
    options: unknown
  ) => Promise<unknown>;
  return run(input, { toolCallId: "r5", messages: [] }).then(String);
}

// ─── HIGH — customer binding ─────────────────────────────────────────────────

describe("HIGH — scope carries the server-side customer phone", () => {
  it("resolveScopeForConversation normalizes the conversation's customerPhone", async () => {
    fake.rows("conversations").push({
      id: 900,
      channel: "whatsapp",
      channelAccountId: 44,
      customerPhone: "+1 (555) 000-1234",
      status: "active",
    });
    const scope = await resolveScopeForConversation(900);
    assert.equal(scope.channel, "whatsapp");
    assert.equal(scope.channelAccountId, 44);
    assert.equal(scope.customerPhone, "15550001234");
  });
});

describe("HIGH — customer-facing tools are bound to the scoped customer", () => {
  // Customer A is the conversation's customer; B is a different customer on
  // the SAME account (the new cross-customer case) and on the legacy plane.
  const scopeBoundA = {
    channel: "whatsapp" as const,
    channelAccountId: 40,
    customerPhone: "15550600",
  };
  const scopeLegacyA = {
    channel: "whatsapp" as const,
    channelAccountId: null,
    customerPhone: "15550600",
  };

  fake.rows("leads").push(
    { id: 80, phone: "15550600", channelAccountId: 40, name: "ClienteA", status: "new" },
    { id: 81, phone: "15550700", channelAccountId: 40, name: "ClienteB", status: "new" },
    { id: 82, phone: "15550600", channelAccountId: null, name: "LegacyA", status: "new" },
    { id: 83, phone: "15550700", channelAccountId: null, name: "LegacyB", status: "new" }
  );
  fake.rows("orders").push(
    { id: 80, leadId: 80, phoneNumber: "15550600", status: "pending", items: [{ name: "Simple", quantity: 1 }], customerName: "A", createdAt: new Date() },
    { id: 81, leadId: 81, phoneNumber: "15550700", status: "pending", items: [{ name: "Doble", quantity: 1 }], customerName: "B", createdAt: new Date() },
    { id: 82, leadId: 82, phoneNumber: "15550600", status: "pending", items: [{ name: "Triple", quantity: 1 }], customerName: "LA", createdAt: new Date() },
    { id: 83, leadId: 83, phoneNumber: "15550700", status: "pending", items: [{ name: "Combo", quantity: 1 }], customerName: "LB", createdAt: new Date() }
  );

  it("getOrderStatus by orderId only sees the scoped customer's orders", async () => {
    // Same account, other customer — blocked.
    const foreignBound = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(getOrderStatusTool, { orderId: 81 })
    );
    assert.match(foreignBound, /No encontré ningún pedido/);

    const ownBound = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(getOrderStatusTool, { orderId: 80 })
    );
    assert.match(ownBound, /Pedido #80/);

    // Legacy NULL account, other customer — still blocked by the phone gate.
    const foreignLegacy = await runWithAgentConfigScope(scopeLegacyA, () =>
      execTool(getOrderStatusTool, { orderId: 83 })
    );
    assert.match(foreignLegacy, /No encontré ningún pedido/);

    const ownLegacy = await runWithAgentConfigScope(scopeLegacyA, () =>
      execTool(getOrderStatusTool, { orderId: 82 })
    );
    assert.match(ownLegacy, /Pedido #82/);
  });

  it("getOrderStatus by phone ignores the model arg when a customer is bound", async () => {
    const out = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(getOrderStatusTool, { customerPhone: "15550700" })
    );
    // Resolved as A's own last order — never B's.
    assert.match(out, /Pedido #8[02]/);
    assert.doesNotMatch(out, /Pedido #8[13]/);
  });

  it("updateOrder cannot mutate another customer's pending order", async () => {
    const blockedBound = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(updateOrderTool, { orderId: 81, notes: "robado" })
    );
    assert.match(blockedBound, /No encontré un pedido pendiente/);

    const blockedLegacy = await runWithAgentConfigScope(scopeLegacyA, () =>
      execTool(updateOrderTool, { orderId: 83, notes: "robado" })
    );
    assert.match(blockedLegacy, /No encontré un pedido pendiente/);
    assert.equal(
      fake.rows("orders").find((row) => row.id === 81)?.notes,
      undefined
    );
    assert.equal(
      fake.rows("orders").find((row) => row.id === 83)?.notes,
      undefined
    );
  });

  it("addToOrder cannot append to another customer's order", async () => {
    const blockedBound = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(addToOrderTool, {
        orderId: 81,
        newItems: [{ name: "X", quantity: 1, unitPrice: 10 }],
      })
    );
    assert.match(blockedBound, /No encontré ese pedido/);

    const blockedLegacy = await runWithAgentConfigScope(scopeLegacyA, () =>
      execTool(addToOrderTool, {
        orderId: 83,
        newItems: [{ name: "X", quantity: 1, unitPrice: 10 }],
      })
    );
    assert.match(blockedLegacy, /No encontré ese pedido/);
    const foreign = fake.rows("orders").find((row) => row.id === 81);
    assert.deepEqual(foreign?.items, [{ name: "Doble", quantity: 1 }]);
  });

  it("cancelOrder cannot cancel another customer's order; own still works", async () => {
    const blockedBound = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(cancelOrderTool, { orderId: 81, reason: "x" })
    );
    assert.match(blockedBound, /No encontré ese pedido/);

    const blockedLegacy = await runWithAgentConfigScope(scopeLegacyA, () =>
      execTool(cancelOrderTool, { orderId: 83, reason: "x" })
    );
    assert.match(blockedLegacy, /No encontré ese pedido/);
    assert.equal(
      fake.rows("orders").find((row) => row.id === 81)?.status,
      "pending"
    );
    assert.equal(
      fake.rows("orders").find((row) => row.id === 83)?.status,
      "pending"
    );

    const ownBound = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(cancelOrderTool, { orderId: 80, reason: "ya no" })
    );
    assert.match(ownBound, /cancelado/i);
    const ownLegacy = await runWithAgentConfigScope(scopeLegacyA, () =>
      execTool(cancelOrderTool, { orderId: 82, reason: "ya no" })
    );
    assert.match(ownLegacy, /cancelado/i);
    assert.equal(
      fake.rows("orders").find((row) => row.id === 80)?.status,
      "cancelled"
    );
    assert.equal(
      fake.rows("orders").find((row) => row.id === 82)?.status,
      "cancelled"
    );
  });

  it("getClientHistory resolves the scoped customer, never the model arg", async () => {
    const bound = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(getClientHistoryTool, { phone: "15550700" })
    );
    assert.match(bound, /ClienteA/);
    assert.doesNotMatch(bound, /ClienteB/);
    assert.doesNotMatch(bound, /15550700/);

    const legacy = await runWithAgentConfigScope(scopeLegacyA, () =>
      execTool(getClientHistoryTool, { phone: "15550700" })
    );
    assert.doesNotMatch(legacy, /ClienteB/);
    assert.doesNotMatch(legacy, /15550700/);
  });

  it("suggestProducts resolves the scoped customer, never the model arg", async () => {
    const bound = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(suggestProductsTool, { phone: "15550700" })
    );
    // A's account-40 history (order 80, item "Simple") drives the answer —
    // B's "Doble" can never surface for a foreign phone arg.
    assert.match(bound, /Simple/);
    assert.doesNotMatch(bound, /Doble/);
  });

  it("saveAddress writes under the scoped customer phone, never the model arg", async () => {
    const out = await runWithAgentConfigScope(scopeBoundA, () =>
      execTool(saveAddressTool, {
        phone: "15550700",
        address: "Av Siempre Viva 742",
      })
    );
    assert.match(out, /Dirección guardada/);
    const rows = fake.rows("addresses");
    assert.ok(
      rows.some(
        (row) => row.phone === "15550600" && row.address === "Av Siempre Viva 742"
      ),
      "address must be written under the scoped customer phone"
    );
    assert.ok(
      !rows.some((row) => row.phone === "15550700"),
      "no address may be written for a foreign phone"
    );
  });

  it("scope-less execution keeps the internal arg-driven semantics", async () => {
    // No ambient scope (internal/admin callers): model args still resolve —
    // the customer gate only binds when a conversation customer exists.
    const internal = await execTool(getOrderStatusTool, { orderId: 81 });
    assert.match(internal, /Pedido #81/);

    const history = await execTool(getClientHistoryTool, { phone: "15550700" });
    assert.match(history, /ClienteB/);
  });
});

// ─── MEDIUM — scoped credential fail-closed ──────────────────────────────────

describe("MEDIUM — env/unknown credentialsRef fail closed", () => {
  function seedAccount(
    id: number,
    credentialsRef: string
  ): void {
    fake.rows("channel_accounts").push({
      id,
      tenantId: "default",
      provider: "ycloud",
      channel: "whatsapp",
      providerAccountId: `waba-${id}`,
      senderAddress: `+155500${id}`,
      displayName: null,
      credentialsRef,
      agentConfigId: null,
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("an env ref whose vars are missing resolves to mismatch", async () => {
    // R5_NOPE_API_KEY / R5_NOPE_ACCESS_TOKEN are intentionally unset.
    seedAccount(90, "env:R5_NOPE*");
    const resolution = await resolveChannelAccountByIdStrict(90, "ycloud");
    assert.equal(resolution.kind, "mismatch");
    if (resolution.kind === "mismatch") {
      assert.match(resolution.reason, /no usable credential/);
      assert.match(resolution.reason, /empty credentials/);
    }
  });

  it("an unknown credentialsRef resolves to mismatch", async () => {
    seedAccount(91, "vault:whatever");
    const resolution = await resolveChannelAccountByIdStrict(91, "ycloud");
    assert.equal(resolution.kind, "mismatch");
    if (resolution.kind === "mismatch") {
      assert.match(resolution.reason, /unknown credentialsRef 'vault:whatever'/);
    }
  });

  it("an env ref with populated vars resolves scoped credentials", async () => {
    // The ref format concatenates raw: env:R5_OK_ → R5_OK_API_KEY.
    seedAccount(92, "env:R5_OK_");
    process.env.R5_OK_API_KEY = "scoped-env-key";
    try {
      const resolution = await resolveChannelAccountByIdStrict(92, "ycloud");
      assert.equal(resolution.kind, "resolved");
      if (resolution.kind === "resolved") {
        assert.equal(resolution.account.credentials.apiKey, "scoped-env-key");
      }
    } finally {
      delete process.env.R5_OK_API_KEY;
    }
  });
});

describe("MEDIUM — a real account never delegates to the global sender", () => {
  const fetches: { url: string; headers: Record<string, string> }[] = [];

  mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    fetches.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: true,
      json: async () => ({ id: "wamid.scoped", status: "sent" }),
      text: async () => "",
    } as Response;
  });

  const emptyAccount = {
    id: "93", // numeric — a real channel_accounts row shape
    tenantId: "default",
    provider: "ycloud" as const,
    channel: "whatsapp" as const,
    providerAccountId: "waba-93",
    senderAddress: "+15550093",
    credentials: { apiKey: "", webhookSecret: "" },
    status: "active" as const,
  };

  it("text/image/document sends fail before touching the global senders", async () => {
    const text = await messenger.send(
      { to: "+15550999", text: "hola", type: "text" },
      { account: emptyAccount }
    );
    const image = await messenger.send(
      { to: "+15550999", mediaUrl: "https://x/y.png", type: "image" },
      { account: emptyAccount }
    );
    const doc = await messenger.send(
      { to: "+15550999", mediaUrl: "https://x/y.pdf", type: "document" },
      { account: emptyAccount }
    );

    assert.equal(text.ok, false);
    assert.equal(image.ok, false);
    assert.equal(doc.ok, false);
    assert.equal(text.retryable, false);
    if (!text.ok) assert.match(text.error, /no scoped ycloud apiKey/);
    assert.equal(sendTextCalls.length, 0, "global sendText must not run");
    assert.equal(sendImageCalls.length, 0, "global sendImage must not run");
    assert.equal(sendDocumentCalls.length, 0, "global sendDocument must not run");
    assert.equal(fetches.length, 0, "no HTTP send may be attempted");
  });

  it("the legacy placeholder path still delegates to the global senders", async () => {
    const res = await messenger.send(
      { to: "+15550999", text: "hola", type: "text" },
      {} // no account, no credentials — the explicit legacy/unbound path
    );
    assert.equal(res.ok, true);
    assert.equal(sendTextCalls.length, 1, "placeholder keeps the legacy delegation");
  });

  it("a real account with a scoped key sends directly with that key", async () => {
    const sendBase = sendTextCalls.length;
    const fetchBase = fetches.length;
    const res = await messenger.send(
      { to: "+15550999", text: "hola", type: "text" },
      {
        account: {
          ...emptyAccount,
          credentials: { apiKey: "key-account-93", webhookSecret: "" },
        },
      }
    );
    assert.equal(res.ok, true);
    assert.equal(
      sendTextCalls.length,
      sendBase,
      "scoped account must not delegate to the global senders"
    );
    assert.equal(fetches.length, fetchBase + 1);
    assert.equal(
      fetches[fetches.length - 1].headers["X-API-Key"],
      "key-account-93"
    );
  });
});

// Keep the hooks alive for the whole file; node runs this process per file.
process.on("exit", () => {
  Module._load = prevLoad;
  restoreDb();
});
