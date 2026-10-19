import { db } from "@/db";
import { conversations, chatMessages, leads, attachments } from "@/db/schema";
import { eq, and, desc, isNull, or } from "drizzle-orm";
import { normalizePhone } from "@/lib/phone-utils";
import {
  resolveConversationIdentity,
  type ConversationIdentityRepository,
} from "@/lib/messaging/conversation-identity";
import { isSchemaNotReady } from "@/lib/messaging/errors";
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
    async find(scopeChannel, scopeAccountId, normalizedExternalUserId) {
      const [row] = await db
        .select({
          id: conversations.id,
          channel: conversations.channel,
          channelAccountId: conversations.channelAccountId,
        })
        .from(conversations)
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
      return row
        ? {
            id: row.id,
            channel: row.channel as ChannelKind,
            channelAccountId: row.channelAccountId ?? null,
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
      await autoLinkLeadToConversation(finalPhone, resolved.record.id);
    }
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
  conversationId: number
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
        .set({ conversationId })
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
  | { kind: "db-error"; error: unknown };

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
      );
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
  const resolution = await resolveChannelAccountByIdStrict(accountId, "ycloud");
  if (resolution.kind === "resolved") {
    return {
      kind: "resolved",
      account: resolution.account,
      conversationId: rows[0].id,
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
  const resolution = await resolveChannelAccountStrict("whatsapp", [], "ycloud");
  switch (resolution.kind) {
    case "resolved":
      return { kind: "resolved", account: resolution.account };
    case "unprovisioned":
    case "schema-not-ready":
    case "not-found":
      return { kind: "unprovisioned" };
    case "mismatch":
      return { kind: "ambiguous", reason: resolution.reason };
    case "db-error":
      return { kind: "db-error", error: resolution.error };
    default:
      return { kind: "ambiguous", reason: "unresolved account state" };
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
    const { resolveAgentConfig } = await import("@/lib/agent-config-scope");
    // S13: the conversation's own channel_account_id/channel picks the scoped
    // config row (creds + sender). Legacy rows (both null) → global, unchanged.
    const cfg = await resolveAgentConfig({
      channel: conv.channel,
      channelAccountId: conv.channelAccountId,
    });
    const { decryptIfEncrypted } = await import("@/lib/encryption");
    const apiKey = decryptIfEncrypted(cfg?.ycloudApiKey) || process.env.YCLOUD_API_KEY || "";
    const from = process.env.WHATSAPP_PHONE_NUMBER || cfg?.phoneNumber || "";
    const to = conv.customerPhone ?? conv.externalUserId ?? "";

    if (!apiKey || !from) {
      throw new Error(
        `Conversation ${conversationId} has no resolvable WhatsApp credentials/sender`
      );
    }
    {
      const credentials = { apiKey, senderAddress: from };
      if (mediaUrl && mediaType === "image") {
        const res = await messenger.send(
          { to, type: "image", mediaUrl, text: content || undefined },
          { credentials }
        );
        if (!res.ok) throw new Error(res.error);
      } else if (mediaUrl && mediaType === "document") {
        const res = await messenger.send(
          { to, type: "document", mediaUrl, text: content || undefined },
          { credentials }
        );
        if (!res.ok) throw new Error(res.error);
      } else {
        const res = await messenger.send(
          { to, type: "text", text: content || " " },
          { credentials }
        );
        if (!res.ok) throw new Error(res.error);
      }
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
 * Busca el último pedido pendiente/preparando y le manda WhatsApp.
 */
export async function notifyCustomerDeliveryArrived(
  deliveryPhone: string
): Promise<string | null> {
  try {
    const { orders, agentConfig } = await import("@/db/schema");
    const { desc, and, inArray } = await import("drizzle-orm");
    
    // Buscar el último pedido pendiente o en preparación
    const [order] = await db
      .select({
        id: orders.id,
        phoneNumber: orders.phoneNumber,
        customerName: orders.customerName,
      })
      .from(orders)
      .where(
        and(
          inArray(orders.status, ["pending", "preparing"]),
        )
      )
      .orderBy(desc(orders.createdAt))
      .limit(1);

    if (!order?.phoneNumber) {
      // No hay pedidos pendientes — avisar al delivery
      const { messenger } = await import("@/lib/messaging");
      const [cfg] = await db.select().from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);
      const { decryptIfEncrypted } = await import("@/lib/encryption");
      const apiKey = decryptIfEncrypted(cfg?.ycloudApiKey) || process.env.YCLOUD_API_KEY || "";
      const from = process.env.WHATSAPP_PHONE_NUMBER || cfg?.phoneNumber || "";
      if (apiKey && from) {
        const res = await messenger.send(
          { to: deliveryPhone, type: "text", text: "Gracias, no hay pedidos pendientes." },
          { credentials: { apiKey, senderAddress: from } },
        );
        if (!res.ok) throw new Error(res.error);
      }
      return null;
    }

    // Enviar WhatsApp al cliente
    const { messenger } = await import("@/lib/messaging");
    const [cfg] = await db.select().from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);
    const { decryptIfEncrypted } = await import("@/lib/encryption");
    const apiKey = decryptIfEncrypted(cfg?.ycloudApiKey) || process.env.YCLOUD_API_KEY || "";
    const from = process.env.WHATSAPP_PHONE_NUMBER || cfg?.phoneNumber || "";

    const customerMsg = `¡Hola ${order.customerName || ""}! El delivery ya está afuera con tu pedido. Que lo disfrutes 🍔`.trim();

    if (apiKey && from) {
      const res = await messenger.send(
        { to: order.phoneNumber, type: "text", text: customerMsg },
        { credentials: { apiKey, senderAddress: from } },
      );
      if (!res.ok) throw new Error(res.error);
      console.log(`[delivery] Notified customer ${order.phoneNumber} about delivery arrival`);
    }

    return order.phoneNumber;
  } catch (error) {
    console.error("[delivery] Error notifying customer:", error);
    return null;
  }
}

/**
 * Reenvía la ubicación del cliente al número de delivery.
 */
export async function forwardLocationToDelivery(
  customerName: string | null,
  customerPhone: string,
  address: string,
  lat: number,
  lng: number,
  deliveryPhone: string
): Promise<boolean> {
  try {
    const { messenger } = await import("@/lib/messaging");
    const { agentConfig } = await import("@/db/schema");
    const [cfg] = await db.select().from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);
    const { decryptIfEncrypted } = await import("@/lib/encryption");
    const apiKey = decryptIfEncrypted(cfg?.ycloudApiKey) || process.env.YCLOUD_API_KEY || "";
    const from = process.env.WHATSAPP_PHONE_NUMBER || cfg?.phoneNumber || "";

    if (!apiKey || !from || !deliveryPhone) return false;

    const mapsLink = `https://www.google.com/maps?q=${lat},${lng}`;
    const message = [
      `📍 Cliente: ${customerName || "Sin nombre"}`,
      `Dirección: ${address}`,
      `Ubicación: ${mapsLink}`,
      `Tel: ${customerPhone}`,
    ].join("\n");

    const res = await messenger.send(
      { to: deliveryPhone, type: "text", text: message },
      { credentials: { apiKey, senderAddress: from } },
    );
    if (!res.ok) throw new Error(res.error);

    console.log(`[delivery] Location forwarded to ${deliveryPhone} for customer ${customerPhone}`);
    return true;
  } catch (error) {
    console.error("[delivery] Error forwarding location:", error);
    return false;
  }
}
