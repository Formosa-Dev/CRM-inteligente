import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { describe, mock } from "node:test";
import { messenger } from "./messenger";
import type { ChannelAccount } from "./types";

// Synthetic values only — no real phones/keys.

describe("messenger.send — channel resolution", () => {
  test("whatsapp resolves to the ycloud adapter", async () => {
    // Validation failure proves we reached ycloudProvider.sendMessage —
    // an unresolved channel would return the registry error instead.
    const res = await messenger.send({ to: "+15550001234", type: "text" });
    assert.deepEqual(res, {
      ok: false,
      error: "text message requires msg.text",
      retryable: false,
    });
  });

  test("unregistered channels fail closed without calling a provider", async () => {
    for (const channel of [
      "telegram",
      "instagram",
      "sms",
      "reddit",
      "linkedin",
      "tiktok",
      "youtube",
      "threads",
      "pinterest",
      "discord",
      "slack",
    ] as const) {
      const res = await messenger.send(
        { to: "+15550001234", type: "text", text: "hola" },
        { channel },
      );
      assert.deepEqual(res, {
        ok: false,
        error: `no messaging provider registered for channel '${channel}'`,
        retryable: false,
      });
    }
  });
});

describe("messenger.send — caller-resolved credentials (folded ycloud-client)", () => {
  test("posts the exact legacy wire shape with the caller's apiKey/from", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "wamid.TEST1", status: "sent" }));
    });
    try {
      const res = await messenger.send(
        { to: "+15550001234", type: "text", text: "tu pedido llegó" },
        { credentials: { apiKey: "test-key", senderAddress: "+15550009999" } },
      );
      assert.deepEqual(res, {
        ok: true,
        providerMessageId: "wamid.TEST1",
        status: "sent",
      });
    } finally {
      mock.restoreAll();
    }

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.ycloud.com/v2/whatsapp/messages/sendDirectly",
    );
    assert.deepEqual(calls[0].init?.headers, {
      "Content-Type": "application/json",
      "X-API-Key": "test-key",
    });
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      from: "+15550009999",
      to: "+15550001234",
      type: "text",
      text: { body: "tu pedido llegó" },
    });
  });

  test("non-OK upstream responses map to a failure SendResult (callers throw)", async () => {
    mock.method(globalThis, "fetch", async () => new Response("boom", { status: 502 }));
    try {
      const res = await messenger.send(
        { to: "+15550001234", type: "text", text: "hola" },
        { credentials: { apiKey: "test-key", senderAddress: "+15550009999" } },
      );
      assert.equal(res.ok, false);
      if (!res.ok) {
        assert.match(res.error, /502/);
        assert.equal(res.retryable, true);
      }
    } finally {
      mock.restoreAll();
    }
  });
});

