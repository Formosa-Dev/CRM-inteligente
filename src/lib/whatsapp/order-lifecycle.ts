/**
 * Order-lifecycle persistence (WhatsApp sales agent).
 *
 * This is the only place that closes stale open orders. It is intentionally
 * repository-injected so the material invariants can be tested without touching
 * production, and so it stays consolidated on the shared `@/db` client.
 *
 * Requirement: an open order (pending/preparing/ready) younger than 4 hours
 * stays active; at/over 4 hours it is idempotently auto-closed as delivered and
 * paid (deliveredAt/updatedAt set) with structured, privacy-safe audit logging.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { logger } from "@/lib/logger";
import {
  ACTIVE_ORDER_STATUSES,
  ageInHours,
  type ActiveOrderStatus,
  type ActiveOrderSnapshot,
} from "./temporal-context";

const ACTIVE_STATUS_LIST = [...ACTIVE_ORDER_STATUSES] as ActiveOrderStatus[];

export interface OrderLifecycleRepository {
  findActiveOrder(phoneNumber: string): Promise<ActiveOrderSnapshot | null>;
  /** Conditional close: returns true only when this call transitioned the row. */
  closeOrderAsDeliveredPaid(orderId: number, at: Date): Promise<boolean>;
}

export class DrizzleOrderLifecycleRepository implements OrderLifecycleRepository {
  async findActiveOrder(phoneNumber: string): Promise<ActiveOrderSnapshot | null> {
    const [row] = await db
      .select({ id: orders.id, status: orders.status, createdAt: orders.createdAt })
      .from(orders)
      .where(and(eq(orders.phoneNumber, phoneNumber), inArray(orders.status, ACTIVE_STATUS_LIST)))
      .orderBy(desc(orders.createdAt))
      .limit(1);
    return row ?? null;
  }

  async closeOrderAsDeliveredPaid(orderId: number, at: Date): Promise<boolean> {
    const updated = await db
      .update(orders)
      .set({
        status: "delivered",
        paymentStatus: "paid",
        deliveredAt: at,
        updatedAt: at,
      })
      .where(and(eq(orders.id, orderId), inArray(orders.status, ACTIVE_STATUS_LIST)));
    const rowCount = (updated as unknown as { rowCount?: number }).rowCount ?? 0;
    return rowCount > 0;
  }
}

/** Read-only snapshot of the customer's open order, if any. */
export async function getActiveOrderSnapshot(phoneNumber: string): Promise<ActiveOrderSnapshot | null> {
  return new DrizzleOrderLifecycleRepository().findActiveOrder(phoneNumber);
}

// ─── Privacy-safe structured audit ──────────────────────────────────────────

export interface OrderAuditFields {
  conversationId?: number;
  messageId?: string;
  localDay?: string;
  consideredCurrentMessages?: number;
  activeOrderId?: number | null;
  activeOrderAgeHours?: number;
  autoClosed?: boolean;
  decision: "create" | "no_create" | "keep_active" | "auto_close";
  reason?: string;
}

/**
 * Emits a structured audit record. Only opaque identifiers, local-day
 * classification and decision facts are logged — never secrets, phone numbers,
 * names, message text, addresses or payment values.
 */
export function auditOrderEvent(event: string, fields: OrderAuditFields): void {
  logger.info({ event, scope: "whatsapp-order-lifecycle", ...fields }, `order-audit: ${event}`);
}

export interface AutoCloseResult {
  closed: boolean;
  orderId: number;
  ageHours: number;
}

/** Idempotent close of a stale open order; safe to retry. */
export async function autoCloseStaleOrder(
  order: ActiveOrderSnapshot,
  now: Date,
  repository: OrderLifecycleRepository,
  audit: Pick<OrderAuditFields, "conversationId" | "messageId" | "localDay"> = {},
): Promise<AutoCloseResult> {
  const ageHours = ageInHours(order.createdAt, now);
  let closed = false;
  try {
    closed = await repository.closeOrderAsDeliveredPaid(order.id, now);
  } catch (error) {
    logger.error(
      { event: "order_auto_close_failed", scope: "whatsapp-order-lifecycle", orderId: order.id, ...audit, error: (error as Error)?.message },
      "order-audit: order_auto_close_failed",
    );
    throw error;
  }
  auditOrderEvent("order_auto_closed", {
    ...audit,
    decision: "auto_close",
    activeOrderId: order.id,
    activeOrderAgeHours: Number(ageHours.toFixed(2)),
    autoClosed: closed,
    reason: closed ? "stale_open_order_over_lifecycle" : "already_closed",
  });
  return { closed, orderId: order.id, ageHours };
}
