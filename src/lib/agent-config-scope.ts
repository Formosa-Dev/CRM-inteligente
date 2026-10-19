/**
 * Scoped agent_config resolution (S13 — per-channel/per-account config).
 *
 * `agent_config` grew two nullable scope columns: `channel` and
 * `channel_account_id`. A row with BOTH null is the global default — identical
 * to the pre-S13 single row. Resolution order for a given scope:
 *
 *   1. `channel_account_id` match (per-account row, or an explicit
 *      `channel_accounts.agent_config_id` binding left over from S11)
 *   2. `channel` match (channel-scoped row, `channel_account_id IS NULL`)
 *   3. global row (`channel IS NULL AND channel_account_id IS NULL`, lowest id)
 *
 * Everything is wrapped in try/catch: on an un-migrated deploy (no scope
 * columns) every scoped lookup fails and callers get the legacy id=1 row —
 * i.e. today's behavior, unchanged.
 *
 * Ambient scope: `runWithAgentConfigScope(scope, fn)` binds a scope to the
 * async context so deep call sites (tool executes, prompt layers, AI creds)
 * resolve scoped rows without threading params through every signature. Any
 * call outside `run` resolves the global row. Explicit `scope` args always win
 * over the ambient store.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
  and,
  asc,
  eq,
  getTableColumns,
  isNotNull,
  isNull,
  or,
} from "drizzle-orm";
import { db } from "@/db";
import {
  agentConfig,
  channelAccounts,
  channelEnum,
  conversations,
} from "@/db/schema";

export type AgentConfigRow = typeof agentConfig.$inferSelect;
export type AgentConfigChannel = (typeof channelEnum.enumValues)[number];

export interface AgentConfigScope {
  channel?: AgentConfigChannel | null;
  channelAccountId?: number | null;
}

/** Legacy convention: the global row is id=1 on every deployed install. */
const GLOBAL_CONFIG_ID = 1;
const RESOLVE_TTL_MS = 30_000;

// ─── Scope keys ("global" | "channel:<channel>" | "account:<id>") ─────────────

export function scopeKeyOf(scope: AgentConfigScope): string {
  if (scope.channelAccountId != null) return `account:${scope.channelAccountId}`;
  if (scope.channel) return `channel:${scope.channel}`;
  return "global";
}

/** Parses a scope key. Returns null for malformed keys (callers fall back). */
export function parseScopeKey(
  key: string | null | undefined
): AgentConfigScope | null {
  if (!key || key === "global") return {};
  const sep = key.indexOf(":");
  const kind = sep === -1 ? key : key.slice(0, sep);
  const raw = sep === -1 ? "" : key.slice(sep + 1);
  if (kind === "channel" && (channelEnum.enumValues as string[]).includes(raw)) {
    return { channel: raw as AgentConfigChannel };
  }
  if (kind === "account") {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0) return { channelAccountId: id };
  }
  return null;
}

// ─── Ambient scope ────────────────────────────────────────────────────────────

const scopeStorage = new AsyncLocalStorage<AgentConfigScope>();

export function runWithAgentConfigScope<T>(
  scope: AgentConfigScope,
  fn: () => T
): T {
  return scopeStorage.run(scope, fn);
}

export function currentAgentConfigScope(): AgentConfigScope {
  return scopeStorage.getStore() ?? {};
}

// ─── Resolution ───────────────────────────────────────────────────────────────

const idCache = new Map<string, { at: number; id: number }>();

/** Applies an admin edit to the next resolver call (same TTL as ai/config). */
export function invalidateAgentConfigScopeCache(): void {
  idCache.clear();
}

async function queryGlobalId(): Promise<number> {
  const [row] = await db
    .select({ id: agentConfig.id })
    .from(agentConfig)
    .where(
      and(
        isNull(agentConfig.channel),
        isNull(agentConfig.channelAccountId)
      )
    )
    .orderBy(asc(agentConfig.id))
    .limit(1);
  return row?.id ?? GLOBAL_CONFIG_ID;
}

