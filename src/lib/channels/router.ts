import { db } from "@/db";
import { conversations, chatMessages, leads, attachments } from "@/db/schema";
import { eq, and, desc, isNull, or } from "drizzle-orm";
import { normalizePhone } from "@/lib/phone-utils";
import {
  resolveConversationIdentity,
  isPhoneChannel,
  type ConversationIdentityRepository,
} from "@/lib/messaging/conversation-identity";
import { ensureLeadIdentity } from "@/lib/messaging/lead-identity";
import { isSchemaNotReady } from "@/lib/messaging/errors";
import { notifyDeliveryArrived } from "@/lib/whatsapp/delivery-notify";
import type { DeliveryNotifyResult } from "@/lib/whatsapp/delivery-notify";
import type { ChannelAccount, ChannelKind, OutboundMessage } from "@/lib/messaging/types";

// Full channel universe (parity with schema channelEnum / ChannelKind).
// Widened in S12 — social channels persist conversations without a phone.
export type Channel = ChannelKind;

export interface MediaAttachment {
  type: "image" | "audio" | "document" | "video";
  url: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  caption?: string;
  transcription?: string;
  description?: string;
}

export interface IncomingMessage {
  channel: Channel;
  externalUserId: string; // phone for WA, chatId string for TG
  senderName: string;
  content: string;
  messageId: string; // for deduplication
  contentAttributes?: MediaAttachment[];
}

// Find or create conversation, returns { id, isNew, channel, channelAccountId }
// channelAccountId (S12/S17): stamps the channel_accounts row that owns this
// conversation. Identity is account-aware: account B never reuses account A's
// row, and a legacy null-account row is never silently rebound.
export async function findOrCreateConversation(
  channel: Channel,
  externalUserId: string,
  customerName?: string,
  customerPhone?: string,
  channelAccountId?: number | null
): Promise<{
  id: number;
  isNew: boolean;
  channel: ChannelKind;
  channelAccountId: number | null;
}> {
  const repo: ConversationIdentityRepository = {
    async find(
      scopeChannel,
      scopeAccountId,
      normalizedExternalUserId,
      externalUserId
    ) {
      const select = () =>
        db
          .select({
            id: conversations.id,
            channel: conversations.channel,
            channelAccountId: conversations.channelAccountId,
          })
          .from(conversations);

      const [row] = await select()
        .where(
          and(
            eq(conversations.channel, scopeChannel),
            eq(
              conversations.externalUserIdNormalized,
              normalizedExternalUserId
            ),
            scopeAccountId == null
              ? isNull(conversations.channelAccountId)
              : eq(conversations.channelAccountId, scopeAccountId)
          )
        )
        .limit(1);
      if (row) {
        return {
          id: row.id,
          channel: row.channel as ChannelKind,
          channelAccountId: row.channelAccountId ?? null,
        };
      }

      // Legacy rows created before `external_user_id` existed have only
      // `whatsapp_id` (whatsapp/telegram). Only the unbound/null-account
      // identity may adopt them — a bound account must never pick one up.
      if (scopeAccountId != null) return null;
      const legacyKeys =
        scopeChannel === "telegram"
          ? [
              `tg_${externalUserId ?? ""}`,
              `tg_${normalizedExternalUserId}`,
            ]
          : scopeChannel === "whatsapp" || scopeChannel === "sms"
            ? [externalUserId ?? "", normalizedExternalUserId]
            : [];
      const legacyWhere = legacyKeys
        .filter((key) => key.length > 0)
        .map((key) => eq(conversations.whatsappId, key));
      if (legacyWhere.length === 0) return null;

      const [legacy] = await select()
        .where(
          and(
            eq(conversations.channel, scopeChannel),
            isNull(conversations.channelAccountId),
            legacyWhere.length === 1
              ? legacyWhere[0]
              : or(...legacyWhere)
          )
        )
        .limit(1);
      return legacy
        ? {
            id: legacy.id,
            channel: legacy.channel as ChannelKind,
            channelAccountId: legacy.channelAccountId ?? null,
          }
        : null;
    },
    async insert(input) {
      try {
        const phoneBacked =
          input.channel === "whatsapp" || input.channel === "telegram";
        const [conv] = await db
          .insert(conversations)
          .values({
            // Account-scoped rows never take the legacy whatsappId slot: it
            // is globally unique and would collide across accounts.
            whatsappId:
              input.channelAccountId == null && input.channel === "whatsapp"
                ? input.externalUserId
                : input.channelAccountId == null && input.channel === "telegram"
                  ? `tg_${input.externalUserId}`
                  : null,
            customerName: input.customerName || null,
            customerPhone:
              phoneBacked || input.customerPhone
                ? normalizePhone(input.customerPhone || input.externalUserId)
                : null,
            channel: input.channel,
            externalUserId: input.externalUserId,
            externalUserIdNormalized: input.externalUserIdNormalized,
            channelAccountId: input.channelAccountId,
            status: "active",
            lastMessageAt: new Date(),
            lastMessagePreview: null,
          })
          .returning({
            id: conversations.id,
            channel: conversations.channel,
            channelAccountId: conversations.channelAccountId,
          });
        return {
          kind: "inserted",
          record: {
            id: conv.id,
            channel: conv.channel as ChannelKind,
            channelAccountId: conv.channelAccountId ?? null,
          },
        };
      } catch (err: unknown) {
        if ((err as { code?: string } | null)?.code === "23505") {
          return { kind: "conflict" };
        }
        throw err;
      }
    },
  };

  const resolved = await resolveConversationIdentity(repo, {
    channel,
    externalUserId,
    channelAccountId: channelAccountId ?? null,
    customerName,
    customerPhone,
  });

  // Auto-link lead by phone number if a new conversation was created.
  if (resolved.isNew) {
    const finalPhone = customerPhone
      ? normalizePhone(customerPhone)
      : normalizePhone(externalUserId);
    if (finalPhone) {
      await autoLinkLeadToConversation(
        finalPhone,
        resolved.record.id,
        resolved.record.channelAccountId
      );
    }
  }

  // Phone-less channels key leads on lead_identities(channel, externalId).
  // Runs on every inbound (not just isNew) — it is one indexed lookup and
  // stays correct if an older conversation pre-dates the identity table.
  if (!isPhoneChannel(channel)) {
    await ensureLeadIdentity({
      channel,
      externalUserId,
      externalUserIdNormalized: resolved.normalizedExternalUserId,
      customerName,
      customerPhone,
      channelAccountId: resolved.record.channelAccountId,
      conversationId: resolved.record.id,
    });
  }

  return {
    id: resolved.record.id,
    isNew: resolved.isNew,
    channel: resolved.record.channel,
    channelAccountId: resolved.record.channelAccountId,
  };
}

