// ─── Caja única (efectivo físico) ─────────────────────────────────────────────
// Dominio del sistema de Cierre de Caja. Las sesiones forman una CADENA
// CONTINUA: cada sesión abre donde cerró la anterior (auto-apertura backdateada
// en ensureOpenSession), así ningún pedido queda fuera de ninguna ventana ni en
// dos a la vez. Una sesión cerrada es inmutable — queda como asiento de
// auditoría. Implementa el contrato de sdd/caja-cierre/specs.md §2 (WT1).

import { db } from "@/db";
import { cashMovements, cashSessions, orders } from "@/db/schema";
import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";

// ─── Clasificación de método de pago ─────────────────────────────────────────

export type MoneyMethod = "cash" | "digital" | "unknown";

// `payment_method` es texto libre (lo escribe el agente o el admin). Se
// normaliza (minúsculas, sin tildes, sólo alfanumérico) y se matchea por
// palabra completa, no substring: "mp" no puede matchear dentro de "ejemplo".
const CASH_KEYWORDS = ["efectivo", "cash", "contado", "efvo", "en mano"];
const DIGITAL_KEYWORDS = [
  "mercadopago",
  "mercado pago",
  "mp",
  "transferencia",
  "alias",
  "tarjeta",
  "debito",
  "credito",
  "qr",
  "modo",
  "cuenta dni",
];

function normalizeMethod(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildMatcher(keywords: string[]): RegExp {
  const body = keywords.map((k) => k.replace(/ /g, "\\s+")).join("|");
  return new RegExp(`\\b(?:${body})\\b`);
}

const CASH_RE = buildMatcher(CASH_KEYWORDS);
const DIGITAL_RE = buildMatcher(DIGITAL_KEYWORDS);

// Si matchea cash y digital a la vez gana cash: el efectivo es el caso base del
// negocio y un método ambiguo pagado en mano es plata física en el cajón.
export function classifyMethod(paymentMethod: string | null): MoneyMethod {
  if (!paymentMethod) return "unknown";
  const normalized = normalizeMethod(paymentMethod);
  if (!normalized) return "unknown";
  if (CASH_RE.test(normalized)) return "cash";
  if (DIGITAL_RE.test(normalized)) return "digital";
  return "unknown";
}

// ─── Totales ──────────────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

// items llega como jsonb desconocido: [{name, quantity, price?}] donde price es
// PRECIO UNITARIO (así lo guardan toolsOrder / resolveItems). Se toleran items
// malformados: qty inválida → 1, price inválido → 0 (nunca rompe el cierre).
export function orderTotal(o: { items: unknown; deliveryFee: string | null }): number {
  const items = Array.isArray(o.items) ? o.items : [];
  let subtotal = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as { quantity?: unknown; price?: unknown; unitPrice?: unknown };
    const qty = Number(item.quantity);
    const unit = Number(item.price ?? item.unitPrice ?? 0);
    subtotal += (Number.isFinite(qty) && qty > 0 ? qty : 1) * (Number.isFinite(unit) ? unit : 0);
  }
  const fee = Number(o.deliveryFee ?? 0);
  return round2(subtotal + (Number.isFinite(fee) ? fee : 0));
}

// ─── Tipos del contrato ───────────────────────────────────────────────────────

export interface OrderLine {
  id: number;
  customer: string;
  total: number;
  method: string | null;
}

export interface CashSnapshot {
  sessionId: number;
  openedAt: Date;
  openingCash: number;
  cashOrders: OrderLine[];
  cashTotal: number;
  digitalByMethod: Record<string, { count: number; total: number }>;
  digitalTotal: number;
  unknownOrders: OrderLine[];
  unknownTotal: number;
  pendingOrders: OrderLine[];
  pendingTotal: number;
  movementsIn: number;
  movementsOut: number;
  expectedCash: number;
  totalSold: number;
}

