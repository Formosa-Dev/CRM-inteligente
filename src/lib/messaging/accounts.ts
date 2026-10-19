/**
 * Channel account resolver — the read seam between the `channel_accounts`
 * table and the messaging contract's `ChannelAccount`.
 *
 * Resolution is strict and account-aware:
 * - candidates are matched by canonical (+/digits) comparison against
 *   `providerAccountId` and `senderAddress`;
 * - only `active` rows with a registered provider participate;
 * - an expected provider must match the row provider (present-but-mismatched
 *   is a hard mismatch, never a fallback);
 * - a provisioned channel with no matching row is `not-found` (fail closed);
 * - only a positively identified missing schema (un-migrated install) may use
 *   the legacy placeholder. Arbitrary DB errors are surfaced as retryable.
 */

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { channelAccounts } from "@/db/schema";
import { resolveAgentConfigStrict } from "@/lib/agent-config-scope";
import { decryptIfEncrypted } from "@/lib/encryption";
import { getIntegrationSecrets, getYCloudApiKey } from "@/lib/integrations";
import { phoneMatches } from "@/lib/phone-utils";

import { isRetryableDbError, isSchemaNotReady } from "./errors";
import {
  PROVIDER_IDS,
  isChannelKind,
  isProviderId,
  providerForChannel,
} from "./registry";
import type { ChannelAccount, ChannelKind, ProviderId } from "./types";

export type ChannelAccountRow = typeof channelAccounts.$inferSelect;

export type ChannelAccountResolution =
  | {
      kind: "resolved";
      account: ChannelAccount;
      rowId: number;
      provider: ProviderId;
      channel: ChannelKind;
    }
  /** No active rows provisioned for the channel — legacy install. */
  | { kind: "unprovisioned" }
  /** Rows exist but none matches the presented identity. */
  | { kind: "not-found"; candidates: string[] }
  /** A match exists but its provider/channel/account context disagrees. */
  | { kind: "mismatch"; reason: string }
  /** Positive evidence that the migration has not run. */
  | { kind: "schema-not-ready"; error: unknown }
  /** Transient failure — caller must retry, never degrade. */
  | { kind: "db-error"; error: unknown };

function toAccountStatus(value: string): ChannelAccount["status"] {
  return value === "disconnected" || value === "error" ? value : "active";
}

function credentialsFromEnv(ref: string): ChannelAccount["credentials"] {
  const prefix = ref.slice("env:".length).replace(/\*$/, "");
  const accessToken = process.env[`${prefix}ACCESS_TOKEN`];
  return {
    apiKey: process.env[`${prefix}API_KEY`] ?? "",
    webhookSecret: process.env[`${prefix}WEBHOOK_SECRET`] ?? "",
    ...(accessToken ? { accessToken } : {}),
  };
}

/**
 * `agent_config`/unset credentials resolve through the account's own scope so
 * a per-account API key is actually used. Schema-not-ready is the only path
 * that falls back to the install-global agent_config/env pair.
 */
async function credentialsFromAgentConfig(
  row: ChannelAccountRow
): Promise<ChannelAccount["credentials"]> {
  if (row.provider !== "ycloud") return { apiKey: "", webhookSecret: "" };

  let scopedKey = "";
  const resolution = await resolveAgentConfigStrict({
    channel: row.channel,
    channelAccountId: row.id,
  });
  if (resolution.kind === "resolved") {
    scopedKey = decryptIfEncrypted(resolution.row.ycloudApiKey);
  } else if (
    resolution.kind !== "schema-not-ready" &&
    resolution.kind !== "not-found"
  ) {
    // A transient DB error must not be silently replaced by global creds.
    throw resolution.error;
  }

  const [globalKey, secrets] = await Promise.all([
    scopedKey ? Promise.resolve("") : getYCloudApiKey(),
    getIntegrationSecrets(),
  ]);
  return {
    apiKey: scopedKey || globalKey,
    webhookSecret: secrets.ycloudWebhookSecret,
  };
}

async function resolveCredentials(
  row: ChannelAccountRow
): Promise<ChannelAccount["credentials"]> {
  const ref = row.credentialsRef?.trim();
  if (!ref || ref === "agent_config") {
    return credentialsFromAgentConfig(row);
  }
  if (ref.startsWith("env:")) return credentialsFromEnv(ref);
  console.warn(
    `[messaging] channel_accounts #${row.id} has unknown credentialsRef '${ref}' — credentials left empty`
  );
  return { apiKey: "", webhookSecret: "" };
}

async function rowToAccount(
  row: ChannelAccountRow
): Promise<ChannelAccount | undefined> {
  if (!isProviderId(row.provider) || !isChannelKind(row.channel)) return undefined;
  return {
    id: String(row.id),
    tenantId: row.tenantId,
    provider: row.provider,
    channel: row.channel,
    providerAccountId: row.providerAccountId,
    senderAddress: row.senderAddress,
    credentials: await resolveCredentials(row),
    status: toAccountStatus(row.status),
  };
}

