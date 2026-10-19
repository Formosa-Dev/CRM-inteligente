import { getTelegramConfigFromDB, sendTelegramMessage } from "./bot";
import { resolveClientName } from "@/lib/lead-utils";
import { normalizePhone } from "@/lib/phone-utils";

export interface OrderNotification {
  id: number;
  customerName: string | null;
  orderType: string | null;
  items: unknown;
  total?: number;
  status: string;
  phoneNumber?: string;
  notes?: string | null;
}

/**
 * Campos controlados por el cliente (nombre del lead, notas del pedido,
 * nombres de producto) pueden traer `*`, `_`, `` ` `` o `[` — con
 * parse_mode=Markdown eso rompe el parseo y TODO el sendMessage falla en
 * silencio, o peor: permite inyectar formato/links. Se escapan los especiales
 * del Markdown legacy; el markup intencional del template queda intacto.
 */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(/([_*`[\]])/g, "\\$1");
}

function formatItems(items: unknown): string {
  return Array.isArray(items)
    ? items.map((i: { quantity?: number; name?: string }) => `${i.quantity || 1}x ${escapeTelegramMarkdown(i.name || "Item")}`).join(", ")
    : "Ver detalle";
}

function orderTypeLabel(orderType: string | null): string {
  if (orderType === "pan_mayorista") return "Pan mayorista";
  if (orderType === "hamburguesas") return "Hamburguesas";
  return orderType || "—";
}

/**
 * Compact ops-bot message for a new order. Includes the customer's direct
 * WhatsApp link (`https://wa.me/<digits>`) so the operator can jump straight
 * into that chat. Digits come from the order's phone number via the shared
 * `normalizePhone` helper.
 */
export function buildOrderNotificationMessage(order: OrderNotification, resolvedName: string): string {
  const items = formatItems(order.items);
  const digits = normalizePhone(order.phoneNumber || "");
  const whatsappLink = digits ? `\n💬 WhatsApp: https://wa.me/${digits}` : "";
  const typeIcon = order.orderType === "pan_mayorista" ? "🍞" : "🍔";
  return [
    `${typeIcon} *Nuevo Pedido #${order.id}*`,
    `👤 Cliente: ${escapeTelegramMarkdown(resolvedName)}`,
    `📦 Items: ${items}`,
    `💰 Total: $${(order.total || 0).toLocaleString("es-AR")}`,
    `📋 Estado: ${order.status}`,
    `🏷️ Tipo: ${orderTypeLabel(order.orderType)}${whatsappLink}`,
    order.orderType === "pan_mayorista" ? "\n🔔 Pedido al por mayor — revisar con urgencia" : "",
  ].filter(Boolean).join("\n");
}

/**
 * Admin broadcast: sends `text` to EVERY chat id in the bot allowlist
 * (agent_config.telegram_chat_id, comma-separated). Best-effort — failures
 * are logged per chat, never thrown. Use for anything ops-level the owner
 * and admins should see: new orders, reconcile reports, escalations, alerts.
 */
export async function notifyAdmins(text: string, parseMode?: "Markdown" | "HTML"): Promise<void> {
  try {
    const config = await getTelegramConfigFromDB();
    if (!config.enabled || config.allowedChatIds.length === 0) return;
    for (const chatId of config.allowedChatIds) {
      try {
        await sendTelegramMessage(config.botToken, chatId, text, parseMode);
      } catch (err) {
        console.warn(`[telegram] notifyAdmins failed for chat ${chatId}:`, err);
      }
    }
  } catch (error) {
    console.error("[telegram] notifyAdmins failed:", error);
  }
}

export async function notifyNewOrder(order: OrderNotification): Promise<void> {
  // Telegram is a best-effort side channel: a config/DB/network failure must
  // never bubble up to the caller that just persisted a real order.
  try {
    const config = await getTelegramConfigFromDB();
    if (!config.enabled || config.allowedChatIds.length === 0) return;

    const resolvedName = await resolveClientName(order.phoneNumber || "", order.customerName || "Desconocido");
    const message = buildOrderNotificationMessage(order, resolvedName);
    await notifyAdmins(message, "Markdown");

    // ─── Notificación específica para pan mayorista ─────────────────────
    if (order.orderType === "pan_mayorista") {
      const { getIntegrationSecrets } = await import("@/lib/integrations");
      const lichasChatId = (await getIntegrationSecrets()).telegramNotifyChatId;
      if (lichasChatId) {
        const lichasMessage = [
          "🫓 *NUEVO PEDIDO PAN MAYORISTA*",
          "",
          `*Cliente:* ${escapeTelegramMarkdown(resolvedName)}`,
          `*Teléfono:* ${escapeTelegramMarkdown(order.phoneNumber || "No especificado")}`,
          `*Pedido:*`,
          `${formatItems(order.items)}`,
          ``,
          `*Total:* $${(order.total || 0).toLocaleString("es-AR")}`,
          ``,
          order.notes ? `📝 *Notas:* ${escapeTelegramMarkdown(order.notes)}` : "",
          `⏰ ${new Date().toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" })}`,
        ].filter(Boolean).join("\n");

        const chatIdNum = parseInt(lichasChatId.trim(), 10);
        if (!isNaN(chatIdNum)) {
          await sendTelegramMessage(config.botToken, chatIdNum, lichasMessage, "Markdown");
        }
      }
    }
  } catch (error) {
    console.error("[telegram] notifyNewOrder failed:", error);
  }
}
