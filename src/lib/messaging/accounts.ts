/**
 * Channel account resolver — the read seam between the `channel_accounts`
 * table and the messaging contract's `ChannelAccount` (slice S11).
 *
 * Resolution order:
 * 1. An `active` row in `channel_accounts` for the channel (matching
 *    `providerAccountId` when given) → mapped to the contract, credentials
 *    materialized from `credentialsRef` (`env:<PREFIX>*`, `agent_config`).
 * 2. No rows provisioned for the channel → the same secret-less placeholder
 *    `messenger.ts` builds for its default path (`{channel}:agent-config`),
 *    so delegated senders keep resolving agent_config → env.
 * 3. Rows exist for the channel but none matches the requested
 *    `providerAccountId`, or the channel has no registered provider →
 *    `undefined` (fail-closed: never silently send as a different account).
 *
 * The table lookup is wrapped in try/catch: deployments whose migration has
 * not run yet (or older installs) degrade to the placeholder path, which is
 * exactly today's behavior.
 */

import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { channelAccounts } from "@/db/schema";
import { getIntegrationSecrets, getYCloudApiKey } from "@/lib/integrations";
import { normalizePhone } from "@/lib/phone-utils";

import {
  PROVIDER_IDS,
  isProviderId,
  providerForChannel,
} from "./registry";
import type { ChannelAccount, ChannelKind, ProviderId } from "./types";

export type ChannelAccountRow = typeof channelAccounts.$inferSelect;

function toAccountStatus(value: string): ChannelAccount["status"] {
  return value === "disconnected" || value === "error" ? value : "active";
}

/**
 * `env:<PREFIX>*` refs (e.g. `env:YCLOUD_*`) map to
 * `<PREFIX>API_KEY` / `<PREFIX>WEBHOOK_SECRET` / `<PREFIX>ACCESS_TOKEN`.
 */
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
 * `agent_config` (or unset) → the existing agent_config → env pattern.
 * Only ycloud has a known store today; other providers return empty
 * credentials and delegated senders resolve downstream when they land.
 */
async function credentialsFromAgentConfig(
  provider: ProviderId
): Promise<ChannelAccount["credentials"]> {
  if (provider !== "ycloud") return { apiKey: "", webhookSecret: "" };
  const [apiKey, secrets] = await Promise.all([
    getYCloudApiKey(),
    getIntegrationSecrets(),
  ]);
  return { apiKey, webhookSecret: secrets.ycloudWebhookSecret };
}

async function resolveCredentials(
  row: ChannelAccountRow
): Promise<ChannelAccount["credentials"]> {
  const ref = row.credentialsRef?.trim();
  if (!ref || ref === "agent_config") {
    return credentialsFromAgentConfig(row.provider as ProviderId);
  }
  if (ref.startsWith("env:")) return credentialsFromEnv(ref);
  console.warn(
    `[messaging] channel_accounts #${row.id} has unknown credentialsRef '${ref}' — credentials left empty`
  );
  return { apiKey: "", webhookSecret: "" };
}

async function findAccountRow(
  channel: ChannelKind,
  providerAccountId?: string
): Promise<ChannelAccountRow | undefined> {
  const conditions = [
    eq(channelAccounts.channel, channel),
    eq(channelAccounts.status, "active"),
    inArray(channelAccounts.provider, PROVIDER_IDS),
  ];
  if (providerAccountId) {
    conditions.push(eq(channelAccounts.providerAccountId, providerAccountId));
  }
  const rows = await db
    .select()
    .from(channelAccounts)
    .where(and(...conditions))
    .orderBy(asc(channelAccounts.id))
    .limit(1);
  return rows[0];
}

