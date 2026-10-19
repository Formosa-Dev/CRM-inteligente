import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { and } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  buildConversationConditions,
  conversationEmptyMessage,
  conversationListWhere,
  formatChannelAccountLabel,
  normalizeAccountParam,
  normalizeChannelParam,
  normalizeConversationListFilters,
  normalizeStatusParam,
} from "./filters";

const dialect = new PgDialect();

/** Compiles the built WHERE into SQL + bound params — no DB needed. */
function compile(raw: {
  channel?: string;
  account?: string;
  status?: string;
  search?: string;
}): { sql: string; params: unknown[] } {
  const where = conversationListWhere(raw);
  // No predicates → undefined WHERE (query runs unfiltered by design).
  if (!where) return { sql: "", params: [] };
  return dialect.sqlToQuery(where);
}

describe("normalizeChannelParam", () => {
  it("keeps the legacy default (undefined) for missing/invalid values", () => {
    assert.equal(normalizeChannelParam(undefined), undefined);
    assert.equal(normalizeChannelParam(null), undefined);
    assert.equal(normalizeChannelParam(""), undefined);
    assert.equal(normalizeChannelParam("carrier-pigeon"), undefined);
  });

  it("accepts every channelEnum value plus 'all'", () => {
    for (const channel of [
      "whatsapp",
      "telegram",
      "instagram",
      "facebook",
      "sms",
      "reddit",
    ]) {
      assert.equal(normalizeChannelParam(channel), channel);
    }
    assert.equal(normalizeChannelParam("all"), "all");
  });
});

describe("normalizeAccountParam", () => {
  it("defaults to 'all'", () => {
    for (const raw of [undefined, null, "", "all", "abc", "0", "-4", "1.5x"]) {
      assert.equal(normalizeAccountParam(raw), "all", `raw=${raw}`);
    }
  });

  it("maps 'unassigned' to the legacy NULL predicate and digits to an id", () => {
    assert.equal(normalizeAccountParam("unassigned"), "unassigned");
    assert.equal(normalizeAccountParam("7"), 7);
    assert.equal(normalizeAccountParam(12), 12);
  });
});

describe("normalizeStatusParam", () => {
  it("accepts known statuses only", () => {
    assert.equal(normalizeStatusParam("active"), "active");
    assert.equal(normalizeStatusParam("closed"), "closed");
    assert.equal(normalizeStatusParam("archived"), "archived");
    for (const raw of [undefined, null, "", "all", "bogus"]) {
      assert.equal(normalizeStatusParam(raw), undefined, `raw=${raw}`);
    }
  });
});

describe("buildConversationConditions / conversationListWhere", () => {
  it("defaults to WhatsApp-only when no channel is given (telegram stays internal)", () => {
    const { sql, params } = compile({});
    assert.match(sql, /"channel" = /);
    assert.deepEqual(params, ["whatsapp"]);
  });

  it("emits no channel predicate for channel=all", () => {
    const { sql } = compile({ channel: "all" });
    assert.doesNotMatch(sql, /"channel" =/);
  });

  it("filters by an explicit channel", () => {
    const { params } = compile({ channel: "instagram" });
    assert.deepEqual(params, ["instagram"]);
  });

  it("filters channelAccountId IS NULL for account=unassigned", () => {
    const { sql } = compile({ channel: "all", account: "unassigned" });
    assert.match(sql, /"channel_account_id" is null/i);
  });

  it("filters by a numeric account id", () => {
    const { sql, params } = compile({ channel: "all", account: "9" });
    assert.match(sql, /"channel_account_id" = /);
    assert.deepEqual(params, [9]);
  });

  it("composes channel AND account predicates", () => {
    const { sql, params } = compile({ channel: "telegram", account: "3" });
    assert.match(sql, /"channel" = .* and /);
    assert.match(sql, /"channel_account_id" = /);
    assert.deepEqual(params, ["telegram", 3]);
  });

  it("keeps status and search predicates alongside channel/account", () => {
    const { sql, params } = compile({
      channel: "whatsapp",
      account: "unassigned",
      status: "closed",
      search: "marta",
    });
    assert.match(sql, /"status" = /);
    assert.match(sql, /ilike/i);
    assert.deepEqual(params, ["whatsapp", "closed", "%marta%", "%marta%"]);
  });

  it("normalizes raw params once", () => {
    const filters = normalizeConversationListFilters({
      channel: "sms",
      account: "unassigned",
      status: "all",
      search: "  ",
    });
    assert.equal(filters.channel, "sms");
    assert.equal(filters.account, "unassigned");
    assert.equal(filters.status, undefined);
    assert.equal(filters.search, undefined);

    const conditions = buildConversationConditions(filters);
    assert.ok(conditions.length > 0);
    assert.doesNotThrow(() => dialect.sqlToQuery(and(...conditions)!));
  });
});

describe("formatChannelAccountLabel", () => {
  const base = {
    provider: "ycloud",
    channel: "whatsapp",
    providerAccountId: "+5493704819234",
    senderAddress: "+5493704819234",
    displayName: null,
  };

  it("labels senderAddress + channel/provider so identical senders differ by provider", () => {
    const label = formatChannelAccountLabel(base);
    assert.ok(label.includes("+5493704819234"));
    assert.ok(label.includes("whatsapp/ycloud"));
    // providerAccountId === senderAddress is not repeated
    assert.equal(label.indexOf("+5493704819234"), label.lastIndexOf("+5493704819234"));
  });

  it("keeps providerAccountId when it differs from senderAddress", () => {
    const label = formatChannelAccountLabel({
      ...base,
      providerAccountId: "waba-123",
    });
    assert.ok(label.includes("waba-123"));
  });

  it("prepends displayName without dropping senderAddress", () => {
    const label = formatChannelAccountLabel({ ...base, displayName: "Ventas" });
    assert.ok(label.startsWith("Ventas"));
    assert.ok(label.includes("+5493704819234"));
  });
});

describe("conversationEmptyMessage", () => {
  const account = {
    id: 5,
    provider: "zernio",
    channel: "instagram",
    providerAccountId: "acct-9",
    senderAddress: "@muzza",
    displayName: null,
    status: "active",
  };

  it("names the default channel", () => {
    assert.match(
      conversationEmptyMessage({ channel: undefined, account: "all" }),
      /No hay conversaciones de WhatsApp\./
    );
  });

  it("composes channel + unassigned account", () => {
    assert.match(
      conversationEmptyMessage({ channel: "telegram", account: "unassigned" }),
      /de Telegram sin cuenta asignada\./
    );
  });

  it("composes channel + a connected account label", () => {
    const message = conversationEmptyMessage({
      channel: "instagram",
      account: 5,
      accountLabel: formatChannelAccountLabel(account),
    });
    assert.match(message, /de Instagram en @muzza · instagram\/zernio · acct-9\./);
  });

  it("falls back to the raw id and appends search context", () => {
    assert.match(
      conversationEmptyMessage({ channel: "all", account: 42, search: "pedido" }),
      /en la cuenta #42 que coincidan con «pedido»\./
    );
  });
});
