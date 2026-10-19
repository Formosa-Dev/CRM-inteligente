/**
 * Shared inbound pipeline (slice S12) — the per-event app logic extracted
 * verbatim from `src/app/api/whatsapp/webhook/route.ts` so both webhook
 * surfaces run the same code:
 *
 * - `POST /api/whatsapp/webhook`            → handleNormalizedEvent(event)
 * - `POST /api/webhooks/ingress/<provider>` → handleNormalizedEvent(event, ctx)
 *
 * `InboundContext` carries the resolved channel account: when it names a real
 * `channel_accounts` row its id is stamped on the conversations/messages this
 * event persists. Legacy callers pass nothing and every write stays null —
 * byte-for-byte identical to the pre-S12 pipeline.
 *
 * Passive persistence: kinds with no conversation row (status/lifecycle/other
 * artifacts) persist to `channel_events` via `persistChannelEvent` — a
 * positively identified missing schema acks 200 without persistence, any
 * other failure is retryable. Kinds with no storage target at all are logged
 * via `logAckedWithoutPersistence` and acked 200.
 */

import { NextResponse } from "next/server";
import { messenger } from "./messenger";
import { matchSenderToChannelAccount } from "./accounts";
import { extractYCloudEchoMessage } from "./providers/ycloud";
import {
  channelAccountRowId,
  logAckedWithoutPersistence,
  resolveIngressContext,
} from "./ingress";
import { getProvider } from "./registry";
import { persistChannelEvent } from "./channel-events";
import type {
  ChannelAccount,
  ChannelKind,
  NormalizedInboundEvent,
} from "./types";
import {
  matchesAssistantBubble,
  sendWhatsAppBubbles,
} from "@/lib/buffer/response-sender";
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
import {
  resolveAgentConfig,
  resolveAgentConfigStrict,
  runWithAgentConfigScope,
  type AgentConfigScope,
} from "@/lib/agent-config-scope";
import { classifyError } from "./errors";
import { downloadYCloudMedia, saveMediaLocally } from "@/lib/media/downloader";
import { transcribeAudio } from "@/lib/media/transcription";
import { analyzeVideo } from "@/lib/media/video";
import { extractDocumentText } from "@/lib/media/document";
import { BufferManager } from "@/lib/buffer/manager";
import { scheduleBufferProcessing } from "@/lib/buffer/processor";
import { accountScopedInboundKey } from "./inbound-keys";
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
 * First-contact auto-reply gate. `isNew` is the fast path; the message-count
 * check makes a retry after a retryable send failure send again (the
 * conversation row committed, but no inbound/auto-reply message did).
 * `alreadyReplied` is the durable marker that stops a replay once the reply
 * was sent and recorded.
 */
export function shouldSendAutoReply(input: {
  isNew: boolean;
  alreadyReplied: boolean;
  conversationHasMessages: boolean;
}): boolean {
  if (input.alreadyReplied) return false;
  return input.isNew || !input.conversationHasMessages;
}

export function autoReplyMarkerKey(messageId: string): string {
  return `auto-reply:${messageId}`;
}

/**
 * Per-event context handed to the pipeline by the unified ingress route.
 * All fields optional — the legacy /api/whatsapp/webhook route passes none.
 */
export interface InboundContext {
  /** Channel the event was routed to (whatsapp in v1). */
  channel?: ChannelKind;
  /** Resolved channel account (channel_accounts row or placeholder). */
  account?: ChannelAccount;
  /** Precomputed numeric channel_accounts.id (else derived from account.id). */
  channelAccountId?: number;
}

