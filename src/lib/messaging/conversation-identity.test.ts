import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertConversationAccount,
  canonicalExternalUserId,
  ConversationIdentityError,
  resolveConversationIdentity,
  type ConversationIdentityInsert,
  type ConversationIdentityRecord,
  type ConversationIdentityRepository,
  type IdentityInsertResult,
} from "./conversation-identity";

interface StoredRow {
  record: ConversationIdentityRecord;
  identity: string;
}

/** Deterministic in-memory repository — no DATABASE_URL, no network. */
class MemoryIdentityRepository implements ConversationIdentityRepository {
  private readonly rows = new Map<string, StoredRow>();
  readonly inserts: ConversationIdentityInsert[] = [];
  private nextId = 1;
  private readonly insertDelay: boolean;

  constructor(seed: StoredRow[] = [], insertDelay = false) {
    for (const row of seed) {
      this.rows.set(
        keyOf(row.record.channel, row.record.channelAccountId, row.identity),
        row
      );
    }
    this.nextId = Math.max(0, ...seed.map((r) => r.record.id)) + 1;
    this.insertDelay = insertDelay;
  }

  async find(
    channel: ConversationIdentityRecord["channel"],
    channelAccountId: number | null,
    normalizedExternalUserId: string
  ): Promise<ConversationIdentityRecord | null> {
    const exact = this.rows.get(
      keyOf(channel, channelAccountId, normalizedExternalUserId)
    );
    return exact?.record ?? null;
  }

  async insert(input: ConversationIdentityInsert): Promise<IdentityInsertResult> {
    this.inserts.push(input);
    if (this.insertDelay) await new Promise((resolve) => setTimeout(resolve, 0));
    const key = keyOf(
      input.channel,
      input.channelAccountId,
      input.externalUserIdNormalized
    );
    if (this.rows.has(key)) return { kind: "conflict" };
    const record: ConversationIdentityRecord = {
      id: this.nextId++,
      channel: input.channel,
      channelAccountId: input.channelAccountId,
    };
    this.rows.set(key, { record, identity: input.externalUserIdNormalized });
    return { kind: "inserted", record };
  }
}

function seed(
  id: number,
  channel: ConversationIdentityRecord["channel"],
  channelAccountId: number | null,
  identity: string
): StoredRow {
  return { record: { id, channel, channelAccountId }, identity };
}

function keyOf(
  channel: string,
  accountId: number | null,
  identity: string
): string {
  return `${channel}|${accountId ?? "legacy"}|${identity}`;
}

describe("canonicalExternalUserId", () => {
  it("normalizes +/digits for phone-shaped channels", () => {
    assert.equal(canonicalExternalUserId("whatsapp", "+1 (555) 000-9999"), "15550009999");
    assert.equal(canonicalExternalUserId("whatsapp", "15550009999"), "15550009999");
    assert.equal(canonicalExternalUserId("sms", "+54 9 3704 868421"), "5493704868421");
    assert.equal(canonicalExternalUserId("telegram", " 12345678 "), "12345678");
  });

  it("keeps non-phone social identifiers verbatim", () => {
    assert.equal(canonicalExternalUserId("instagram", "@Some.Handle "), "@Some.Handle");
    assert.equal(canonicalExternalUserId("facebook", "page-123"), "page-123");
    assert.equal(canonicalExternalUserId("telegram", "@handle"), "@handle");
  });
});

describe("resolveConversationIdentity — two-account separation", () => {
  it("creates separate conversations for the same customer on two accounts", async () => {
    const repo = new MemoryIdentityRepository();
    const a = await resolveConversationIdentity(repo, {
      channel: "whatsapp",
      externalUserId: "+15550001234",
      channelAccountId: 1,
    });
    const b = await resolveConversationIdentity(repo, {
      channel: "whatsapp",
      externalUserId: "+15550001234",
      channelAccountId: 2,
    });

    assert.equal(a.isNew, true);
    assert.equal(b.isNew, true);
    assert.notEqual(a.record.id, b.record.id);
    assert.equal(a.record.channelAccountId, 1);
    assert.equal(b.record.channelAccountId, 2);
    assert.equal(repo.inserts.length, 2);
  });

  it("reuses the same row for the same account regardless of +/digits form", async () => {
    const repo = new MemoryIdentityRepository();
    const first = await resolveConversationIdentity(repo, {
      channel: "whatsapp",
      externalUserId: "+15550001234",
      channelAccountId: 1,
    });
    const second = await resolveConversationIdentity(repo, {
      channel: "whatsapp",
      externalUserId: "15550001234",
      channelAccountId: 1,
    });
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.isNew, false);
  });
});

