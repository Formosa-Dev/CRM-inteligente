/**
 * Delivery-arrived notification workflow.
 *
 * Pure over injected dependencies so the account-bound transport, success and
 * retryable failure paths are testable without a database. The transport is
 * always the resolved account (or the scoped credentials), never a global
 * `agent_config` read.
 */

import type { SendResult } from "@/lib/messaging/types";

export interface DeliveryOrder {
  phoneNumber: string;
  customerName: string | null;
}

export interface DeliveryNotifyDeps {
  findPendingOrder(): Promise<DeliveryOrder | null>;
  send(
    to: string,
    text: string,
    audience: "delivery" | "customer"
  ): Promise<SendResult>;
}

export type DeliveryNotifyResult =
  | { ok: true; customerPhone: string | null }
  | { ok: false; error: string; retryable: boolean };

export async function notifyDeliveryArrived(
  deliveryPhone: string,
  deps: DeliveryNotifyDeps
): Promise<DeliveryNotifyResult> {
  let order: DeliveryOrder | null;
  try {
    order = await deps.findPendingOrder();
  } catch (error) {
    return {
      ok: false,
      error: `no se pudo leer el pedido pendiente: ${
        error instanceof Error ? error.message : "error desconocido"
      }`,
      retryable: true,
    };
  }

  if (!order?.phoneNumber) {
    const sent = await deps.send(
      deliveryPhone,
      "Gracias, no hay pedidos pendientes.",
      "delivery"
    );
    return sent.ok
      ? { ok: true, customerPhone: null }
      : { ok: false, error: sent.error, retryable: sent.retryable };
  }

  const text = `¡Hola ${order.customerName || ""}! El delivery ya está afuera con tu pedido. Que lo disfrutes 🍔`.trim();
  const sent = await deps.send(order.phoneNumber, text, "customer");
  return sent.ok
    ? { ok: true, customerPhone: order.phoneNumber }
    : { ok: false, error: sent.error, retryable: sent.retryable };
}
