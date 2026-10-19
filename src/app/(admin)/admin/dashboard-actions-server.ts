"use server";

import { db } from "@/db";
import { chatMessages, conversations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { auth } from "@/auth";
import { revalidatePath } from "next/cache";
import {
  messenger,
  resolveChannelAccount,
  resolveChannelAccountById,
} from "@/lib/messaging";
import {
  insertMessage,
  resolveConversationAccountForPhone,
  resolveDefaultWhatsAppAccount,
  resolveLegacyWhatsAppCredentials,
  resolveUnboundWhatsAppSend,
} from "@/lib/channels/router";
import { sendWhatsAppBubbles } from "@/lib/buffer/response-sender";
import { runWhatsAppAgent } from "@/lib/whatsapp/agent";
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
    //    - whatsapp sin binding → la misma decisión de send-account que
    //      sendOutboundMessage: binding por teléfono, después la única cuenta
    //      activa; las credenciales legacy solo aplican a un canal realmente
    //      unprovisioned y jamás rescatan una resolución ambigua/fallida.
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
    let legacyCredentials: { apiKey: string; senderAddress: string } | undefined;
    if (conv?.channelAccountId != null) {
      account = await resolveChannelAccountById(conv.channelAccountId);
      if (!account) {
        return {
          success: false,
          message: `La cuenta de canal #${conv.channelAccountId} no es resoluble`,
        };
      }
    } else if (channel !== "whatsapp") {
      account = await resolveChannelAccount(channel);
      if (!account) {
        return {
          success: false,
          message: `El canal '${channel}' no tiene proveedor registrado`,
        };
      }
    } else {
      const decision = await resolveUnboundWhatsAppSend(customerPhone, {
        resolveBinding: resolveConversationAccountForPhone,
        resolveDefaultAccount: resolveDefaultWhatsAppAccount,
        resolveLegacyCredentials: resolveLegacyWhatsAppCredentials,
      });
      if (decision.kind === "fail") {
        return {
          success: false,
          message: `Sin remitente seguro para WhatsApp: ${decision.reason}`,
        };
      }
      if (decision.kind === "account") {
        account = decision.account;
      } else {
        legacyCredentials = decision.credentials;
      }
    }

    // 4. Ejecutar agente
    const { text: responseText, pendingMedia } = await runWhatsAppAgent({
      conversationId,
      customerPhone,
      messages: aiMessages,
    });

    // 5. Guardar respuesta en DB
    const { id: msgId } = await insertMessage(conversationId, "assistant", responseText);

    // 6. Enviar por el canal de la conversación — como la cuenta resuelta,
    //    o con las credenciales legacy cuando el canal está unprovisioned.
    const ycloudResult = await sendWhatsAppBubbles(
      account
        ? { to: customerPhone, text: responseText, apiKey: "", from: "", channel, account }
        : {
            to: customerPhone,
            text: responseText,
            apiKey: legacyCredentials?.apiKey ?? "",
            from: legacyCredentials?.senderAddress ?? "",
          }
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
      for (const media of pendingMedia) {
        if (media.type === "image" || media.type === "sticker") {
          await messenger.send(
            {
              to: customerPhone,
              type: "image",
              mediaUrl: media.url,
              text: media.caption,
            },
            account
              ? { channel, account }
              : { credentials: legacyCredentials ?? { apiKey: "", senderAddress: "" } }
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