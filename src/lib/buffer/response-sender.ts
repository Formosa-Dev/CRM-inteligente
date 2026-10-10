import { sendWhatsAppMessage, type YCloudResponse } from "@/lib/whatsapp/ycloud-client";
import { sendTelegramMessage } from "@/lib/telegram/bot";

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

// Send response as bubbles via WhatsApp (YCloud)
// Returns the LAST YCloud response (which has the wamid) for echo dedup
export async function sendWhatsAppBubbles(params: {
  to: string;
  text: string;
  apiKey: string;
  from: string;
}): Promise<YCloudResponse | null> {
  const bubbles = splitIntoBubbles(params.text);
  let lastResult: YCloudResponse | null = null;

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) {
      // Typing indicator + delay between bubbles
      await sendTypingIndicator("whatsapp", params.to, params.apiKey, params.from);
      await sleep(DELAY_BETWEEN_BUBBLES_MS);
    }

    lastResult = await sendWhatsAppMessage({
      to: params.to,
      body: bubbles[i],
      apiKey: params.apiKey,
      from: params.from,
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
  channel: "whatsapp" | "telegram",
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