/**
 * Busca un lead por phone y vincula su conversationId si no lo tiene.
 * Se llama automáticamente cuando se crea una conversación nueva.
 */
async function autoLinkLeadToConversation(
  phone: string,
  conversationId: number,
  channelAccountId?: number | null
): Promise<void> {
  try {
    const [lead] = await db
      .select({ id: leads.id, conversationId: leads.conversationId })
      .from(leads)
      .where(eq(leads.phone, phone))
      .limit(1);

    if (lead && !lead.conversationId) {
      await db
        .update(leads)
        .set(
          channelAccountId != null
            ? { conversationId, channelAccountId }
            : { conversationId }
        )
        .where(eq(leads.id, lead.id));
      console.log(`[leads] Auto-linked lead #${lead.id} → conversation #${conversationId}`);
    }
  } catch (err) {
    console.warn(`[leads] Auto-link failed for phone ${phone}:`, err);
  }
}

export interface InsertMessageResult {
  id: number;
  /** true if this platformMessageId already existed (duplicate webhook) */
  wasDuplicate: boolean;
}

// Insert a message into chat_messages table
// Handles unique constraint violation on platformMessageId gracefully
// (race condition from duplicate YCloud webhook calls)
export async function insertMessage(
  conversationId: number,
  role: "user" | "assistant" | "system" | "human",
  content: string,
  contentAttributes?: MediaAttachment[],
  platformMessageId?: string,
  channelAccountId?: number | null
): Promise<InsertMessageResult> {
  const preview = content.slice(0, 250);

  let msg: { id: number };

  try {
    [msg] = await db
      .insert(chatMessages)
      .values({
        conversationId,
        role,
        content,
        contentAttributes: contentAttributes || [],
        platformMessageId: platformMessageId || null,
        channelAccountId: channelAccountId ?? null,
      })
      .returning({ id: chatMessages.id });
  } catch (err: unknown) {
    // P0001 / 23505 = unique_violation on platform_message_id
    // If this is a duplicate platformMessageId, return the existing message ID
    if (platformMessageId && (err as { code?: string } | null)?.code === "23505") {
      const [existing] = await db
        .select({ id: chatMessages.id })
        .from(chatMessages)
        .where(eq(chatMessages.platformMessageId, platformMessageId))
        .limit(1);
      if (existing) {
        console.log(`[router] Duplicate platformMessageId ${platformMessageId} — returning existing msg ${existing.id}`);
        return { id: existing.id, wasDuplicate: true };
      }
    }
    // If it's NOT a duplicate on platformMessageId, re-throw
    throw err;
  }

  // Update conversation last message
  await db
    .update(conversations)
    .set({
      lastMessageAt: new Date(),
      lastMessagePreview: preview,
      updatedAt: new Date(),
    })
    .where(eq(conversations.id, conversationId));

  // Auto-attach media to lead
  if (contentAttributes && contentAttributes.length > 0 && role === "user") {
    autoAttachToLead(conversationId, msg.id, contentAttributes).catch((err) =>
      console.error("[router] autoAttach failed:", err)
    );
  }

  return { id: msg.id, wasDuplicate: false };
}