export interface CloseResult extends CashSnapshot {
  closedAt: Date;
  actualCash: number;
  difference: number;
}

// ─── Sesiones ─────────────────────────────────────────────────────────────────

export async function getOpenSession(): Promise<typeof cashSessions.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.status, "open"))
    .orderBy(desc(cashSessions.openedAt))
    .limit(1);
  return row ?? null;
}

// ─── Cierre obligatorio de fin de turno (02:00 ART) ──────────────────────────
// El día de negocio cierra a las 02:00 hora Argentina (= 05:00 UTC, sin DST).
// Si la sesión abierta arrancó antes del último límite de las 02:00, se cierra
// automáticamente EN ese instante y se abre la siguiente sesión de la cadena.
// Es rollover perezoso: corre en cualquier entrada a la caja (tools del agente,
// admin, scheduler), así no depende de que el proceso esté despierto a las
// 02:00 en punto — en free tier la instancia duerme y el cierre sale igual a la
// primera actividad posterior.
export function lastCashBoundary(now = new Date()): Date {
  const b = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 0, 0),
  );
  if (now.getTime() < b.getTime()) b.setUTCDate(b.getUTCDate() - 1);
  return b;
}

// Cierra `session` con timestamp `boundary` (no "ahora"): los pedidos entre la
// frontera y ahora quedan dentro de la sesión nueva. El conteo es virtual —
// actualCash = esperado, diferencia 0 — porque nadie contó el cajón; el admin
// puede verificar después y la diferencia real se ajusta como movimiento nuevo.
async function rolloverAt(
  session: typeof cashSessions.$inferSelect,
  boundary: Date,
): Promise<{ rolledOver: boolean; closedId?: number }> {
  const snapshot = await getSnapshot(session.id, boundary);
  const expected = snapshot.expectedCash.toFixed(2);
  const [closed] = await db
    .update(cashSessions)
    .set({
      status: "closed",
      closedAt: boundary,
      expectedCash: expected,
      actualCash: expected,
      difference: "0",
      closedBy: "auto-02:00",
      report: snapshot,
      notes:
        "Cierre automático de fin de turno (02:00). Conteo virtual = esperado; verificar el efectivo real contra este número.",
    })
    .where(and(eq(cashSessions.id, session.id), eq(cashSessions.status, "open")))
    .returning();
  if (!closed) return { rolledOver: false }; // otra llamada la cerró primero

  await db.insert(cashSessions).values({
    status: "open",
    openedAt: boundary,
    openingCash: expected,
  });
  return { rolledOver: true, closedId: session.id };
}

// Expuesta para el scheduler: si la caja abierta ya cruzó el límite de las
// 02:00 la cierra en la frontera y abre la siguiente. Devuelve si hubo rollover
// para que el caller decida si notificar.
export async function rolloverCashDay(): Promise<{ rolledOver: boolean; closedId?: number }> {
  const open = await getOpenSession();
  if (!open) return { rolledOver: false };
  const boundary = lastCashBoundary();
  if (open.openedAt >= boundary) return { rolledOver: false };
  return rolloverAt(open, boundary);
}

// Devuelve la sesión abierta o crea una manteniendo la cadena continua:
// openedAt = closedAt de la última cerrada (ahora si no hay historial) y
// openingCash = actualCash de esa sesión (0 si no hay). Así los pedidos hechos
// "con la caja cerrada" caen igual dentro de la próxima ventana.
export async function ensureOpenSession(): Promise<typeof cashSessions.$inferSelect> {
  let open = await getOpenSession();
  if (open) {
    const boundary = lastCashBoundary();
    if (open.openedAt >= boundary) return open;
    // Cruzó el cierre de las 02:00 sin cerrarse: rollover ahora, en la frontera.
    await rolloverAt(open, boundary);
    open = await getOpenSession();
    if (open) return open;
  }

  const [lastClosed] = await db
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.status, "closed"))
    .orderBy(desc(cashSessions.closedAt))
    .limit(1);

  const [created] = await db
    .insert(cashSessions)
    .values({
      status: "open",
      openedAt: lastClosed?.closedAt ?? new Date(),
      openingCash: lastClosed?.actualCash ?? "0",
    })
    .returning();
  return created;
}

