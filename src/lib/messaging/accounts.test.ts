import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  rowMatchesCandidate,
  matchSenderInRows,
  resolveChannelAccount,
  resolveChannelAccountById,
} from "./accounts";
import type { ChannelAccountRow } from "./accounts";

// Synthetic rows only — no real phones/account ids. matchSenderInRows is
// pure; the async resolvers are exercised on their fail-closed edges.

function row(over: Partial<ChannelAccountRow>): ChannelAccountRow {
  return {
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
    ...over,
  };
}

describe("matchSenderInRows — echo sender attribution", () => {
  test("matches a digit-normalized E.164 senderAddress", () => {
    const rows = [row({})];
    const match = matchSenderInRows(rows, { senderAddress: "15550009999" });
    assert.equal(match?.id, 1);
  });

  test("matches providerAccountId verbatim (wabaId-style routing key)", () => {
    const rows = [
      row({ providerAccountId: "waba-abc-123", senderAddress: "+15551110000" }),
    ];
    const match = matchSenderInRows(rows, {
      senderAddress: "+15559990000",
      providerAccountId: "waba-abc-123",
    });
    assert.equal(match?.id, 1);
  });

  test("matches the ycloud-style providerAccountId by digit comparison", () => {
    const rows = [
      row({ providerAccountId: "15550009999", senderAddress: "+15550009999" }),
    ];
    const match = matchSenderInRows(rows, { senderAddress: "+1 (555) 000-9999" });
    assert.equal(match?.id, 1);
  });

  test("returns undefined when no row matches the sender", () => {
    const rows = [row({})];
    assert.equal(
      matchSenderInRows(rows, { senderAddress: "+15558887777" }),
      undefined
    );
    assert.equal(
      matchSenderInRows(rows, { providerAccountId: "waba-other" }),
      undefined
    );
  });

  test("prefers the row that matches among several provisioned accounts", () => {
    const rows = [
      row({ id: 1, senderAddress: "+15550001111", providerAccountId: "a1" }),
      row({ id: 2, senderAddress: "+15550002222", providerAccountId: "a2" }),
    ];
    const match = matchSenderInRows(rows, { senderAddress: "15550002222" });
    assert.equal(match?.id, 2);
  });
});

describe("canonical candidate matching", () => {
  test("matches +/digits forms against both routing key and sender address", () => {
    const rows = [
      row({ providerAccountId: "15550009999", senderAddress: "+15550009999" }),
      row({ id: 2, providerAccountId: "waba-2", senderAddress: "+15550002222" }),
    ];
    assert.equal(rowMatchesCandidate(rows[0], "+1 (555) 000-9999"), true);
    assert.equal(rowMatchesCandidate(rows[0], "15550009999"), true);
    assert.equal(rowMatchesCandidate(rows[1], "waba-2"), true);
    assert.equal(rowMatchesCandidate(rows[1], "15550002222"), true);
    assert.equal(rowMatchesCandidate(rows[0], ""), false);
  });

  test("a candidate that matches two rows is treated as ambiguous by the pure matcher", () => {
    const rows = [
      row({ id: 1, providerAccountId: "shared", senderAddress: "+15550001111" }),
      row({ id: 2, providerAccountId: "shared", senderAddress: "+15550002222" }),
    ];
    assert.equal(matchSenderInRows(rows, { providerAccountId: "shared" }), undefined);
  });
});

describe("channel account resolvers — never degrade on DB failure", () => {
  test("does not return a placeholder when the database is unavailable", async () => {
    // No DATABASE_URL in the test environment: the strict resolver surfaces a
    // typed DB failure instead of the old fail-open placeholder.
    await assert.rejects(() => resolveChannelAccountById(-1));
    await assert.rejects(() => resolveChannelAccount("whatsapp"));
  });

  test("surfaces DB failure before channel-provider fallback", async () => {
    for (const channel of ["instagram", "facebook", "sms", "reddit"] as const) {
      await assert.rejects(() => resolveChannelAccount(channel));
    }
  });
});