async function autoAttachToLead(
  conversationId: number,
  messageId: number,
  contentAttributes: MediaAttachment[]
): Promise<void> {
  if (!contentAttributes || contentAttributes.length === 0) return;

  try {
    // Find lead by conversation
    const [conv] = await db
      .select({ customerPhone: conversations.customerPhone })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv?.customerPhone) return;

    // Find lead by phone
    const leadRows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.phone, conv.customerPhone))
      .limit(1);

    const leadId = leadRows[0]?.id || null;

    // Create attachment for each media item
    for (const media of contentAttributes) {
      await db.insert(attachments).values({
        leadId,
        conversationId,
        messageId,
        type: media.type,
        url: media.url,
        fileName: media.fileName || null,
        mimeType: media.mimeType || null,
        fileSize: media.fileSize || null,
        caption: media.caption || null,
      });
    }
  } catch (error) {
    console.error("[router] autoAttachToLead error:", error);
    // Non-fatal — don't break message flow
  }
}

// Check if message was already processed (deduplication)
export async function isMessageDuplicate(
  platformMessageId: string
): Promise<boolean> {
  if (!platformMessageId) return false;

  const existing = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.platformMessageId, platformMessageId))
    .limit(1);

  return existing.length > 0;
}

// Get messages for a conversation
export async function getConversationMessages(
  conversationId: number,
  limit = 50,
  offset = 0
) {
  // Select the most recent page first; callers receive chronological order.
  const recent = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
    .limit(limit)
    .offset(offset);
  return recent.reverse();
}

// Check if a human sent messages recently (last 60s)
// Used by the buffer callback to abort AI processing when human is active
export async function checkRecentHumanActivity(
  conversationId: number,
  withinSeconds = 60
): Promise<boolean> {
  const cutoff = new Date(Date.now() - withinSeconds * 1000);
  const recent = await db
    .select({ id: chatMessages.id, createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.conversationId, conversationId),
        eq(chatMessages.role, "human"),
      )
    )
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);

  if (recent.length === 0) return false;

  const msgTime = recent[0].createdAt instanceof Date
    ? recent[0].createdAt.getTime()
    : new Date(recent[0].createdAt).getTime();

  return msgTime > cutoff.getTime();
}

export type BoundAccountResolution =
  /** No conversation, or conversation without a channel_account binding. */
  | { kind: "unbound" }
  /** Conversation is bound and the account resolved cleanly. */
  | { kind: "resolved"; account: ChannelAccount; conversationId: number }
  /** Bound but missing/inactive/unregistered — callers must fail closed. */
  | { kind: "unresolvable"; accountId: number; reason: string }
  /** The same phone has conversations on several accounts — no safe sender. */
  | { kind: "ambiguous"; accountIds: number[] }
  /** Transient lookup failure — caller must surface a retryable error. */
  | { kind: "error"; error: unknown; retryable: boolean };