async function resolveIdUncached(scope: AgentConfigScope): Promise<number> {
  let channel = scope.channel ?? undefined;

  if (scope.channelAccountId != null) {
    const [scoped] = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(eq(agentConfig.channelAccountId, scope.channelAccountId))
      .limit(1);
    if (scoped) return scoped.id;

    // S11 binding seam: an account row can point straight at any config row.
    // Also supplies the channel for the channel-level fallback below.
    const [account] = await db
      .select({
        channel: channelAccounts.channel,
        boundConfigId: channelAccounts.agentConfigId,
      })
      .from(channelAccounts)
      .where(eq(channelAccounts.id, scope.channelAccountId))
      .limit(1);
    channel ??= account?.channel;
    if (account?.boundConfigId != null) {
      const [bound] = await db
        .select({ id: agentConfig.id })
        .from(agentConfig)
        .where(eq(agentConfig.id, account.boundConfigId))
        .limit(1);
      if (bound) return bound.id;
    }
  }

  if (channel) {
    const [row] = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(
        and(
          eq(agentConfig.channel, channel),
          isNull(agentConfig.channelAccountId)
        )
      )
      .limit(1);
    if (row) return row.id;
  }

  return queryGlobalId();
}

/**
 * Resolves the effective `agent_config.id` for a scope: account → channel →
 * global. Falls back to id=1 on un-migrated deploys (query errors) so every
 * existing `where eq(id, …)` reader keeps today's semantics.
 */
export async function resolveAgentConfigId(
  scope: AgentConfigScope = currentAgentConfigScope()
): Promise<number> {
  const key = scopeKeyOf(scope);
  const hit = idCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.id;
  try {
    const id = await resolveIdUncached(scope);
    idCache.set(key, { at: Date.now(), id });
    return id;
  } catch {
    return GLOBAL_CONFIG_ID;
  }
}

/**
 * Legacy-shaped read for un-migrated deploys: selects every column EXCEPT the
 * new scope columns, which don't exist pre-migration.
 */
function legacyColumns() {
  const { channel: _channel, channelAccountId: _account, ...rest } =
    getTableColumns(agentConfig);
  return rest;
}

