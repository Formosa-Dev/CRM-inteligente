import { messenger } from "@/lib/messaging";
import { sendTelegramMessage } from "@/lib/telegram/bot";
import type { ChannelAccount, ChannelKind } from "@/lib/messaging/types";

/** Provider send receipt (was `YCloudResponse` in the folded ycloud-client). */
export interface YCloudResponse {
  id: string;
  status: string;
}

const MAX_BUBBLE_CHARS = 250;
const DELAY_BETWEEN_BUBBLES_MS = 3_000; // 3s feels natural

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split text into natural WhatsApp-style bubbles.
 * Rules:
 * 1. Split by double newlines (paragraphs) first
 * 2. Lists (lines starting with - or •) get grouped together as one bubble
 * 3. Long paragraphs split by sentences
 * 4. Each bubble ≤ MAX_BUBBLE_CHARS
 * 5. Strip markdown formatting (bold **text**, backticks, etc.) for natural feel
 */
export function splitIntoBubbles(text: string): string[] {
  // Clean up markdown artifacts + internal markers for WhatsApp
  const cleaned = text
    .replace(/\[INTERNAL_[^\]]*\]/g, "")  // [INTERNAL_*] markers
    .replace(/\*\*([^*]*)\*\*/g, "$1")   // **bold** → bold (allow empty)
    .replace(/\*([^*]+)\*/g, "$1")       // *italic* → italic
    .replace(/`([^`]+)`/g, "$1")         // `code` → code
    .replace(/^#+\s*/gm, "")             // # headers → remove
    .replace(/^[-*]\s+/gm, "- ")         // normalize bullet points
    .replace(/---+/g, "")                // --- dividers
    .replace(/👇/g, "")                  // remove pointer emojis
    .replace(/\n{3,}/g, "\n\n")          // collapse 3+ newlines
    .trim();

  const paragraphs = cleaned.split(/\n\n+/).filter((p) => p.trim());

  // Si solo hay 1 párrafo y entra en el límite, devolverlo directamente
  if (paragraphs.length <= 1 && cleaned.length <= MAX_BUBBLE_CHARS) return [cleaned];

  const bubbles: string[] = [];

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (trimmed.length <= MAX_BUBBLE_CHARS) {
      bubbles.push(trimmed);
      continue;
    }

    // Split long paragraph by sentences
    const sentences = trimmed.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
    let current = "";

    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 > MAX_BUBBLE_CHARS) {
        if (current) bubbles.push(current.trim());
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }
    }
    if (current) bubbles.push(current.trim());
  }

  // Filter empty bubbles
  const result = bubbles.filter((b) => b.trim().length > 0);
  return result.length > 0 ? result : [cleaned.slice(0, MAX_BUBBLE_CHARS)];
}

/**
 * A-04 — own-echo recognition for multi-bubble replies.
 *
 * A reply longer than MAX_BUBBLE_CHARS is sent as N bubbles, each with its
 * own providerMessageId, but only one id is persisted. An echo of any
 * non-final bubble therefore misses the platformMessageId lookups — it is
 * still ours, and must be recognized by CONTENT: true when `displayText`
 * equals the whole stored message or any single bubble it was split into.
 *
 * The comparison runs the stored content through the same splitter that
 * produced the sends, so markdown stripping and bullet normalization can't
 * cause a false mismatch.
 */
export function matchesAssistantBubble(
  lastContent: string,
  displayText: string
): boolean {
  const fragment = displayText.trim();
  if (!fragment) return false;
  if (lastContent.trim() === fragment) return true;
  return splitIntoBubbles(lastContent).some(
    (bubble) => bubble.trim() === fragment
  );
}

// Send response as bubbles via WhatsApp (YCloud)
// Returns the LAST YCloud response (which has the wamid) for echo dedup
//
// S15: `account` + `channel` make the send account-aware — when a
// conversation is bound to a `channel_accounts` row the bubbles go out as
// that account's provider instead of the caller's agent_config credentials.
// Bubble splitting, delays and error propagation are identical either way.
export async function sendWhatsAppBubbles(params: {
  to: string;
  text: string;
  apiKey: string;
  from: string;
  channel?: ChannelKind;
  account?: ChannelAccount;
  /**
   * Provider-native thread (zernio conversationId, from
   * conversations.external_thread_id). Conversation-scoped providers
   * cannot send to `to` directly — they reply into this thread; absent,
   * they fall back to opening a new conversation (and may fail with
   * PLATFORM_NOT_SUPPORTED / TEMPLATE_REQUIRED).
   */
  providerConversationId?: string;
  /**
   * A-11 — invoked right after each bubble's send resolves ok, with the
   * fragment that was actually delivered and its providerMessageId. Lets
   * the caller persist per-bubble (only delivered fragments reach history,
   * each with its own wamid for echo dedup). A throwing callback aborts
   * the remaining bubbles like a send failure — wrap persistence errors
   * inside the callback if they must not poison the send.
   */
  onBubbleSent?: (bubble: {
    index: number;
    text: string;
    providerMessageId: string;
    status: string;
  }) => void | Promise<void>;
}): Promise<YCloudResponse | null> {
  const bubbles = splitIntoBubbles(params.text);
  let lastResult: YCloudResponse | null = null;

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      // Typing indicator + delay between bubbles
      await sendTypingIndicator(
        params.account ? (params.channel ?? "whatsapp") : "whatsapp",
        params.to,
        params.apiKey,
        params.from
      );
      await sleep(DELAY_BETWEEN_BUBBLES_MS);
    }

    const res = await messenger.send(
      {
        to: params.to,
        type: "text",
        text: bubbles[i],
        ...(params.providerConversationId
          ? { providerConversationId: params.providerConversationId }
          : {}),
      },
      params.account
        ? { channel: params.channel ?? params.account.channel, account: params.account }
        : { credentials: { apiKey: params.apiKey, senderAddress: params.from } },
    );
    if (!res.ok) {
      const error = new Error(res.error) as Error & { retryable?: boolean };
      error.retryable = res.retryable;
      throw error;
    }
    lastResult = { id: res.providerMessageId, status: res.status };
    await params.onBubbleSent?.({
      index: i,
      text: bubbles[i],
      providerMessageId: res.providerMessageId,
      status: res.status,
    });
  }

  return lastResult;
}

// Send response as bubbles via Telegram
export async function sendTelegramBubbles(params: {
  botToken: string;
  chatId: number;
  text: string;
}): Promise<void> {
  const bubbles = splitIntoBubbles(params.text);

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      await sendTypingIndicator("telegram", String(params.chatId), params.botToken);
      await sleep(DELAY_BETWEEN_BUBBLES_MS);
    }

    await sendTelegramMessage(params.botToken, params.chatId, bubbles[i]);
  }
}

// Send typing indicator per channel
async function sendTypingIndicator(
  channel: ChannelKind,
  userId: string,
  tokenOrApiKey: string,
  from?: string
): Promise<void> {
  try {
    if (channel === "telegram") {
      await fetch(`https://api.telegram.org/bot${tokenOrApiKey}/sendChatAction`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: Number(userId), action: "typing" }),
        signal: AbortSignal.timeout(5_000),
      });
    }
    // YCloud WhatsApp doesn't have a native typing indicator API
    // The delay between bubbles naturally simulates "typing"
    void from; // suppress unused warning
  } catch (err) {
    // Non-fatal — just skip the indicator
    console.warn("[response-sender] Typing indicator failed:", err);
  }
}
