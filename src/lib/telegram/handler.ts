import { generateText, stepCountIs } from "ai";
import { getFastModel } from "@/lib/ai/config";
import {
  sendTelegramMessage,
  downloadTelegramFile,
  type TelegramUpdate,
  type TelegramConfig,
  isChatAuthorized,
} from "./bot";
import { internalAgentTools } from "./tools";
import { buildTelegramPrompt } from "./prompt-builder";
import { transcribeAudio } from "@/lib/media/transcription";
import { processImageWithVision } from "@/lib/media/vision";
import { findOrCreateConversation, insertMessage } from "@/lib/channels/router";
import type { MediaAttachment } from "@/lib/channels/router";

export type HandleResult =
  | { ok: true; replied: boolean; replyText?: string }
  | { ok: false; error: string };

/**
 * Procesa un update entrante de Telegram.
 * Soporta: texto, voice, audio, photo, document
 */
export async function handleTelegramUpdate(
  update: TelegramUpdate,
  config: TelegramConfig
): Promise<HandleResult> {
  const message = update.message;
  if (!message) {
    return { ok: true, replied: false };
  }

  const chatId = message.chat.id;
  let text = message.text?.trim() || "";
  let storedMediaMessageId: number | undefined;

  // ── Verificar autorización PRIMERO ──
  if (!isChatAuthorized(chatId, config.allowedChatIds)) {
    const unauthorizedReply =
      "❌ No autorizado. No tengo instrucciones de responder en este chat.";
    await sendTelegramMessage(config.botToken, chatId, unauthorizedReply);
    return { ok: true, replied: true, replyText: unauthorizedReply };
  }

  // ── Audio/Voice → transcribir con Whisper ──
  const voiceOrAudio = message.voice || message.audio;
  if (!text && voiceOrAudio) {
    const file = await downloadTelegramFile(config.botToken, voiceOrAudio.file_id);
    if (file) {
      const transcription = await transcribeAudio(file.buffer, file.filePath);
      text = transcription ? `[Audio]: ${transcription}` : "[Audio sin transcripción]";
      if (transcription) {
        console.log(`[telegram-handler] Audio transcribed: ${transcription.slice(0, 100)}`);
      }
    } else {
      text = "[Audio sin transcripción]";
    }
  }

  // ── Photo → descargar + Vision ──
  if (!text && message.photo && message.photo.length > 0) {
    const photo = message.photo[message.photo.length - 1]; // mayor resolución
    const file = await downloadTelegramFile(config.botToken, photo.file_id);
    if (file) {
      try {
        // Persistir en conversation + attachments
        const { id: conversationId } = await findOrCreateConversation(
          "telegram",
          String(chatId),
          message.from?.first_name
        );

        const attachment: MediaAttachment = {
          type: "image",
          url: file.filePath,
          mimeType: "image/jpeg",
          caption: message.caption,
        };

        const { id: msgId } = await insertMessage(conversationId, "user", "[Imagen recibida]", [attachment]);
        storedMediaMessageId = msgId;

        // Get attachment ID
        const { db } = await import("@/db");
        const { attachments: attachmentsTable } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        const [att] = await db
          .select({ id: attachmentsTable.id })
          .from(attachmentsTable)
          .where(eq(attachmentsTable.messageId, msgId))
          .limit(1);

        const captionCtx = message.caption ? `Caption: ${message.caption}` : undefined;
        const visionResult = await processImageWithVision(
          file.buffer, "image/jpeg", att?.id || 0, msgId, captionCtx
        );

        text = visionResult.agentText;
        if (visionResult.backgroundPersist) visionResult.backgroundPersist();

        console.log(`[telegram-handler] Photo analyzed: ${text.slice(0, 100)}`);
      } catch (err) {
        console.error("[telegram-handler] Photo processing error:", err);
        text = "Recibí tu foto. ¿En qué te ayudo?";
      }
    } else {
      text = "Recibí tu foto pero no pude descargarla. ¿Podés mandarla de nuevo?";
    }
  }

  // ── Document → descargar, Vision si es imagen ──
  if (!text && message.document) {
    const doc = message.document;
    const file = await downloadTelegramFile(config.botToken, doc.file_id);
    if (file) {
      const isImage = doc.mime_type?.startsWith("image/") || false;

      try {
        const { id: conversationId } = await findOrCreateConversation(
          "telegram",
          String(chatId),
          message.from?.first_name
        );

        const attachment: MediaAttachment = {
          type: "document",
          url: file.filePath,
          fileName: doc.file_name,
          mimeType: doc.mime_type,
          caption: message.caption,
        };

        const { id: msgId } = await insertMessage(
          conversationId, "user",
          isImage ? "[Imagen recibida]" : `[Documento]: ${doc.file_name || "archivo"}`,
          [attachment]
        );
        storedMediaMessageId = msgId;

        if (isImage) {
          const { db } = await import("@/db");
          const { attachments: attachmentsTable } = await import("@/db/schema");
          const { eq } = await import("drizzle-orm");
          const [att] = await db
            .select({ id: attachmentsTable.id })
            .from(attachmentsTable)
            .where(eq(attachmentsTable.messageId, msgId))
            .limit(1);

          const visionResult = await processImageWithVision(
            file.buffer, doc.mime_type || "image/jpeg", att?.id || 0, msgId
          );
          text = visionResult.agentText;
          if (visionResult.backgroundPersist) visionResult.backgroundPersist();
        } else {
          text = `[Documento]: ${doc.file_name || "archivo"}${message.caption ? ` — "${message.caption}"` : ""}`;
        }

        console.log(`[telegram-handler] Document processed: ${text.slice(0, 100)}`);
      } catch (err) {
        console.error("[telegram-handler] Document processing error:", err);
        text = `Recibí tu documento${doc.file_name ? ` (${doc.file_name})` : ""}. ¿En qué te ayudo?`;
      }
    } else {
      text = "Recibí tu documento pero no pude descargarlo. ¿Podés mandarlo de nuevo?";
    }
  }

  // ── Nada que procesar ──
  if (!text) {
    return { ok: true, replied: false };
  }

  // ── Cargar historial de conversación para contexto ──
  let conversationMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  try {
    const { id: conversationId } = await findOrCreateConversation(
      "telegram",
      String(chatId),
      message.from?.first_name
    );

    const { getConversationMessages } = await import("@/lib/channels/router");
    // Cargar historial para mantener contexto entre mensajes.
    // El LLM usa esto para entender referencias como "ese mismo" o "ahora mandale un WhatsApp".
    // El system prompt instruye a tratar cada solicitud como independiente por defecto.
    const history = await getConversationMessages(conversationId, 25);
    conversationMessages = history
      .filter((m) => m.id !== storedMediaMessageId && (m.role === "user" || m.role === "assistant"))
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

    // Persistir el mensaje actual
    if (storedMediaMessageId !== undefined) {
      const { db } = await import("@/db");
      const { chatMessages } = await import("@/db/schema");
      const { eq } = await import("drizzle-orm");
      await db.update(chatMessages).set({ content: text }).where(eq(chatMessages.id, storedMediaMessageId));
    } else {
      await insertMessage(conversationId, "user", text);
    }
  } catch (err) {
    console.warn("[telegram-handler] History load failed, continuing stateless", err);
  }

  // Agregar mensaje actual al final del historial
  conversationMessages.push({ role: "user", content: text });

  try {
    const result = await generateText({
      model: await getFastModel(),
      system: await buildTelegramPrompt(),
      messages: conversationMessages,
      tools: internalAgentTools,
      stopWhen: stepCountIs(10),
    });

    const reply = result.text || "Disculpá, no pude procesar eso.";

    // Persistir respuesta del agente
    try {
      const { id: conversationId } = await findOrCreateConversation(
        "telegram", String(chatId), message.from?.first_name
      );
      await insertMessage(conversationId, "assistant", reply);
    } catch { /* non-fatal */ }

    await sendTelegramMessage(config.botToken, chatId, reply);

    return { ok: true, replied: true, replyText: reply };
  } catch (error) {
    console.error("[telegram-handler] Error:", error);
    const errorReply =
      "❌ Tuve un error interno. Mandale 'hola' de nuevo si querés.";
    await sendTelegramMessage(config.botToken, chatId, errorReply);
    return { ok: true, replied: true, replyText: errorReply };
  }
}
