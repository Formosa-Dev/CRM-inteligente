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
 * `resolveAgentConfigStrict` returns the FIRST row of that chain (whole-row
 * granularity — admin editor / single-row consumers). `resolveAgentConfigChain`
 * returns ALL rows in scope order so credential fields merge per field: a
 * scoped row that only toggles a flag no longer hides a parent's credentials
 * (S2, AH R4-MED-2). Blank on a scoped row means "inherit" for chain-resolved
 * fields; fail-closed still applies when NO scope supplies a field.
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
import { isSchemaNotReady } from "@/lib/messaging/errors";
import { normalizePhone } from "@/lib/phone-utils";

export type AgentConfigRow = typeof agentConfig.$inferSelect;
export type AgentConfigChannel = (typeof channelEnum.enumValues)[number];

export interface AgentConfigScope {
  channel?: AgentConfigChannel | null;
  channelAccountId?: number | null;
  /**
   * Server-side conversation customer (canonical digits, `normalizePhone`).
   * Set only by conversation-derived scopes — customer-facing tools MUST use
   * it instead of model-supplied phone/orderId identity so one customer can
   * never read or mutate another customer's objects. Internal/admin callers
   * run without it and keep the legacy arg-driven behavior.
   */
  customerPhone?: string;
}

export type AgentConfigResolutionSource = "account" | "channel" | "global";

export type AgentConfigResolution =
  | {
      kind: "resolved";
      id: number;
      row: AgentConfigRow;
      source: AgentConfigResolutionSource;
    }
  /** No global row exists yet (uninitialized install). */
  | { kind: "not-found" }
  /** Positive evidence that the S13 scope columns are absent. */
  | { kind: "schema-not-ready"; error: unknown }
  /** Transient failure — never degrade to a global/placeholder config. */
  | { kind: "db-error"; error: unknown };

export class AgentConfigResolutionError extends Error {
  readonly retryable: boolean;
  readonly resolution: Exclude<AgentConfigResolution, { kind: "resolved" }>;

  constructor(
    resolution: Exclude<AgentConfigResolution, { kind: "resolved" }>
  ) {
    super(
      resolution.kind === "db-error"
        ? "agent config resolution failed (retryable)"
        : `agent config resolution: ${resolution.kind}`
    );
    this.name = "AgentConfigResolutionError";
    this.retryable = resolution.kind === "db-error";
    this.resolution = resolution;
  }
}

/**
 * Cache identity is channel + account (never account alone): the same numeric
 * account id can be addressed with different channel hints, and a channel
 * fallback must not be reused as if it were the account's own row.
 */
export function configCacheKey(scope: AgentConfigScope): string {
  const channel = scope.channel ?? "*";
  const account =
    scope.channelAccountId != null
      ? `account:${scope.channelAccountId}`
      : "account:none";
  return `channel:${channel}|${account}`;
}

/**
 * Only an exact scope result may be cached under that scope's key. Chained
 * global fallbacks (account -> channel -> global) are resolved on every
 * request so a missing scoped row can never masquerade as a cached account
 * answer.
 */