export type DefaultAccountResolution =
  | { kind: "unprovisioned" }
  | { kind: "resolved"; account: ChannelAccount }
  | { kind: "ambiguous"; reason: string }
  /** Rows exist but no active provider account — hard fail, not legacy. */
  | { kind: "not-found"; reason: string }
  | { kind: "db-error"; error: unknown };

/** Prefer the row actually bound to the selected account over a legacy row. */
export function selectBoundConversationId(
  rows: readonly { id: number; channelAccountId: number | null }[],
  accountId: number
): number | undefined {
  return rows.find((row) => row.channelAccountId === accountId)?.id;
}

/**
 * Resolve the channel_account bound to an existing WhatsApp conversation
 * addressed by canonical (+/digits) phone. Read-only — no conversation is
 * created. Multiple conversations for the same phone on different accounts
 * are ambiguous and fail closed instead of picking a global/wrong sender.
 */
export async function resolveConversationAccountForPhone(
  phone: string
): Promise<BoundAccountResolution> {
  const digits = normalizePhone(phone);
  if (!digits) return { kind: "unbound" };

  let rows: { id: number; channelAccountId: number | null }[];
  try {
    rows = await db
      .select({
        id: conversations.id,
        channelAccountId: conversations.channelAccountId,
      })
      .from(conversations)
      .where(
        and(
          eq(conversations.channel, "whatsapp"),
          or(
            eq(conversations.externalUserIdNormalized, digits),
            eq(conversations.whatsappId, digits),
            eq(conversations.whatsappId, phone)
          )
        )
      )
      .orderBy(desc(conversations.id));
  } catch (error) {
    // Positively identified un-migrated install: legacy phone lookup is the
    // only available behavior. Any other DB error is surfaced.
    if (isSchemaNotReady(error)) return { kind: "unbound" };
    return { kind: "error", error, retryable: true };
  }

  if (rows.length === 0) return { kind: "unbound" };

  const accountIds = [
    ...new Set(
      rows
        .map((row) => row.channelAccountId)
        .filter((id): id is number => id != null)
    ),
  ];
  if (accountIds.length > 1) return { kind: "ambiguous", accountIds };
  if (accountIds.length === 0) return { kind: "unbound" };

  const accountId = accountIds[0];
  const { resolveChannelAccountByIdStrict } = await import("@/lib/messaging");
  // No expected provider: the row's own provider wins (kapso/zernio/ycloud) —
  // messenger.send already binds `account.provider`. A ycloud-only assumption
  // here mismatched every non-ycloud bound conversation into a silent drop.
  const resolution = await resolveChannelAccountByIdStrict(accountId);
  if (resolution.kind === "resolved") {
    const conversationId = selectBoundConversationId(rows, accountId);
    if (conversationId === undefined) {
      return { kind: "unbound" };
    }
    return {
      kind: "resolved",
      account: resolution.account,
      conversationId,
    };
  }
  if (resolution.kind === "db-error") {
    return { kind: "error", error: resolution.error, retryable: true };
  }
  return {
    kind: "unresolvable",
    accountId,
    reason: resolution.kind === "mismatch" ? resolution.reason : "missing/inactive",
  };
}

/**
 * Account for a phone-addressed send with no conversation binding. Exactly one
 * active WhatsApp account wins; zero keeps the legacy placeholder; several is
 * ambiguous and must fail closed.
 */
export async function resolveDefaultWhatsAppAccount(): Promise<DefaultAccountResolution> {
  const { resolveChannelAccountStrict } = await import("@/lib/messaging");
  // Provider-agnostic: exactly one active whatsapp account wins regardless of
  // provider — hard-coding ycloud dropped kapso/zernio-bound sends silently.
  const resolution = await resolveChannelAccountStrict("whatsapp", []);
  switch (resolution.kind) {
    case "resolved":
      return { kind: "resolved", account: resolution.account };
    case "unprovisioned":
    case "schema-not-ready":
      return { kind: "unprovisioned" };
    case "not-found":
      return {
        kind: "not-found",
        reason: "provisioned channel has no active matching account",
      };
    case "mismatch":
      return { kind: "ambiguous", reason: resolution.reason };
    case "db-error":
      return { kind: "db-error", error: resolution.error };
    default:
      return { kind: "ambiguous", reason: "unresolved account state" };
  }
}