/** Resolves the effective config row for a scope (account → channel → global). */
export async function resolveAgentConfig(
  scope: AgentConfigScope = currentAgentConfigScope()
): Promise<AgentConfigRow | undefined> {
  const id = await resolveAgentConfigId(scope);
  try {
    const [row] = await db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.id, id))
      .limit(1);
    return row;
  } catch {
    try {
      const [row] = await db
        .select(legacyColumns())
        .from(agentConfig)
        .where(eq(agentConfig.id, id))
        .limit(1);
      return row
        ? ({ ...row, channel: null, channelAccountId: null } as AgentConfigRow)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Exact-scope lookup for the admin editor — does NOT chain to broader scopes
 * (editing "channel:telegram" must show that row or blank, never the global).
 */
export async function findAgentConfigForScope(
  scope: AgentConfigScope
): Promise<AgentConfigRow | undefined> {
  const where =
    scope.channelAccountId != null
      ? eq(agentConfig.channelAccountId, scope.channelAccountId)
      : scope.channel
        ? and(
            eq(agentConfig.channel, scope.channel),
            isNull(agentConfig.channelAccountId)
          )
        : and(
            isNull(agentConfig.channel),
            isNull(agentConfig.channelAccountId)
          );
  try {
    const [row] = await db
      .select()
      .from(agentConfig)
      .where(where)
      .orderBy(asc(agentConfig.id))
      .limit(1);
    return row;
  } catch {
    // Un-migrated: only the legacy global row can exist.
    if (scope.channelAccountId != null || scope.channel) return undefined;
    try {
      const [row] = await db
        .select(legacyColumns())
        .from(agentConfig)
        .where(eq(agentConfig.id, GLOBAL_CONFIG_ID))
        .limit(1);
      return row
        ? ({ ...row, channel: null, channelAccountId: null } as AgentConfigRow)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Scope column values for an INSERT of a new config row. Account rows carry
 * the account's channel too (informative; the account partial unique is the
 * real guard) — looked up here so callers don't duplicate it.
 */
export async function scopeColumnsForInsert(
  scope: AgentConfigScope
): Promise<{ channel: AgentConfigChannel | null; channelAccountId: number | null }> {
  const channelAccountId = scope.channelAccountId ?? null;
  let channel = scope.channel ?? null;
  if (channelAccountId != null && channel == null) {
    try {
      const [account] = await db
        .select({ channel: channelAccounts.channel })
        .from(channelAccounts)
        .where(eq(channelAccounts.id, channelAccountId))
        .limit(1);
      channel = account?.channel ?? null;
    } catch {
      channel = null;
    }
  }
  return { channel, channelAccountId };
}

/** Derives the config scope from a conversation row (channel + account). */
export async function resolveScopeForConversation(
  conversationId: number
): Promise<AgentConfigScope> {
  try {
    const [conv] = await db
      .select({
        channel: conversations.channel,
        channelAccountId: conversations.channelAccountId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conv) return {};
    return {
      channel: conv.channel ?? undefined,
      channelAccountId: conv.channelAccountId ?? undefined,
    };
  } catch {
    return {};
  }
}

// ─── Admin selector ───────────────────────────────────────────────────────────

export interface AgentConfigScopeOption {
  key: string;
  kind: "global" | "channel" | "account";
  label: string;
  /** True when the scope already owns a config row (vs. create-on-save). */
  exists: boolean;
}

const CHANNEL_LABELS: Record<AgentConfigChannel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  instagram: "Instagram",
  facebook: "Facebook",
  sms: "SMS",
  reddit: "Reddit",
};

/**
 * Lists every selectable scope for /admin/agent: the global default, one entry
 * per channel, and one entry per connected channel account.
 */
export async function listAgentConfigScopes(): Promise<AgentConfigScopeOption[]> {
  const options: AgentConfigScopeOption[] = [
    { key: "global", kind: "global", label: "Global (predeterminada)", exists: true },
  ];

  let scopedRows: {
    id: number;
    channel: AgentConfigChannel | null;
    channelAccountId: number | null;
  }[] = [];
  try {
    scopedRows = await db
      .select({
        id: agentConfig.id,
        channel: agentConfig.channel,
        channelAccountId: agentConfig.channelAccountId,
      })
      .from(agentConfig)
      .where(
        or(
          isNotNull(agentConfig.channel),
          isNotNull(agentConfig.channelAccountId)
        )
      );
  } catch {
    // Un-migrated deploy: only the global scope exists.
    return options;
  }

  const channelTaken = new Set(
    scopedRows
      .filter((r) => r.channel != null && r.channelAccountId == null)
      .map((r) => r.channel as AgentConfigChannel)
  );
  const accountTaken = new Set(
    scopedRows
      .filter((r) => r.channelAccountId != null)
      .map((r) => r.channelAccountId as number)
  );

  for (const channel of channelEnum.enumValues) {
    options.push({
      key: `channel:${channel}`,
      kind: "channel",
      label: `Canal · ${CHANNEL_LABELS[channel]}`,
      exists: channelTaken.has(channel),
    });
  }

  try {
    const accounts = await db
      .select({
        id: channelAccounts.id,
        provider: channelAccounts.provider,
        channel: channelAccounts.channel,
        senderAddress: channelAccounts.senderAddress,
        displayName: channelAccounts.displayName,
      })
      .from(channelAccounts)
      .orderBy(asc(channelAccounts.id));
    for (const a of accounts) {
      options.push({
        key: `account:${a.id}`,
        kind: "account",
        label: `Cuenta · ${a.displayName || a.senderAddress} (${CHANNEL_LABELS[a.channel]} · ${a.provider})`,
        exists: accountTaken.has(a.id),
      });
    }
  } catch {
    // channel_accounts missing on un-migrated deploys — channels still listed.
  }

  return options;
}
