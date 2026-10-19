"use server";

import { db } from "@/db";
import { chatMessages, conversations } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
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
  // Mutación con envío real de mensajes — exige rol admin, no solo sesión.
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  try {
    // 1. Cargar la conversación y resolver el destinatario DESDE la fila —
    //    el `customerPhone` que llega del cliente nunca se confía: un viewer
    //    podría apuntar el envío a un número arbitrario (A-02).
    const [conv] = await db
      .select({
        channel: conversations.channel,
        channelAccountId: conversations.channelAccountId,
        customerPhone: conversations.customerPhone,
        externalUserId: conversations.externalUserId,
        whatsappId: conversations.whatsappId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv) {
      return { success: false, message: "Conversación no encontrada" };
    }

    // Mismo orden de resolución que el router de envíos:
    // customerPhone ?? externalUserId ?? whatsappId.
    const recipientPhone =
      conv.customerPhone ?? conv.externalUserId ?? conv.whatsappId ?? "";
    if (!recipientPhone) {
      return {
        success: false,
        message: "La conversación no tiene un destinatario resoluble",
      };
    }
    if (
      customerPhone &&
      customerPhone.replace(/\D/g, "") !== recipientPhone.replace(/\D/g, "")
    ) {
      // Sin PII en logs: solo la conversación y el hecho del mismatch.
      console.warn(
        `[dashboard-actions] triggerAgent phone mismatch on conversation ${conversationId} — using stored recipient`
      );
    }

    // 2. Cargar historial (últimos 20 mensajes)
    const history = await db
      .select({ role: chatMessages.role, content: chatMessages.content })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conversationId))
      .orderBy(chatMessages.createdAt)
      .limit(20);

    if (history.length === 0) {
      return { success: false, message: "La conversación no tiene mensajes" };
    }

    // 3. Mapear roles para OpenAI
    const aiMessages = history.map((m) => {
      if (m.role === "system") {
        return { role: "system" as const, content: m.content };
      }
      return {
        role: (m.role === "human" ? "assistant" : m.role) as "user" | "assistant",
        content: m.content,
      };
    });

    // 4. Resolver la identidad de envío (S15):
    //    - conversación con channelAccountId → esa channel_account
    //    - canal no-whatsapp sin binding → resolución por canal (fail closed)
    //    - whatsapp sin binding → la misma decisión de send-account que
    //      sendOutboundMessage: binding por teléfono, después la única cuenta
    //      activa; las credenciales legacy solo aplican a un canal realmente
    //      unprovisioned y jamás rescatan una resolución ambigua/fallida.
    const channel = conv.channel || "whatsapp";
    let account: ChannelAccount | undefined;
    let legacyCredentials: { apiKey: string; senderAddress: string } | undefined;
    if (conv.channelAccountId != null) {
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
      const decision = await resolveUnboundWhatsAppSend(recipientPhone, {
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

    // 5. Ejecutar agente
    const { text: responseText, pendingMedia } = await runWhatsAppAgent({
      conversationId,
      customerPhone: recipientPhone,
      messages: aiMessages,
    });

    // 6. Guardar respuesta en DB
    const { id: msgId } = await insertMessage(conversationId, "assistant", responseText);

    // 7. Enviar por el canal de la conversación — como la cuenta resuelta,
    //    o con las credenciales legacy cuando el canal está unprovisioned.
    const ycloudResult = await sendWhatsAppBubbles(
      account
        ? { to: recipientPhone, text: responseText, apiKey: "", from: "", channel, account }
        : {
            to: recipientPhone,
            text: responseText,
            apiKey: legacyCredentials?.apiKey ?? "",
            from: legacyCredentials?.senderAddress ?? "",
          }
    );

    // 8. Guardar wamid
    if (ycloudResult?.id) {
      await db
        .update(chatMessages)
        .set({ platformMessageId: ycloudResult.id })
        .where(eq(chatMessages.id, msgId));
    }

    // 9. Media pendiente
    if (pendingMedia.length > 0) {
      for (const media of pendingMedia) {
        if (media.type === "image" || media.type === "sticker") {
          await messenger.send(
            {
              to: recipientPhone,
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