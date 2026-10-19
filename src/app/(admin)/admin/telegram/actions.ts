"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { randomBytes } from "crypto";
import {
  getTelegramConfigFromDB,
  getMe,
  setTelegramWebhook,
  deleteTelegramWebhook as removeTelegramWebhook,
  getTelegramWebhookInfo,
} from "@/lib/telegram/bot";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { agentConfig } from "@/db/schema";
import { maskToken as maskTokenUtil } from "@/lib/encryption";

export type TelegramStatus = {
  configured: boolean;
  botUsername: string | null;
  botToken: string;
  webhookToken: string;
  webhookUrl: string;
  allowedChatIds: number[];
  enabled: boolean;
};

export type WebhookInfo = {
  url: string;
  pendingUpdateCount: number;
};

export type TelegramActionState = {
  success: boolean;
  message: string;
};

/**
 * Obtiene el estado actual de la configuración de Telegram
 */
function getPublicHost(): string | null {
  const raw =
    process.env.AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.RENDER_EXTERNAL_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  return raw ? raw.replace(/\/$/, "") : null;
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  if (!(await requireAdmin())) {
    return {
      configured: false,
      botUsername: null,
      botToken: "",
      webhookToken: "",
      webhookUrl: "",
      allowedChatIds: [],
      enabled: false,
    };
  }

  // Get from DB first, fallback to env
  const config = await getTelegramConfigFromDB();

  // Lazily generate + persist a webhook token so the admin always sees a
  // real URL — and no deployment ever ships a guessable one.
  let webhookToken = config.webhookToken;
  if (!webhookToken) {
    webhookToken = randomBytes(24).toString("hex");
    await db
      .update(agentConfig)
      .set({ telegramWebhookToken: webhookToken, updatedAt: new Date() })
      .where(eq(agentConfig.id, 1));
  }

  const host = getPublicHost();
  const webhookUrl = host ? `${host}/api/telegram/webhook/${webhookToken}` : "— configurá AUTH_URL —";

  // Intentar obtener info del bot
  let botUsername: string | null = null;
  if (config.botToken) {
    const me = await getMe(config.botToken);
    if (me.ok && me.username) {
      botUsername = `@${me.username}`;
    }
  }

  return {
    configured: config.enabled,
    botUsername,
    botToken: config.botToken ? maskTokenUtil(config.botToken) : "",
    webhookToken: webhookToken,
    webhookUrl: webhookUrl,
    allowedChatIds: config.allowedChatIds,
    enabled: config.enabled,
  };
}

/**
 * Configura el webhook en Telegram
 */
export async function setTelegramWebhookAction(): Promise<TelegramActionState> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  const config = await getTelegramConfigFromDB();
  if (!config.botToken) {
    return {
      success: false,
      message:
        "El bot token no está configurado. Guardalo desde esta pantalla o en TELEGRAM_BOT_TOKEN.",
    };
  }

  const host = getPublicHost();
  if (!host) {
    return {
      success: false,
      message:
        "Configurá AUTH_URL (o NEXT_PUBLIC_APP_URL) con la URL pública del deploy para poder registrar el webhook.",
    };
  }

  let webhookToken = config.webhookToken;
  if (!webhookToken) {
    webhookToken = randomBytes(24).toString("hex");
    await db
      .update(agentConfig)
      .set({ telegramWebhookToken: webhookToken, updatedAt: new Date() })
      .where(eq(agentConfig.id, 1));
  }
  const webhookUrl = `${host}/api/telegram/webhook/${webhookToken}`;

  const result = await setTelegramWebhook(config.botToken, webhookUrl);
  if (!result.ok) {
    return {
      success: false,
      message: `Error al configurar webhook: ${result.error}`,
    };
  }

  return {
    success: true,
    message: `Webhook configurado correctamente → ${webhookUrl}`,
  };
}

/**
 * Elimina el webhook de Telegram
 */
export async function deleteTelegramWebhookAction(): Promise<TelegramActionState> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  const config = await getTelegramConfigFromDB();
  if (!config.botToken) {
    return { success: false, message: "TELEGRAM_BOT_TOKEN no está configurado." };
  }

  const result = await removeTelegramWebhook(config.botToken);
  if (!result.ok) {
    return {
      success: false,
      message: `Error al eliminar webhook: ${result.error}`,
    };
  }

  return { success: true, message: "Webhook eliminado correctamente" };
}

/**
 * Obtiene información del webhook actual
 */
export async function getTelegramWebhookInfoAction(): Promise<
  WebhookInfo | TelegramActionState
> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  const config = await getTelegramConfigFromDB();
  if (!config.botToken) {
    return { success: false, message: "El bot token no está configurado." };
  }

  const info = await getTelegramWebhookInfo(config.botToken);
  if (!info.ok) {
    return {
      success: false,
      message: `Error al obtener info del webhook: ${info.error}`,
    };
  }

  return {
    url: info.url ?? "",
    pendingUpdateCount: info.pendingUpdateCount ?? 0,
  };
}