export type LegacyWhatsAppCredentialsResolution =
  | {
      kind: "resolved";
      credentials: { apiKey: string; senderAddress: string };
    }
  | { kind: "missing"; reason: string }
  | { kind: "error"; error: unknown; retryable: boolean };

export interface UnboundWhatsAppSendDeps {
  resolveBinding(phone: string): Promise<BoundAccountResolution>;
  resolveDefaultAccount(): Promise<DefaultAccountResolution>;
  resolveLegacyCredentials(): Promise<LegacyWhatsAppCredentialsResolution>;
}

export type UnboundWhatsAppSendResolution =
  | { kind: "account"; account: ChannelAccount }
  | {
      kind: "legacy";
      credentials: { apiKey: string; senderAddress: string };
    }
  | { kind: "fail"; reason: string; retryable: boolean };

/**
 * Sender decision for a WhatsApp conversation with no account binding.
 *
 * The binding by phone wins, then the single active account. Only a genuinely
 * unprovisioned channel may use the legacy config/env credentials; ambiguous,
 * not-found, or transient lookup failures never fall back to them.
 */
export async function resolveUnboundWhatsAppSend(
  phone: string,
  deps: UnboundWhatsAppSendDeps
): Promise<UnboundWhatsAppSendResolution> {
  const { decideSendAccount } = await import("@/lib/messaging/send-account");
  const decision = await decideSendAccount(phone, {
    resolveBinding: deps.resolveBinding,
    resolveDefaultAccount: deps.resolveDefaultAccount,
  });
  if (decision.kind === "retry") {
    return { kind: "fail", reason: decision.reason, retryable: true };
  }
  if (decision.kind === "drop") {
    return { kind: "fail", reason: decision.reason, retryable: false };
  }
  if (decision.account) return { kind: "account", account: decision.account };

  const legacy = await deps.resolveLegacyCredentials();
  switch (legacy.kind) {
    case "resolved":
      return { kind: "legacy", credentials: legacy.credentials };
    case "missing":
      return { kind: "fail", reason: legacy.reason, retryable: false };
    case "error":
      return {
        kind: "fail",
        reason: "legacy credential lookup failed",
        retryable: legacy.retryable,
      };
  }
}

/**
 * Legacy credential path used ONLY when `channel_accounts` is unprovisioned.
 * A scoped row with a blank key is an explicit failure; only a global row or
 * a positively identified un-migrated schema may use the env install values.
 */
export async function resolveLegacyWhatsAppCredentials(): Promise<LegacyWhatsAppCredentialsResolution> {
  const { resolveAgentConfig, resolveAgentConfigStrict } = await import(
    "@/lib/agent-config-scope"
  );
  const { decryptIfEncrypted } = await import("@/lib/encryption");
  const scope = { channel: "whatsapp" as const, channelAccountId: null };

  let resolution: Awaited<ReturnType<typeof resolveAgentConfigStrict>>;
  try {
    resolution = await resolveAgentConfigStrict(scope);
  } catch (error) {
    return { kind: "error", error, retryable: true };
  }
  if (resolution.kind === "db-error") {
    return { kind: "error", error: resolution.error, retryable: true };
  }

  const schemaNotReady = resolution.kind === "schema-not-ready";
  const row =
    resolution.kind === "resolved"
      ? resolution.row
      : schemaNotReady
        ? await resolveAgentConfig(scope)
        : undefined;
  if (!row && resolution.kind === "not-found") {
    return {
      kind: "missing",
      reason: "no scoped/global WhatsApp config for an unprovisioned channel",
    };
  }

  const envAllowed =
    schemaNotReady ||
    (resolution.kind === "resolved" && resolution.source === "global");
  const apiKey =
    decryptIfEncrypted(row?.ycloudApiKey) ||
    (envAllowed ? process.env.YCLOUD_API_KEY ?? "" : "");
  const senderAddress =
    row?.phoneNumber || (envAllowed ? process.env.WHATSAPP_PHONE_NUMBER ?? "" : "");

  if (!apiKey) {
    return {
      kind: "missing",
      reason:
        resolution.kind === "resolved"
          ? `agent_config #${resolution.id} (${resolution.source}) has a blank ycloudApiKey`
          : "no ycloudApiKey for the WhatsApp config",
    };
  }
  if (!senderAddress) {
    return {
      kind: "missing",
      reason: "no WhatsApp sender phone for the config",
    };
  }
  return { kind: "resolved", credentials: { apiKey, senderAddress } };
}

