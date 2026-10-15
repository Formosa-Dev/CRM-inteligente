import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { cashMovements, cashSessions, orders } from "@/db/schema";
import { classifyMethod, orderTotal } from "@/lib/cash/session";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CashMovementLine {
  id: number;
  direction: "in" | "out";
  amount: number;
  reason: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface OpenSessionView {
  sessionId: number;
  openedAt: Date;
  openingCash: number;
  cashSalesTotal: number;
  cashSalesCount: number;
  digitalTotal: number;
  digitalCount: number;
  unknownTotal: number;
  unknownCount: number;
  pendingTotal: number;
  pendingCount: number;
  deliveryFees: number;
  deliveryCount: number;
  movementsIn: number;
  movementsOut: number;
  expectedCash: number;
  movements: CashMovementLine[];
}

export interface ClosedSessionLine {
  id: number;
  openedAt: Date;
  closedAt: Date | null;
  expectedCash: number | null;
  actualCash: number | null;
  difference: number | null;
  closedBy: string | null;
}

// classifyMethod viene de @/lib/cash/session (WT1 ya mergeado) — única fuente
// de verdad para la clasificación de métodos de pago. La página necesita las
// filas crudas de cash_movements, por eso consulta drizzle directo.

// ─── Sesión abierta ───────────────────────────────────────────────────────────

/**
 * Vista de la sesión de caja abierta (o null si no hay ninguna).
 * Esperado = apertura + ventas en efectivo cobradas + entradas − salidas,
 * con la misma ventana que el cierre: COALESCE(delivered_at, created_at)
 * >= opened_at, excluyendo pedidos cancelados. Los cobros pendientes
 * (paymentStatus != 'paid') se reportan aparte — no suman a la caja.
 */
export async function getOpenSessionView(): Promise<OpenSessionView | null> {
  const [session] = await db
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.status, "open"))
    .orderBy(desc(cashSessions.openedAt))
    .limit(1);

  if (!session) return null;

  const periodOrders = await db
    .select({
      id: orders.id,
      items: orders.items,
      deliveryFee: orders.deliveryFee,
      paymentStatus: orders.paymentStatus,
      paymentMethod: orders.paymentMethod,
    })
    .from(orders)
    .where(
      and(
        ne(orders.status, "cancelled"),
        sql`coalesce(${orders.deliveredAt}, ${orders.createdAt}) >= ${session.openedAt}`,
      ),
    );

  let cashSalesTotal = 0;
  let cashSalesCount = 0;
  let digitalTotal = 0;
  let digitalCount = 0;
  let unknownTotal = 0;
  let unknownCount = 0;
  let pendingTotal = 0;
  let pendingCount = 0;
  let deliveryFees = 0;
  let deliveryCount = 0;

  for (const order of periodOrders) {
    const total = orderTotal({ items: order.items, deliveryFee: order.deliveryFee });
    if (order.paymentStatus !== "paid") {
      pendingTotal += total;
      pendingCount += 1;
      continue;
    }
    const fee = Number(order.deliveryFee ?? 0);
    if (Number.isFinite(fee) && fee > 0) {
      deliveryFees += fee;
      deliveryCount += 1;
    }
    switch (classifyMethod(order.paymentMethod)) {
      case "cash":
        cashSalesTotal += total;
        cashSalesCount += 1;
        break;
      case "digital":
        digitalTotal += total;
        digitalCount += 1;
        break;
      default:
        unknownTotal += total;
        unknownCount += 1;
    }
  }

  const movementRows = await db
    .select()
    .from(cashMovements)
    .where(eq(cashMovements.sessionId, session.id))
    .orderBy(desc(cashMovements.createdAt));

  const movements: CashMovementLine[] = movementRows.map((row) => ({
    id: row.id,
    direction: row.direction === "out" ? "out" : "in",
    amount: Number(row.amount),
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  }));

  const movementsIn = movements
    .filter((m) => m.direction === "in")
    .reduce((sum, m) => sum + m.amount, 0);
  const movementsOut = movements
    .filter((m) => m.direction === "out")
    .reduce((sum, m) => sum + m.amount, 0);

  const openingCash = Number(session.openingCash);

  return {
    sessionId: session.id,
    openedAt: session.openedAt,
    openingCash,
    cashSalesTotal,
    cashSalesCount,
    digitalTotal,
    digitalCount,
    unknownTotal,
    unknownCount,
    pendingTotal,
    pendingCount,
    deliveryFees,
    deliveryCount,
    movementsIn,
    movementsOut,
    // Cobrado sin método cuenta en caja (efectivo = caso base del negocio);
    // se sigue mostrando aparte para que el admin lo corrija si fue digital.
    expectedCash: openingCash + cashSalesTotal + unknownTotal + movementsIn - movementsOut,
    movements,
  };
}

// ─── Historial de cierres ─────────────────────────────────────────────────────

/** Últimas sesiones cerradas, más recientes primero. */
export async function getClosedSessions(limit = 20): Promise<ClosedSessionLine[]> {
  const rows = await db
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.status, "closed"))
    .orderBy(desc(cashSessions.closedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    expectedCash: row.expectedCash === null ? null : Number(row.expectedCash),
    actualCash: row.actualCash === null ? null : Number(row.actualCash),
    difference: row.difference === null ? null : Number(row.difference),
    closedBy: row.closedBy,
  }));
}
