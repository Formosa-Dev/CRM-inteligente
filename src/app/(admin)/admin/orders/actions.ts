"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { orders, conversations } from "@/db/schema";
import { eq, desc, and, count, ilike, or } from "drizzle-orm";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth/require-admin";
import { resolveClientNamesBatch } from "@/lib/lead-utils";
import { getBusinessInfo } from "@/lib/business";
import { getStatusNotificationMessage } from "@/lib/whatsapp/status-utils";

const PAGE_SIZE = 30;

/**
 * Programa un follow-up para 30 minutos después de la entrega.
 * Usa setTimeout con un tope de 30 min reales.
 */
async function scheduleFollowUp(orderId: number, _phoneNumber: string, _customerName: string | null) {
  try {
    const now = new Date();
    const hour = now.getHours();
    // Solo enviar follow-up en horario hábil (9-22hs)
    if (hour < 9 || hour >= 22) {
      console.log(`[followup] Skipped for order #${orderId} — outside business hours (${hour}:00)`);
      return;
    }

    // setTimeout de 30 minutos (1800000 ms) — pero no esperamos si es serverless
    // En su lugar, marcamos followupSent como false y usamos un endpoint cron.
    // Ya está en false por defecto. El envío real se hace desde un endpoint.

    // Para Render (serverless), usamos un enfoque simple:
    // Marcamos que hay un follow-up pendiente con followupSent=false
    // El endpoint GET /api/followup procesa los pendientes.
    await db.update(orders).set({ followupSent: false }).where(eq(orders.id, orderId));
    console.log(`[followup] Scheduled for order #${orderId} — will be sent via /api/followup`);
  } catch (e) {
    console.warn(`[followup] Failed to schedule for order #${orderId}:`, e);
  }
}

export type OrderStatus = "pending" | "preparing" | "ready" | "delivered" | "cancelled";
export type OrderType = "hamburguesas" | "pan_mayorista";

export interface OrderRow {
  id: number;
  phoneNumber: string;
  customerName: string | null;
  address: string | null;
  orderType: OrderType | null;
  items: unknown;
  notes: string | null;
  tags: string[] | null;
  status: string;
  leadId: number | null;
  deliveryFee: string | null;
  paymentStatus: string | null;
  paymentMethod: string | null;
  deliveredAt: Date | null;
  followupSent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrdersResponse {
  rows: OrderRow[];
  total: number;
  totalPages: number;
  currentPage: number;
}

/**
 * Fetch orders with filters
 */
export async function fetchOrders(params: {
  status?: string;
  type?: string;
  search?: string;
  page?: number;
}): Promise<OrdersResponse> {
  const session = await auth();
  if (!session) return { rows: [], total: 0, totalPages: 1, currentPage: 1 };

  const page = Math.max(1, params.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions = [];

  if (params.status && ["pending", "preparing", "ready", "delivered", "cancelled"].includes(params.status)) {
    conditions.push(eq(orders.status, params.status as OrderStatus));
  }
  if (params.type && ["hamburguesas", "pan_mayorista"].includes(params.type)) {
    conditions.push(eq(orders.orderType, params.type as OrderType));
  }
  if (params.search) {
    const s = `%${params.search}%`;
    conditions.push(
      or(
        ilike(orders.phoneNumber, s),
        ilike(orders.customerName ?? "", s),
        ilike(orders.notes ?? "", s)
      )
    );
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(orders)
      .where(whereClause)
      .orderBy(desc(orders.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ total: count() }).from(orders).where(whereClause),
  ]);

  // Enrich with managed client names from leads
  if (rows.length > 0) {
    const phones = rows.map((r) => r.phoneNumber).filter(Boolean) as string[];
    const nameMap = await resolveClientNamesBatch(phones);
    for (const row of rows) {
      const resolved = nameMap.get(row.phoneNumber);
      if (resolved) row.customerName = resolved;
    }
  }

  return {
    rows,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    currentPage: page,
  };
}

// ─── Mensajes profesionales segun estado, tipo y entrega ───────────────
// Delega al helper compartido; los datos de contacto salen de agent_config.
async function buildWhatsAppMessage(status: string, order: OrderRow): Promise<string | null> {
  const biz = await getBusinessInfo();
  return getStatusNotificationMessage(status, order.id, order.orderType, order.address, {
    address: biz.address,
    instagram: biz.instagram,
  });
}

/**
 * Update order status + send WhatsApp notification
 */
export async function updateOrderStatus(
  orderId: number,
  newStatus: OrderStatus
): Promise<{ success: boolean; message: string }> {
  if (!(await requireAdmin())) return { success: false, message: "No autorizado"  };
  // Server actions are callable with arbitrary payloads — validate the enum.
  if (!["pending", "preparing", "ready", "delivered", "cancelled"].includes(newStatus)) {
    return { success: false, message: "Estado inválido" };
  }

  try {
    // Get order details before updating
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return { success: false, message: "Pedido no encontrado" };

    const updateFields: Record<string, unknown> = { status: newStatus, updatedAt: new Date() };

    // Si se marca como entregado, guardar timestamp y programar followup
    if (newStatus === "delivered") {
      updateFields.deliveredAt = new Date();
      await db.update(orders).set(updateFields).where(eq(orders.id, orderId));
      scheduleFollowUp(orderId, order.phoneNumber || "", order.customerName);
    } else {
      await db
        .update(orders)
        .set(updateFields)
        .where(eq(orders.id, orderId));
    }

    // Send WhatsApp notification + save to conversation history
    const message = await buildWhatsAppMessage(newStatus, order as OrderRow);
    if (message && order.phoneNumber) {
      try {
        const { sendText } = await import("@/lib/ycloud");
        const result = await sendText(order.phoneNumber, message);
        console.log(`[orders] WhatsApp sent to ${order.phoneNumber} for order #${orderId}: ${newStatus}`);

        // Save the outgoing message in chat_messages so AI has context
        // Se guarda como "system" (no "assistant") para que el AI sepa que es notificación automática
        const { insertMessage } = await import("@/lib/channels/router");
        const phone = order.phoneNumber.startsWith("+") ? order.phoneNumber : `+${order.phoneNumber}`;
        const conv = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.whatsappId, phone))
          .limit(1);
        if (conv[0]) {
          await insertMessage(conv[0].id, "system", message, undefined, result.ok ? result.wamid : undefined);
          console.log(`[orders] Status message saved to conversation #${conv[0].id} (role=system, wamid=${result.ok ? result.wamid : "none"})`);
        }
      } catch (e) {
        console.warn(`[orders] Failed to send WhatsApp for order #${orderId}:`, e);
      }
    }

