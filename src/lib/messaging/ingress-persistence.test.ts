/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * A-49 — delivery-marker claim ordering for passive ingress.
 *
 * The channel_events unique insert is the delivery claim and it happens
 * BEFORE any conversation/message write: concurrent same-deliveryId events
 * can no longer both pass a read→insert→mark check and persist an id-less
 * delivery twice. A failed persistence releases the claim so the provider's
 * redelivery can retry instead of being permanently skipped.
 *
 * Synthetic ids only — no real phones, no DATABASE_URL, no network.
 */

import assert from "node:assert/strict";
import { getTableName } from "drizzle-orm";
import { describe, it } from "node:test";

import { FakeDb } from "./test-support/fake-db";

const fake = new FakeDb();
let poisonChatMessagesInsert = false;

// Same shape as installFakeDb, plus a poison switch on chat_messages inserts
// to simulate a transient write failure after the delivery claim lands.
const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const prevLoad = Module._load;
Module._load = function (request, parent, isMain): unknown {
  if (request === "@/db") {
    return {
      db: {
        select: () => fake.select(),
        insert: (table: unknown) => {
          const builder = fake.insertInto(table);
          if (
            poisonChatMessagesInsert &&
            getTableName(table as never) === "chat_messages"
          ) {
            poisonChatMessagesInsert = false;
            builder.returning = () => {
              throw Object.assign(new Error("connection terminated"), {
                code: "08006",
              });
            };
          }
          return builder;
        },
        update: (table: unknown) => fake.updateTable(table),
        delete: (table: unknown) => fake.deleteFrom(table),
      },
      getDb: () => fake,
    };
  }
  return prevLoad.call(this, request, parent, isMain);
};

const {
  handlePassiveChannelEvent,
  releaseChannelDeliveryMarker,
} = require("./ingress") as typeof import("./ingress");
import type { IngressContext } from "./ingress";
import type { NormalizedInboundEvent } from "./types";

const ACCOUNT = {
  id: "7",
  tenantId: "default",
  provider: "kapso" as const,
  channel: "whatsapp" as const,
  providerAccountId: "waba-7",
  senderAddress: "+15550000007",
  credentials: { apiKey: "k", webhookSecret: "" },
  status: "active" as const,
};

function ctx(channelAccountId?: number): IngressContext {
  return { channel: "whatsapp", account: ACCOUNT, channelAccountId };
}

function makeEvent(
  overrides: Partial<NormalizedInboundEvent> = {}
): NormalizedInboundEvent {
  return {
    provider: "kapso",
    deliveryId: "evt-claim-1",
    kind: "message.received",
    direction: "inbound",
    providerAccountId: "waba-7",
    type: "text",
    text: "hola",
    sender: { phone: "+15551234567" },
    timestamp: "2026-01-01T00:00:00.000Z",
    raw: {},
    ...overrides,
  };
}

const chatRows = () => fake.rows("chat_messages");
const markerRows = () =>
  fake
    .rows("channel_events")
    .filter((row) => row.kind === "message.received");

describe("A-49 — the delivery marker is claimed before persisting", () => {
  it("claims the marker and persists the message once for an id-less redelivery", async () => {
    const first = await handlePassiveChannelEvent(makeEvent(), ctx(7));
    assert.equal(first.status, 200);
    assert.equal(chatRows().length, 1);
    assert.equal(markerRows().length, 1);

    // Same deliveryId, still no platformMessageId — the OLD read→insert→mark
    // window let a concurrent twin persist a second row; the claim can't.
    const second = await handlePassiveChannelEvent(makeEvent(), ctx(7));
    assert.equal(second.status, 200);
    assert.equal(chatRows().length, 1);
    assert.equal(markerRows().length, 1);
  });

  it("a pre-claimed marker alone suppresses the event", async () => {
    fake.rows("channel_events").push({
      id: 1,
      tenantId: "default",
      provider: "kapso",
      channel: "whatsapp",
      channelAccountId: 7,
      deliveryId: "evt-claimed-early",
      platformMessageId: null,
      kind: "message.received",
      direction: "inbound",
      createdAt: new Date(),
    });
    const res = await handlePassiveChannelEvent(
      makeEvent({ deliveryId: "evt-claimed-early" }),
      ctx(7)
    );
    assert.equal(res.status, 200);
    assert.equal(chatRows().length, 1, "no second message row may persist");
  });

  it("the claim is account-scoped — another account's delivery still persists", async () => {
    const res = await handlePassiveChannelEvent(
      makeEvent({ deliveryId: "evt-claimed-early" }),
      ctx(8)
    );
    assert.equal(res.status, 200);
    assert.equal(chatRows().length, 2);
  });

  it("a failed persistence releases the claim so a redelivery can retry", async () => {
    poisonChatMessagesInsert = true;
    const failed = await handlePassiveChannelEvent(
      makeEvent({ deliveryId: "evt-flaky-1" }),
      ctx(7)
    );
    assert.equal(failed.status, 503, "transient failure must surface as retryable");

    // The claim was released — no marker may survive a failed delivery.
    assert.equal(
      markerRows().filter((row) => row.deliveryId === "evt-flaky-1").length,
      0
    );

    const retried = await handlePassiveChannelEvent(
      makeEvent({ deliveryId: "evt-flaky-1" }),
      ctx(7)
    );
    assert.equal(retried.status, 200);
    assert.equal(
      chatRows().length,
      3,
      "the retried delivery persists exactly once"
    );
    assert.equal(
      markerRows().filter((row) => row.deliveryId === "evt-flaky-1").length,
      1
    );
  });

  it("releaseChannelDeliveryMarker removes only its own account partition", async () => {
    fake.rows("channel_events").push(
      {
        id: 2,
        tenantId: "default",
        provider: "kapso",
        channel: "whatsapp",
        channelAccountId: 7,
        deliveryId: "evt-release-1",
        kind: "message.received",
        direction: "inbound",
        createdAt: new Date(),
      },
      {
        id: 3,
        tenantId: "default",
        provider: "kapso",
        channel: "whatsapp",
        channelAccountId: 8,
        deliveryId: "evt-release-1",
        kind: "message.received",
        direction: "inbound",
        createdAt: new Date(),
      }
    );
    await releaseChannelDeliveryMarker("kapso", "evt-release-1", 7);
    const survivors = fake
      .rows("channel_events")
      .filter((row) => row.deliveryId === "evt-release-1");
    assert.equal(survivors.length, 1);
    assert.equal(survivors[0].channelAccountId, 8);
  });
});

process.on("exit", () => {
  Module._load = prevLoad;
});