// Apertura explícita (desde el bot/admin). A diferencia de ensureOpenSession NO
// backdatea: openedAt = ahora. Falla si ya hay una abierta.
export async function openSession(
  openingCash: number,
  openedBy?: string,
): Promise<typeof cashSessions.$inferSelect> {
  if (!Number.isFinite(openingCash) || openingCash < 0) {
    throw new Error("El fondo inicial de caja tiene que ser un número mayor o igual a 0.");
  }
  const existing = await getOpenSession();
  if (existing) {
    throw new Error(`Ya hay una sesión de caja abierta (#${existing.id}). Cerrala antes de abrir otra.`);
  }
  // No hay columna openedBy en el schema — queda registrado en notes.
  const [created] = await db
    .insert(cashSessions)
    .values({
      status: "open",
      openedAt: new Date(),
      openingCash: openingCash.toFixed(2),
      ...(openedBy ? { notes: `Abierta por ${openedBy}` } : {}),
    })
    .returning();
  return created;
}

// ─── Movimientos manuales (entradas/salidas de efectivo) ──────────────────────

export async function addMovement(
  direction: "in" | "out",
  amount: number,
  reason: string,
  by?: string,
): Promise<typeof cashMovements.$inferSelect> {
  if (direction !== "in" && direction !== "out") {
    throw new Error("La dirección del movimiento tiene que ser 'in' u 'out'.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("El monto del movimiento tiene que ser un número mayor a 0.");
  }
  if (!reason?.trim()) {
    throw new Error("El movimiento necesita un motivo (de dónde salió / para qué fue la plata).");
  }
  const session = await ensureOpenSession();
  const [movement] = await db
    .insert(cashMovements)
    .values({
      sessionId: session.id,
      direction,
      amount: amount.toFixed(2),
      reason: reason.trim(),
      createdBy: by ?? null,
    })
    .returning();
  return movement;
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────
// Lee pedidos + movimientos de la ventana de la sesión y calcula todo lo que el
// cierre necesita. Ventana: COALESCE(delivered_at, created_at) dentro de
// [openedAt, closedAt|ahora) — delivered_at manda porque un pedido entregado
// tarde pertenece al turno en que se entregó, no al que se cargó.

export async function getSnapshot(sessionId: number, windowEndOverride?: Date): Promise<CashSnapshot> {
  const [session] = await db
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.id, sessionId))
    .limit(1);
  if (!session) {
    throw new Error(`No encontré la sesión de caja #${sessionId}.`);
  }

  const windowEnd = windowEndOverride ?? session.closedAt ?? new Date();
  const orderAt = sql`COALESCE(${orders.deliveredAt}, ${orders.createdAt})`;

  const orderRows = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      phoneNumber: orders.phoneNumber,
      items: orders.items,
      deliveryFee: orders.deliveryFee,
      paymentStatus: orders.paymentStatus,
      paymentMethod: orders.paymentMethod,
    })
    .from(orders)
    .where(
      and(
        ne(orders.status, "cancelled"),
        gte(orderAt, session.openedAt),
        lt(orderAt, windowEnd),
      ),
    );

  const movementRows = await db
    .select({ direction: cashMovements.direction, amount: cashMovements.amount })
    .from(cashMovements)
    .where(eq(cashMovements.sessionId, sessionId));

  const cashOrders: OrderLine[] = [];
  const digitalByMethod: Record<string, { count: number; total: number }> = {};
  const unknownOrders: OrderLine[] = [];
  const pendingOrders: OrderLine[] = [];
  let cashTotal = 0;
  let digitalTotal = 0;
  let unknownTotal = 0;
  let pendingTotal = 0;
  let totalSold = 0;

  for (const o of orderRows) {
    const line: OrderLine = {
      id: o.id,
      customer: o.customerName ?? o.phoneNumber,
      total: orderTotal({ items: o.items, deliveryFee: o.deliveryFee }),
      method: o.paymentMethod,
    };
    // Sin cobrar todavía: no suma al cajón ni a ventas cobradas.
    if (o.paymentStatus !== "paid") {
      pendingOrders.push(line);
      pendingTotal += line.total;
      continue;
    }
    totalSold += line.total;
    const kind = classifyMethod(o.paymentMethod);
    if (kind === "cash") {
      cashOrders.push(line);
      cashTotal += line.total;
    } else if (kind === "digital") {
      // Se agrupa por método normalizado: "MP", "mp" y "Mercado Pago" cuentan
      // juntos en el desglose aunque el texto crudo difiera.
      const key = normalizeMethod(o.paymentMethod ?? "") || "digital";
      const bucket = digitalByMethod[key] ?? { count: 0, total: 0 };
      bucket.count += 1;
      bucket.total = round2(bucket.total + line.total);
      digitalByMethod[key] = bucket;
      digitalTotal += line.total;
    } else {
      unknownOrders.push(line);
      unknownTotal += line.total;
    }
  }

  let movementsIn = 0;
  let movementsOut = 0;
  for (const m of movementRows) {
    const amt = Number(m.amount);
    if (!Number.isFinite(amt)) continue;
    if (m.direction === "in") movementsIn += amt;
    else movementsOut += amt;
  }

  const openingCash = Number(session.openingCash);
  return {
    sessionId: session.id,
    openedAt: session.openedAt,
    openingCash: round2(openingCash),
    cashOrders,
    cashTotal: round2(cashTotal),
    digitalByMethod,
    digitalTotal: round2(digitalTotal),
    unknownOrders,
    unknownTotal: round2(unknownTotal),
    pendingOrders,
    pendingTotal: round2(pendingTotal),
    movementsIn: round2(movementsIn),
    movementsOut: round2(movementsOut),
    expectedCash: round2(openingCash + cashTotal + movementsIn - movementsOut),
    totalSold: round2(totalSold),
  };
}

