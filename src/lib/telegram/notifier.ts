import { getTelegramConfigFromDB, sendTelegramMessage } from "./bot";
import { resolveClientName } from "@/lib/lead-utils";

interface OrderNotification {
  id: number;
  customerName: string | null;
  orderType: string | null;
  items: unknown;
  total?: number;
  status: string;
  phoneNumber?: string;
  notes?: string | null;
}

export async function notifyNewOrder(order: OrderNotification): Promise<void> {
  const config = await getTelegramConfigFromDB();
  if (!config.enabled || config.allowedChatIds.length === 0) return;

  const items = Array.isArray(order.items) 
    ? order.items.map((i: { quantity?: number; name?: string }) => `${i.quantity || 1}x ${i.name || "Item"}`).join(", ")
    : "Ver detalle";

  const resolvedName = await resolveClientName(order.phoneNumber || "", order.customerName || "Desconocido");

  const typeIcon = order.orderType === "pan_mayorista" ? "🍞" : "🍔";
  const message = `${typeIcon} *Nuevo Pedido #${order.id}*\n👤 Cliente: ${resolvedName}\n📦 Items: ${items}\n💰 Total: $${(order.total || 0).toLocaleString("es-AR")}\n📋 Estado: ${order.status}\n${order.orderType === "pan_mayorista" ? "\n🔔 Pedido al por mayor — revisar con urgencia" : ""}`;

  for (const chatId of config.allowedChatIds) {
    await sendTelegramMessage(config.botToken, chatId, message, "Markdown");
  }

  // ─── Notificación específica para pan mayorista ─────────────────────
  if (order.orderType === "pan_mayorista") {
    const { getIntegrationSecrets } = await import("@/lib/integrations");
    const lichasChatId = (await getIntegrationSecrets()).telegramNotifyChatId;
    if (lichasChatId) {
      const lichasResolvedName = await resolveClientName(order.phoneNumber || "", order.customerName || "Desconocido");
      const lichasMessage = [
        "🫓 *NUEVO PEDIDO PAN MAYORISTA*",
        "",
        `*Cliente:* ${lichasResolvedName}`,
        `*Teléfono:* ${order.phoneNumber || "No especificado"}`,
        `*Pedido:*`,
        `${items}`,
        ``,
        `*Total:* $${(order.total || 0).toLocaleString("es-AR")}`,
        ``,
        order.notes ? `📝 *Notas:* ${order.notes}` : "",
        `⏰ ${new Date().toLocaleString("es-AR")}`,
      ].filter(Boolean).join("\n");

      const chatIdNum = parseInt(lichasChatId.trim(), 10);
      if (!isNaN(chatIdNum)) {
        await sendTelegramMessage(config.botToken, chatIdNum, lichasMessage, "Markdown");
      }
    }
  }
}