describe("messenger.send — account-bound sends (S15)", () => {
  const ACCOUNT: ChannelAccount = {
    id: "7",
    tenantId: "default",
    provider: "ycloud",
    channel: "whatsapp",
    providerAccountId: "15550009999",
    senderAddress: "+15550009999",
    credentials: { apiKey: "account-key", webhookSecret: "" },
    status: "active",
  };

  test("sends through the account's own provider with the account's credentials", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "wamid.ACCT1", status: "sent" }));
    });
    try {
      const res = await messenger.send(
        { to: "+15550001234", type: "text", text: "respuesta" },
        { channel: "whatsapp", account: ACCOUNT },
      );
      assert.deepEqual(res, {
        ok: true,
        providerMessageId: "wamid.ACCT1",
        status: "sent",
      });
    } finally {
      mock.restoreAll();
    }
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].init?.headers, {
      "Content-Type": "application/json",
      "X-API-Key": "account-key",
    });
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      from: "+15550009999",
      to: "+15550001234",
      type: "text",
      text: { body: "respuesta" },
    });
  });

  for (const type of ["image", "document"] as const) {
    test(`${type} sends use the account's apiKey and sender (A/B isolation)`, async () => {
      const calls: { init?: RequestInit }[] = [];
      mock.method(globalThis, "fetch", async (_url: string, init?: RequestInit) => {
        calls.push({ init });
        return new Response(JSON.stringify({ id: `wamid.${type}`, status: "sent" }));
      });
      try {
        const accountB: ChannelAccount = {
          ...ACCOUNT,
          id: "8",
          providerAccountId: "15550008888",
          senderAddress: "+15550008888",
          credentials: { apiKey: "account-b-key", webhookSecret: "" },
        };
        await messenger.send(
          { to: "+15550001234", type, mediaUrl: "https://cdn.test/x", text: "hola" },
          { channel: "whatsapp", account: ACCOUNT }
        );
        await messenger.send(
          { to: "+15550001234", type, mediaUrl: "https://cdn.test/x", text: "hola" },
          { channel: "whatsapp", account: accountB }
        );
      } finally {
        mock.restoreAll();
      }

      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].init?.headers, {
        "Content-Type": "application/json",
        "X-API-Key": "account-key",
      });
      assert.deepEqual(calls[1].init?.headers, {
        "Content-Type": "application/json",
        "X-API-Key": "account-b-key",
      });
      const first = JSON.parse(String(calls[0].init?.body));
      const second = JSON.parse(String(calls[1].init?.body));
      assert.equal(first.from, "+15550009999");
      assert.equal(second.from, "+15550008888");
      assert.equal(first.type, type);
      assert.equal(second.type, type);
    });
  }

  test("an account whose provider is not registered fails closed — no channel fallback", async () => {
    let fetched = false;
    mock.method(globalThis, "fetch", async () => {
      fetched = true;
      return new Response("{}");
    });
    try {
      // All shipped providers are registered now — a stale channel_accounts
      // row can still name one this build doesn't know (rollback, drift).
      const provider = "ghost" as ChannelAccount["provider"];
      const res = await messenger.send(
        { to: "+15550001234", type: "text", text: "hola" },
        {
          channel: "whatsapp",
          account: { ...ACCOUNT, provider },
        },
      );
      assert.deepEqual(res, {
        ok: false,
        error: "no messaging provider registered for provider 'ghost'",
        retryable: false,
      });
      assert.equal(fetched, false);
    } finally {
      mock.restoreAll();
    }
  });

  test("account channel is used when no explicit channel is passed", async () => {
    // instagram has no channel-default route — the send only dispatches
    // because the bound account names its own provider. It must land on
    // zernio's create-conversation endpoint, not the ycloud default.
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ data: { messageId: "zm1", conversationId: "zc1" } }),
      );
    });
    try {
      const res = await messenger.send(
        { to: "@handle", type: "text", text: "hola" },
        { account: { ...ACCOUNT, channel: "instagram", provider: "zernio" } },
      );
      assert.deepEqual(res, {
        ok: true,
        providerMessageId: "zm1",
        status: "sent",
      });
    } finally {
      mock.restoreAll();
    }
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://zernio.com/api/v1/inbox/conversations",
    );
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      accountId: "15550009999",
      participantId: "@handle",
      message: "hola",
    });
  });
});

describe("messenger.send — template dispatch", () => {
  test("prefers provider.sendTemplate when the adapter implements it", async () => {
    // ycloud has no sendTemplate yet — the facade falls through to
    // sendMessage, which rejects 'template' until an adapter adds support.
    const res = await messenger.sendTemplate({
      to: "+15550001234",
      type: "text",
      template: { name: "hello", language: "es" },
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.error, /'template'/);
  });
});

describe("send facade — migrated call sites (C10)", () => {
  // Every file that used to hit YCloud directly now goes through
  // messenger.send(); the folded client file no longer exists.
  const MIGRATED = [
    "src/lib/whatsapp/broadcast.ts",
    "src/app/api/cron/followup/route.ts",
    "src/lib/telegram/toolsWhatsApp.ts",
    "src/lib/telegram/toolsManagement.ts",
    "src/lib/whatsapp/tools/create-order.ts",
    "src/lib/channels/router.ts",
    "src/lib/buffer/response-sender.ts",
    "src/lib/messaging/inbound-pipeline.ts",
    "src/app/(admin)/admin/orders/actions.ts",
    "src/app/(admin)/admin/dashboard-actions-server.ts",
  ];

  for (const file of MIGRATED) {
    test(`${file} sends via the facade`, () => {
      const src = readFileSync(file, "utf8");
      assert.match(src, /messenger\.send\(/, `${file} must call messenger.send`);
      assert.doesNotMatch(src, /@\/lib\/whatsapp\/ycloud-client/);
      assert.doesNotMatch(src, /@\/lib\/ycloud/);
      assert.doesNotMatch(src, /api\.ycloud\.com/);
      assert.doesNotMatch(src, /\bsendText\s*\(/);
      assert.doesNotMatch(src, /\bsendImage\s*\(/);
      assert.doesNotMatch(src, /\bsendDocument\s*\(/);
    });
  }

  test("the duplicate ycloud-client module is gone", () => {
    assert.throws(() =>
      readFileSync("src/lib/whatsapp/ycloud-client.ts", "utf8"),
    );
  });

  test("only the adapter keeps the provider senders", () => {
    const adapter = readFileSync("src/lib/messaging/providers/ycloud.ts", "utf8");
    assert.match(adapter, /@\/lib\/ycloud/);
    assert.match(adapter, /sendDirectly/);
  });
});
