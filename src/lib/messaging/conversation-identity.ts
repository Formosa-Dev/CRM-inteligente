/**
 * Account-aware conversation identity.
 *
 * A conversation identity is (channel, channel_account_id, canonical external
 * user id). Legacy rows (channel_account_id IS NULL) keep the pre-S11
 * (channel, canonical external user id) identity.
 *
 * Safety rules:
 * - A bound account never adopts a legacy null-account row; it creates its own
 *   scoped row. Legacy history is left untouched.
 * - Two provisioned accounts may hold the same customer id; they never share a
 *   row and a request for account B never returns account A's conversation.
 * - Concurrent creates converge through the unique indexes: the loser re-reads
 *   the winner instead of failing the webhook.
 */

import { normalizePhone } from "@/lib/phone-utils";
import type { ChannelKind } from "./types";

const PHONE_CHANNELS = new Set<ChannelKind>(["whatsapp", "telegram", "sms"]);
const PHONE_SHAPED = /^[+\d\s().-]+$/;

/**
 * Channels whose customer identity is a phone number — `leads.phone` remains
 * their primary lead key. Social channels (instagram/facebook/reddit) key
 * leads through `lead_identities` instead (see `lead-identity.ts`).
 */
export function isPhoneChannel(channel: ChannelKind): boolean {
  return PHONE_CHANNELS.has(channel);
}

/**
 * Canonical identity key: digits for phone-shaped values on phone channels,
 * the trimmed raw id otherwise. A non-phone value (BSUID-only identity under
 * Meta phone-hiding, social handle) must NOT be digit-stripped — stripping
 * collapses distinct customers into "" or shared fragments.
 */
export function canonicalExternalUserId(
  channel: ChannelKind,
  value: string
): string {
  const trimmed = value.trim();
  if (PHONE_CHANNELS.has(channel) && PHONE_SHAPED.test(trimmed)) {
    return normalizePhone(trimmed);
  }
  return trimmed;
}

export interface ConversationIdentityRecord {
  id: number;
  channel: ChannelKind;
  channelAccountId: number | null;
}

export interface ConversationIdentityInsert {
  channel: ChannelKind;
  channelAccountId: number | null;
  externalUserId: string;
  externalUserIdNormalized: string;
  customerName?: string | null;
  customerPhone?: string | null;
}

export type IdentityInsertResult =
  | { kind: "inserted"; record: ConversationIdentityRecord }
  | { kind: "conflict" };

export interface ConversationIdentityRepository {
  find(
    channel: ChannelKind,
    channelAccountId: number | null,
    normalizedExternalUserId: string,
    /** Raw identity, used only for a legacy null-account fallback. */
    externalUserId?: string
  ): Promise<ConversationIdentityRecord | null>;
  insert(input: ConversationIdentityInsert): Promise<IdentityInsertResult>;
}

export type ConversationIdentityErrorCode =
  | "stale-account-mismatch"
  | "conflict-unresolved";

export class ConversationIdentityError extends Error {
  readonly code: ConversationIdentityErrorCode;

  constructor(code: ConversationIdentityErrorCode, message: string) {
    super(message);
    this.name = "ConversationIdentityError";
    this.code = code;
  }
}

export interface ConversationIdentityResult {
  record: ConversationIdentityRecord;
  isNew: boolean;
  normalizedExternalUserId: string;
}

/**
 * Finds or creates the conversation for an exact account scope. Never mutates a
 * legacy row and never returns a conversation owned by another account.
 */
export async function resolveConversationIdentity(
  repo: ConversationIdentityRepository,
  input: {
    channel: ChannelKind;
    externalUserId: string;
    channelAccountId: number | null;
    customerName?: string | null;
    customerPhone?: string | null;
  }
): Promise<ConversationIdentityResult> {
  const normalized = canonicalExternalUserId(
    input.channel,
    input.externalUserId
  );
  const accountId = input.channelAccountId ?? null;

  const existing = await repo.find(
    input.channel,
    accountId,
    normalized,
    input.externalUserId
  );
  if (existing) {
    assertConversationAccount(existing, accountId);
    return { record: existing, isNew: false, normalizedExternalUserId: normalized };
  }

  const inserted = await repo.insert({
    channel: input.channel,
    channelAccountId: accountId,
    externalUserId: input.externalUserId,
    externalUserIdNormalized: normalized,
    customerName: input.customerName,
    customerPhone: input.customerPhone,
  });
  if (inserted.kind === "inserted") {
    return {
      record: inserted.record,
      isNew: true,
      normalizedExternalUserId: normalized,
    };
  }

  // Unique-index race: another request inserted the same identity first.
  const raced = await repo.find(
    input.channel,
    accountId,
    normalized,
    input.externalUserId
  );
  if (raced) {
    assertConversationAccount(raced, accountId);
    return { record: raced, isNew: false, normalizedExternalUserId: normalized };
  }
  throw new ConversationIdentityError(
    "conflict-unresolved",
    `conversation identity conflict for channel '${input.channel}'`
  );
}

/**
 * Echo/send guard: the loaded conversation must belong to the account the
 * caller resolved. A present-but-different binding is a hard failure, never a
 * rebind or a fallback to another sender.
 */
export function assertConversationAccount(
  record: ConversationIdentityRecord,
  expectedChannelAccountId: number | null
): void {
  if (record.channelAccountId !== (expectedChannelAccountId ?? null)) {
    throw new ConversationIdentityError(
      "stale-account-mismatch",
      `conversation #${record.id} belongs to account ` +
        `${record.channelAccountId ?? "legacy"}, not ${expectedChannelAccountId ?? "legacy"}`
    );
  }
}