export function shouldCacheResolution(
  scope: AgentConfigScope,
  source: AgentConfigResolutionSource
): boolean {
  if (scope.channelAccountId != null) return source === "account";
  if (scope.channel) return source === "channel";
  return source === "global";
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

const resolutionCache = new Map<
  string,
  { at: number; id: number; source: AgentConfigResolutionSource }
>();

/** Applies an admin edit to the next resolver call (same TTL as ai/config). */
export function invalidateAgentConfigScopeCache(): void {
  resolutionCache.clear();
}

type ScopedRowResolution =
  | { kind: "resolved"; id: number; source: AgentConfigResolutionSource }
  | { kind: "not-found" };

async function resolveScopedRowId(
  scope: AgentConfigScope
): Promise<ScopedRowResolution> {
  let channel = scope.channel ?? undefined;

  if (scope.channelAccountId != null) {
    const [scoped] = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(eq(agentConfig.channelAccountId, scope.channelAccountId))
      .limit(1);
    if (scoped) return { kind: "resolved", id: scoped.id, source: "account" };

    // S11 binding seam: an account row can point straight at any config row.
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
      if (bound) return { kind: "resolved", id: bound.id, source: "account" };
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
    if (row) return { kind: "resolved", id: row.id, source: "channel" };
  }

  const [global] = await db
    .select({ id: agentConfig.id })
    .from(agentConfig)
    .where(
      and(isNull(agentConfig.channel), isNull(agentConfig.channelAccountId))
    )
    .orderBy(asc(agentConfig.id))
    .limit(1);
  return global
    ? { kind: "resolved", id: global.id, source: "global" }
    : { kind: "not-found" };
}

/**
 * R4-MED-2 — the FULL scope chain (account → channel → global), ordered from
 * most to least specific. Credential fields resolve per field across this
 * chain: a scoped row created only to toggle `enabled` no longer hides the
 * dedicated provider credential stored on a broader scope.
 */
async function resolveScopedRowIds(
  scope: AgentConfigScope
): Promise<
  | {
      kind: "resolved";
      entries: { id: number; source: AgentConfigResolutionSource }[];
    }
  | { kind: "not-found" }
> {
  const entries: { id: number; source: AgentConfigResolutionSource }[] = [];
  let channel = scope.channel ?? undefined;

  if (scope.channelAccountId != null) {
    const [scoped] = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(eq(agentConfig.channelAccountId, scope.channelAccountId))
      .limit(1);
    if (scoped) entries.push({ id: scoped.id, source: "account" });

    // S11 binding seam: an account row can point straight at any config row.
    // Only consulted when no direct per-account row exists — same precedence
    // as `resolveScopedRowId` so both helpers agree. When a direct row exists
    // and the channel is already known, the account lookup is unnecessary.
    if (!scoped || channel == null) {
      const [account] = await db
        .select({
          channel: channelAccounts.channel,
          boundConfigId: channelAccounts.agentConfigId,
        })
        .from(channelAccounts)
        .where(eq(channelAccounts.id, scope.channelAccountId))
        .limit(1);
      channel ??= account?.channel;
      if (!scoped && account?.boundConfigId != null) {
        const [bound] = await db
          .select({ id: agentConfig.id })
          .from(agentConfig)
          .where(eq(agentConfig.id, account.boundConfigId))
          .limit(1);
        if (bound) entries.push({ id: bound.id, source: "account" });
      }
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
    if (row) entries.push({ id: row.id, source: "channel" });
  }

  const [global] = await db
    .select({ id: agentConfig.id })
    .from(agentConfig)
    .where(
      and(isNull(agentConfig.channel), isNull(agentConfig.channelAccountId))
    )
    .orderBy(asc(agentConfig.id))
    .limit(1);
  if (global) entries.push({ id: global.id, source: "global" });

  return entries.length > 0
    ? { kind: "resolved", entries }
    : { kind: "not-found" };
}

export type AgentConfigChainResolution =
  | {
      kind: "resolved";
      /** Rows ordered from most to least specific (account → channel → global). */
      rows: AgentConfigRow[];
      sources: AgentConfigResolutionSource[];
    }
  | { kind: "not-found" }
  | { kind: "schema-not-ready"; error: unknown }
  | { kind: "db-error"; error: unknown };

/**
 * Credential-oriented resolution: returns every row in the scope chain instead
 * of just the first one. Callers resolve each credential field independently
 * with `firstScopedValue` and only fall to env / `MissingScopedCredentialError`
 * when every scope is empty for that field.
 */
export async function resolveAgentConfigChain(
  scope: AgentConfigScope = currentAgentConfigScope()
): Promise<AgentConfigChainResolution> {
  try {
    const resolved = await resolveScopedRowIds(scope);
    if (resolved.kind === "not-found") return { kind: "not-found" };

    const rows: AgentConfigRow[] = [];
    const sources: AgentConfigResolutionSource[] = [];
    const seen = new Set<number>();
    for (const entry of resolved.entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      const row = await fetchConfigById(entry.id);
      if (!row) continue;
      rows.push(row);
      sources.push(entry.source);
    }
    return rows.length > 0
      ? { kind: "resolved", rows, sources }
      : { kind: "not-found" };
  } catch (error) {
    if (isSchemaNotReady(error)) return { kind: "schema-not-ready", error };
    return { kind: "db-error", error };
  }
}

/**
 * First non-empty value for a single field across an ordered scope chain.
 * Used by credential resolution so each field inherits independently.
 */
export function firstScopedValue(
  rows: readonly AgentConfigRow[],
  read: (row: AgentConfigRow) => unknown
): string {
  for (const row of rows) {
    const value = read(row);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

async function fetchConfigById(id: number): Promise<AgentConfigRow | undefined> {
  const [row] = await db
    .select()
    .from(agentConfig)
    .where(eq(agentConfig.id, id))
    .limit(1);
  return row;
}

/**
 * Strict, explicit resolution. Callers get a typed result and must handle
 * transient errors; only `schema-not-ready` may use a compatibility fallback.
 */
export async function resolveAgentConfigStrict(
  scope: AgentConfigScope = currentAgentConfigScope()
): Promise<AgentConfigResolution> {
  const key = configCacheKey(scope);
  const hit = resolutionCache.get(key);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) {
    try {
      const row = await fetchConfigById(hit.id);
      return row
        ? { kind: "resolved", id: hit.id, row, source: hit.source }
        : { kind: "not-found" };
    } catch (error) {
      if (isSchemaNotReady(error)) return { kind: "schema-not-ready", error };
      return { kind: "db-error", error };
    }
  }

  try {
    const resolved = await resolveScopedRowId(scope);
    if (resolved.kind === "not-found") return { kind: "not-found" };
    const row = await fetchConfigById(resolved.id);
    if (!row) return { kind: "not-found" };
    if (shouldCacheResolution(scope, resolved.source)) {
      resolutionCache.set(key, {
        at: Date.now(),
        id: resolved.id,
        source: resolved.source,
      });
    }
    return {
      kind: "resolved",
      id: resolved.id,
      row,
      source: resolved.source,
    };
  } catch (error) {
    if (isSchemaNotReady(error)) {
      console.warn(
        "[agent-config] scope columns missing - legacy compatibility path"
      );
      return { kind: "schema-not-ready", error };
    }
    return { kind: "db-error", error };
  }
}

/**
 * Legacy-shaped read for un-migrated deploys: selects every column EXCEPT the
 * scope columns and the S0 channel-port columns, which don't exist
 * pre-migration. Callers must treat the absent fields as unset (provider
 * creds → blank, template fallback → none).
 */
function legacyColumns() {
  const {
    channel: _channel,
    channelAccountId: _account,
    zernioApiKeyEnc: _zernioKey,
    zernioWebhookSecretEnc: _zernioSecret,
    kapsoApiKeyEnc: _kapsoKey,
    kapsoWebhookSecretEnc: _kapsoSecret,
    ycloudWebhookSecretEnc: _ycloudSecret,
    waTemplateFallback: _waTemplate,
    ...rest
  } = getTableColumns(agentConfig);
  return rest;
}

async function fetchLegacyRowById(
  id: number
): Promise<AgentConfigRow | undefined> {
  const [row] = await db
    .select(legacyColumns())
    .from(agentConfig)
    .where(eq(agentConfig.id, id))
    .limit(1);
  return row
    ? ({ ...row, channel: null, channelAccountId: null } as AgentConfigRow)
    : undefined;
}

/** The legacy global row read without scope/S0 columns (un-migrated deploys). */
export async function fetchLegacyGlobalAgentConfig(): Promise<
  AgentConfigRow | undefined
> {
  return fetchLegacyRowById(GLOBAL_CONFIG_ID);
}

/**
 * Compatibility read for existing call sites: resolves strictly and maps the
 * result. `schema-not-ready` returns the legacy global row (positive evidence
 * only); DB errors throw instead of silently reading the global row.
 */
export async function resolveAgentConfig(
  scope: AgentConfigScope = currentAgentConfigScope()
): Promise<AgentConfigRow | undefined> {
  const resolution = await resolveAgentConfigStrict(scope);
  switch (resolution.kind) {
    case "resolved":
      return resolution.row;
    case "not-found":
      return undefined;
    case "schema-not-ready":
      try {
        return await fetchLegacyRowById(GLOBAL_CONFIG_ID);
      } catch {
        throw new AgentConfigResolutionError(resolution);
      }
    case "db-error":
      throw new AgentConfigResolutionError(resolution);
  }
}

export async function resolveAgentConfigId(
  scope: AgentConfigScope = currentAgentConfigScope()
): Promise<number> {
  const resolution = await resolveAgentConfigStrict(scope);
  switch (resolution.kind) {
    case "resolved":
      return resolution.id;
    case "not-found":
    case "schema-not-ready":
      return GLOBAL_CONFIG_ID;
    case "db-error":
      throw new AgentConfigResolutionError(resolution);
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
  } catch (error) {
    // Only a positively identified missing schema may use the legacy row.
    if (!isSchemaNotReady(error)) throw error;
    if (scope.channelAccountId != null || scope.channel) return undefined;
    try {
      return await fetchLegacyRowById(GLOBAL_CONFIG_ID);
    } catch (legacyError) {
      if (!isSchemaNotReady(legacyError)) throw legacyError;
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
    } catch (error) {
      if (!isSchemaNotReady(error)) throw error;
      channel = null;
    }
  }
  return { channel, channelAccountId };
}

/**
 * Derives the config scope from a conversation row (channel + account +
 * normalized customer phone). `customerPhone` binds customer-facing tools to
 * THIS conversation's customer — never a model-supplied phone.
 */
export async function resolveScopeForConversation(
  conversationId: number
): Promise<AgentConfigScope> {
  try {
    const [conv] = await db
      .select({
        channel: conversations.channel,
        channelAccountId: conversations.channelAccountId,
        customerPhone: conversations.customerPhone,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conv) return {};
    return {
      channel: conv.channel ?? undefined,
      channelAccountId: conv.channelAccountId ?? undefined,
      customerPhone: conv.customerPhone
        ? normalizePhone(conv.customerPhone)
        : undefined,
    };
  } catch (error) {
    if (isSchemaNotReady(error)) return {};
    throw error;
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
  linkedin: "LinkedIn",
  tiktok: "TikTok",
  youtube: "YouTube",
  threads: "Threads",
  pinterest: "Pinterest",
  discord: "Discord",
  slack: "Slack",
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
