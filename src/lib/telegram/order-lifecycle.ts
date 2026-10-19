// ─── Order status transitions (Telegram ops bot) ─────────────────────────────
// Comparte la semántica del camino admin (admin/orders/actions.ts): al marcar
// delivered se guarda deliveredAt, se agenda el follow-up de 30' y se envía la
// notificación de estado al cliente por WhatsApp — antes las tools de
// Telegram solo tocaban `status`+`updatedAt` y el cliente nunca se enteraba.
//
// `planOrderStatusTransition` es pura: la decisión de qué efectos dispara cada
// transición queda testeable sin DB. `applyOrderStatusTransition` la ejecuta.

import { db } from "@/db";
import { orders } from "@/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { getArgentinaHour } from "@/lib/argentina-time";
import { isValidPhone, normalizePhone } from "@/lib/phone-utils";
import { getStatusNotificationMessage } from "@/lib/whatsapp/status-utils";

export type OrderStatusTransition =
  | "pending"
  | "preparing"
  | "ready"
  | "delivered"
  | "cancelled";

export interface StatusTransitionPlan {
  /** delivered → guardar timestamp de entrega. */
  markDeliveredAt: boolean;
  /** primera entrada a delivered → dejar followupSent=false (cron lo envía). */
  scheduleFollowUp: boolean;
  /** hay mensaje de estado para notificar al cliente. */
  notify: boolean;
  /** cancelled desde un estado no-terminal → reponer el stock descontado. */
  restoreStock: boolean;
}

/**
 * Decide los efectos de pasar de `currentStatus` a `newStatus`. Misma tabla
 * de decisión que el camino admin: solo ready/delivered tienen mensaje al
 * cliente (getStatusNotificationMessage devuelve null para el resto) y el
 * follow-up se agenda solo en la primera transición a delivered — re-marcar
 * delivered no debe re-encolar un aviso que el cron ya envió.
 *
 * El stock se repone SOLO al entrar a cancelled desde un estado no terminal:
 * re-cancelar no duplica la reposición y cancelar algo ya entregado no
 * devuelve items que ya salieron físicamente.
 */
export function planOrderStatusTransition(
  currentStatus: string | null,
  newStatus: OrderStatusTransition
): StatusTransitionPlan {
  const delivered = newStatus === "delivered";
  return {
    markDeliveredAt: delivered,
    scheduleFollowUp: delivered && currentStatus !== "delivered",
    notify: newStatus === "ready" || delivered,
    restoreStock:
      newStatus === "cancelled" &&
      currentStatus !== "cancelled" &&
      currentStatus !== "delivered",
  };
}

export interface ApplyTransitionResult {
  ok: boolean;
  error?: string;
  notified?: boolean;
  notifyError?: string;
  customerName?: string | null;
  /** el pedido ya estaba en el estado pedido (nada que hacer). */
  alreadyInStatus?: boolean;
  /** se repuso stock por la cancelación. */
  stockRestored?: boolean;
}

/**
 * Espejo de decrementStockBestEffort (order-utils): createOrder descuenta
 * stock al crear; al cancelar hay que devolverlo. Best-effort — una falla de
 * stock no debe romper la cancelación del pedido.
 */
async function restoreStockBestEffort(items: unknown): Promise<void> {
  try {
    for (const item of Array.isArray(items) ? items : []) {
      const { productId, quantity } = item as {
        productId?: number;
        quantity?: number;
      };
      if (
        !productId ||
        typeof quantity !== "number" ||
        !Number.isSafeInteger(quantity) ||
        quantity <= 0
      )
        continue;
      await db.execute(
        sql`UPDATE products SET stock = stock + ${quantity} WHERE id = ${productId} AND stock IS NOT NULL`
      );
    }
  } catch (err) {
    console.warn("[restoreStock] Failed (non-fatal):", err);
  }
}

/**
 * Misma regla de horario que `scheduleFollowUp` en orders/actions.ts:
 * follow-ups solo en horario hábil 9-22 (hora Argentina). El envío real lo
 * hace el cron GET /api/cron/followup sobre filas con followupSent=false.
 */
async function scheduleOrderFollowUp(orderId: number): Promise<void> {
  try {
    const hour = getArgentinaHour();
    if (hour < 9 || hour >= 22) {
      console.log(
        `[followup] Skipped for order #${orderId} — outside business hours (${hour}:00)`
      );
      return;
    }
    await db
      .update(orders)
      .set({ followupSent: false })
      .where(eq(orders.id, orderId));
  } catch (e) {
    console.warn(`[followup] Failed to schedule for order #${orderId}:`, e);
  }
}