/**
 * Persists the provider-native thread id (zernio conversationId) onto the
 * conversation — the send-routing handle for conversation-scoped providers.
 * Best-effort: never throws; a failed stamp is retried by the next inbound.
 */
export async function stampConversationThreadId(
  conversationId: number,
  threadId: string
): Promise<void> {
  try {
    await db
      .update(conversations)
      .set({ externalThreadId: threadId })
      .where(eq(conversations.id, conversationId));
  } catch (error) {
    console.warn(
      `[router] external_thread_id stamp failed for conv=${conversationId}`,
      error
    );
  }
}

// Send outbound message via the correct channel
export async function sendOutboundMessage(
  conversationId: number,
  content: string,
  role: "assistant" | "human" = "human",
  mediaUrl?: string,
  mediaType?: "image" | "document"
): Promise<void> {
  // Get conversation to know channel
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conv) throw new Error(`Conversation ${conversationId} not found`);

  const channel: ChannelKind = conv.channel || "whatsapp";

  // S15 — three delivery surfaces, resolved in this order:
  //   1. telegram conversations → internal bot (outside the provider model)
  //   2. unbound whatsapp conversations → legacy credentials path, verbatim
  //      (channel_accounts empty/unmigrated ⇒ identical behavior to before)
  //   3. account-bound or non-whatsapp messenger conversations →
  //      channel_accounts resolution + messenger.send({account}) — fail
  //      closed: an unresolvable account or unregistered channel throws and
  //      the caller surfaces it, never a silent drop or wrong-sender send.
  if (channel === "telegram") {
    const { sendTelegramMessage, getTelegramConfigFromDB } = await import(
      "@/lib/telegram/bot"
    );
    const tgConfig = await getTelegramConfigFromDB();
    if (!tgConfig?.botToken || !conv.externalUserId) {
      throw new Error(
        `Conversation ${conversationId} has no resolvable Telegram bot/chat`
      );
    }
    await sendTelegramMessage(
      tgConfig.botToken,
      Number(conv.externalUserId),
      content || (mediaUrl || "")
    );
  } else if (channel === "whatsapp" && conv.channelAccountId == null) {
    const { messenger } = await import("@/lib/messaging");
    const to = conv.customerPhone ?? conv.externalUserId ?? "";
    if (!to) {
      throw new Error(
        `Conversation ${conversationId} has no recipient address for WhatsApp`
      );
    }

    // Unbound conversation: resolve the sender by phone/active account first.
    // The install-global/env pair is allowed only when the channel is truly
    // unprovisioned — never as a way around an ambiguous/failed account lookup.
    const decision = await resolveUnboundWhatsAppSend(to, {
      resolveBinding: resolveConversationAccountForPhone,
      resolveDefaultAccount: resolveDefaultWhatsAppAccount,
      resolveLegacyCredentials: resolveLegacyWhatsAppCredentials,
    });
    if (decision.kind === "fail") {
      const error = new Error(
        `Conversation ${conversationId} has no safe WhatsApp sender: ${decision.reason}`
      ) as Error & { retryable?: boolean };
      error.retryable = decision.retryable;
      throw error;
    }

    const sendWithAccount = decision.kind === "account";
    const options = sendWithAccount
      ? { channel: "whatsapp" as const, account: decision.account }
      : { credentials: decision.credentials };
    if (mediaUrl && mediaType === "image") {
      const res = await messenger.send(
        { to, type: "image", mediaUrl, text: content || undefined },
        options
      );
      if (!res.ok) throw new Error(res.error);
    } else if (mediaUrl && mediaType === "document") {
      const res = await messenger.send(
        { to, type: "document", mediaUrl, text: content || undefined },
        options
      );
      if (!res.ok) throw new Error(res.error);
    } else {
      const res = await messenger.send(
        { to, type: "text", text: content || " " },
        options
      );
      if (!res.ok) throw new Error(res.error);
    }
  } else {
    const { messenger } = await import("@/lib/messaging");
    const {
      resolveChannelAccount,
      resolveChannelAccountById,
    } = await import("@/lib/messaging");

    const account = conv.channelAccountId != null
      ? await resolveChannelAccountById(conv.channelAccountId)
      : await resolveChannelAccount(channel);
    if (!account) {
      throw new Error(
        conv.channelAccountId != null
          ? `Channel account #${conv.channelAccountId} is not resolvable for conversation ${conversationId} (missing, inactive, or provider unregistered)`
          : `No messaging provider registered for channel '${channel}'`
      );
    }
    const to = conv.customerPhone ?? conv.externalUserId ?? "";
    if (!to) {
      throw new Error(
        `Conversation ${conversationId} has no recipient address for channel '${channel}'`
      );
    }
    const msg: OutboundMessage =
      mediaUrl && mediaType
        ? { to, type: mediaType, mediaUrl, text: content || undefined }
        : { to, type: "text", text: content || " " };
    // Conversation-scoped providers (zernio) send into the stored thread;
    // when it is absent the adapter opens a conversation to `to` instead.
    if (conv.externalThreadId) {
      msg.providerConversationId = conv.externalThreadId;
    }
    const res = await messenger.send(msg, { channel, account });
    if (!res.ok) throw new Error(res.error);
  }

  // Save the outbound message with contentAttributes if media attached
  const dbRole = role === "human" ? "assistant" : role;
  const attrs = mediaUrl && mediaType ? [{ type: mediaType, url: mediaUrl }] : undefined;
  await insertMessage(conversationId, dbRole, content || "[Media]", attrs);

  // If a human sent this from the admin panel, set humanOverrideUntil
  if (role === "human") {
    const overrideUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await db
      .update(conversations)
      .set({ humanOverrideUntil: overrideUntil, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    console.log(`[router] Human override set for conv ${conversationId} until ${overrideUntil.toISOString()}`);
  }
}

// ─── Delivery helpers ─────────────────────────────────────────────────────────

/**
 * Notifica al cliente que el delivery ya llegó.
 * Usa la cuenta/config resuelta para el evento (nunca agent_config id=1) y
 * devuelve un resultado explícito para que el webhook pueda reintentar.
 */
export interface DeliveryNotifyContext {
  account?: ChannelAccount;
  channelAccountId?: number | null;
  apiKey?: string;
  senderAddress?: string;
}

export async function notifyCustomerDeliveryArrived(
  deliveryPhone: string,
  ctx: DeliveryNotifyContext = {}
): Promise<DeliveryNotifyResult> {
  const { orders } = await import("@/db/schema");
  const { desc, and, inArray } = await import("drizzle-orm");
  const { messenger } = await import("@/lib/messaging");

  const account =
    ctx.account && (ctx.account.credentials.apiKey || ctx.account.senderAddress)
      ? ctx.account
      : undefined;

  const accountId =
    ctx.channelAccountId ??
    (ctx.account && Number(ctx.account.id) > 0 ? Number(ctx.account.id) : null);

  return notifyDeliveryArrived(deliveryPhone, {
    async findPendingOrder() {
      // Account-scoped notifications only consider orders whose lead belongs
      // to the same channel account. The unbound/legacy context keeps the
      // historical install-wide lookup.
      const selection = {
        phoneNumber: orders.phoneNumber,
        customerName: orders.customerName,
      };
      const status = inArray(orders.status, ["pending", "preparing"]);

      const [order] =
        accountId != null
          ? await db
              .select(selection)
              .from(orders)
              .innerJoin(leads, eq(orders.leadId, leads.id))
              .where(
                and(status, eq(leads.channelAccountId, accountId))
              )
              .orderBy(desc(orders.createdAt))
              .limit(1)
          : await db
              .select(selection)
              .from(orders)
              .where(status)
              .orderBy(desc(orders.createdAt))
              .limit(1);
      return order?.phoneNumber
        ? { phoneNumber: order.phoneNumber, customerName: order.customerName }
        : null;
    },
    async send(to, text) {
      const credentials =
        !account && ctx.apiKey && ctx.senderAddress
          ? { apiKey: ctx.apiKey, senderAddress: ctx.senderAddress }
          : undefined;
      if (!account && !credentials) {
        return {
          ok: false,
          error:
            "delivery notification has no resolved account or scoped credentials",
          retryable: false,
        };
      }
      return messenger.send(
        { to, type: "text", text },
        account
          ? { channel: "whatsapp", account }
          : { credentials: credentials! }
      );
    },
  });
}