async function hasAnyAccountRow(channel: ChannelKind): Promise<boolean> {
  const rows = await db
    .select({ id: channelAccounts.id })
    .from(channelAccounts)
    .where(
      and(eq(channelAccounts.channel, channel), eq(channelAccounts.status, "active"))
    )
    .limit(1);
  return rows.length > 0;
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

async function rowToAccount(
  row: ChannelAccountRow
): Promise<ChannelAccount | undefined> {
  if (!isProviderId(row.provider)) return undefined;
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

export async function resolveChannelAccount(
  channel: ChannelKind,
  providerAccountId?: string
): Promise<ChannelAccount | undefined> {
  let row: ChannelAccountRow | undefined;
  let tableAvailable = true;
  try {
    row = await findAccountRow(channel, providerAccountId);
  } catch (err) {
    // Table missing on un-migrated deploys — keep the legacy path alive.
    tableAvailable = false;
    console.warn(
      "[messaging] channel_accounts lookup failed — falling back to agent_config/env:",
      err
    );
  }

  if (row) return rowToAccount(row);

  if (providerAccountId && tableAvailable) {
    try {
      // A provisioned channel whose accounts don't include the requested id
      // must not fall back to another sender — fail closed instead.
      if (await hasAnyAccountRow(channel)) return undefined;
    } catch {
      // Treat lookup errors as "unprovisioned" → legacy fallback below.
    }
  }
  return fallbackAccount(channel);
}

/**
 * Resolve a bound account by its `channel_accounts` primary key — the
 * resolution path for `conversations.channelAccountId` (S15). Fail-closed:
 * missing/inactive rows, unknown providers, and an unavailable table all
 * return `undefined`; callers must surface the error, never fall back to a
 * different sender.
 */
export async function resolveChannelAccountById(
  accountId: number
): Promise<ChannelAccount | undefined> {
  let row: ChannelAccountRow | undefined;
  try {
    const rows = await db
      .select()
      .from(channelAccounts)
      .where(eq(channelAccounts.id, accountId))
      .limit(1);
    row = rows[0];
  } catch (err) {
    console.warn(
      `[messaging] channel_accounts lookup failed for id ${accountId}:`,
      err
    );
    return undefined;
  }
  if (!row || row.status !== "active") return undefined;
  return rowToAccount(row);
}

export type SenderAccountMatch =
  | { kind: "matched"; account: ChannelAccount }
  /** No active rows for the channel (or table unavailable) → legacy path. */
  | { kind: "unprovisioned" }
  /** Rows exist but none matches the sender — foreign account, fail closed. */
  | { kind: "unmatched" };

/**
 * Pure matcher — the business-side sender of an echo/self-send must equal an
 * active row's `senderAddress` or `providerAccountId` (digit-normalized for
 * E.164), or carry the row's `providerAccountId` verbatim (wabaId et al.).
 */
export function matchSenderInRows(
  rows: readonly ChannelAccountRow[],
  sender: { senderAddress?: string; providerAccountId?: string }
): ChannelAccountRow | undefined {
  const senderDigits = sender.senderAddress
    ? normalizePhone(sender.senderAddress)
    : "";
  return rows.find(
    (row) =>
      (sender.providerAccountId !== undefined &&
        sender.providerAccountId !== "" &&
        row.providerAccountId === sender.providerAccountId) ||
      (senderDigits !== "" &&
        (normalizePhone(row.senderAddress) === senderDigits ||
          normalizePhone(row.providerAccountId) === senderDigits))
  );
}

/**
 * Attribute an outbound/echo event's business-side sender to a provisioned
 * `channel_accounts` row (S15 echo human-override path). Tri-state so callers
 * can keep the legacy phone-only flow on unmigrated installs while refusing
 * foreign senders once any account is provisioned.
 */
export async function matchSenderToChannelAccount(
  channel: ChannelKind,
  sender: { senderAddress?: string; providerAccountId?: string }
): Promise<SenderAccountMatch> {
  let rows: ChannelAccountRow[];
  try {
    rows = await db
      .select()
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.channel, channel),
          eq(channelAccounts.status, "active"),
          inArray(channelAccounts.provider, PROVIDER_IDS)
        )
      );
  } catch (err) {
    console.warn(
      "[messaging] channel_accounts sender lookup failed — treating as unprovisioned:",
      err
    );
    return { kind: "unprovisioned" };
  }
  if (rows.length === 0) return { kind: "unprovisioned" };

  const row = matchSenderInRows(rows, sender);
  if (!row) return { kind: "unmatched" };
  const account = await rowToAccount(row);
  return account ? { kind: "matched", account } : { kind: "unmatched" };
}
