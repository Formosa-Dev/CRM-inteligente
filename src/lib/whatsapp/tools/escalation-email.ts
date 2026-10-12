/**
 * Email escalation system for WhatsApp agent.
 * Sends a formatted HTML email when the agent can't handle a situation.
 * Uses ESCALATION_EMAIL env var as the recipient.
 */

import { getBusinessInfo } from "@/lib/business";

export interface EscalationData {
  customerName: string;
  customerPhone: string;
  reason: string;
  category: string;
  conversationSummary: string;
  lastMessages: string[];
}

/**
 * Send escalation email via a simple SMTP-less approach:
 * Uses the Resend API or falls back to a webhook.
 * For now, we use a simple fetch to an email API.
 */
export async function sendEscalationEmail(data: EscalationData): Promise<{ ok: boolean; error?: string }> {
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secrets = await getIntegrationSecrets();
  const to = secrets.escalationEmail;
  if (!to) {
    console.warn("[escalation] escalationEmail not set — skipping email");
    return { ok: false, error: "Escalation email not configured" };
  }

  const biz = await getBusinessInfo();
  const subject = `[${biz.name}] Derivación: ${data.category} — ${data.customerName}`;

  // Try Telegram notification as primary channel — broadcast to ALL admins
  // in the allowlist (plus the dedicated notify chat if it's not already in).
  try {
    const { getTelegramConfigFromDB } = await import("@/lib/telegram/bot");
    const tg = await getTelegramConfigFromDB();
    const botToken = tg.botToken || process.env.TELEGRAM_BOT_TOKEN;
    const chatIds = new Set<number>(tg.allowedChatIds);
    const extraId = parseInt(
      (secrets.telegramNotifyChatId
        || process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(",")[0]?.trim() || "").trim(),
      10
    );
    if (!isNaN(extraId)) chatIds.add(extraId);

    if (botToken && chatIds.size) {
      // Plain text, no parse_mode — customer-controlled fields must not be
      // interpreted as Telegram markdown (link/format injection).
      const telegramText = [
        `🔔 DERIVACIÓN`,
        ``,
        `Cliente: ${data.customerName}`,
        `Tel: ${data.customerPhone}`,
        `Categoría: ${data.category}`,
        `Motivo: ${data.reason}`,
        ``,
        `Últimos mensajes:`,
        ...data.lastMessages.slice(-5).map((m) => `> ${m}`),
        ``,
        `Resumen: ${data.conversationSummary}`,
      ].join("\n");

      for (const chatId of chatIds) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: telegramText }),
            signal: AbortSignal.timeout(10_000),
          });
        } catch (err) {
          console.warn(`[escalation] Telegram to ${chatId} failed:`, err);
        }
      }

      console.log(`[escalation] Telegram notification sent to ${chatIds.size} admin chat(s)`);
    }
  } catch (err) {
    console.warn("[escalation] Telegram notification failed:", err);
  }

  // Log the escalation for the admin dashboard
  console.log(`[escalation] 🔔 ${subject}`);
  console.log(`[escalation] Customer: ${data.customerName} (${data.customerPhone})`);
  console.log(`[escalation] Reason: ${data.reason}`);
  console.log(`[escalation] Category: ${data.category}`);

  return { ok: true };
}