// ─── Cierre ───────────────────────────────────────────────────────────────────
// Idempotente: si no hay sesión abierta (o la que había ya la cerró otro entre
// el snapshot y el update) devuelve { error } en vez de cerrar de nuevo. OJO:
// usa getOpenSession y no ensureOpenSession a propósito — si no hay sesión
// abierta no tiene sentido crear una vacía sólo para cerrarla (generaría
// asientos de auditoría fantasma en cada doble-cierre).

export async function closeSession(
  actualCash: number,
  closedBy: string,
  notes?: string,
): Promise<CloseResult | { error: string }> {
  if (!Number.isFinite(actualCash) || actualCash < 0) {
    return { error: "El conteo físico de caja tiene que ser un número mayor o igual a 0." };
  }
  const session = await getOpenSession();
  if (!session) {
    return { error: "No hay ninguna sesión de caja abierta para cerrar." };
  }

  const snapshot = await getSnapshot(session.id);
  const closedAt = new Date();
  const difference = round2(actualCash - snapshot.expectedCash);

  // El WHERE con status='open' hace atómico el check de idempotencia: si otra
  // llamada cerró la sesión en el medio, este update no toca ninguna fila.
  const [updated] = await db
    .update(cashSessions)
    .set({
      status: "closed",
      closedAt,
      expectedCash: snapshot.expectedCash.toFixed(2),
      actualCash: actualCash.toFixed(2),
      difference: difference.toFixed(2),
      closedBy: closedBy?.trim() || "sistema",
      report: snapshot,
      ...(notes !== undefined ? { notes } : {}),
    })
    .where(and(eq(cashSessions.id, session.id), eq(cashSessions.status, "open")))
    .returning();

  if (!updated) {
    return { error: `La sesión de caja #${session.id} ya estaba cerrada.` };
  }
  return { ...snapshot, closedAt, actualCash, difference };
}

