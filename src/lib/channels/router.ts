import { db } from "@/db";
import { conversations, chatMessages, leads, attachments } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { normalizePhone } from "@/lib/phone-utils";

export type Channel = "whatsapp" | "telegram";

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

// Find or create conversation, returns { id, isNew }
export async function findOrCreateConversation(
  channel: Channel,
  externalUserId: string,
  customerName?: string,
  customerPhone?: string
): Promise<{ id: number; isNew: boolean }> {
  // Try to find existing by channel + externalUserId
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.channel, channel),
        eq(conversations.externalUserId, externalUserId)
      )
    )
    .limit(1);

  if (existing[0]) {
    return { id: existing[0].id, isNew: false };
  }

  // For WhatsApp, also check by whatsappId (backward compat)
  if (channel === "whatsapp") {
    const byWaId = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.whatsappId, externalUserId))
      .limit(1);

    if (byWaId[0]) {
      // Update with new fields
      await db
        .update(conversations)
        .set({
          channel: "whatsapp",
          externalUserId,
        })
        .where(eq(conversations.id, byWaId[0].id));
      return { id: byWaId[0].id, isNew: false };
    }
  }

  // Create new
  const [conv] = await db
    .insert(conversations)
    .values({
      whatsappId:
        channel === "whatsapp" ? externalUserId : `tg_${externalUserId}`,
      customerName: customerName || null,
      customerPhone: normalizePhone(customerPhone || externalUserId),
      channel,
      externalUserId,
      status: "active",
      lastMessageAt: new Date(),
      lastMessagePreview: null,
    })
    .returning({ id: conversations.id });

  // Auto-link lead by phone number if a new conversation was created
  const finalPhone = customerPhone ? normalizePhone(customerPhone) : externalUserId;
  if (finalPhone) {
    await autoLinkLeadToConversation(finalPhone, conv.id);
  }

  return { id: conv.id, isNew: true };
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
  platformMessageId?: string
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

  const channel = conv.channel || "whatsapp";

  if (channel === "whatsapp") {
    const { messenger } = await import("@/lib/messaging");
    const { agentConfig } = await import("@/db/schema");
    const config = await db.select().from(agentConfig).limit(1);
    const cfg = config[0];
    const { decryptIfEncrypted } = await import("@/lib/encryption");
    const apiKey = decryptIfEncrypted(cfg?.ycloudApiKey) || process.env.YCLOUD_API_KEY || "";
    const from = process.env.WHATSAPP_PHONE_NUMBER || cfg?.phoneNumber || "";
    const to = conv.customerPhone ?? conv.externalUserId ?? "";

    if (apiKey && from) {
      if (mediaUrl && mediaType === "image") {
        await messenger.send({ to, type: "image", mediaUrl, text: content || undefined });
      } else if (mediaUrl && mediaType === "document") {
        await messenger.send({ to, type: "document", mediaUrl, text: content || undefined });
      } else {
        const res = await messenger.send(
          { to, type: "text", text: content || " " },
          { credentials: { apiKey, senderAddress: from } }
        );
        if (!res.ok) throw new Error(res.error);
      }
    }
  } else if (channel === "telegram") {
    const { sendTelegramMessage, getTelegramConfigFromDB } = await import(
      "@/lib/telegram/bot"
    );
    const tgConfig = await getTelegramConfigFromDB();
    if (tgConfig?.botToken && conv.externalUserId) {
      await sendTelegramMessage(
        tgConfig.botToken,
        Number(conv.externalUserId),
        content || (mediaUrl || "")
      );
    }
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
