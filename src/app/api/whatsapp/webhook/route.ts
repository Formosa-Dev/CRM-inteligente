import { NextRequest, NextResponse } from "next/server";
import { verifyYCloudSignature } from "@/lib/whatsapp/signature";
import { messenger } from "@/lib/messaging";
import { sendWhatsAppBubbles } from "@/lib/buffer/response-sender";
import {
  findOrCreateConversation,
  insertMessage,
  isMessageDuplicate,
  getConversationMessages,
  notifyCustomerDeliveryArrived,
  type MediaAttachment,
} from "@/lib/channels/router";
import { captureLeadIfNew } from "@/lib/whatsapp/lead-capture";
import { runWhatsAppAgent, resolveAgentRouting } from "@/lib/whatsapp/agent";
import { toSessionContext, type RoutingDecision } from "@/lib/whatsapp/session-policy";
import { resolveHandoffTransport } from "@/lib/whatsapp/human-handoff";
import { sendEscalationEmail } from "@/lib/whatsapp/tools/escalation-email";
import { db } from "@/db";
import { agentConfig, conversations, leads, addresses } from "@/db/schema";
import { eq } from "drizzle-orm";
import { normalizePhone, phoneInList } from "@/lib/phone-utils";
import { mergeBufferedTurn } from "@/lib/whatsapp/buffered-history";
import { buildTemporalAgentMessages } from "@/lib/whatsapp/temporal-context";
import { getActiveOrderSnapshot } from "@/lib/whatsapp/order-lifecycle";
import { resolveWhatsAppActor, shouldCaptureLead } from "@/lib/whatsapp/actor";
import { downloadYCloudMedia, saveMediaLocally } from "@/lib/media/downloader";
import { transcribeAudio } from "@/lib/media/transcription";
import { analyzeVideo } from "@/lib/media/video";
import { extractDocumentText } from "@/lib/media/document";
import { BufferManager } from "@/lib/buffer/manager";
import { scheduleBufferProcessing } from "@/lib/buffer/processor";
import { buildSellerPrompt, internalSellerTools } from "@/lib/whatsapp/seller-prompt";
import { generateText, stepCountIs } from "ai";
import { openai, type OpenAILanguageModelChatOptions } from "@ai-sdk/openai";
import {
  isProtocolArtifact,
  resolveSessionPersistence,
} from "@/lib/whatsapp/webhook-pipeline";
import {
  loadSessionState,
  persistSessionTransition,
} from "@/lib/whatsapp/session-store";
import { checkRateLimit } from "@/lib/infra/rate-limit";
import { buildWebOrderRedirectMessage } from "@/lib/whatsapp/web-order-redirect";

/**
 * GET — Webhook verification (YCloud sends a challenge token)
 */
export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) {
    return NextResponse.json({ error: "Missing token" }, { status: 400 });
  }
  return new NextResponse(token, { status: 200 });
}

// ─── Echo event types de YCloud ─────────────────────────────────────────────
const ECHO_EVENT_TYPES = [
  "whatsapp.message.echo",
  "whatsapp.smb.message.echoes",
];

// Keys candidatas donde puede venir el mensaje en el payload del echo
const ECHO_MESSAGE_KEYS = [
  "whatsappMessage",
  "whatsappSmbMessageEcho",
  "whatsappSmbMessageEchoes",
  "smbMessage",
  "message",
  "whatsappMessageEcho",
];

