/**
 * Escalation notification for WhatsApp agent.
 * Notifies the operator when the agent can't handle a situation.
 * Primary channel: Telegram (broadcast to all allowed admin chats).
 * ESCALATION_EMAIL remains an optional recipient marker — its absence must
 * never gate the Telegram notification (A-43).
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
 * Notify the operator about an escalation.
 * Telegram runs unconditionally — it is the channel that actually reaches the
 * owner. `escalationEmail` is optional/best-effort and never gates it.
 * Returns ok=true only when at least one owner notification was delivered.
 */
export async function sendEscalationEmail(data: EscalationData): Promise<{ ok: boolean; error?: string }> {
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secrets = await getIntegrationSecrets();
  const to = secrets.escalationEmail;

  const biz = await getBusinessInfo();
  const subject = `[${biz.name}] Derivación: ${data.category} — ${data.customerName}`;

  // A-43: Telegram notification is independent of the escalation email —
  // broadcast to ALL admins in the allowlist (plus the dedicated notify chat
  // if it's not already in). Runs even when escalationEmail is unset.
  let telegramDelivered = false;
  let telegramConfigured = false;
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
      telegramConfigured = true;
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
          const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: telegramText }),
            signal: AbortSignal.timeout(10_000),
          });
          if (resp.ok) telegramDelivered = true;
        } catch (err) {
          console.warn(`[escalation] Telegram to ${chatId} failed:`, err);
        }
      }

      console.log(`[escalation] Telegram notification sent to ${chatIds.size} admin chat(s)`);
    } else {
      console.warn("[escalation] Telegram not configured — no bot token or admin chat ids");
    }
  } catch (err) {
    console.warn("[escalation] Telegram notification failed:", err);
  }

  if (!to) {
    console.warn("[escalation] escalationEmail not set — email channel skipped (Telegram already attempted)");
  }

  // Log the escalation for the admin dashboard
  console.log(`[escalation] 🔔 ${subject}`);
  console.log(`[escalation] Customer: ${data.customerName} (${data.customerPhone})`);
  console.log(`[escalation] Reason: ${data.reason}`);
  console.log(`[escalation] Category: ${data.category}`);

  if (telegramDelivered) return { ok: true };
  return {
    ok: false,
    error: telegramConfigured
      ? "Telegram notification attempted but no chat accepted it"
      : "No owner notification channel configured (telegram/email)",
  };
}
