/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * WhatsApp 24h customer-service window decisions (S5 / F-02 port):
 * - customer inbound is identified by S0 sender columns, falling back to
 *   legacy role='user' rows that pre-date the migration;
 * - inside 24h → free-form text; outside → configured fallback template;
 *   outside + no template → honest { text, windowOpen:false, no_template };
 * - wa_template_fallback resolves account → channel → global, defaulting to
 *   es_AR; a config read failure degrades to "not configured".
 *
 * Synthetic ids only — no DATABASE_URL, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "../messaging/test-support/fake-db";

const fake = new FakeDb();
const restoreDb = installFakeDb(fake);

const {
  decideCustomerWindowSend,
  isCustomerWindowOpen,
  lastCustomerInboundAt,
  resolveTemplateFallback,
  WHATSAPP_CUSTOMER_WINDOW_MS,
} = require("./outbound-window") as typeof import("./outbound-window");

function pushInbound(over: Record<string, unknown>): void {
  fake.rows("chat_messages").push({
    id: fake.rows("chat_messages").length + 1,
    conversationId: 1,
    role: "user",
    content: "inbound",
    createdAt: new Date(),
    ...over,
  });
}

// Scoped resolution chains account → channel → global — a row seeded for one
// test would leak into another test's fallback chain, so each template test
// starts from an empty agent_config.
function clearAgentConfig(): void {
  fake.rows("agent_config").length = 0;
}

describe("isCustomerWindowOpen", () => {
  it("is open within 24h of the last customer inbound", () => {
    const now = new Date();
    assert.equal(
      isCustomerWindowOpen(new Date(now.getTime() - 60 * 1000), now),
      true
    );
    assert.equal(
      isCustomerWindowOpen(
        new Date(now.getTime() - WHATSAPP_CUSTOMER_WINDOW_MS + 1000),
        now
      ),
      true
    );
  });

  it("is closed at/past the boundary and when no inbound exists", () => {
    const now = new Date();
    assert.equal(
      isCustomerWindowOpen(
        new Date(now.getTime() - WHATSAPP_CUSTOMER_WINDOW_MS),
        now
      ),
      false
    );
    assert.equal(isCustomerWindowOpen(null, now), false);
  });
});

describe("lastCustomerInboundAt", () => {
  it("finds S0-stamped customer inbounds", async () => {
    const at = new Date("2024-06-01T12:00:00Z");
    pushInbound({
      conversationId: 10,
      direction: "inbound",
      senderKind: "customer",
      createdAt: at,
    });
    assert.deepEqual(await lastCustomerInboundAt(10), at);
  });

  it("recognizes legacy role='user' rows with no sender columns", async () => {
    const at = new Date("2024-06-02T12:00:00Z");
    pushInbound({
      conversationId: 11,
      direction: null,
      senderKind: null,
      createdAt: at,
    });
    assert.deepEqual(await lastCustomerInboundAt(11), at);
  });

  it("ignores operator/agent/echo rows that are not customer inbounds", async () => {
    fake.rows("chat_messages").push(
      {
        id: 990,
        conversationId: 12,
        role: "assistant",
        direction: "outbound",
        senderKind: "operator",
        content: "reply",
        createdAt: new Date(),
      },
      {
        id: 991,
        conversationId: 12,
        role: "human",
        direction: "outbound",
        senderKind: "operator",
        content: "echo",
        createdAt: new Date(),
      }
    );
    assert.equal(await lastCustomerInboundAt(12), null);
  });
});

describe("resolveTemplateFallback", () => {
  it("parses a string name with the default es_AR language", async () => {
    clearAgentConfig();
    fake.rows("agent_config").push({
      id: 70,
      channel: "whatsapp",
      channelAccountId: null,
      waTemplateFallback: "order_update",
    });
    const tpl = await resolveTemplateFallback({ channel: "whatsapp" });
    assert.deepEqual(tpl, { name: "order_update", language: "es_AR" });
  });

  it("parses { name, language } and the account row wins the chain", async () => {
    clearAgentConfig();
    fake.rows("agent_config").push(
      {
        id: 71,
        channel: null,
        channelAccountId: 501,
        waTemplateFallback: { name: "cuenta_a", language: "es" },
      },
      {
        id: 72,
        channel: "whatsapp",
        channelAccountId: null,
        waTemplateFallback: "canal",
      },
      {
        id: 73,
        channel: null,
        channelAccountId: null,
        waTemplateFallback: "global",
      }
    );
    const tpl = await resolveTemplateFallback({
      channel: "whatsapp",
      channelAccountId: 501,
    });
    assert.deepEqual(tpl, { name: "cuenta_a", language: "es" });
  });

  it("returns null when nothing is configured", async () => {
    clearAgentConfig();
    assert.equal(
      await resolveTemplateFallback({
        channel: "whatsapp",
        channelAccountId: 502,
      }),
      null
    );
  });
});

describe("decideCustomerWindowSend", () => {
  it("sends text inside the window", async () => {
    pushInbound({
      conversationId: 20,
      direction: "inbound",
      senderKind: "customer",
      createdAt: new Date(),
    });
    const decision = await decideCustomerWindowSend(20);
    assert.deepEqual(decision, { kind: "text", windowOpen: true });
  });

  it("sends the configured template outside the window", async () => {
    clearAgentConfig();
    pushInbound({
      conversationId: 21,
      direction: "inbound",
      senderKind: "customer",
      createdAt: new Date(Date.now() - 30 * 60 * 60 * 1000),
    });
    fake.rows("agent_config").push({
      id: 74,
      channel: null,
      channelAccountId: 507,
      waTemplateFallback: { name: "reengagement" },
    });
    const decision = await decideCustomerWindowSend(21, {
      channelAccountId: 507,
    });
    assert.equal(decision.kind, "template");
    if (decision.kind === "template") {
      assert.deepEqual(decision.template, {
        name: "reengagement",
        language: "es_AR",
      });
      assert.ok(decision.lastInboundAt instanceof Date);
    }
  });

  it("reports no_template honestly when nothing is configured", async () => {
    clearAgentConfig();
    const decision = await decideCustomerWindowSend(22, {
      channelAccountId: 505,
    });
    assert.deepEqual(decision, {
      kind: "text",
      windowOpen: false,
      reason: "no_template",
    });
  });

  it("treats a conversation with no customer inbound as window-closed", async () => {
    clearAgentConfig();
    fake.rows("agent_config").push({
      id: 75,
      channel: null,
      channelAccountId: 506,
      waTemplateFallback: "hello_again",
    });
    const decision = await decideCustomerWindowSend(23, {
      channelAccountId: 506,
    });
    assert.equal(decision.kind, "template");
    if (decision.kind === "template") {
      assert.equal(decision.lastInboundAt, null);
    }
  });
});

// Keep the hook alive for the whole file; node runs this process per file.
process.on("exit", () => {
  restoreDb();
});
