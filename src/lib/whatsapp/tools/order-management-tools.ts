import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { getStatusSemantic, isActiveStatus, getStatusNotificationMessage } from "@/lib/whatsapp/status-utils";
import { currentAgentConfigScope } from "@/lib/agent-config-scope";
import { isOrderVisibleToScope } from "@/lib/whatsapp/order-lifecycle";

// The ambient scope carries the conversation's channelAccountId. A bound
// scope only sees/mutates orders owned by its account's leads; NULL keeps
// the legacy phone-global behavior. Post-fetch gating keeps the not-found
// path identical (a foreign order is indistinguishable from a missing one).
async function visibleOrderOrNull<T extends { id: number }>(
  order: T | undefined
): Promise<T | undefined> {
  if (!order) return undefined;
  const scopeAccountId = currentAgentConfigScope().channelAccountId ?? null;
  if (!(await isOrderVisibleToScope(order.id, scopeAccountId))) return undefined;
  return order;
}

// ─── getOrderStatus ─────────────────────────────────────────────────────────
export const getOrderStatusTool = tool({
  description:
    "Consulta el estado de un pedido. Cuando el cliente pregunte: 'ya salió?', 'dónde está mi pedido?', 'cómo vamos?', 'ya?', 'cuánto falta?', 'mi pedido?', 'el delivery?', 'salió?'",
  inputSchema: z.object({
    orderId: z
      .number()
      .optional()
      .describe("ID del pedido (si lo tiene)"),
    customerPhone: z
      .string()
      .optional()
      .describe("Teléfono del cliente para buscar su último pedido"),
  }),
  execute: async ({ orderId, customerPhone }) => {
    let order;

    if (orderId) {
      const rows = await db
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      order = rows[0];
    } else if (customerPhone) {
      const rows = await db
        .select()
        .from(orders)
        .where(eq(orders.phoneNumber, customerPhone))
        .orderBy(desc(orders.createdAt))
        .limit(1);
      order = rows[0];
    }

    order = await visibleOrderOrNull(order);
    if (!order) {
      return "No encontré ningún pedido. ¿Podés darme el número de pedido o tu teléfono?";
    }

    const statusLabels: Record<string, string> = {
      pending: "⏳ Pendiente",
      preparing: "👨‍🍳 Preparándose",
      ready: "✅ Listo para entregar",
      delivered: "🛵 Entregado",
      cancelled: "❌ Cancelado",
    };

    const items = order.items as { name: string; quantity: number }[];
    const itemList = Array.isArray(items)
      ? items.map((i) => `  • ${i.quantity}x ${i.name}`).join("\n")
      : "Sin detalle";

    const active = isActiveStatus(order.status);
    const semantic = getStatusSemantic(order.status, order.orderType, order.address, order.id);
    const notificationMsg = getStatusNotificationMessage(
      order.status, order.id, order.orderType, order.address,
    );

    let result = `📋 Pedido #${order.id}\n${statusLabels[order.status] || order.status}\n${itemList}\n👤 ${order.customerName || "Sin nombre"}`;
    result += `\n📌 Estado: ${semantic}`;
    result += `\n🔵 Pedido activo: ${active ? "SÍ" : "NO"}`;

    if (notificationMsg) {
      result += `\n📨 Notificación enviada al cliente: "${notificationMsg}"`;
    }

    // Instrucciones para el agente según el estado
    if (order.status === "ready") {
      result += `\n⚠️ IMPORTANTE: Si el cliente responde a la notificación de 'Listo', NO es un pedido nuevo. Es respuesta a la notificación. NO ejecutes createOrder.`;
    } else if (order.status === "delivered") {
      result += `\n⚠️ Este pedido ya fue entregado. No es un pedido activo. Tratá al cliente como si fuera nuevo.`;
    } else if (active) {
      result += `\n⚠️ El cliente tiene un pedido activo. Si pide algo nuevo, primero completá este pedido.`;
    }

    return result;
  },
});

