import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
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

describe("channel account resolvers — fail closed", () => {
  test("resolveChannelAccountById returns undefined for a missing row or an unavailable table", async () => {
    // Works deterministically: with no DB the lookup throws → undefined;
    // against a real DB id -1 simply does not exist → undefined.
    assert.equal(await resolveChannelAccountById(-1), undefined);
  });

  test("resolveChannelAccount returns undefined for channels with no registered provider", async () => {
    for (const channel of ["instagram", "facebook", "sms", "reddit"] as const) {
      assert.equal(await resolveChannelAccount(channel), undefined);
    }
  });
});