    revalidatePath("/admin/orders");
    return { success: true, message: "Estado actualizado" };
  } catch {
    return { success: false, message: "Error al actualizar" };
  }
}

/**
 * Notificar al cliente sin cambiar el estado
 */
export async function notifyCustomer(
  orderId: number
): Promise<{ success: boolean; message: string }> {
  if (!(await requireAdmin())) return { success: false, message: "No autorizado"  };

  try {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!order) return { success: false, message: "Pedido no encontrado" };
    if (!order.phoneNumber) return { success: false, message: "Sin teléfono" };

    const msg = await buildWhatsAppMessage(order.status, order as OrderRow);
    if (!msg) return { success: false, message: "No hay mensaje para este estado" };

    const { sendText } = await import("@/lib/ycloud");
    const result = await sendText(order.phoneNumber, msg);
    if (!result.ok) return { success: false, message: `Error al enviar: ${result.error}` };

    // Save notification in conversation history so AI has context (role "system")
    const { insertMessage } = await import("@/lib/channels/router");
    const phone = order.phoneNumber.startsWith("+") ? order.phoneNumber : `+${order.phoneNumber}`;
    const conv = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.whatsappId, phone))
      .limit(1);
    if (conv[0]) {
      await insertMessage(conv[0].id, "system", msg, undefined, result.wamid);
    }

    return { success: true, message: "Notificación enviada" };
  } catch (e) {
    return { success: false, message: `Error: ${e instanceof Error ? e.message : "desconocido"}` };
  }
}

/**
 * Get order summary counts
 */
export async function getOrderCounts(): Promise<Record<string, number>> {
  const session = await auth();
  if (!session) return {};

  const grouped = await db
    .select({ status: orders.status, n: count() })
    .from(orders)
    .groupBy(orders.status);

  const counts: Record<string, number> = { pending: 0, preparing: 0, ready: 0, delivered: 0, cancelled: 0 };
  for (const row of grouped) counts[row.status] = row.n;
  counts["total"] = Object.values(counts).reduce((a, b) => a + b, 0);

  return counts;
}

/**
 * Marcar como pagado + entregado de una sola vez, sin notificar al cliente
 */
export async function markPaidAndDelivered(
  orderId: number
): Promise<{ success: boolean; message: string }> {
  if (!(await requireAdmin())) return { success: false, message: "No autorizado"  };

  try {
    const [order] = await db
      .select({ phoneNumber: orders.phoneNumber, customerName: orders.customerName })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    await db
      .update(orders)
      .set({
        paymentStatus: "paid",
        status: "delivered",
        deliveredAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    if (order) {
      scheduleFollowUp(orderId, order.phoneNumber || "", order.customerName);
    }

    revalidatePath("/admin/orders");
    return { success: true, message: "Pagado y entregado" };
  } catch {
    return { success: false, message: "Error al actualizar" };
  }
}

/**
 * Delete an order permanently
 */
export async function deleteOrder(
  orderId: number
): Promise<{ success: boolean; error?: string }> {
  if (!(await requireAdmin())) return { success: false, error: "No autorizado"  };

  try {
    await db.delete(orders).where(eq(orders.id, orderId));
    revalidatePath("/admin/orders");
    return { success: true };
  } catch {
    return { success: false, error: "Error al eliminar" };
  }
}

/**
 * Actualiza un pedido (items, datos del cliente, etc.)
 */
export const updateOrder = async (
  orderId: number,
  data: {
    customerName?: string;
    phoneNumber?: string;
    address?: string | null;
    orderType?: "hamburguesas" | "pan_mayorista";
    items?: { name: string; quantity: number; price?: number; unitPrice?: number }[];
    deliveryFee?: number;
    notes?: string | null;
    paymentStatus?: string;
    paymentMethod?: string | null;
  }
): Promise<{ success: boolean; error?: string }> => {
  if (!(await requireAdmin())) return { success: false, error: "No autorizado"  };

  try {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (data.customerName !== undefined) updates.customerName = data.customerName;
    if (data.phoneNumber !== undefined) updates.phoneNumber = data.phoneNumber;
    if (data.address !== undefined) updates.address = data.address;
    if (data.orderType !== undefined) updates.orderType = data.orderType;
    if (data.items !== undefined) updates.items = data.items;
    if (data.deliveryFee !== undefined) updates.deliveryFee = String(data.deliveryFee);
    if (data.notes !== undefined) updates.notes = data.notes;
    if (data.paymentStatus !== undefined) updates.paymentStatus = data.paymentStatus;
    if (data.paymentMethod !== undefined) updates.paymentMethod = data.paymentMethod;

    await db.update(orders).set(updates).where(eq(orders.id, orderId));
    revalidatePath("/admin/orders");
    revalidatePath("/admin/clients");
    revalidatePath("/admin");
    return { success: true };
  } catch {
    return { success: false, error: "Error al actualizar" };
  }
};
