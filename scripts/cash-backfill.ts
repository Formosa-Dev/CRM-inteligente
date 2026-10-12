// ─── Backfill de caja histórica ──────────────────────────────────────────────
// Crea sesiones de caja CERRADAS para cada día (hora Argentina) que tuvo
// pedidos, hasta ayer inclusive. El día de hoy queda para la sesión viva.
//
// - Solo días con ≥1 pedido no-cancelado (días sin ventas no generan cierre).
// - openingCash encadenado = actualCash de la sesión anterior (cadena continua).
// - actualCash = expectedCash (nunca hubo conteo físico → diferencia 0).
// - closedBy = "backfill", notes marcadas; report JSON con el mismo shape que
//   CashSnapshot para que /admin/caja y las tools lo lean igual.
// - Idempotente: aborta si ya existe cualquier sesión (corrida única).
//
// Uso:  npx tsx scripts/cash-backfill.ts          (dry-run, no escribe)
//       npx tsx scripts/cash-backfill.ts --apply  (escribe)

import "dotenv/config";
import { db } from "@/db";
import { cashSessions, orders } from "@/db/schema";
import { and, gte, lt, ne, sql } from "drizzle-orm";
import { classifyMethod, orderTotal } from "@/lib/cash/session";

const APPLY = process.argv.includes("--apply");
const AR_OFFSET_MS = -3 * 60 * 60 * 1000; // UTC-3 fijo (sin DST)

/** Día civil AR (YYYY-MM-DD) → [startUTC, endUTC) cubriendo 00:00→24:00 ART. */
function dayWindowUTC(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00.000-03:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function todayAR(): string {
  return new Date(Date.now() + AR_OFFSET_MS).toISOString().slice(0, 10);
}

async function main() {
  const existing = await db.select({ id: cashSessions.id }).from(cashSessions).limit(1);
  if (existing.length) {
    console.log("ABORT: ya hay sesiones de caja — el backfill corre una sola vez sobre tabla vacía.");
    process.exit(1);
  }

  const dayRows = await db
    .select({ day: sql<string>`to_char(coalesce(${orders.deliveredAt}, ${orders.createdAt}) at time zone 'America/Argentina/Buenos_Aires', 'YYYY-MM-DD')` })
    .from(orders)
    .where(ne(orders.status, "cancelled"))
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const today = todayAR();
  const days = dayRows.map((r) => r.day).filter((d) => d < today);
  console.log(`Hoy (AR): ${today} — queda para la sesión viva`);
  console.log(`Días a cerrar retroactivamente: ${days.length}\n`);

  let prevActualCash = 0;
  for (const day of days) {
    const { start, end } = dayWindowUTC(day);

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
          gte(sql`COALESCE(${orders.deliveredAt}, ${orders.createdAt})`, start),
          lt(sql`COALESCE(${orders.deliveredAt}, ${orders.createdAt})`, end),
        ),
      );

    const cashOrders: { id: number; customer: string; total: number; method: string | null }[] = [];
    const digitalByMethod: Record<string, { count: number; total: number }> = {};
    const unknownOrders: typeof cashOrders = [];
    const pendingOrders: typeof cashOrders = [];
    let cashTotal = 0, digitalTotal = 0, unknownTotal = 0, pendingTotal = 0, totalSold = 0;

    for (const o of orderRows) {
      const line = {
        id: o.id,
        customer: o.customerName ?? o.phoneNumber,
        total: orderTotal({ items: o.items, deliveryFee: o.deliveryFee }),
        method: o.paymentMethod,
      };
      if (o.paymentStatus !== "paid") {
        pendingOrders.push(line);
        pendingTotal += line.total;
        continue;
      }
      totalSold += line.total;
      const method = classifyMethod(o.paymentMethod);
      if (method === "cash") {
        cashOrders.push(line);
        cashTotal += line.total;
      } else if (method === "digital") {
        const key = (o.paymentMethod ?? "digital").trim() || "digital";
        const bucket = (digitalByMethod[key] ??= { count: 0, total: 0 });
        bucket.count += 1;
        bucket.total += line.total;
        digitalTotal += line.total;
      } else {
        unknownOrders.push(line);
        unknownTotal += line.total;
      }
    }

    const openingCash = prevActualCash;
    const expectedCash = Math.round((openingCash + cashTotal) * 100) / 100;
    const actualCash = expectedCash;

    console.log(
      `${day}: ${orderRows.length} pedidos · efectivo ${cashTotal} · digital ${digitalTotal} · ` +
        `sin método ${unknownTotal} · pendiente ${pendingTotal} · esperado ${expectedCash}` +
        (APPLY ? "" : "  [dry-run]"),
    );

    if (APPLY) {
      const [inserted] = await db
        .insert(cashSessions)
        .values({
          status: "closed",
          openedAt: start,
          closedAt: end,
          openingCash: openingCash.toFixed(2),
          expectedCash: expectedCash.toFixed(2),
          actualCash: actualCash.toFixed(2),
          difference: "0",
          closedBy: "backfill",
          notes: "Cierre retroactivo automático — sin conteo físico del cajón.",
          report: {},
        })
        .returning({ id: cashSessions.id });

      const report = {
        kind: "backfill",
        day,
        sessionId: inserted.id,
        openedAt: start,
        openingCash,
        cashOrders,
        cashTotal,
        digitalByMethod,
        digitalTotal,
        unknownOrders,
        unknownTotal,
        pendingOrders,
        pendingTotal,
        movementsIn: 0,
        movementsOut: 0,
        expectedCash,
        totalSold,
      };
      await db
        .update(cashSessions)
        .set({ report })
        .where(sql`${cashSessions.id} = ${inserted.id}`);
      console.log(`  → sesión #${inserted.id} creada`);
    }

    prevActualCash = actualCash;
  }

  console.log(APPLY ? "\nListo. La próxima sesión viva abre encadenada al último cierre." : "\nDry-run — corré con --apply para escribir.");
  process.exit(0);
}

void main();