// ─── Echo handler ───────────────────────────────────────────────────────────
async function handleEcho(
  payload: Record<string, unknown>
): Promise<NextResponse> {
  try {
    // 1. Extraer el objeto mensaje del payload (búsqueda en múltiples keys)
    const event = payload as Record<string, unknown>;
    let msg: Record<string, unknown> | undefined;

    for (const key of ECHO_MESSAGE_KEYS) {
      const candidate = event[key];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        msg = candidate as Record<string, unknown>;
        break;
      }
    }

    // Fallback dinámico: buscar cualquier valor dict que tenga "to" o "from"
    if (!msg) {
      for (const [k, v] of Object.entries(event)) {
        if (["type", "id", "createTime", "sendTime", "apiVersion"].includes(k)) continue;
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const obj = v as Record<string, unknown>;
          if (obj.to || obj.from) {
            msg = obj;
            break;
          }
        }
      }
    }

    if (!msg) {
      console.warn("[webhook:echo] Could not extract message from echo payload", {
        type: event.type,
        keys: Object.keys(event).filter(k => !["type", "id", "createTime", "sendTime", "apiVersion"].includes(k)),
        hasTo: !!event.to,
        hasFrom: !!event.from,
      });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // 2. Extraer teléfonos
    // En un echo: from = quien envió (bot/staff), to = quien recibe (customer)
    const customerPhone = (msg.to || event.to) as string | undefined;
    const botPhone = (msg.from || event.from) as string | undefined;

    if (!customerPhone || !botPhone) {
      console.warn("[webhook:echo] Missing phone numbers in echo payload");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // 3. Extraer el contenido del mensaje
    const msgType = (msg.type as string) || "text";
    let displayText = "[Mensaje desde WhatsApp Business]";

    if (msgType === "text" && msg.text && typeof msg.text === "object") {
      displayText = (msg.text as Record<string, unknown>).body as string || displayText;
    } else if (["image", "audio", "document", "video"].includes(msgType)) {
      const mediaObj = msg[msgType] as Record<string, unknown> | undefined;
      const caption = mediaObj?.caption as string | undefined;
      displayText = caption || `[${msgType}]`;
    }

    const echoMsgId = (msg.id || event.id) as string | undefined;

    console.log(
      `[webhook:echo] Echo from ${botPhone} → ${customerPhone}: "${displayText.slice(0, 80)}"`
    );

    // 4. Buscar o crear conversación por el teléfono del customer
    //    findOrCreateConversation normaliza customerPhone internamente
    const { id: conversationId } = await findOrCreateConversation(
      "whatsapp",
      customerPhone,
      undefined,
      customerPhone
    );

    // 5. Dedup: si este echo ya tiene el mismo platformMessageId, skip
    if (echoMsgId) {
      const isDup = await isMessageDuplicate(echoMsgId);
      if (isDup) {
        console.log(`[webhook:echo] Duplicate echo ${echoMsgId} — skipping`);
        return NextResponse.json({ ok: true }, { status: 200 });
      }

      // Dedup adicional: si el contenido coincide con el ÚLTIMO mensaje
      // del assistant en los últimos 30s, es el eco de nuestra propia respuesta
      const recentMessages = await getConversationMessages(conversationId, 1);
      if (recentMessages.length > 0) {
        const last = recentMessages[0];
        const thirtySecAgo = Date.now() - 30_000;
        const msgTime = last.createdAt instanceof Date
          ? last.createdAt.getTime()
          : new Date(last.createdAt).getTime();

        if (
          last.role === "assistant" &&
          msgTime > thirtySecAgo &&
          last.content.trim() === displayText.trim()
        ) {
          console.log(`[webhook:echo] Skip — echo matches recent AI response (${echoMsgId})`);
          return NextResponse.json({ ok: true }, { status: 200 });
        }
      }
    }

    // 6. Determinar si este echo es del bot (AI) o de un humano
    //    Buscamos el mensaje original por platformMessageId.
    //    Si existe y era role="assistant" o role="system" → es eco de nuestra propia respuesta → NO override.
    //    Si NO existe o era role="human" → un humano respondió desde WhatsApp Business App → override 24h.
    let isOwnEcho = false;
    let foundRole: string | undefined;
    if (echoMsgId) {
      try {
        const { chatMessages: cmTable } = await import("@/db/schema");
        const [original] = await db
          .select({ role: cmTable.role })
          .from(cmTable)
          .where(eq(cmTable.platformMessageId, echoMsgId))
          .limit(1);
        foundRole = original?.role;
        // Si encontramos el mensaje original y era assistant o system → es eco propio
        // (system = status messages automáticos como "Ya esta tu pedido")
        isOwnEcho = original?.role === "assistant" || original?.role === "system";
      } catch {
        // Si falla la query, asumimos que NO es echo propio (más seguro para no perder override)
        isOwnEcho = false;
      }
    }

    if (echoMsgId && !foundRole) {
      console.log(`[webhook:echo] Echo ${echoMsgId} — no original message found by platformMessageId, treating as human echo`);
    }

    if (isOwnEcho) {
      // Es eco de nuestra propia respuesta AI → solo dedup, NO setear override
      console.log(`[webhook:echo] Own AI echo ${echoMsgId} — no human override needed`);
    } else {
      // Un humano respondió desde WhatsApp Business App → override 2h
      const overrideUntil = new Date(Date.now() + 2 * 60 * 60 * 1000);
      await db
        .update(conversations)
        .set({ humanOverrideUntil: overrideUntil, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));

      console.log(`[webhook:echo] Human override set for conversation ${conversationId} until ${overrideUntil.toISOString()}`);
    }

    // 7. Guardar el mensaje como human para diferenciar del AI
    //    Solo guardar si NO es echo propio (los echos propios ya tienen su mensaje guardado)
    if (!isOwnEcho) {
      // ── AUDIO: download + transcribe (P2) ─────────────────────────────────
      if (msgType === "audio") {
        const mediaObj = msg["audio"] as Record<string, unknown> | undefined;
        if (mediaObj?.id) {
          try {
            const [acConfig] = await db
              .select({ apiKey: agentConfig.ycloudApiKey })
              .from(agentConfig)
              .where(eq(agentConfig.id, 1))
              .limit(1);

            const { decryptIfEncrypted } = await import("@/lib/encryption");
            const mediaApiKey = decryptIfEncrypted(acConfig?.apiKey);
            if (mediaApiKey) {
              const { buffer, mimeType, filename } = await downloadYCloudMedia(
                mediaObj.id as string,
                mediaApiKey
              );
              const mediaUrl = await saveMediaLocally(buffer, conversationId, filename, mimeType);

              const contentAttachments: MediaAttachment[] = [{
                type: "audio",
                url: mediaUrl,
                fileName: (mediaObj.filename as string) || filename,
                mimeType,
                fileSize: mediaObj.fileSize as number | undefined,
              }];

              const echoInsert = await insertMessage(
                conversationId, "human", displayText,
                contentAttachments, echoMsgId
              );

              if (!echoInsert.wasDuplicate) {
                const storedMsgId = echoInsert.id;
                // Fire-and-forget: transcribe async, then update stored message
                transcribeAudio(buffer, filename, mimeType)
                  .then(async (transcription) => {
                    if (transcription && storedMsgId) {
                      const { chatMessages: cmTable } = await import("@/db/schema");
                      try {
                        const [stored] = await db
                          .select({ contentAttributes: cmTable.contentAttributes })
                          .from(cmTable)
                          .where(eq(cmTable.id, storedMsgId))
                          .limit(1);

                        if (stored?.contentAttributes) {
                          const attrs = stored.contentAttributes;
                          if (attrs.length > 0) attrs[0].transcription = transcription;
                          await db
                            .update(cmTable)
                            .set({
                              content: `[Audio]: ${transcription}`,
                              contentAttributes: attrs,
                            })
                            .where(eq(cmTable.id, storedMsgId));
                        }
                      } catch (updateErr) {
                        console.error("[webhook:echo] Failed to update transcription:", updateErr);
                      }
                    }
                  })
                  .catch(async (err) => {
                    console.error("[webhook:echo] Transcription failed for operator audio:", err);
                    // Spec OA-6: update content to fallback on failure
                    if (storedMsgId) {
                      try {
                        const { chatMessages: cmTable } = await import("@/db/schema");
                        await db
                          .update(cmTable)
                          .set({ content: "[Audio sin transcripción]" })
                          .where(eq(cmTable.id, storedMsgId));
                      } catch (updateErr) {
                        console.error("[webhook:echo] Failed to update fallback content:", updateErr);
                      }
                    }
                  });
              }

              return NextResponse.json({ ok: true }, { status: 200 });
            }
          } catch (mediaErr) {
            console.error("[webhook:echo] Audio processing error:", mediaErr);
            // Fall through to generic store
          }
        }
      }

      // Generic store (non-audio or audio fallback)
      const echoInsert = await insertMessage(
        conversationId,
        "human",
        displayText,
        undefined,
        echoMsgId
      );
      if (echoInsert.wasDuplicate) {
        console.log(`[webhook:echo] Duplicate echo ${echoMsgId} — already saved`);
      } else {
        console.log(`[webhook:echo] Echo saved as human message in conversation ${conversationId}`);
      }
    }

  } catch (error) {
    console.error("[webhook:echo] Error processing echo:", error);
    // Siempre devolver 200 para evitar retries de YCloud
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

// ─── Delivery handler ───────────────────────────────────────────────────────
async function handleDeliveryNotification(
  payload: Record<string, unknown>,
  config: typeof agentConfig.$inferSelect
): Promise<NextResponse> {
  try {
    const message = payload.whatsappInboundMessage as Record<string, unknown> | undefined;
    if (!message) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const msgType = message.type as string;
    const deliveryPhone = config.deliveryPhoneNumber;

    if (!deliveryPhone) {
      console.warn("[delivery] No delivery phone configured — ignoring message");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    console.log(`[delivery] Message from delivery (${deliveryPhone}): type=${msgType}`);

    if (msgType === "text") {
      // Delivery confirms arrival → notify customer
      const text = (message.text as Record<string, unknown> | undefined)?.body as string || "";
      console.log(`[delivery] Delivery says: "${text.slice(0, 80)}"`);

      await notifyCustomerDeliveryArrived(deliveryPhone);
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[delivery] Error handling delivery notification:", error);
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}

// ─── Check if AI is overridden by human ────────────────────────────────────
async function checkHumanOverride(conversationId: number): Promise<boolean> {
  try {
    const [conv] = await db
      .select({ humanOverrideUntil: conversations.humanOverrideUntil })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv?.humanOverrideUntil) return false; // no override → AI can respond

    // humanOverrideUntil en el futuro → override activo → AI no responde
    return new Date(conv.humanOverrideUntil).getTime() > Date.now();
  } catch (error) {
    // SDD memoria-persistente-sesion-whatsapp (W4): fail CLOSED. A DB error
    // must never be read as "no override" (that would let the AI answer over
    // a human). Treat as overridden so every caller skips AI/buffering; the
    // post-debounce revalidation stays fail-closed the same way.
    console.error("[webhook] Error checking human override — fail closed, AI skipped:", error);
    return true;
  }
}

/**
 * Maneja mensajes de VENDEDORES registrados.
 * Usa el mismo sistema que el bot de Telegram (internalAgentTools + INTERNAL_AGENT_SYSTEM_PROMPT)
 * pero respondiendo por WhatsApp en lugar de Telegram.
 * 
 * Los vendedores SIEMPRE hablan con la IA — no hay human override, no hay AI disabled.
 */


/**
 * Minimal webhook handoff transport (SDD memoria-persistente-sesion-whatsapp,
 * W2). Claims are at-most-once per episode/message and the transport follows
 * the same claims, so retries stay silent. The owner side (24h override write
 * + escalation email/Telegram) is deliverable even with AI disabled; the
 * customer reply is NEVER sent from this path while the IA stays off.
 */
async function deliverWebhookHandoff(input: {
  conversationId: number;
  customerName: string | null;
  customerPhone: string;
  messageId: string;
  decision: Extract<RoutingDecision, { kind: "handoff" }>;
}): Promise<void> {
  const { decision } = input;
  console.log(`[webhook:wa] Session handoff notifyClaim=${decision.notifyClaim} replyClaim=${decision.replyClaim} delivery=${decision.delivery} — persisting without GPT/tools or automatic replies`);
  const transport = resolveHandoffTransport({
    notifyClaim: decision.notifyClaim,
    replyClaim: decision.replyClaim,
    delivery: decision.delivery,
  });
  if (transport.writeOverride) {
    try {
      await db
        .update(conversations)
        .set({ humanOverrideUntil: new Date(Date.now() + 2 * 60 * 60 * 1000) })
        .where(eq(conversations.id, input.conversationId));
    } catch (overrideError) {
      console.error("[webhook:wa] Handoff override write failed — claim already durable", overrideError);
    }
  }
  if (transport.sendOwnerNotification) {
    try {
      await sendEscalationEmail({
        customerName: input.customerName ?? "Desconocido",
        customerPhone: input.customerPhone,
        reason: "Derivación automática por política de sesión (handoff determinístico)",
        category: "otro",
        conversationSummary:
          `Sesión handed_off — conversación ${input.conversationId}, ` +
          `episodio ${input.decision.state.episode}, mensaje ${input.messageId} ` +
          `(notifyClaim=${input.decision.notifyClaim} replyClaim=${input.decision.replyClaim} ` +
          `delivery=${input.decision.delivery})`,
        lastMessages: [],
      });
    } catch (notifyError) {
      console.error("[webhook:wa] Handoff owner notification failed — claim already durable", notifyError);
    }
  }
}

/**
 * POST — Incoming WhatsApp messages from YCloud
 */export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // 1. Verify webhook signature (header: ycloud-signature)
  const signature = request.headers.get("ycloud-signature") || "";
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secret = (await getIntegrationSecrets()).ycloudWebhookSecret;

  if (!secret) {
    console.error("[webhook:wa] YCLOUD_WEBHOOK_SECRET not set — rejecting");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  if (!verifyYCloudSignature(rawBody, signature, secret)) {
    console.error("[webhook:wa] Signature verification FAILED — check YCLOUD_WEBHOOK_SECRET matches YCloud dashboard");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Parse the payload
  const payload = JSON.parse(rawBody);

  // 2a. Protocol-eligibility gate FIRST: empty Business echoes and
  //     delivery/status events are acknowledged with 200 and cause no
  //     conversation lookup, session/event mutation, routing, or reply.
  //     Non-empty echoes (human override) still fall through to handleEcho.
  if (isProtocolArtifact(payload)) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // 2. Handle ECHO events (outgoing messages from WhatsApp Business App)
  //    Esto va ANTES del filtro de inbound messages porque los echoes
  //    tienen type diferente
  if (ECHO_EVENT_TYPES.includes(payload.type)) {
    return handleEcho(payload);
  }

  // 3. Filter non-message events (status updates, etc.)
  if (payload.type !== "whatsapp.inbound_message.received") {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const message = payload.whatsappInboundMessage;

  // Accept: text, image, audio, document, video, location — drop everything else
  const SUPPORTED_TYPES = ["text", "image", "audio", "document", "video", "location"] as const;
  type SupportedType = (typeof SUPPORTED_TYPES)[number];

  if (!message || !SUPPORTED_TYPES.includes(message.type as SupportedType)) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const msgType = message.type as SupportedType;
  const messageId = message.id as string;
  const customerPhone = message.from as string;
  const customerName = (message.customerProfile?.name as string) || null;

  // 3b. Durable inbound dedup BEFORE any conversation lookup or session
  //     work. A dedup failure fails closed: no routing and no output.
  try {
    if (!messageId || (await isMessageDuplicate(messageId))) {
      if (messageId) console.log(`[webhook:wa] Duplicate message ${messageId} — skipping`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }
  } catch (dedupError) {
    console.error("[webhook:wa] Dedup lookup failed — fail closed, no routing or output", dedupError);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // Normalizar teléfono para operaciones DB
  // customerPhone (raw) se usa para enviar mensajes a YCloud
  // phone (normalizado) se usa para buscar en DB
  const phone = normalizePhone(customerPhone);

  // Per-phone rate limit — a spamming customer would otherwise burn OpenAI
  // tokens through Whisper/vision/agent calls. 200 is returned regardless so
  // YCloud does not retry-storm dropped messages.
  const inboundRate = await checkRateLimit(`wa-inbound:${phone}`);
  if (!inboundRate.success) {
    console.warn(`[webhook:wa] Rate limited inbound from ${phone}`);
    return NextResponse.json({ ok: true, rateLimited: true }, { status: 200 });
  }

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // 4. Load agent config — SIN filtro de enabled
    //    (siempre cargamos la config, aunque la AI esté apagada,
    //    para poder guardar el mensaje igual)
    // ─────────────────────────────────────────────────────────────────────────
    const [config] = await db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    if (!config) {
      console.error("[webhook:wa] No agent config found — is DB initialized?");
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    // Stored encrypted at rest — decrypt once for every downstream use.
    const { decryptIfEncrypted } = await import("@/lib/encryption");
    config.ycloudApiKey = decryptIfEncrypted(config.ycloudApiKey);
    console.log(`[webhook:wa] Config loaded — enabled:${config.enabled} phone:${config.phoneNumber || "N/A"}`);

    // 4b. DELIVERY DETECTION: si el mensaje es del número del delivery,
    //     tratar como notificación de delivery, no como mensaje de cliente.
    const deliveryPhoneRaw = config.deliveryPhoneNumber?.trim();
    const sellerIds = (config.sellerPhoneIds ?? []) as { name: string; phone: string }[];
    const actor = resolveWhatsAppActor(customerPhone, { deliveryPhoneNumber: deliveryPhoneRaw, sellerPhoneIds: sellerIds });
    if (actor === "delivery") {
      return handleDeliveryNotification(payload, config);
    }

    // Gate identities before creating a conversation or persisting a lead.
    const allowedIds = (config.allowedPhoneIds ?? []) as { name: string; phone: string }[];
    if (allowedIds.length > 0 && !phoneInList(customerPhone, allowedIds)) {
      console.log(`[webhook:wa] BLOCKED — phone ${customerPhone} not in allowedPhoneIds`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // 4c. Find or create conversation (necesario para todo, incluso vendedores)
    const { id: conversationId, isNew } = await findOrCreateConversation(
      "whatsapp",
      customerPhone,
      customerName ?? undefined,
      customerPhone
    );

    // 4d. SELLER DETECTION: los vendedores usan el buffer como los clientes,
    //     pero con un callback que ejecuta el sistema de Telegram en lugar de Karen.
    //     El buffer acumula mensajes por ~11s y los procesa todos juntos.
    const isSeller = actor === "seller";
    if (isSeller) {
      console.log(`[webhook:wa] SELLER DETECTED — ${customerPhone}, will use seller buffer callback`);
      // No hacemos return — el flujo sigue abajo y el mensaje se encola en el buffer
      // pero con un flag para que el callback use el sistema de Telegram
    }

    console.log(`[webhook:wa] Message from ${customerPhone} (${customerName}) type=${msgType} id=${messageId}`);

    // 4f. Auto-reply when outside 24h window
    const autoReplyEnabled = config.autoReply24h === true;
    const autoReplyMessage = config.autoReply24hMessage?.trim();
    const webOrderRedirectEnabled = config.webOrderRedirectEnabled === true;
    const isAiEnabled = config.enabled === true;

    // 6. Deduplication already enforced before conversation lookup (see 3b);
    //    per-branch insertMessage calls below still guard races via
    //    wasDuplicate. No second lookup here by design.

    // 7. Capture lead if first contact — a lead-capture failure must never
    //    kill the inbound pipeline (message persistence + agent reply).
    const textForLead = msgType === "text" ? (message.text?.body as string) || "" : "";
    if (shouldCaptureLead(actor)) {
      try {
        await captureLeadIfNew(customerPhone, customerName, textForLead);
      } catch (leadError) {
        console.error("[webhook:wa] Lead capture failed — continuing pipeline", leadError);
      }
    }

    // 8. Auto-reply for new conversations (solo si la AI está habilitada)
    if (
      actor === "customer" &&
      isAiEnabled &&
      autoReplyEnabled &&
      autoReplyMessage &&
      isNew &&
      !webOrderRedirectEnabled
    ) {
      const autoReplyResult = await messenger.send(
        { to: customerPhone, type: "text", text: autoReplyMessage },
        {
          credentials: {
            apiKey: config.ycloudApiKey || "",
            senderAddress: config.phoneNumber || "",
          },
        },
      );
      if (!autoReplyResult.ok) throw new Error(autoReplyResult.error);
    }

    // -------------------------------------------------------------------------
    // 9. Persist inbound message + resolve text for agent
    //    ESTO SIEMPRE SE HACE, independientemente de si la AI está encendida
    // -------------------------------------------------------------------------
    let agentText: string;
    let contentAttributes: MediaAttachment[] | undefined;
    // Text eligible for boundary classification. Contentless media/location
    // placeholders must never drive the session machine, so they stay null
    // and only persist the inbound message.
    let policyText: string | null = null;

    if (msgType === "location") {
      // ── LOCATION (pin de Maps) ──────────────────────────────────────────
      const loc = message.location as {
        latitude?: number;
        longitude?: number;
        name?: string;
        address?: string;
      } | undefined;

      const address = loc?.address || loc?.name || "ubicación compartida";
      const coords = loc?.latitude && loc?.longitude
        ? ` (${loc.latitude}, ${loc.longitude})`
        : "";
      agentText = `[Ubicacion]: ${address}${coords}`;

      contentAttributes = [{
        type: "image" as const,
        url: "",
        caption: agentText,
        description: `Ubicación compartida: ${address}${coords}`,
      }];
      const locResult = await insertMessage(conversationId, "user", agentText, contentAttributes, messageId);
      if (locResult.wasDuplicate) {
        console.log(`[webhook:wa] Duplicate location message ${messageId} — skipping`);
        return NextResponse.json({ ok: true }, { status: 200 });
      }

      // ── PERSISTIR dirección en leads.address + tabla addresses ──
      const addrToSave = loc?.address || loc?.name || "";
      if (addrToSave) {
        // Actualizar leads.address como dirección principal
        db.update(leads)
          .set({ address: addrToSave })
          .where(eq(leads.phone, phone))
          .then((r) => {
            if (r.rowCount && r.rowCount > 0)
              console.log(`[webhook:wa] Address saved to lead ${customerPhone}: ${addrToSave}`);
          })
          .catch((err) => console.warn("[webhook:wa] Failed to save address:", err));

        // Guardar en tabla addresses (histórico de ubicaciones)
        const mapsLink = loc?.latitude && loc?.longitude
          ? `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}`
          : null;
        db.insert(addresses).values({
          phone: phone,
          address: addrToSave,
          latitude: loc?.latitude ? String(loc.latitude) : null,
          longitude: loc?.longitude ? String(loc.longitude) : null,
          mapsLink,
        }).catch((err) => console.warn("[webhook:wa] Failed to save address record:", err));
      }

      // NOTA: la ubicación NO se reenvía al delivery acá.
      // Se guarda y se envía junto con el pedido confirmado en createOrder.

    } else if (msgType === "text") {
      // ── TEXT ──────────────────────────────────────────────────────────────
      agentText = (message.text?.body as string) || "";
      policyText = agentText.trim().length > 0 ? agentText : null;
      const textInsert = await insertMessage(conversationId, "user", agentText, undefined, messageId);

      // Si el platformMessageId ya existía (duplicate webhook de YCloud),
      // salir temprano — el otro webhook ya encoló al buffer
      if (textInsert.wasDuplicate) {
        console.log(`[webhook:wa] Duplicate text message ${messageId} — skipping buffer enqueue`);
        return NextResponse.json({ ok: true }, { status: 200 });
      }

    } else {
      // ── MEDIA (image | audio | document | video) ──────────────────────────
      const mediaObj = message[msgType] as {
        id?: string;
        caption?: string;
        filename?: string;
        voice?: boolean;
      } | undefined;

      if (!mediaObj?.id) {
        // Malformed payload — ack and move on
        return NextResponse.json({ ok: true }, { status: 200 });
      }

      try {
        const apiKey = config.ycloudApiKey || "";

        // Download from YCloud
        const { buffer, mimeType, filename } = await downloadYCloudMedia(mediaObj.id, apiKey);

        // Persist to disk, get public URL
        const mediaUrl = await saveMediaLocally(buffer, conversationId, filename, mimeType);

        // Build contentAttributes entry
        const attachment: MediaAttachment = {
          type: msgType as MediaAttachment["type"],
          url: mediaUrl,
          fileName: mediaObj.filename || filename,
          mimeType,
          caption: mediaObj.caption,
        };

        // Transcribe audio — enriches both the attachment and the agent context
        if (msgType === "audio") {
          const transcription = await transcribeAudio(buffer, filename, mimeType);
          
          if (transcription) {
            // Transcripción exitosa — se la pasamos al agente
            attachment.transcription = transcription;
            agentText = `[Audio]: ${transcription}`;
            policyText = transcription;
          } else {
            // Transcripción fallida — mensaje limpio, sin fallback string
            agentText = "[Audio sin transcripción]";
            policyText = null;
          }

          contentAttributes = [attachment];
          const audResult = await insertMessage(conversationId, "user", agentText, contentAttributes, messageId);
          if (audResult.wasDuplicate) {
            console.log(`[webhook:wa] Duplicate audio message ${messageId} — skipping`);
            return NextResponse.json({ ok: true }, { status: 200 });
          }

        } else if (msgType === "image" || (msgType === "document" && mimeType.startsWith("image/"))) {
          // Image or image-document → Vision analysis with race timeout
          const { processImageWithVision } = await import("@/lib/media/vision");

          contentAttributes = [attachment];
          const imgResult = await insertMessage(conversationId, "user", "[Imagen recibida]", contentAttributes, messageId);
          if (imgResult.wasDuplicate) {
            console.log(`[webhook:wa] Duplicate image message ${messageId} — skipping`);
            return NextResponse.json({ ok: true }, { status: 200 });
          }
          const msgId = imgResult.id;

          // Get attachment ID from the auto-created record
          const { attachments: attachmentsTable } = await import("@/db/schema");
          const [att] = await db
            .select({ id: attachmentsTable.id })
            .from(attachmentsTable)
            .where(eq(attachmentsTable.messageId, msgId))
            .limit(1);

          const attachmentId = att?.id || 0;
          const captionCtx = mediaObj.caption ? `Caption del cliente: ${mediaObj.caption}` : undefined;
          policyText =
            typeof mediaObj.caption === "string" && mediaObj.caption.trim().length > 0
              ? mediaObj.caption
              : null;

          const visionResult = await processImageWithVision(buffer, mimeType, attachmentId, msgId, captionCtx);
          agentText = visionResult.agentText;

          // Fire background persist if vision timed out
          if (visionResult.backgroundPersist) {
            visionResult.backgroundPersist();
          }

        } else if (msgType === "video") {
          // Video → transcribe audio track + description
          const clip = await analyzeVideo(buffer, filename, mimeType, mediaObj.caption);
          attachment.transcription = clip.transcription ?? undefined;
          contentAttributes = [attachment];
          agentText = clip.agentText;
          policyText =
            typeof mediaObj.caption === "string" && mediaObj.caption.trim().length > 0
              ? mediaObj.caption
              : null;
          const vidResult = await insertMessage(conversationId, "user", agentText, contentAttributes, messageId);
          if (vidResult.wasDuplicate) {
            console.log(`[webhook:wa] Duplicate video message ${messageId} — skipping`);
            return NextResponse.json({ ok: true }, { status: 200 });
          }

        } else {
          // Document (non-image): PDF, text, etc — intentar extraer texto
          const extractedText = mimeType === "application/pdf" || mimeType === "text/plain"
            ? await extractDocumentText(buffer, filename, mimeType)
            : null;
          policyText =
            typeof mediaObj.caption === "string" && mediaObj.caption.trim().length > 0
              ? mediaObj.caption
              : null;

          if (extractedText) {
            agentText = `El cliente envió un documento "${mediaObj.filename || filename}". Contenido extraído:\n\n${extractedText}`;
          } else {
            agentText = `El cliente envió un documento: ${mediaObj.filename || filename}${mediaObj.caption ? ` — "${mediaObj.caption}"` : ""}`;
          }

          contentAttributes = [attachment];
          if (extractedText) attachment.description = extractedText;
          const docResult = await insertMessage(conversationId, "user", agentText, contentAttributes, messageId);
          if (docResult.wasDuplicate) {
            console.log(`[webhook:wa] Duplicate document message ${messageId} — skipping`);
            return NextResponse.json({ ok: true }, { status: 200 });
          }
        }

      } catch (mediaError) {
        // Media processing failed — still run the agent with a degraded context
        console.error("[webhook] Media processing error:", mediaError);
        const fallbackMsg = msgType === "audio" ? "[Audio sin transcripción]" : `[${msgType}]`;
        agentText = fallbackMsg;
        const fallbackResult = await insertMessage(conversationId, "user", agentText, undefined, messageId);
        if (fallbackResult.wasDuplicate) {
          console.log(`[webhook:wa] Duplicate message ${messageId} (fallback) — skipping`);
          return NextResponse.json({ ok: true }, { status: 200 });
        }
      }
    }

    // Optional storefront-first mode: persist the first inbound message, then
    // send one deterministic redirect instead of invoking the sales agent.
    // This avoids duplicate operational orders while retaining normal chat for
    // subsequent questions and preserves the existing behavior when disabled.
    if (actor === "customer" && isNew && webOrderRedirectEnabled) {
      const redirectMessage = buildWebOrderRedirectMessage(config);
      try {
        await insertMessage(conversationId, "assistant", redirectMessage);
        await sendWhatsAppBubbles({
          to: customerPhone,
          text: redirectMessage,
          apiKey: config.ycloudApiKey || "",
          from: config.phoneNumber || "",
        });
      } catch (redirectError) {
        console.error("[webhook:wa] Web-order redirect failed", redirectError);
      }
      return NextResponse.json({ ok: true });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9b. Session boundary persistence — runs for classifiable customer
    //     input even when AI is disabled. Dedup/CAS failure fails closed:
    //     no buffering, no GPT/Jev/tools, no automatic customer replies.
    //     Sellers bypass the customer boundary machine.
    // ─────────────────────────────────────────────────────────────────────────
    let sessionDecision: Awaited<ReturnType<typeof persistSessionTransition>> | null = null;
    if (!isSeller && policyText !== null) {
      // Active-order fact for the boundary policy: an open order keeps the
      // conversation commercial. Lookup failure is treated as "no active
      // order" (never forces a commercial route on stale/unknown state).
      let hasActiveOrder = false;
      try {
        hasActiveOrder = (await getActiveOrderSnapshot(phone)) !== null;
      } catch {
        hasActiveOrder = false;
      }
      try {
        sessionDecision = await persistSessionTransition({
          conversationId,
          messageId,
          text: policyText,
          messageType: msgType,
          aiEnabled: isAiEnabled,
          hasHumanOverride: await checkHumanOverride(conversationId),
          hasActiveOrder,
        });
      } catch (sessionError) {
        console.error("[webhook:wa] Session persistence failed — fail closed, no routing or output", sessionError);
        return NextResponse.json({ ok: true }, { status: 200 });
      }
      if (sessionDecision.kind === "duplicate") {
        console.log(`[webhook:wa] Duplicate session transition ${messageId} — skipping`);
        return NextResponse.json({ ok: true }, { status: 200 });
      }
      // W1 — fixed paths never reach buffer, GPT, Jev, or tools. While AI is
      // disabled (delivery suppressed) the durable transition above is the
      // whole effect: silent 200. When AI is enabled the single fixed reply
      // is sent directly, still bypassing the LLM/tool stack. Legacy is
      // preserved: when there is no session decision (sellers, contentless
      // media/location), the flow below runs exactly as before.
      if (sessionDecision.kind === "fixed_ack" || sessionDecision.kind === "fixed_clarification") {
        if (sessionDecision.delivery !== "allowed") {
          console.log(`[webhook:wa] Session ${sessionDecision.kind} suppressed (AI disabled) — persisting without reply`);
          return NextResponse.json({ ok: true }, { status: 200 });
        }
        const fixedReply = resolveAgentRouting(sessionDecision.kind).fixedReply ?? "";
        try {
          await insertMessage(conversationId, "assistant", fixedReply);
          await sendWhatsAppBubbles({
            to: customerPhone,
            text: fixedReply,
            apiKey: config.ycloudApiKey || "",
            from: config.phoneNumber || "",
          });
        } catch (fixedError) {
          console.error("[webhook:wa] Fixed reply failed — transition already durable, no retry", fixedError);
        }
        return NextResponse.json({ ok: true }, { status: 200 });
      }
      if (sessionDecision.kind === "blocked" || sessionDecision.kind === "handoff") {
        if (sessionDecision.kind === "handoff") await deliverWebhookHandoff({ conversationId, customerName, customerPhone, messageId, decision: sessionDecision });
        console.log(`[webhook:wa] Session ${sessionDecision.kind} — persisting without GPT/tools or automatic replies`);
        return NextResponse.json({ ok: true }, { status: 200 });
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. Verificar si la AI DEBE responder o no
    //     El mensaje YA FUE GUARDADO arriba. Ahora decidimos si ejecutamos AI.
    // ─────────────────────────────────────────────────────────────────────────

    // Check 1: ¿La AI está habilitada en el admin?
    // State persists while AI is disabled: the eligible transition above is
    // already durable, and buffering/GPT/tools/automatic replies stay off.
    const sessionGate = resolveSessionPersistence({
      eligible: true,
      aiEnabled: isAiEnabled,
      dedup: "new",
      cas: "saved",
    });
    if (!sessionGate.allowAgent) {
      console.log(`[webhook:wa] AI disabled — message ${messageId} saved, session persisted, AI skipped`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // Check 2: ¿Hay un human override activo?
    const isOverridden = await checkHumanOverride(conversationId);
    if (isOverridden) {
      console.log(`[webhook:wa] Human override active for conv ${conversationId} — AI skipped`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // ───────────────────────────────────────────────────────────────────────
    // 11. AI está habilitada y no hay override — encolar en buffer
    // ───────────────────────────────────────────────────────────────────────

    // Content-level dedup (Level 2) — catches exact resends within 5s
    const isDuplContent = await BufferManager.isContentDuplicate("whatsapp", customerPhone, agentText);
    if (isDuplContent) {
      console.log(`[buffer:enqueue] Content duplicate detected, skipping: ${agentText.slice(0, 50)}`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    console.log(`[webhook:wa] Enqueueing to buffer for whatsapp:${customerPhone}`);
    await BufferManager.enqueue("whatsapp", customerPhone, {
      content: agentText,
      messageId,
      timestamp: Date.now(),
      contentAttributes: contentAttributes ?? undefined,
    });

    // Capture config values for the closure
    // UI-managed key (agent_config, already decrypted above) takes precedence
    // over the env var — a stale YCLOUD_API_KEY in the environment must not
    // shadow the valid key saved from the admin panel.
    const apiKey = config.ycloudApiKey || process.env.YCLOUD_API_KEY || "";
    const botNumber = config.phoneNumber || process.env.WHATSAPP_PHONE_NUMBER || "";
    const systemPrompt = config.systemPrompt || "";

    console.log(`[webhook:wa] Config for agent — apiKey:${apiKey ? "SET" : "EMPTY"} botNumber:${botNumber || "EMPTY"} prompt:${systemPrompt ? "SET" : "EMPTY"}`);

    // Fire-and-forget: webhook returns 200 immediately, processing happens in background
    scheduleBufferProcessing("whatsapp", customerPhone, async (bufferedMessages) => {
      console.log(`[webhook:wa] Buffer callback fired — ${bufferedMessages.length} msgs for ${customerPhone}${isSeller ? " (SELLER)" : ""}`);

      // VENDEDOR: solo los últimos 4 mensajes para contexto mínimo
      // (evita que historial viejo contamine la conversación actual)
      if (isSeller) {
        const history = await getConversationMessages(conversationId, 4);
        const aiMessages = mergeBufferedTurn(history
          .filter((m) => m.role === "user" || m.role === "assistant" || m.role === "system"), bufferedMessages)
          .map((m) => ({
            role: (m.role === "system" ? "system" : m.role) as "user" | "assistant" | "system",
            content: m.content,
          }));

        const SELLER_MODEL = "gpt-5.4-mini";
        console.log(`[webhook:wa] Seller agent using model: ${SELLER_MODEL} (parallelToolCalls:false)`);
        const result = await generateText({
          model: openai.chat(SELLER_MODEL),
          system: await buildSellerPrompt(),
          messages: aiMessages,
          tools: internalSellerTools,
          providerOptions: {
            openai: {
              systemMessageMode: "developer",
              parallelToolCalls: false,
            } satisfies OpenAILanguageModelChatOptions,
          },
          stopWhen: stepCountIs(10),
        });
        const reply = result.text || "Disculpá, no pude procesar eso.";
        await insertMessage(conversationId, "assistant", reply);
        const r = await sendWhatsAppBubbles({ to: customerPhone, text: reply, apiKey, from: botNumber });
        if (r?.id) {
          try {
            const { chatMessages } = await import("@/db/schema");
            // Buscar el último mensaje del assistant para esta conversación y actualizar su wamid
            const { desc: descOrder } = await import("drizzle-orm");
            const [lastMsg] = await db
              .select({ id: chatMessages.id })
              .from(chatMessages)
              .where(eq(chatMessages.conversationId, conversationId))
              .orderBy(descOrder(chatMessages.createdAt))
              .limit(1);
            if (lastMsg) {
              await db.update(chatMessages).set({ platformMessageId: r.id }).where(eq(chatMessages.id, lastMsg.id));
            }
          } catch {}
        }
        console.log(`[seller-agent] Replied to seller ${customerPhone}: ${reply.slice(0, 80)}`);
        return;
      }

      // CLIENTE: verificar human override
      const stillOverridden = await checkHumanOverride(conversationId);
      if (stillOverridden) {
        console.log(`[webhook:wa] Human override activated during debounce for ${customerPhone} — aborting AI`);
        return;
      }

      // Verificar si el humano respondió en los últimos 60s (echo que llegó durante buffer)
      const { checkRecentHumanActivity } = await import("@/lib/channels/router");
      const recentHuman = await checkRecentHumanActivity(conversationId, 60);
      if (recentHuman) {
        console.log(`[webhook:wa] Human activity detected in last 60s for ${customerPhone} — aborting AI to avoid conflict`);
        return;
      }

      // Re-read persisted boundary state and override after debounce.
      // Any race or read failure fails closed: no GPT/tools, no reply.
      try {
        const gated = await loadSessionState(conversationId);
        if (gated?.mode === "handed_off") {
          console.log(`[webhook:wa] Session handed_off for ${customerPhone} — aborting AI`);
          return;
        }
        const overrideNow = await checkHumanOverride(conversationId);
        if (overrideNow) {
          console.log(`[webhook:wa] Human override re-read after debounce for ${customerPhone} — aborting AI`);
          return;
        }
      } catch (stateError) {
        console.error("[webhook:wa] Session revalidation failed — fail closed, aborting AI", stateError);
        return;
      }

      // Concatenate all buffered messages into a single context for the agent.
      // Fresh conversation history (last 20) segmented by Argentina local day:
      // today is primary, older days are labelled [DD/MM HH:mm] and marked as
      // secondary so old items can never be read as the current order.
      const history = await getConversationMessages(conversationId, 20);
      const temporalContext = buildTemporalAgentMessages(history, bufferedMessages, new Date());
      const aiMessages = temporalContext.messages;
      console.log(
        `[webhook:wa] Running agent with ${aiMessages.length} history messages ` +
        `(today=${temporalContext.todayCount} older=${temporalContext.olderCount} day=${temporalContext.todayDayKey})`
      );

      // NOTA: el customer context (order history, address, notes, preferences)
      // ya se carga DENTRO de runWhatsAppAgent() → buildSystemPrompt().
      // NO inyectar nada como role:"user" — eso contamina la línea temporal.

      // Run agent with combined context.
      // W1 — thread the boundary routing into the agent: commercial paths
      // carry the validated compact session facts plus an explicit
      // allow_agent kind, so fixed/handoff/blocked can never fall through to
      // GPT/tools here (they already returned above). Legacy preserved: when
      // there is no session decision, the call keeps its original shape.
      const { text: responseText, pendingMedia } = await runWhatsAppAgent({
        conversationId,
        customerPhone,
        messages: aiMessages,
        turnMessageIds: bufferedMessages
          .map((m) => m.messageId)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
        ...(sessionDecision && sessionDecision.kind === "allow_agent"
          ? { routingKind: "allow_agent" as const, sessionContext: toSessionContext(sessionDecision.state) }
          : {}),
      });

      console.log(`[webhook:wa] Agent response: ${responseText.slice(0, 100)}... (${pendingMedia.length} media pending)`);

      // ═══════════════════════════════════════════════════════════════════
      // ORDEN CORRECTO: primero texto, DESPUÉS media
      // ═══════════════════════════════════════════════════════════════════

      // 1a. Guardar texto en DB
      const { id: msgId } = await insertMessage(conversationId, "assistant", responseText);

      // 1b. Enviar texto (split into bubbles for natural UX)
      const ycloudResult = await sendWhatsAppBubbles({
        to: customerPhone,
        text: responseText,
        apiKey,
        from: botNumber,
      });

      // 1c. Guardar wamid en el texto de la DB
      if (ycloudResult?.id) {
        try {
          const { chatMessages } = await import("@/db/schema");
          await db
            .update(chatMessages)
            .set({ platformMessageId: ycloudResult.id })
            .where(eq(chatMessages.id, msgId));
          console.log(`[webhook:wa] Updated chatMessage ${msgId} with wamid ${ycloudResult.id}`);
        } catch (updateErr) {
          console.warn("[webhook:wa] Failed to update wamid on chatMessage:", updateErr);
        }
      }

      // 2. DESPUÉS del texto, enviar media pendiente en orden
      if (pendingMedia.length > 0) {
        console.log(`[webhook:wa] Sending ${pendingMedia.length} pending media after text...`);
        for (const media of pendingMedia) {
          // Delay entre mensajes para que se sienta natural
          await new Promise((r) => setTimeout(r, 2000));

          if (media.type === "image" || media.type === "sticker") {
            const imgResult = await messenger.send({
              to: customerPhone,
              type: "image",
              mediaUrl: media.url,
              text: media.caption,
            });
            if (imgResult.ok) {
              // Guardar en DB con contenido descriptivo para contexto del AI
              await insertMessage(conversationId, "assistant", media.dbContent);
            } else {
              console.warn(`[webhook:wa] Failed to send media ${media.url.slice(0, 50)}:`, imgResult.error);
            }
          } else if (media.type === "document") {
            // Para documentos usaríamos sendDocument, pero por ahora skip
            console.warn("[webhook:wa] Document sending not implemented in response flow yet");
            await insertMessage(conversationId, "assistant", media.dbContent);
          }
        }
      }

      console.log(`[webhook:wa] Response sent to ${customerPhone}`);
    }).catch((err) => console.error("[webhook:wa] Buffer processing error:", err));

  } catch (error) {
    console.error("[webhook] Error processing message:", error);
    // Always return 200 after signature verification passes
    // to prevent YCloud from retrying
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