// ─── addToOrder ─────────────────────────────────────────────────────────────
export const addToOrderTool = tool({
  description:
    "Agrega items a un pedido existente. Tiene 5 MINUTOS desde que se creó el pedido para agregar cosas. Después ya no se puede.",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
    newItems: z
      .array(
        z.object({
          name: z.string(),
          quantity: z.number().int().positive(),
          unitPrice: z.number().positive(),
        })
      )
      .describe("Items nuevos a agregar"),
  }),
  execute: async ({ orderId, newItems }) => {
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const order = await visibleOrderOrNull(rows[0]);
    if (!order) {
      return "No encontré ese pedido.";
    }

    // Ventana de 5 minutos desde la creación del pedido
    const now = Date.now();
    const createdAt = order.createdAt instanceof Date 
      ? order.createdAt.getTime() 
      : new Date(order.createdAt).getTime();
    const minutosPasados = (now - createdAt) / 60000;

    if (minutosPasados > 5) {
      return `Pasaron más de 5 minutos desde que se creó el pedido #${orderId}. Derivo al equipo para que lo evalúe y te confirme si se puede agregar.`;
    }

    if (order.status !== "pending") {
      return "El pedido ya no está pendiente, no puedo agregar más items.";
    }

    const currentItems = (order.items as { name: string; quantity: number; unitPrice: number }[]) || [];
    const updatedItems = [...currentItems, ...newItems];
    const total = updatedItems.reduce(
      (sum, i) => sum + i.quantity * i.unitPrice,
      0
    );

    await db
      .update(orders)
      .set({ items: updatedItems, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    const added = newItems
      .map((i) => `${i.quantity}x ${i.name}`)
      .join(", ");

    return `✅ Agregado al pedido #${orderId}: ${added}\n💰 Nuevo total: $${total.toFixed(2)}\n⏱ Tenés hasta 5 minutos desde la creación del pedido para agregar cosas.`;
  },
});

// ─── updateOrder ────────────────────────────────────────────────────────────
export const updateOrderTool = tool({
  description:
    "Modifica notas, items, tipo de entrega, o dirección de un pedido pendiente. Solo funciona si está en 'pending'. Usar cuando el cliente cambia delivery/retiro, dirección, o contenido del pedido.",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
    notes: z.string().optional().describe("Nuevas notas"),
    orderType: z.enum(["delivery", "retiro"]).optional().describe("Cambiar tipo de entrega: delivery o retiro"),
    address: z.string().optional().describe("Nueva dirección si cambia a delivery"),
    deliveryFee: z.number().optional().describe("Nuevo costo de envío"),
    items: z
      .array(
        z.object({
          name: z.string(),
          quantity: z.number().int().positive(),
          unitPrice: z.number().positive(),
        })
      )
      .optional()
      .describe("Items actualizados (reemplaza los existentes)"),
  }),
  execute: async ({ orderId, notes, items, orderType, address, deliveryFee }) => {
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
      .limit(1);

    if (!(await visibleOrderOrNull(rows[0]))) {
      return "No encontré un pedido pendiente con ese número. Solo puedo modificar pedidos que todavía no se están preparando.";
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (notes !== undefined) updates.notes = notes;
    if (items !== undefined) updates.items = items;
    if (orderType !== undefined) updates.orderType = orderType;
    if (address !== undefined) updates.address = address;
    if (deliveryFee !== undefined) updates.deliveryFee = deliveryFee;

    await db.update(orders).set(updates).where(eq(orders.id, orderId));

    const parts: string[] = [`✅ Pedido #${orderId} actualizado.`];
    if (orderType) parts.push(`📦 Tipo de entrega: ${orderType}`);
    if (address) parts.push(`📍 Dirección: ${address}`);
    if (deliveryFee !== undefined) parts.push(`🚚 Delivery: $${deliveryFee}`);
    if (items) {
      const total = items.reduce(
        (sum, i) => sum + i.quantity * i.unitPrice,
        0
      );
      parts.push(`💰 Nuevo total: $${total.toFixed(2)}`);
    }
    if (notes) parts.push(`📝 Notas: ${notes}`);

    return parts.join("\n");
  },
});

// ─── cancelOrder ────────────────────────────────────────────────────────────
export const cancelOrderTool = tool({
  description:
    "Cancela un pedido. Solo se puede cancelar si está en 'pending' o 'preparing'. SIEMPRE confirmar con el cliente antes de cancelar.",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido a cancelar"),
    reason: z
      .string()
      .optional()
      .describe("Motivo de cancelación"),
  }),
  execute: async ({ orderId, reason }) => {
    const rows = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    const order = await visibleOrderOrNull(rows[0]);
    if (!order) {
      return "No encontré ese pedido.";
    }

    if (order.status === "delivered" || order.status === "cancelled") {
      return `No se puede cancelar — el pedido #${orderId} ya está ${order.status === "delivered" ? "entregado" : "cancelado"}.`;
    }

    await db
      .update(orders)
      .set({
        status: "cancelled",
        notes: reason
          ? `${order.notes || ""} [CANCELADO: ${reason}]`.trim()
          : order.notes,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    return `❌ Pedido #${orderId} cancelado.${reason ? ` Motivo: ${reason}` : ""}\nDisculpá las molestias. ¿Querés hacer un pedido nuevo?`;
  },
});
