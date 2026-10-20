// ─── Types ───────────────────────────────────────────────────────────────────

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; first_name?: string; username?: string };
    from: { id: number; is_bot: boolean; first_name?: string; username?: string };
    text?: string;
    voice?: { file_id: string; duration: number; mime_type?: string };
    audio?: { file_id: string; duration: number; mime_type?: string; file_name?: string };
    photo?: Array<{ file_id: string; file_unique_id?: string; width: number; height: number; file_size?: number }>;
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
    video?: { file_id: string; width?: number; height?: number; duration?: number; mime_type?: string; file_size?: number };
    caption?: string;
    date: number;
  };
};

export type TelegramConfig = {
  botToken: string;
  webhookToken: string;
  allowedChatIds: number[];
  enabled: boolean;
};

// ─── API helpers ─────────────────────────────────────────────────────────────

const TELEGRAM_API = "https://api.telegram.org/bot";

function apiUrl(token: string, method: string): string {
  return `${TELEGRAM_API}${token}/${method}`;
}

/**
 * Descarga un archivo de Telegram por file_id.
 * 1. getFile → obtiene file_path
 * 2. Descarga el binario desde api.telegram.org/file/bot{token}/{file_path}
 */
export async function downloadTelegramFile(
  token: string,
  fileId: string
): Promise<{ buffer: Buffer; filePath: string } | null> {
  try {
    const res = await fetch(apiUrl(token, "getFile"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as { ok: boolean; result?: { file_path?: string } };
    const filePath = data.result?.file_path;
    if (!filePath) return null;

    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) return null;

    const arrayBuffer = await fileRes.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), filePath };
  } catch (err) {
    console.error("[telegram] Error downloading file:", err);
    return null;
  }
}

export async function sendTelegramMessage(
  token: string,
  chatId: number,
  text: string,
  parseMode: "HTML" | "Markdown" | null = null
): Promise<{ ok: boolean; error?: string }> {
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
    };
    if (parseMode) body.parse_mode = parseMode;

    const res = await fetch(apiUrl(token, "sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      return { ok: false, error: errBody?.description ?? `HTTP ${res.status}` };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function setTelegramWebhook(
  token: string,
  webhookUrl: string,
  secretToken?: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(apiUrl(token, "setWebhook"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // secret_token makes Telegram sign every update with
      // X-Telegram-Bot-Api-Secret-Token, which the webhook route verifies
      // before parsing (F10).
      body: JSON.stringify({
        url: webhookUrl,
        ...(secretToken ? { secret_token: secretToken } : {}),
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      return { ok: false, error: data.description ?? "Error desconocido" };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function deleteTelegramWebhook(
  token: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(apiUrl(token, "deleteWebhook"), {
      method: "POST",
    });

    const data = await res.json();
    if (!data.ok) {
      return { ok: false, error: data.description ?? "Error desconocido" };
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getTelegramWebhookInfo(
  token: string
): Promise<{
  ok: boolean;
  url?: string;
  pendingUpdateCount?: number;
  error?: string;
}> {
  try {
    const res = await fetch(apiUrl(token, "getWebhookInfo"));

    const data = await res.json();
    if (!data.ok) {
      return { ok: false, error: data.description ?? "Error desconocido" };
    }

    return {
      ok: true,
      url: data.result.url,
      pendingUpdateCount: data.result.pending_update_count,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getMe(
  token: string
): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(apiUrl(token, "getMe"));
    const data = await res.json();
    if (!data.ok) {
      return { ok: false, error: data.description ?? "Error desconocido" };
    }
    return { ok: true, username: data.result.username };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Config helpers ──────────────────────────────────────────────────────────

export function getTelegramConfigFromEnv(): TelegramConfig {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  // No default — an empty token disables the webhook rather than leaving a
  // publicly guessable one.
  const webhookToken = process.env.TELEGRAM_WEBHOOK_TOKEN ?? "";
  const rawIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "";
  const allowedChatIds = rawIds
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => !isNaN(n));

  return {
    botToken,
    webhookToken,
    allowedChatIds,
    enabled: botToken.length > 0,
  };
}

// ─── Telegram Bot Config from DB (with encryption) ────────────────────────

import { db } from "@/db";
import { eq } from "drizzle-orm";
import { agentConfig } from "@/db/schema";
import { decrypt, decryptIfEncrypted } from "@/lib/encryption";

/**
 * Get Telegram config from database (with encrypted token)
 * Priority: DB > ENV
 */
export async function getTelegramConfigFromDB(): Promise<TelegramConfig> {
  // Try to get from DB first
  try {
    const rows = await db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    const config = rows[0];
    if (config?.telegramBotToken) {
      const decryptedToken = decrypt(config.telegramBotToken);
      // No default: an empty webhook token disables the route (401 on every
      // request) rather than leaving a publicly guessable one.
      // Stored plaintext today — telegram_webhook_token is varchar(100) and
      // cannot hold the ~187-char AES-GCM ciphertext (F10 rotation note:
      // widening the column to text enables at-rest encryption, which this
      // decryptIfEncrypted read already tolerates).
      const webhookToken =
        decryptIfEncrypted(config.telegramWebhookToken) ||
        process.env.TELEGRAM_WEBHOOK_TOKEN ||
        "";
      // Soporta múltiples IDs separados por coma: "123456, 789012, 345678"
      const allowedChatIds = config.telegramChatId
        ? config.telegramChatId
            .split(",")
            .map((id: string) => parseInt(id.trim(), 10))
            .filter((id: number) => !isNaN(id) && id > 0)
        : [];

      return {
        botToken: decryptedToken,
        webhookToken,
        allowedChatIds,
        enabled: config.telegramEnabled ?? false,
      };
    }
  } catch (error) {
    console.error("[telegram] Error getting config from DB:", error);
  }

  // Fallback to env
  return getTelegramConfigFromEnv();
}

export function isChatAuthorized(
  chatId: number,
  allowedChatIds: number[]
): boolean {
  // Fail closed: an empty allowlist must NOT let the internal ops bot answer
  // strangers — it exposes admin tools (orders, client history, metrics).
  return allowedChatIds.length > 0 && allowedChatIds.includes(chatId);
}

/**
 * Platform message id scoped by chat. Telegram's `message_id` is a per-chat
 * monotonic counter (1, 2, 3, …) identical across every chat — storing it raw
 * in `chat_messages.platform_message_id` (a globally-unique dedup key) makes
 * a second authorized chat's early messages collide with the first chat's and
 * get swallowed as false duplicates. Namespacing by chat id keeps the dedup
 * key unique per (chat, message).
 */
export function telegramPlatformMessageId(
  chatId: number | string,
  messageId: number | string
): string {
  return `tg_${chatId}_${messageId}`;
}
