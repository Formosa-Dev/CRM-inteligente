import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { getStatusSemantic, isActiveStatus, getStatusNotificationMessage } from "@/lib/whatsapp/status-utils";
import { currentAgentConfigScope } from "@/lib/agent-config-scope";
import { isOrderVisibleToScope } from "@/lib/whatsapp/order-lifecycle";
import { normalizePhone } from "@/lib/phone-utils";
import { resolveItems, validateResolvedOrderItems, restoreOrderStockBestEffort } from "@/lib/order-utils";
import { resolveDeliveryFee } from "./extended-tools";

// The ambient scope carries the conversation's channelAccountId AND its
// server-side customerPhone. A bound scope only sees/mutates orders owned by
// its account's leads; a customer-bound scope only sees ITS OWN orders —
// model-supplied orderId/phone can never reach another customer's row. NULL
// scope fields keep the legacy phone-global behavior (internal/admin tools).
// Post-fetch gating keeps the not-found path identical (a foreign order is
// indistinguishable from a missing one).
async function visibleOrderOrNull<T extends { id: number; phoneNumber?: string | null }>(
  order: T | undefined
): Promise<T | undefined> {
  if (!order) return undefined;
  const scope = currentAgentConfigScope();
  if (!(await isOrderVisibleToScope(order.id, scope.channelAccountId ?? null))) {
    return undefined;
  }
  if (
    scope.customerPhone &&
    normalizePhone(order.phoneNumber ?? "") !== scope.customerPhone
  ) {
    return undefined;
  }
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
    } else {
      // The conversation's customer phone wins over the model-supplied one —
      // a customer can only ever ask about their own last order.
      const scopedPhone =
        currentAgentConfigScope().customerPhone ??
        (customerPhone ? normalizePhone(customerPhone) : undefined);
      if (scopedPhone) {
        const rows = await db
          .select()
          .from(orders)
          .where(eq(orders.phoneNumber, scopedPhone))
          .orderBy(desc(orders.createdAt))
          .limit(1);
        order = rows[0];
      }
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
        })
      )
      .describe("Items nuevos a agregar (el precio se resuelve desde la DB — nunca lo inventes)"),
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

    // Re-price against the DB: LLM-supplied prices are untrusted input and
    // never reach orders.items (same invariant as createOrder).
    const resolvedNew = await resolveItems(newItems);
    const itemError = validateResolvedOrderItems(resolvedNew);
    if (itemError) return itemError;

    const currentItems = (order.items as { name: string; quantity: number; unitPrice: number }[]) || [];
    const updatedItems = [...currentItems, ...resolvedNew];
    const total = updatedItems.reduce(
      (sum, i) => sum + i.quantity * i.unitPrice,
      0
    );

    await db
      .update(orders)
      .set({ items: updatedItems, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    const added = resolvedNew
      .map((i) => `${i.quantity}x ${i.name}`)
      .join(", ");

    return `✅ Agregado al pedido #${orderId}: ${added}\n💰 Nuevo total: $${total.toFixed(2)}\n⏱ Tenés hasta 5 minutos desde la creación del pedido para agregar cosas.`;
  },
});

// ─── updateOrder ────────────────────────────────────────────────────────────
export const updateOrderTool = tool({
  description:
    "Modifica notas, items, modo de entrega, o dirección de un pedido pendiente. Solo funciona si está en 'pending'. Usar cuando el cliente cambia delivery/retiro, dirección, o contenido del pedido.",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
    notes: z.string().optional().describe("Nuevas notas"),
    entrega: z
      .enum(["delivery", "retiro"])
      .optional()
      .describe("Cambiar modo de entrega: 'delivery' (requiere address) o 'retiro' (por el local)"),
    address: z.string().optional().describe("Nueva dirección si cambia a delivery"),
    items: z
      .array(
        z.object({
          name: z.string(),
          quantity: z.number().int().positive(),
        })
      )
      .optional()
      .describe("Items actualizados (reemplaza los existentes; el precio se resuelve desde la DB, nunca lo inventes)"),
  }),
  execute: async ({ orderId, notes, items, entrega, address }) => {
    const rows = await db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.status, "pending")))
      .limit(1);

    const order = await visibleOrderOrNull(rows[0]);
    if (!order) {
      return "No encontré un pedido pendiente con ese número. Solo puedo modificar pedidos que todavía no se están preparando.";
    }

    // Fulfillment mode lives in `address` (presence = delivery, per
    // status-utils) — orders.order_type is the BUSINESS-LINE enum
    // (hamburguesas|pan_mayorista) and is never written here. The delivery
    // fee is resolved server-side from the configured zones; the model's
    // price/fee args are untrusted and never persisted.
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (notes !== undefined) updates.notes = notes;

    let resolvedItems = undefined as Awaited<ReturnType<typeof resolveItems>> | undefined;
    if (items !== undefined) {
      resolvedItems = await resolveItems(items);
      const itemError = validateResolvedOrderItems(resolvedItems);
      if (itemError) return itemError;
      updates.items = resolvedItems;
    }

    const effectiveAddress = address !== undefined ? address : order.address;
    if (entrega === "retiro") {
      updates.address = null;
      updates.deliveryFee = "0";
    } else if (entrega === "delivery") {
      if (!effectiveAddress || !effectiveAddress.trim()) {
        return "Para pasar a delivery necesito la dirección del cliente. Pedísela y ejecutá updateOrder con entrega='delivery' y address.";
      }
      updates.address = effectiveAddress;
      updates.deliveryFee = String(await resolveDeliveryFee(effectiveAddress));
    } else if (address !== undefined) {
      updates.address = address;
      updates.deliveryFee = String(await resolveDeliveryFee(address));
    }

    await db.update(orders).set(updates).where(eq(orders.id, orderId));

    const parts: string[] = [`✅ Pedido #${orderId} actualizado.`];
    if (entrega) parts.push(`📦 Entrega: ${entrega === "delivery" ? "delivery" : "retiro"}`);
    if (typeof updates.address === "string") parts.push(`📍 Dirección: ${updates.address}`);
    if (typeof updates.deliveryFee === "string") parts.push(`🚚 Envío: $${updates.deliveryFee}`);
    if (resolvedItems) {
      const total = resolvedItems.reduce(
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

    // A-26: transition is conditional — only the call that actually flips an
    // ACTIVE order to cancelled proceeds (concurrent cancels lose the race).
    const updated = await db
      .update(orders)
      .set({
        status: "cancelled",
        notes: reason
          ? `${order.notes || ""} [CANCELADO: ${reason}]`.trim()
          : order.notes,
        updatedAt: new Date(),
      })
      .where(and(eq(orders.id, orderId), inArray(orders.status, ["pending", "preparing", "ready"])));
    // neon-http returns {rowCount}; test fakes return the updated rows array.
    const cancelledRows = Array.isArray(updated)
      ? updated.length
      : ((updated as unknown as { rowCount?: number }).rowCount ?? 0);
    if (cancelledRows === 0) {
      return `No se puede cancelar — el pedido #${orderId} ya no está activo.`;
    }

    // Creation decremented stock — the cancel gives it back. The restore is
    // claimed by a notes marker so retries can never restore twice.
    await restoreOrderStockBestEffort(orderId);

    return `❌ Pedido #${orderId} cancelado.${reason ? ` Motivo: ${reason}` : ""}\nDisculpá las molestias. ¿Querés hacer un pedido nuevo?`;
  },
});