describe("resolveConversationIdentity — legacy null-account rows", () => {
  it("never adopts or rebinds a legacy row for a provisioned account", async () => {
    const legacy = seed(10, "whatsapp", null, "15550001234");
    const repo = new MemoryIdentityRepository([legacy]);

    const scoped = await resolveConversationIdentity(repo, {
      channel: "whatsapp",
      externalUserId: "+15550001234",
      channelAccountId: 5,
    });

    assert.equal(scoped.isNew, true);
    assert.notEqual(scoped.record.id, 10);
    assert.equal(scoped.record.channelAccountId, 5);
    // The legacy row is untouched.
    const legacyStillThere = await repo.find("whatsapp", null, "15550001234");
    assert.equal(legacyStillThere?.id, 10);
    assert.equal(legacyStillThere?.channelAccountId, null);
  });

  it("keeps legacy dedup for null-account callers", async () => {
    const legacy = seed(10, "whatsapp", null, "15550001234");
    const repo = new MemoryIdentityRepository([legacy]);
    const resolved = await resolveConversationIdentity(repo, {
      channel: "whatsapp",
      externalUserId: "15550001234",
      channelAccountId: null,
    });
    assert.equal(resolved.record.id, 10);
    assert.equal(resolved.isNew, false);
  });

  it("assertConversationAccount fails closed on a present mismatch", () => {
    assert.throws(
      () => assertConversationAccount({ id: 1, channel: "whatsapp", channelAccountId: 1 }, 2),
      /belongs to account 1, not 2/
    );
    assert.throws(
      () => assertConversationAccount({ id: 1, channel: "whatsapp", channelAccountId: 1 }, null),
      ConversationIdentityError
    );
    assert.doesNotThrow(() =>
      assertConversationAccount({ id: 1, channel: "whatsapp", channelAccountId: 1 }, 1)
    );
  });
});

describe("resolveConversationIdentity — concurrent creates", () => {
  it("converges concurrent create races onto one row per account", async () => {
    const repo = new MemoryIdentityRepository([], true);

    const [first, second] = await Promise.all([
      resolveConversationIdentity(repo, {
        channel: "whatsapp",
        externalUserId: "+15550007777",
        channelAccountId: 3,
      }),
      resolveConversationIdentity(repo, {
        channel: "whatsapp",
        externalUserId: "15550007777",
        channelAccountId: 3,
      }),
    ]);

    assert.equal(first.record.id, second.record.id);
    assert.equal([first.isNew, second.isNew].filter(Boolean).length, 1);
    assert.equal(
      repo.inserts.filter((i) => i.channelAccountId === 3).length,
      2,
      "both requests attempt an insert; the unique index resolves the loser"
    );
    const stored = await repo.find("whatsapp", 3, "15550007777");
    assert.equal(stored?.id, first.record.id);
  });

  it("concurrent different-account creates never share a row", async () => {
    const repo = new MemoryIdentityRepository([], true);
    const [a, b] = await Promise.all([
      resolveConversationIdentity(repo, {
        channel: "whatsapp",
        externalUserId: "15550008888",
        channelAccountId: 1,
      }),
      resolveConversationIdentity(repo, {
        channel: "whatsapp",
        externalUserId: "15550008888",
        channelAccountId: 2,
      }),
    ]);
    assert.notEqual(a.record.id, b.record.id);
    assert.equal(a.record.channelAccountId, 1);
    assert.equal(b.record.channelAccountId, 2);
  });
});
