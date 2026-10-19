/**
 * Conversation list filters — normalizes channel/account/status/search params
 * (from URL search params or server-action callers) into indexed-friendly
 * Drizzle predicates over `conversations.channel` /
 * `conversations.channelAccountId`.
 *
 * Pure module: no db handle, safe to import from server actions, page
 * components, and client components alike.
 *
 * Channel semantics (S14):
 * - `undefined`/invalid → legacy default: WhatsApp only (Telegram is the
 *   internal admin channel; pre-S14 the inbox never showed anything else).
 * - `"all"` → every `channelEnum` value, no channel predicate.
 * - a `channelEnum` value → that channel only.
 *
 * Account semantics:
 * - `"all"` → no account predicate (bound + legacy rows).
 * - `"unassigned"` → `channel_account_id IS NULL` (legacy/unbound rows).
 * - a positive integer → `channel_account_id = <id>`.
 */

import { and, eq, ilike, isNull, or, type SQL } from "drizzle-orm";

import { channelEnum, conversations } from "@/db/schema";

export type ConversationChannel = (typeof channelEnum.enumValues)[number];

export const CONVERSATION_CHANNELS: readonly ConversationChannel[] =
  channelEnum.enumValues;

export type ConversationAccountFilter = "all" | "unassigned" | number;

export type ConversationStatusFilter = "active" | "closed" | "archived";

export interface ConversationListFilters {
  channel: ConversationChannel | "all" | undefined;
  account: ConversationAccountFilter;
  status: ConversationStatusFilter | undefined;
  search: string | undefined;
}

/** Option row for the account selector — a subset of `channel_accounts`. */
export interface ChannelAccountOption {
  id: number;
  provider: string;
  channel: string;
  providerAccountId: string;
  senderAddress: string;
  displayName: string | null;
  status: string;
}

const CHANNEL_LABELS: Record<ConversationChannel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  facebook: "Facebook",
  sms: "SMS",
  reddit: "Reddit",
};

export function conversationChannelLabel(channel: string): string {
  return CHANNEL_LABELS[channel as ConversationChannel] ?? channel;
}

export function normalizeChannelParam(
  raw: string | undefined | null
): ConversationChannel | "all" | undefined {
  if (raw === "all") return "all";
  if (
    raw &&
    (channelEnum.enumValues as readonly string[]).includes(raw)
  ) {
    return raw as ConversationChannel;
  }
  return undefined;
}

export function normalizeAccountParam(
  raw: string | number | undefined | null
): ConversationAccountFilter {
  if (raw === "unassigned") return "unassigned";
  if (raw !== undefined && raw !== null && raw !== "" && raw !== "all") {
    const id =
      typeof raw === "number"
        ? raw
        : /^\d+$/.test(raw.trim())
          ? Number.parseInt(raw.trim(), 10)
          : NaN;
    if (Number.isInteger(id) && id > 0) return id;
  }
  return "all";
}

export function normalizeStatusParam(
  raw: string | undefined | null
): ConversationStatusFilter | undefined {
  return raw === "active" || raw === "closed" || raw === "archived"
    ? raw
    : undefined;
}

export function normalizeConversationListFilters(raw: {
  channel?: string;
  account?: string;
  status?: string;
  search?: string;
}): ConversationListFilters {
  const search = raw.search?.trim();
  return {
    channel: normalizeChannelParam(raw.channel),
    account: normalizeAccountParam(raw.account),
    status: normalizeStatusParam(raw.status),
    search: search ? search : undefined,
  };
}

/**
 * Predicates for the conversations list query, kept index-friendly: plain
 * `=`/`IS NULL` on `channel`/`channel_account_id` (or the existing ILIKE pair
 * for search) — no expressions or functions that would defeat a B-tree.
 *
 * Index reality today (schema.ts): `channel` is the leading column of
 * `conversations_channel_identity_idx` and of both partial unique indexes,
 * so channel filters are served. `channel_account_id` is NOT covered — the
 * only indexes containing it are partial uniques that can't satisfy plain
 * `= N` or `IS NULL` scans. Residual recommendation: an additive
 * `(channel, channel_account_id)` index (deferred — migration numbering is
 * owned by another slice); these predicates already match its column order.
 */
export function buildConversationConditions(
  filters: ConversationListFilters
): SQL[] {
  const conditions: SQL[] = [];

  if (filters.channel === undefined) {
    // Legacy default: the inbox predates multi-channel and Telegram is the
    // internal admin channel — keep it hidden unless explicitly requested.
    conditions.push(eq(conversations.channel, "whatsapp"));
  } else if (filters.channel !== "all") {
    conditions.push(eq(conversations.channel, filters.channel));
  }

  if (filters.account === "unassigned") {
    conditions.push(isNull(conversations.channelAccountId));
  } else if (typeof filters.account === "number") {
    conditions.push(eq(conversations.channelAccountId, filters.account));
  }

  if (filters.status) {
    conditions.push(eq(conversations.status, filters.status));
  }

  if (filters.search) {
    conditions.push(
      or(
        ilike(conversations.customerName, `%${filters.search}%`),
        ilike(conversations.customerPhone, `%${filters.search}%`)
      )!
    );
  }

  return conditions;
}

/**
 * Raw params → combined WHERE for the list query (the single seam used by
 * `getConversations`; count + page queries share it).
 */
export function conversationListWhere(raw: {
  channel?: string;
  account?: string;
  status?: string;
  search?: string;
}): SQL | undefined {
  const conditions = buildConversationConditions(
    normalizeConversationListFilters(raw)
  );
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/**
 * Selector label for a connected account — keeps `senderAddress`,
 * `channel/provider` and (when it differs) `providerAccountId` visible so
 * "+54 … via ycloud" is distinguishable from the same address on another
 * provider.
 */
export function formatChannelAccountLabel(
  account: Pick<
    ChannelAccountOption,
    "provider" | "channel" | "providerAccountId" | "senderAddress" | "displayName"
  >
): string {
  const parts: string[] = [];
  const displayName = account.displayName?.trim();
  if (displayName) parts.push(displayName);
  parts.push(account.senderAddress);
  parts.push(`${account.channel}/${account.provider}`);
  if (account.providerAccountId !== account.senderAddress) {
    parts.push(account.providerAccountId);
  }
  return parts.join(" · ");
}

/**
 * Spanish empty-state copy for the exact filter combination — the operator
 * should see which constraint produced zero rows.
 */
export function conversationEmptyMessage(opts: {
  channel: ConversationChannel | "all" | undefined;
  account: ConversationAccountFilter;
  accountLabel?: string;
  search?: string;
}): string {
  const segments: string[] = ["No hay conversaciones"];

  if (opts.channel === undefined) {
    segments.push("de WhatsApp");
  } else if (opts.channel !== "all") {
    segments.push(`de ${conversationChannelLabel(opts.channel)}`);
  }

  if (opts.account === "unassigned") {
    segments.push("sin cuenta asignada");
  } else if (typeof opts.account === "number") {
    segments.push(`en ${opts.accountLabel ?? `la cuenta #${opts.account}`}`);
  }

  if (opts.search) {
    segments.push(`que coincidan con «${opts.search}»`);
  }

  return `${segments.join(" ")}.`;
}