/**
 * Notificación de estado al cliente: mismo mensaje, mismo transporte y mismo
 * registro en historial que el camino admin (sendOrderStatusNotification +
 * findOrCreateConversation/insertMessage con la cuenta resuelta). Leads sin
 * teléfono real ("sin-telefono-*") no tienen destino — se omite sin error.
 */
async function notifyCustomerOfStatusChange(
  order: {
    id: number;
    phoneNumber: string | null;
    customerName: string | null;
    orderType: string | null;
    address: string | null;
  },
  newStatus: OrderStatusTransition
): Promise<{ notified: boolean; error?: string }> {
  try {
    const { getBusinessInfo } = await import("@/lib/business");
    const biz = await getBusinessInfo();
    const message = getStatusNotificationMessage(
      newStatus,
      order.id,
      order.orderType,
      order.address,
      { address: biz.address, instagram: biz.instagram }
    );
    if (!message) return { notified: false };

    const phone = order.phoneNumber ? normalizePhone(order.phoneNumber) : "";
    if (!phone || !isValidPhone(phone)) return { notified: false };

    const { messenger } = await import("@/lib/messaging");
    const {
      findOrCreateConversation,
      insertMessage,
      resolveConversationAccountForPhone,
      resolveDefaultWhatsAppAccount,
    } = await import("@/lib/channels/router");
    const { sendOrderStatusNotification } = await import(
      "@/lib/whatsapp/order-status-notify"
    );

    const notified = await sendOrderStatusNotification(
      { phoneNumber: phone, message },
      {
        resolveBinding: resolveConversationAccountForPhone,
        resolveDefaultAccount: resolveDefaultWhatsAppAccount,
        send: (msg, opts) => messenger.send(msg, opts),
      }
    );
    if (!notified.ok) {
      return { notified: false, error: notified.error };
    }

    const phoneWithPlus = phone.startsWith("+") ? phone : `+${phone}`;
    const conversationId =
      notified.conversationId ??
      (
        await findOrCreateConversation(
          "whatsapp",
          phoneWithPlus,
          order.customerName ?? undefined,
          phoneWithPlus,
          notified.channelAccountId
        )
      ).id;
    await insertMessage(
      conversationId,
      "system",
      message,
      undefined,
      notified.providerMessageId,
      notified.channelAccountId
    );
    return { notified: true };
  } catch (e) {
    return {
      notified: false,
      error: e instanceof Error ? e.message : "error desconocido",
    };
  }
}

/**
 * Aplica la transición de estado con la semántica completa del admin:
 * status + updatedAt (+deliveredAt si delivered), agenda de follow-up y
 * notificación al cliente. Una falla de notificación NO revierte el cambio
 * de estado — se reporta en `notifyError` igual que hace la UI admin.
 */
export async function applyOrderStatusTransition(
  orderId: number,
  newStatus: OrderStatusTransition,
  opts: { extraFields?: Record<string, unknown> } = {}
): Promise<ApplyTransitionResult> {
  const [order] = await db
    .select({
      id: orders.id,
      status: orders.status,
      phoneNumber: orders.phoneNumber,
      customerName: orders.customerName,
      orderType: orders.orderType,
      address: orders.address,
      items: orders.items,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return { ok: false, error: `No encontré el pedido #${orderId}.` };

  const plan = planOrderStatusTransition(order.status, newStatus);
  const fields: Record<string, unknown> = {
    status: newStatus,
    updatedAt: new Date(),
    ...opts.extraFields,
  };
  if (plan.markDeliveredAt) fields.deliveredAt = new Date();

  if (newStatus === "cancelled") {
    // Idempotente: la cláusula `status != 'cancelled'` hace que una segunda
    // cancelación (o dos concurrentes) devuelva 0 filas — solo la transición
    // real repone stock, nunca dos veces.
    const rows = await db
      .update(orders)
      .set(fields)
      .where(and(eq(orders.id, orderId), ne(orders.status, "cancelled")))
      .returning({ id: orders.id });
    if (rows.length === 0) {
      return { ok: true, alreadyInStatus: true, customerName: order.customerName };
    }
    if (plan.restoreStock) await restoreStockBestEffort(order.items);
    return {
      ok: true,
      stockRestored: plan.restoreStock,
      customerName: order.customerName,
    };
  }

  await db.update(orders).set(fields).where(eq(orders.id, orderId));

  if (plan.scheduleFollowUp) await scheduleOrderFollowUp(orderId);

  const notify = plan.notify
    ? await notifyCustomerOfStatusChange(order, newStatus)
    : { notified: false };

  return {
    ok: true,
    notified: notify.notified,
    notifyError: notify.error,
    customerName: order.customerName,
  };
}