// ─── Echo handler ───────────────────────────────────────────────────────────
// Envelope→event translation lives in the adapter's parseWebhook; the fields
// consumed here are the normalized equivalents of what this handler used to
// parse inline:
//   sender.phone            = msg.from || payload.from  (bot/staff)
//   providerConversationId  = msg.to   || payload.to    (customer)
//   platformMessageId       = msg.id   || payload.id    (echo dedup key)
//   type / text             = msg.type / body-or-caption
async function handleEcho(
  event: NormalizedInboundEvent,
  channelAccountId?: number
): Promise<NextResponse> {
  try {
    const payload = event.raw as Record<string, unknown>;

    // En un echo: from = quien envió (bot/staff), to = quien recibe (customer)
    const customerPhone = event.providerConversationId;
    const botPhone = event.sender.phone;

    if (!customerPhone || !botPhone) {
      console.warn("[webhook:echo] Missing phone numbers in echo payload");
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // S15 — echo→account attribution: once channel_accounts is provisioned,
    // the echo's business-side sender must match an active row
    // (providerAccountId, or the E.164 senderAddress for ycloud). An
    // unmatched sender is a foreign echo → ack + ignore, no conversation
    // created. When no rows exist (unmigrated installs) the match is
    // "unprovisioned" and the legacy phone-only flow below runs unchanged.
    const senderMatch = await matchSenderToChannelAccount(
      "whatsapp",
      {
        senderAddress: botPhone,
        providerAccountId: event.providerAccountId || undefined,
      },
      event.provider
    );
    if (senderMatch.kind === "db-error") {
      console.error(
        "[webhook:echo] channel account lookup failed — retryable",
        senderMatch.error
      );
      return NextResponse.json(
        { error: "account-resolution-failed" },
        { status: 503 }
      );
    }
    if (senderMatch.kind === "unmatched" || senderMatch.kind === "mismatch") {
      console.warn(
        `[webhook:echo] Echo sender ${botPhone} (providerAccountId ${event.providerAccountId || "n/a"}) ` +
          (senderMatch.kind === "mismatch"
            ? `mismatched: ${senderMatch.reason}`
            : "matches no active channel_accounts row") +
          " — ignoring"
      );
      return NextResponse.json({ ok: true }, { status: 200 });
    }
    const echoAccountId =
      senderMatch.kind === "matched"
        ? Number(senderMatch.account.id)
        : channelAccountId;

    // Extraer el contenido del mensaje
    const msgType = event.type ?? "text";
    let displayText = "[Mensaje desde WhatsApp Business]";

    if (msgType === "text") {
      displayText = event.text ?? displayText;
    } else if (["image", "audio", "document", "video"].includes(msgType)) {
      displayText = event.text ?? `[${msgType}]`;
    }

    const echoMsgId = event.platformMessageId;

    console.log(
      `[webhook:echo] Echo from ${botPhone} → ${customerPhone}: "${displayText.slice(0, 80)}"`
    );

    // 4. Dedup BEFORE any conversation lookup/mutation. An echo from account
    //    B must never touch account A's conversation, not even to rebind it.
    if (echoMsgId && (await isMessageDuplicate(echoMsgId))) {
      console.log(`[webhook:echo] Duplicate echo ${echoMsgId} — skipping`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // 5. Buscar o crear la conversación EN EL ÁMBITO DE LA CUENTA. A legacy
    //    null-account row is never adopted; a different account gets its own
    //    row. This is the no-crossover guarantee.
    const echoConv = await findOrCreateConversation(
      "whatsapp",
      customerPhone,
      undefined,
      customerPhone,
      echoAccountId
    );
    const conversationId = echoConv.id;

    if (echoMsgId) {
      // Dedup adicional: si el contenido coincide con un mensaje del
      // assistant reciente (últimos 30s), es el eco de nuestra propia
      // respuesta. A-04: la comparación es por BURBUJA — una respuesta
      // larga sale en N envíos y cada eco trae solo un fragmento.
      const recentMessages = await getConversationMessages(conversationId, 6);
      const thirtySecAgo = Date.now() - 30_000;
      const isOwnBubbleEcho = recentMessages.some((recent) => {
        if (recent.role !== "assistant") return false;
        const msgTime = recent.createdAt instanceof Date
          ? recent.createdAt.getTime()
          : new Date(recent.createdAt).getTime();
        return (
          msgTime > thirtySecAgo &&
          matchesAssistantBubble(recent.content, displayText)
        );
      });
      if (isOwnBubbleEcho) {
        console.log(`[webhook:echo] Skip — echo matches recent AI response bubble (${echoMsgId})`);
        return NextResponse.json({ ok: true }, { status: 200 });
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
        // mediaRefs has no fileSize field — pull the raw media object through
        // the adapter's own echo extraction for the fields it can't carry.
        const mediaObj = extractYCloudEchoMessage(payload)?.["audio"] as
          | Record<string, unknown>
          | undefined;
        if (mediaObj?.id) {
          try {
            const echoConfig = await resolveAgentConfig({
              channel: "whatsapp",
              channelAccountId: echoAccountId ?? channelAccountId,
            });

            const { decryptIfEncrypted } = await import("@/lib/encryption");
            const mediaApiKey = decryptIfEncrypted(echoConfig?.ycloudApiKey);
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
                contentAttachments, echoMsgId, echoAccountId ?? channelAccountId
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
        echoMsgId,
        echoAccountId ?? channelAccountId
      );
      if (echoInsert.wasDuplicate) {
        console.log(`[webhook:echo] Duplicate echo ${echoMsgId} — already saved`);
      } else {
        console.log(`[webhook:echo] Echo saved as human message in conversation ${conversationId}`);
      }
    }

  } catch (error) {
    console.error("[webhook:echo] Error processing echo:", error);
    if (classifyError(error) === "retryable-db") {
      return NextResponse.json({ error: "transient-failure" }, { status: 503 });
    }
    return NextResponse.json({ error: "echo-processing-failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}

// ─── Delivery handler ───────────────────────────────────────────────────────
async function handleDeliveryNotification(
  payload: Record<string, unknown>,
  config: typeof agentConfig.$inferSelect,
  ctx: InboundContext
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

      const result = await notifyCustomerDeliveryArrived(deliveryPhone, {
        account: ctx.channelAccountId != null ? ctx.account : undefined,
        channelAccountId: ctx.channelAccountId,
        apiKey: config.ycloudApiKey || undefined,
        senderAddress: config.phoneNumber || undefined,
      });
      if (!result.ok) {
        console.error(
          "[delivery] Notification failed — not acked",
          result.error
        );
        return NextResponse.json(
          { error: "delivery-notification-failed" },
          { status: result.retryable ? 503 : 502 }
        );
      }
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error("[delivery] Error handling delivery notification:", error);
    return NextResponse.json(
      { error: "delivery-notification-failed" },
      { status: classifyError(error) === "retryable-db" ? 503 : 500 }
    );
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
  channel?: ChannelKind;
  decision: Extract<RoutingDecision, { kind: "handoff" }>;
}): Promise<void> {
  const { decision } = input;
  console.log(`[webhook:wa] Session handoff notifyClaim=${decision.notifyClaim} replyClaim=${decision.replyClaim} delivery=${decision.delivery} — persisting without GPT/tools or automatic replies`);
  const transport = resolveHandoffTransport({
    notifyClaim: decision.notifyClaim,
    replyClaim: decision.replyClaim,
    delivery: decision.delivery,
    channel: input.channel,
  });
  if (transport.sendCustomerReply && transport.transport !== "messenger") {
    // Non-messenger surfaces can't send the customer reply from this
    // whatsapp-scoped route — surfaced for the operator, never dropped
    // silently. (whatsapp resolves to "messenger" → this never fires there.)
    console.warn(
      `[webhook:wa] Handoff customer reply deliverable on '${transport.transport}' transport — no sender wired for channel '${transport.channel}' in this route`
    );
  }
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
 * Per-event pipeline. The adapter already translated the envelope into
 * `NormalizedInboundEvent` (kind, dedup ids, sender, type, text, mediaRefs);
 * `event.raw` stays available for fields the contract can't carry (location
 * coordinates, per-type media extras like caption/fileSize). Everything
 * below is app logic identical to the pre-extraction inline flow.
 */
export async function handleNormalizedEvent(
  event: NormalizedInboundEvent,
  ctx?: InboundContext
): Promise<NextResponse> {
  // S12/S17 — every surface (canonical /api/whatsapp/webhook included)
  // resolves the event's channel account BEFORE any conversation lookup or
  // send. Callers may pass it; otherwise resolve it here. A provisioned
  // channel with no matching account fails closed instead of falling back to
  // the legacy null-account identity.
  let effectiveCtx = ctx;
  if (!effectiveCtx) {
    try {
      effectiveCtx = await resolveIngressContext(
        getProvider(event.provider),
        event
      );
    } catch (resolveError) {
      console.error(
        "[webhook] Channel-account resolution failed — retryable, not acked",
        resolveError
      );
      return NextResponse.json(
        { error: "account-resolution-failed" },
        { status: 503 }
      );
    }
  }
  if (!effectiveCtx) {
    logAckedWithoutPersistence(
      event,
      "no channel account matches this event (fail-closed)"
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  }
  const channelAccountId =
    effectiveCtx.channelAccountId ??
    channelAccountRowId(effectiveCtx.account);
  const payload = event.raw as Record<string, unknown>;

  // 2. Status/lifecycle/other events have no conversation row: persist them
  //    in `channel_events` idempotently. This replaces the old generic
  //    log-and-ack path. Only a positively identified missing schema may ack
  //    without persistence (documented compatibility), never an arbitrary DB
  //    error.
  if (event.kind !== "message.received" && event.kind !== "message.echo") {
    try {
      const persisted = await persistChannelEvent(event, {
        channel: effectiveCtx.channel ?? "whatsapp",
        account: effectiveCtx.account,
        channelAccountId,
      });
      if (persisted.kind === "schema-not-ready") {
        console.warn(
          `[webhook] channel_events schema not ready — ${event.provider}/${event.kind} ` +
            `${event.deliveryId} acknowledged without persistence (migration pending)`
        );
      } else if (persisted.kind === "duplicate") {
        console.log(
          `[webhook] Duplicate ${event.kind} ${event.deliveryId} — already persisted`
        );
      }
      return NextResponse.json({ ok: true }, { status: 200 });
    } catch (error) {
      console.error(
        `[webhook] ${event.kind} persistence failed — retryable, not acked`,
        error
      );
      return NextResponse.json(
        { error: "event-persistence-failed" },
        { status: 503 }
      );
    }
  }

  // 2a. Protocol-eligibility gate: empty Business echoes are acknowledged
  //     with 200 and cause no conversation lookup, mutation, routing, or
  //     reply. Non-empty echoes fall through to handleEcho.
  if (isProtocolArtifact(payload)) {
    logAckedWithoutPersistence(event, "protocol artifact");
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  // 2. Handle ECHO events (outgoing messages from WhatsApp Business App)
  //    Esto va ANTES del filtro de inbound messages porque los echoes
  //    tienen type diferente
  if (event.kind === "message.echo") {
    return handleEcho(event, channelAccountId);
  }

  // 3. Filter non-message events (status updates, etc.)
  if (event.kind !== "message.received") {
    logAckedWithoutPersistence(event, `kind '${event.kind}' not persistable`);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const message = payload.whatsappInboundMessage as
    | Record<string, unknown>
    | undefined;

  // Accept: text, image, audio, document, video, location — drop everything else
  const SUPPORTED_TYPES = ["text", "image", "audio", "document", "video", "location"] as const;
  type SupportedType = (typeof SUPPORTED_TYPES)[number];

  if (
    !message ||
    !event.type ||
    !SUPPORTED_TYPES.includes(event.type as SupportedType)
  ) {
    logAckedWithoutPersistence(event, `type '${event.type ?? "n/a"}' unsupported`);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const msgType = event.type as SupportedType;
  const messageId = event.platformMessageId as string;
  const customerPhone = event.sender.phone as string;
  const customerName = event.sender.name ?? null;

  // 3b. Durable inbound dedup BEFORE any conversation lookup or session
  //     work. A dedup failure fails closed: no routing and no output.
  try {
    if (!messageId || (await isMessageDuplicate(messageId))) {
      if (messageId) console.log(`[webhook:wa] Duplicate message ${messageId} — skipping`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }
  } catch (dedupError) {
    console.error(
      "[webhook:wa] Dedup lookup failed — fail closed, retryable (503)",
      dedupError
    );
    return NextResponse.json({ error: "dedup-unavailable" }, { status: 503 });
  }

  // Normalizar teléfono para operaciones DB
  // customerPhone (raw) se usa para enviar mensajes a YCloud
  // phone (normalizado) se usa para buscar en DB
  const phone = normalizePhone(customerPhone);

  // Account-scoped inbound identities: a bound channel account namespaces the
  // customer key so the same phone messaging two provisioned numbers never
  // shares a rate-limit window, dedup slot, or buffer debounce turn. NULL
  // preserves the exact legacy `${phone}`/`${customerPhone}` key shapes.
  const phoneKey = accountScopedInboundKey(channelAccountId, phone);
  const customerKey = accountScopedInboundKey(channelAccountId, customerPhone);

  // Per-phone rate limit — a spamming customer would otherwise burn OpenAI
  // tokens through Whisper/vision/agent calls. 200 is returned regardless so
  // YCloud does not retry-storm dropped messages.
  const inboundRate = await checkRateLimit(`wa-inbound:${phoneKey}`);
  if (!inboundRate.success) {
    console.warn(`[webhook:wa] Rate limited inbound from ${phone}`);
    return NextResponse.json({ ok: true, rateLimited: true }, { status: 200 });
  }

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // 4. Load the EXACT effective config for this conversation/account.
    //    enabled, allowlists, seller/delivery routing, auto-reply/redirect,
    //    API key and sender phone all come from this row — never from id=1
    //    implicitly. A transient resolution failure is retryable (503).
    // ─────────────────────────────────────────────────────────────────────────
    const configScope: AgentConfigScope = {
      channel: effectiveCtx.channel,
      channelAccountId,
      customerPhone: phone || undefined,
    };
    const configResolution = await resolveAgentConfigStrict(configScope);
    let config: Awaited<ReturnType<typeof resolveAgentConfig>>;
    if (configResolution.kind === "db-error") {
      console.error(
        "[webhook:wa] Agent config resolution failed — retryable",
        configResolution.error
      );
      return NextResponse.json(
        { error: "agent-config-unavailable" },
        { status: 503 }
      );
    }
    if (configResolution.kind === "resolved") {
      config = configResolution.row;
    } else {
      // `schema-not-ready` may use the legacy global row; `not-found` has no
      // safe sender/config and must not pretend one exists.
      config = await resolveAgentConfig(configScope);
    }

    if (!config) {
      console.error("[webhook:wa] No agent config found — is DB initialized?");
      return NextResponse.json(
        { error: "agent-config-unavailable" },
        { status: 503 }
      );
    }
    // Stored encrypted at rest — decrypt once for every downstream use.
    const { decryptIfEncrypted } = await import("@/lib/encryption");
    config.ycloudApiKey = decryptIfEncrypted(config.ycloudApiKey);
    console.log(
      `[webhook:wa] Config loaded — scope=${configScope.channelAccountId ?? configScope.channel ?? "global"} source=${configResolution.kind === "resolved" ? configResolution.source : configResolution.kind} enabled:${config.enabled} phone:${config.phoneNumber ? "SET" : "N/A"}`
    );

    // 4b. DELIVERY DETECTION: si el mensaje es del número del delivery,
    //     tratar como notificación de delivery, no como mensaje de cliente.
    const deliveryPhoneRaw = config.deliveryPhoneNumber?.trim();
    const sellerIds = (config.sellerPhoneIds ?? []) as { name: string; phone: string }[];
    const actor = resolveWhatsAppActor(customerPhone, { deliveryPhoneNumber: deliveryPhoneRaw, sellerPhoneIds: sellerIds });
    if (actor === "delivery") {
      return handleDeliveryNotification(payload, config, effectiveCtx);
    }

    // Gate identities before creating a conversation or persisting a lead.
    const allowedIds = (config.allowedPhoneIds ?? []) as { name: string; phone: string }[];
    if (allowedIds.length > 0 && !phoneInList(customerPhone, allowedIds)) {
      console.log(`[webhook:wa] BLOCKED — phone ${customerPhone} not in allowedPhoneIds`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // 4c. Find or create conversation (necesario para todo, incluso vendedores)
    const {
      id: conversationId,
      isNew,
      channel: convChannel,
      channelAccountId: convAccountId,
    } = await findOrCreateConversation(
      "whatsapp",
      customerPhone,
      customerName ?? undefined,
      customerPhone,
      channelAccountId
    );

    // S15 — resolve the conversation's channel_account binding once: every
    // deterministic outbound below (auto-reply, redirect, fixed reply) goes
    // out as that account. A bound-but-unresolvable account suppresses the
    // send (fail closed) — never reply as a different sender.
    let convAccount: ChannelAccount | undefined;
    let convAccountBroken = false;
    if (convAccountId != null) {
      const { resolveChannelAccountById } = await import("./accounts");
      convAccount = await resolveChannelAccountById(convAccountId);
      if (!convAccount) {
        convAccountBroken = true;
        console.error(
          `[webhook:wa] channel_account #${convAccountId} (conv ${conversationId}) is not resolvable — outbound sends suppressed, inbound still persisted`
        );
      }
    }

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
    const textForLead = msgType === "text" ? event.text ?? "" : "";
    if (shouldCaptureLead(actor)) {
      try {
        await captureLeadIfNew(customerPhone, customerName, textForLead, channelAccountId);
      } catch (leadError) {
        console.error("[webhook:wa] Lead capture failed — continuing pipeline", leadError);
      }
    }

    // 8. Auto-reply for new conversations (solo si la AI está habilitada).
    //    The marker + idempotency key make retries safe: a first-contact send
    //    that failed retryably is retried, while a sent reply is never
    //    duplicated (provider dedups on the same external id).
    if (
      actor === "customer" &&
      isAiEnabled &&
      autoReplyEnabled &&
      autoReplyMessage &&
      !webOrderRedirectEnabled
    ) {
      const marker = autoReplyMarkerKey(messageId);
      const alreadyReplied = await isMessageDuplicate(marker);
      let conversationHasMessages = false;
      if (!alreadyReplied) {
        try {
          const existing = await getConversationMessages(conversationId, 1);
          conversationHasMessages = existing.length > 0;
        } catch (lookupError) {
          console.error(
            "[webhook:wa] Auto-reply history lookup failed — retryable",
            lookupError
          );
          return NextResponse.json(
            { error: "auto-reply-history-unavailable" },
            { status: 503 }
          );
        }
      }
      if (!shouldSendAutoReply({ isNew, alreadyReplied, conversationHasMessages })) {
        // no-op: duplicate/replay or an established conversation
      } else if (convAccountBroken) {
        console.warn("[webhook:wa] Auto-reply suppressed — channel account unresolvable");
      } else {
        const autoReplyResult = await messenger.send(
          {
            to: customerPhone,
            type: "text",
            text: autoReplyMessage,
            idempotencyKey: marker,
          },
          convAccount
            ? { channel: convChannel, account: convAccount }
            : {
                credentials: {
                  apiKey: config.ycloudApiKey || "",
                  senderAddress: config.phoneNumber || "",
                },
              },
        );
        if (!autoReplyResult.ok) {
          console.error(
            "[webhook:wa] Auto-reply send failed — inbound not acked",
            { retryable: autoReplyResult.retryable, error: autoReplyResult.error }
          );
          return NextResponse.json(
            { error: "auto-reply-send-failed" },
            { status: autoReplyResult.retryable ? 503 : 502 }
          );
        }
        await insertMessage(
          conversationId,
          "assistant",
          autoReplyMessage,
          undefined,
          marker,
          channelAccountId
        );
      }
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
      const locResult = await insertMessage(conversationId, "user", agentText, contentAttributes, messageId, channelAccountId);
      if (locResult.wasDuplicate) {
        console.log(`[webhook:wa] Duplicate location message ${messageId} — skipping`);
        return NextResponse.json({ ok: true }, { status: 200 });
      }

      // ── PERSISTIR dirección en leads.address + tabla addresses ──
      const addrToSave = loc?.address || loc?.name || "";
      if (addrToSave) {
        // Actualizar leads.address como dirección principal — y, cuando el
        // evento llegó por una cuenta vinculada, atribuir el lead a esa cuenta
        // para que los lookups de pedidos scoped la encuentren.
        db.update(leads)
          .set(
            channelAccountId != null
              ? { address: addrToSave, channelAccountId }
              : { address: addrToSave }
          )
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
      agentText = event.text ?? "";
      policyText = agentText.trim().length > 0 ? agentText : null;
      const textInsert = await insertMessage(conversationId, "user", agentText, undefined, messageId, channelAccountId);

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
          const audResult = await insertMessage(conversationId, "user", agentText, contentAttributes, messageId, channelAccountId);
          if (audResult.wasDuplicate) {
            console.log(`[webhook:wa] Duplicate audio message ${messageId} — skipping`);
            return NextResponse.json({ ok: true }, { status: 200 });
          }

        } else if (msgType === "image" || (msgType === "document" && mimeType.startsWith("image/"))) {
          // Image or image-document → Vision analysis with race timeout
          const { processImageWithVision } = await import("@/lib/media/vision");

          contentAttributes = [attachment];
          const imgResult = await insertMessage(conversationId, "user", "[Imagen recibida]", contentAttributes, messageId, channelAccountId);
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
          const vidResult = await insertMessage(conversationId, "user", agentText, contentAttributes, messageId, channelAccountId);
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
          const docResult = await insertMessage(conversationId, "user", agentText, contentAttributes, messageId, channelAccountId);
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
        const fallbackResult = await insertMessage(conversationId, "user", agentText, undefined, messageId, channelAccountId);
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
      if (convAccountBroken) {
        console.error(
          "[webhook:wa] Web-order redirect blocked — channel account unresolvable"
        );
        return NextResponse.json(
          { error: "channel-account-unresolvable" },
          { status: 503 }
        );
      }
      try {
        // Send first; persist only on success so a failed redirect is not
        // recorded as delivered.
        await sendWhatsAppBubbles({
          to: customerPhone,
          text: redirectMessage,
          apiKey: config.ycloudApiKey || "",
          from: config.phoneNumber || "",
          channel: convChannel,
          account: convAccount,
        });
        await insertMessage(
          conversationId,
          "assistant",
          redirectMessage,
          undefined,
          undefined,
          channelAccountId
        );
      } catch (redirectError) {
        console.error("[webhook:wa] Web-order redirect failed", redirectError);
        return NextResponse.json(
          { error: "web-order-redirect-failed" },
          { status: classifyError(redirectError) === "retryable-db" ? 503 : 502 }
        );
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
        hasActiveOrder = (await getActiveOrderSnapshot(phone, channelAccountId)) !== null;
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
        console.error(
          "[webhook:wa] Session persistence failed — fail closed, retryable (503)",
          sessionError
        );
        return NextResponse.json(
          { error: "session-persistence-failed" },
          { status: 503 }
        );
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
        if (convAccountBroken) {
          console.error(
            "[webhook:wa] Fixed reply blocked — channel account unresolvable"
          );
          return NextResponse.json(
            { error: "channel-account-unresolvable" },
            { status: 503 }
          );
        }
        try {
          await sendWhatsAppBubbles({
            to: customerPhone,
            text: fixedReply,
            apiKey: config.ycloudApiKey || "",
            from: config.phoneNumber || "",
            channel: convChannel,
            account: convAccount,
          });
          await insertMessage(
            conversationId,
            "assistant",
            fixedReply,
            undefined,
            undefined,
            channelAccountId
          );
        } catch (fixedError) {
          console.error("[webhook:wa] Fixed reply failed", fixedError);
          return NextResponse.json(
            { error: "fixed-reply-failed" },
            { status: classifyError(fixedError) === "retryable-db" ? 503 : 502 }
          );
        }
        return NextResponse.json({ ok: true }, { status: 200 });
      }
      if (sessionDecision.kind === "blocked" || sessionDecision.kind === "handoff") {
        if (sessionDecision.kind === "handoff") await deliverWebhookHandoff({ conversationId, customerName, customerPhone, messageId, channel: convChannel, decision: sessionDecision });
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
    const isDuplContent = await BufferManager.isContentDuplicate("whatsapp", customerKey, agentText);
    if (isDuplContent) {
      console.log(`[buffer:enqueue] Content duplicate detected, skipping: ${agentText.slice(0, 50)}`);
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    console.log(`[webhook:wa] Enqueueing to buffer for whatsapp:${customerKey}`);
    await BufferManager.enqueue("whatsapp", customerKey, {
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
    scheduleBufferProcessing("whatsapp", customerKey, async (bufferedMessages) => {
      return runWithAgentConfigScope(configScope, async () => {
      console.log(`[webhook:wa] Buffer callback fired — ${bufferedMessages.length} msgs for ${customerPhone}${isSeller ? " (SELLER)" : ""}`);

      // S15 — honor the conversation's channel-account binding (echoes stamp
      // it): replies go out as that account. A bound-but-unresolvable account
      // suppresses the send — fail closed, never reply as a different sender.
      // Re-read after the debounce so bindings stamped mid-window count.
      const [convBinding] = await db
        .select({
          channel: conversations.channel,
          channelAccountId: conversations.channelAccountId,
        })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1);
      const replyChannel = convBinding?.channel ?? "whatsapp";
      let replyAccount: ChannelAccount | undefined;
      if (convBinding?.channelAccountId != null) {
        const { resolveChannelAccountById } = await import("./accounts");
        replyAccount = await resolveChannelAccountById(convBinding.channelAccountId);
        if (!replyAccount) {
          console.error(
            `[webhook:wa] channel_account #${convBinding.channelAccountId} for conv ${conversationId} is not resolvable — AI reply suppressed, no wrong-sender send`
          );
          return;
        }
      }

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
        await insertMessage(conversationId, "assistant", reply, undefined, undefined, channelAccountId);
        const r = await sendWhatsAppBubbles({ to: customerPhone, text: reply, apiKey, from: botNumber, channel: replyChannel, account: replyAccount });
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
      const { id: msgId } = await insertMessage(conversationId, "assistant", responseText, undefined, undefined, channelAccountId);

      // 1b. Enviar texto (split into bubbles for natural UX)
      const ycloudResult = await sendWhatsAppBubbles({
        to: customerPhone,
        text: responseText,
        apiKey,
        from: botNumber,
        channel: replyChannel,
        account: replyAccount,
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
            const imgResult = await messenger.send(
              {
                to: customerPhone,
                type: "image",
                mediaUrl: media.url,
                text: media.caption,
              },
              replyAccount
                ? { channel: replyChannel, account: replyAccount }
                : {}
            );
            if (imgResult.ok) {
              // Guardar en DB con contenido descriptivo para contexto del AI
              await insertMessage(conversationId, "assistant", media.dbContent, undefined, undefined, channelAccountId);
            } else {
              console.warn(`[webhook:wa] Failed to send media ${media.url.slice(0, 50)}:`, imgResult.error);
            }
          } else if (media.type === "document") {
            // Para documentos usaríamos sendDocument, pero por ahora skip
            console.warn("[webhook:wa] Document sending not implemented in response flow yet");
            await insertMessage(conversationId, "assistant", media.dbContent, undefined, undefined, channelAccountId);
          }
        }
      }

      console.log(`[webhook:wa] Response sent to ${customerPhone}`);
      });
    }).catch((err) => console.error("[webhook:wa] Buffer processing error:", err));

  } catch (error) {
    console.error("[webhook] Error processing message:", error);
    // Persistence/transport failures must be retryable, not acked/dropped.
    // Durable dedup makes provider redelivery idempotent.
    const kind = classifyError(error);
    if (kind === "retryable-db") {
      return NextResponse.json(
        { error: "transient-failure" },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: "processing-failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