function classifyRowsError(
  channel: ChannelKind,
  error: unknown
): ChannelAccountResolution {
  if (isSchemaNotReady(error)) {
    console.warn(
      `[messaging] channel_accounts schema not ready for '${channel}' — legacy compatibility path`
    );
    return { kind: "schema-not-ready", error };
  }
  console.error(
    isRetryableDbError(error)
      ? `[messaging] channel_accounts lookup failed for '${channel}' — retryable`
      : `[messaging] channel_accounts lookup failed for '${channel}'`,
    error
  );
  return { kind: "db-error", error };
}

export function rowMatchesCandidate(
  row: Pick<ChannelAccountRow, "providerAccountId" | "senderAddress">,
  candidate: string
): boolean {
  if (!candidate) return false;
  return (
    row.providerAccountId === candidate ||
    phoneMatches(candidate, row.providerAccountId) ||
    phoneMatches(candidate, row.senderAddress)
  );
}

function matchRows(
  rows: readonly ChannelAccountRow[],
  candidates: readonly string[]
): ChannelAccountRow[] {
  return rows.filter((row) =>
    candidates.some((candidate) => rowMatchesCandidate(row, candidate))
  );
}

/**
 * Strict account resolution for an inbound/reply event. `candidates` may
 * contain the provider routing key and the business self-address in any
 * (+/digits) form; duplicates collapse.
 */
export async function resolveChannelAccountStrict(
  channel: ChannelKind,
  candidates: readonly string[],
  expectedProvider?: ProviderId
): Promise<ChannelAccountResolution> {
  let rows: ChannelAccountRow[];
  try {
    rows = await db
      .select()
      .from(channelAccounts)
      .where(eq(channelAccounts.channel, channel));
  } catch (error) {
    return classifyRowsError(channel, error);
  }

  if (rows.length === 0) return { kind: "unprovisioned" };

  const active = rows.filter(
    (row) =>
      row.status === "active" &&
      isProviderId(row.provider) &&
      isChannelKind(row.channel)
  );
  if (active.length === 0) {
    return { kind: "not-found", candidates: [...candidates] };
  }

  const uniqueCandidates = [...new Set(candidates.filter((c) => c.length > 0))];
  if (uniqueCandidates.length === 0 && active.length > 1) {
    return {
      kind: "mismatch",
      reason: "multiple active accounts and no routing key",
    };
  }

  const matched = uniqueCandidates.length
    ? matchRows(active, uniqueCandidates)
    : active.slice(0, 1);
  if (matched.length === 0) {
    return { kind: "not-found", candidates: uniqueCandidates };
  }

  const distinct = [...new Map(matched.map((row) => [row.id, row])).values()];
  if (distinct.length > 1) {
    return { kind: "mismatch", reason: "routing key matches multiple accounts" };
  }

  const row = distinct[0];
  if (expectedProvider && row.provider !== expectedProvider) {
    return {
      kind: "mismatch",
      reason: `account #${row.id} provider '${row.provider}' != event provider '${expectedProvider}'`,
    };
  }
  if (!isProviderId(row.provider)) {
    return { kind: "mismatch", reason: `unregistered provider '${row.provider}'` };
  }

  const account = await rowToAccount(row);
  if (!account) {
    return { kind: "mismatch", reason: `account #${row.id} cannot be materialized` };
  }
  return {
    kind: "resolved",
    account,
    rowId: row.id,
    provider: row.provider,
    channel: row.channel,
  };
}

/** Strict lookup by primary key (conversation binding / operator send). */
export async function resolveChannelAccountByIdStrict(
  accountId: number,
  expectedProvider?: ProviderId
): Promise<ChannelAccountResolution> {
  let rows: ChannelAccountRow[];
  try {
    rows = await db
      .select()
      .from(channelAccounts)
      .where(eq(channelAccounts.id, accountId))
      .limit(1);
  } catch (error) {
    return classifyRowsError("whatsapp", error);
  }
  const row = rows[0];
  if (!row) return { kind: "not-found", candidates: [String(accountId)] };
  if (row.status !== "active") {
    return { kind: "not-found", candidates: [String(accountId)] };
  }
  if (!isProviderId(row.provider) || !isChannelKind(row.channel)) {
    return { kind: "mismatch", reason: `account #${accountId} has invalid provider/channel` };
  }
  if (expectedProvider && row.provider !== expectedProvider) {
    return {
      kind: "mismatch",
      reason: `account #${accountId} provider '${row.provider}' != expected '${expectedProvider}'`,
    };
  }
  const account = await rowToAccount(row);
  return account
    ? {
        kind: "resolved",
        account,
        rowId: row.id,
        provider: row.provider,
        channel: row.channel,
      }
    : { kind: "mismatch", reason: `account #${accountId} cannot be materialized` };
}

