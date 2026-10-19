"use server";

import { db } from "@/db";
import { agentConfig, chatMessages, conversations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import type { ChannelAccount } from "@/lib/messaging/types";

/**
 * Activa el agente IA para una conversación sin respuesta.
 * Carga el historial, ejecuta runWhatsAppAgent y envía la respuesta por WhatsApp.
 */
export async function triggerAgentForConversation(
  conversationId: number,
  customerPhone: string
): Promise<{ success: boolean; message: string }> {
  const session = await auth();
  if (!session) return { success: false, message: "No autorizado" };

  try {
    // 1. Cargar historial (últimos 20 mensajes)
    const history = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.createdAt)
      .limit(20);

    if (history.length === 0) {
      return { success: false, message: "La conversación no tiene mensajes" };
    }

    // 2. Mapear roles para OpenAI
    const aiMessages = history.map((m) => {
      if (m.role === "system") {
        return { role: "system" as const, content: m.content };
      }
      return {
        role: (m.role === "human" ? "assistant" : m.role) as "user" | "assistant",
        content: m.content,
      };
    });

    // 3. Resolver la identidad de envío (S15):
    //    - conversación con channelAccountId → esa channel_account
    //    - canal no-whatsapp sin binding → resolución por canal (fail closed)
    //    - whatsapp sin binding → credenciales agent_config/env (legacy)
    const [conv] = await db
      .select({
        channel: conversations.channel,
        channelAccountId: conversations.channelAccountId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    const channel = conv?.channel || "whatsapp";
    let account: ChannelAccount | undefined;
    if (conv?.channelAccountId != null) {
      const { resolveChannelAccountById } = await import("@/lib/messaging");
      account = await resolveChannelAccountById(conv.channelAccountId);
      if (!account) {
        return {
          success: false,
          message: `La cuenta de canal #${conv.channelAccountId} no es resoluble`,
        };
      }
    } else if (channel !== "whatsapp") {
      const { resolveChannelAccount } = await import("@/lib/messaging");
      account = await resolveChannelAccount(channel);
      if (!account) {
        return {
          success: false,
          message: `El canal '${channel}' no tiene proveedor registrado`,
        };
      }
    }

    const [cfg] = await db
      .select({ ycloudApiKey: agentConfig.ycloudApiKey, phoneNumber: agentConfig.phoneNumber })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    const { decryptIfEncrypted } = await import("@/lib/encryption");
    const apiKey = decryptIfEncrypted(cfg?.ycloudApiKey) || process.env.YCLOUD_API_KEY || "";
    const from = process.env.WHATSAPP_PHONE_NUMBER || cfg?.phoneNumber || "";
    if (!account && (!apiKey || !from)) {
      return { success: false, message: "WhatsApp no configurado (falta API key)" };
    }

    // 4. Ejecutar agente
    const { runWhatsAppAgent } = await import("@/lib/whatsapp/agent");
    const { text: responseText, pendingMedia } = await runWhatsAppAgent({
      conversationId,
      customerPhone,
      messages: aiMessages,
    });

    // 5. Guardar respuesta en DB
    const { insertMessage } = await import("@/lib/channels/router");
    const { id: msgId } = await insertMessage(conversationId, "assistant", responseText);

    // 6. Enviar por el canal de la conversación — como la cuenta vinculada
    //    cuando existe, o con las credenciales legacy si es whatsapp sin
    //    binding (comportamiento idéntico al anterior).
    const { sendWhatsAppBubbles } = await import("@/lib/buffer/response-sender");
    const ycloudResult = await sendWhatsAppBubbles(
      account
        ? { to: customerPhone, text: responseText, apiKey: "", from: "", channel, account }
        : { to: customerPhone, text: responseText, apiKey, from }
    );

    // 7. Guardar wamid
    if (ycloudResult?.id) {
      await db
        .update(chatMessages)
        .set({ platformMessageId: ycloudResult.id })
        .where(eq(chatMessages.id, msgId));
    }

    // 8. Media pendiente
    if (pendingMedia.length > 0) {
      const { messenger } = await import("@/lib/messaging");
      for (const media of pendingMedia) {
        if (media.type === "image" || media.type === "sticker") {
          await messenger.send(
            {
              to: customerPhone,
              type: "image",
              mediaUrl: media.url,
              text: media.caption,
            },
            account ? { channel, account } : {}
          );
          await insertMessage(conversationId, "assistant", media.dbContent);
        }
      }
    }

    revalidatePath("/admin");
    return { success: true, message: `✅ Agente activado — respuesta enviada` };
  } catch (err) {
    console.error("[dashboard-actions] triggerAgent error:", err);
    return { success: false, message: "Error al activar el agente" };
  }
}