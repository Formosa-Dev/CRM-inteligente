import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  channelEventKey,
  persistChannelEventWithRepo,
  toChannelEventInsert,
  type ChannelEventInsert,
  type ChannelEventRepository,
} from "./channel-events";
import type { NormalizedInboundEvent } from "./types";

class MemoryEventRepository implements ChannelEventRepository {
  private readonly keys = new Set<string>();
  readonly inserts: string[] = [];
  private readonly failure?: unknown;

  constructor(failure?: unknown) {
    this.failure = failure;
  }

  async insert(input: ChannelEventInsert): Promise<"inserted" | "duplicate"> {
    if (this.failure) throw this.failure;
    this.inserts.push(input.eventKey);
    if (this.keys.has(input.eventKey)) return "duplicate";
    this.keys.add(input.eventKey);
    return "inserted";
  }
}

function event(over: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    provider: "ycloud",
    deliveryId: "evt_status_1",
    kind: "message.status",
    direction: "outbound",
    providerAccountId: "waba-1",
    platformMessageId: "wamid.1",
    status: "delivered",
    sender: {},
    timestamp: "2026-01-01T00:00:00.000Z",
    raw: { type: "whatsapp.message.updated" },
    ...over,
  };
}

const CTX = { channel: "whatsapp" as const, channelAccountId: 4 };

describe("channel event key", () => {
  it("prefers the provider delivery id", () => {
    assert.equal(channelEventKey(event()), "ycloud:delivery:evt_status_1");
  });

  it("falls back to platform id + kind + status", () => {
    assert.equal(
      channelEventKey(event({ deliveryId: "", platformMessageId: "wamid.1" })),
      "ycloud:platform:wamid.1:message.status:delivered"
    );
  });
});

describe("channel event persistence", () => {
  it("stores the normalized event with account context", () => {
    const input = toChannelEventInsert(event(), CTX);
    assert.equal(input.provider, "ycloud");
    assert.equal(input.channel, "whatsapp");
    assert.equal(input.channelAccountId, 4);
    assert.equal(input.kind, "message.status");
    assert.equal(input.status, "delivered");
    assert.equal(input.platformMessageId, "wamid.1");
    assert.ok(input.eventTimestamp instanceof Date);
  });

  it("is idempotent on the provider delivery id", async () => {
    const repo = new MemoryEventRepository();
    const first = await persistChannelEventWithRepo(repo, event(), CTX);
    const second = await persistChannelEventWithRepo(repo, event(), CTX);
    assert.deepEqual(first, { kind: "persisted" });
    assert.deepEqual(second, { kind: "duplicate" });
    assert.equal(repo.inserts.length, 2);
  });

  it("distinguishes a missing schema from other DB failures", async () => {
    const pending = await persistChannelEventWithRepo(
      new MemoryEventRepository({ code: "42P01" }),
      event(),
      CTX
    );
    assert.equal(pending.kind, "schema-not-ready");

    await assert.rejects(() =>
      persistChannelEventWithRepo(
        new MemoryEventRepository(new Error("connection reset")),
        event(),
        CTX
      )
    );
  });

  it("keeps status transitions as distinct platform keys", () => {
    const delivered = channelEventKey(event({ status: "delivered" }));
    const read = channelEventKey(event({ status: "read", deliveryId: "" }));
    assert.notEqual(delivered, read);
  });
});

describe("channel_events migration", () => {
  it("is additive and idempotent on delivery/platform identifiers", () => {
    const sql = readFileSync("drizzle/0017_channel_events.sql", "utf8");
    assert.match(sql, /CREATE TABLE "channel_events"/);
    assert.match(sql, /channel_events_provider_delivery_uq/);
    assert.match(sql, /channel_events_provider_platform_uq/);
    assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM/i);
  });

  it("documents the schema in drizzle", () => {
    const schema = readFileSync("src/db/schema.ts", "utf8");
    assert.match(schema, /export const channelEvents = pgTable\("channel_events"/);
    assert.match(schema, /channel_events_provider_delivery_uq/);
  });
});