/** Identical shape to messenger.ts's placeholder — carries no secrets. */
function fallbackAccount(channel: ChannelKind): ChannelAccount | undefined {
  const provider = providerForChannel(channel);
  if (!provider) return undefined;
  return {
    id: `${channel}:agent-config`,
    tenantId: "default",
    provider: provider.id,
    channel,
    providerAccountId: "",
    senderAddress: "",
    credentials: { apiKey: "", webhookSecret: "" },
    status: "active",
  };
}

export class ChannelAccountResolutionError extends Error {
  readonly retryable: boolean;
  readonly resolution: ChannelAccountResolution;

  constructor(
    resolution: Exclude<ChannelAccountResolution, { kind: "resolved" }>
  ) {
    super(
      resolution.kind === "db-error"
        ? "channel account resolution failed (retryable)"
        : resolution.kind === "mismatch"
          ? resolution.reason
          : resolution.kind === "not-found"
            ? "no channel account matches the presented identity"
            : `channel account resolution: ${resolution.kind}`
    );
    this.name = "ChannelAccountResolutionError";
    this.retryable = resolution.kind === "db-error";
    this.resolution = resolution;
  }
}

/**
 * Compatibility wrapper for callers that only need an account. Legacy
 * placeholder is used for a truly unprovisioned channel or a positively
 * identified missing schema. Not-found/mismatch return undefined (fail
 * closed); transient errors throw a retryable error.
 */
export async function resolveChannelAccount(
  channel: ChannelKind,
  providerAccountId?: string,
  expectedProvider?: ProviderId
): Promise<ChannelAccount | undefined> {
  const resolution = await resolveChannelAccountStrict(
    channel,
    providerAccountId ? [providerAccountId] : [],
    expectedProvider
  );
  switch (resolution.kind) {
    case "resolved":
      return resolution.account;
    case "unprovisioned":
    case "schema-not-ready":
      return fallbackAccount(channel);
    case "db-error":
      throw new ChannelAccountResolutionError(resolution);
    case "not-found":
    case "mismatch":
      return undefined;
  }
}

/**
 * Compatibility wrapper for conversation-bound sends. Missing/inactive rows
 * return undefined; transient DB errors throw.
 */
export async function resolveChannelAccountById(
  accountId: number,
  expectedProvider?: ProviderId
): Promise<ChannelAccount | undefined> {
  const resolution = await resolveChannelAccountByIdStrict(
    accountId,
    expectedProvider
  );
  if (resolution.kind === "resolved") return resolution.account;
  if (resolution.kind === "db-error") {
    throw new ChannelAccountResolutionError(resolution);
  }
  return undefined;
}

export type SenderAccountMatch =
  | { kind: "matched"; account: ChannelAccount }
  /** No active rows for the channel (or a truly un-migrated install). */
  | { kind: "unprovisioned" }
  /** Rows exist but none matches the sender — foreign account, fail closed. */
  | { kind: "unmatched" }
  | { kind: "mismatch"; reason: string }
  | { kind: "db-error"; error: unknown };

/**
 * Pure matcher — the business-side sender of an echo/self-send must equal an
 * active row's `senderAddress` or `providerAccountId` (digit-normalized for
 * E.164), or carry the row's `providerAccountId` verbatim (wabaId et al.).
 */
export function matchSenderInRows(
  rows: readonly ChannelAccountRow[],
  sender: { senderAddress?: string; providerAccountId?: string }
): ChannelAccountRow | undefined {
  const candidates = [sender.providerAccountId, sender.senderAddress].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  const matches = matchRows(rows, candidates);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Attribute an outbound/echo event's business-side sender to a provisioned
 * `channel_accounts` row. Tri-state so callers can keep the legacy phone-only
 * flow only on an unprovisioned/un-migrated install while refusing foreign
 * senders and surfacing retryable DB failures.
 */
export async function matchSenderToChannelAccount(
  channel: ChannelKind,
  sender: { senderAddress?: string; providerAccountId?: string },
  expectedProvider?: ProviderId
): Promise<SenderAccountMatch> {
  const candidates = [sender.providerAccountId, sender.senderAddress].filter(
    (candidate): candidate is string => Boolean(candidate)
  );
  const resolution = await resolveChannelAccountStrict(
    channel,
    candidates,
    expectedProvider
  );
  switch (resolution.kind) {
    case "resolved":
      return { kind: "matched", account: resolution.account };
    case "unprovisioned":
    case "schema-not-ready":
      // Positive evidence only: legacy installs keep today's behavior.
      return { kind: "unprovisioned" };
    case "db-error":
      return { kind: "db-error", error: resolution.error };
    case "not-found":
      return { kind: "unmatched" };
    case "mismatch":
      return { kind: "mismatch", reason: resolution.reason };
  }
}

/** Non-resolved account-row query used by admin/config helpers. */
export async function listActiveAccounts(
  channel: ChannelKind
): Promise<ChannelAccountRow[]> {
  return db
    .select()
    .from(channelAccounts)
    .where(
      and(
        eq(channelAccounts.channel, channel),
        eq(channelAccounts.status, "active"),
        inArray(channelAccounts.provider, PROVIDER_IDS)
      )
    );
}