// ─── Historial ────────────────────────────────────────────────────────────────

export async function getHistory(limit: number): Promise<typeof cashSessions.$inferSelect[]> {
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 20;
  return db
    .select()
    .from(cashSessions)
    .where(eq(cashSessions.status, "closed"))
    .orderBy(desc(cashSessions.closedAt))
    .limit(safeLimit);
}

// ─── Gestión de movimientos ──────────────────────────────────────────────────
// Solo se pueden editar/borrar movimientos de la sesión ABIERTA. Las sesiones
// cerradas son asientos inmutables: una corrección de un día viejo se carga
// como movimiento nuevo en la sesión abierta, referenciando el día en reason.

export async function listMovements(
  sessionId: number,
): Promise<typeof cashMovements.$inferSelect[]> {
  return db
    .select()
    .from(cashMovements)
    .where(eq(cashMovements.sessionId, sessionId))
    .orderBy(desc(cashMovements.createdAt));
}

/** Devuelve el movimiento + la sesión a la que pertenece (para chequear status). */
async function getMovementWithSession(movementId: number) {
  const [row] = await db
    .select({ movement: cashMovements, session: cashSessions })
    .from(cashMovements)
    .innerJoin(cashSessions, eq(cashMovements.sessionId, cashSessions.id))
    .where(eq(cashMovements.id, movementId))
    .limit(1);
  return row ?? null;
}

function assertEditable(
  row: { movement: typeof cashMovements.$inferSelect; session: typeof cashSessions.$inferSelect } | null,
): { error: string } | null {
  if (!row) return { error: "No encontré ese movimiento de caja." };
  if (row.session.status !== "open") {
    return {
      error: `El movimiento #${row.movement.id} pertenece a la sesión #${row.session.id}, que ya está cerrada. Las sesiones cerradas no se tocan: cargá la corrección como un movimiento nuevo en la caja abierta.`,
    };
  }
  return null;
}

export async function updateMovement(
  movementId: number,
  patch: { direction?: "in" | "out"; amount?: number; reason?: string },
): Promise<typeof cashMovements.$inferSelect | { error: string }> {
  const row = await getMovementWithSession(movementId);
  const blocked = assertEditable(row);
  if (blocked) return blocked;

  const set: Partial<typeof cashMovements.$inferInsert> = {};
  if (patch.direction !== undefined) {
    if (patch.direction !== "in" && patch.direction !== "out") {
      return { error: "La dirección tiene que ser 'in' u 'out'." };
    }
    set.direction = patch.direction;
  }
  if (patch.amount !== undefined) {
    if (!Number.isFinite(patch.amount) || patch.amount <= 0) {
      return { error: "El monto tiene que ser un número mayor a 0." };
    }
    set.amount = patch.amount.toFixed(2);
  }
  if (patch.reason !== undefined) {
    if (!patch.reason.trim()) {
      return { error: "El motivo no puede quedar vacío." };
    }
    set.reason = patch.reason.trim();
  }
  if (Object.keys(set).length === 0) {
    return { error: "No me pasaste nada para actualizar (amount, reason o direction)." };
  }

  const [updated] = await db
    .update(cashMovements)
    .set(set)
    .where(eq(cashMovements.id, movementId))
    .returning();
  return updated;
}

export async function deleteMovement(
  movementId: number,
): Promise<{ deleted: true; id: number } | { error: string }> {
  const row = await getMovementWithSession(movementId);
  const blocked = assertEditable(row);
  if (blocked) return blocked;

  await db.delete(cashMovements).where(eq(cashMovements.id, movementId));
  return { deleted: true, id: movementId };
}
