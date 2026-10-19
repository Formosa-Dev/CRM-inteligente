"use server";

import { db } from "@/db";
import { agentConfig, chatMessages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";

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

    // 3. Obtener credenciales WhatsApp
    const [cfg] = await db
      .select({ ycloudApiKey: agentConfig.ycloudApiKey, phoneNumber: agentConfig.phoneNumber })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    const { decryptIfEncrypted } = await import("@/lib/encryption");
    const apiKey = decryptIfEncrypted(cfg?.ycloudApiKey) || process.env.YCLOUD_API_KEY || "";
    const from = process.env.WHATSAPP_PHONE_NUMBER || cfg?.phoneNumber || "";
    if (!apiKey || !from) {
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

    // 6. Enviar por WhatsApp
    const { sendWhatsAppBubbles } = await import("@/lib/buffer/response-sender");
    const ycloudResult = await sendWhatsAppBubbles({
      to: customerPhone,
      text: responseText,
      apiKey,
      from,
    });

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
          await messenger.send({
            to: customerPhone,
            type: "image",
            mediaUrl: media.url,
            text: media.caption,
          });
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