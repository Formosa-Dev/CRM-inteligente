// ─── Cash Session Tools (cierre de caja — efectivo físico) ───────────────────
// Tools del agente interno para operar la caja única: abrir, cargar movimientos
// de efectivo, ver estado, cerrar (con reporte a admins) y consultar historial.
// La lógica de dominio vive en @/lib/cash/session (WT1) — estas tools son una
// capa fina de formato/notificación. Ver sdd/caja-cierre/specs.md §3.

import { tool } from "ai";
import { z } from "zod";
import {
  ensureOpenSession,
  openSession,
  getOpenSession,
  addMovement,
  getSnapshot,
  closeSession,
  getHistory,
  listMovements,
  updateMovement,
  deleteMovement,
  type CashSnapshot,
  type CloseResult,
} from "@/lib/cash/session";
import { notifyAdmins } from "@/lib/telegram/notifier";

const CLOSED_BY = "telegram-admin";

const fmtMoney = (n: number) => `$${n.toLocaleString("es-AR")}`;

function fmtDateTime(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm} ${hh}:${mi}`;
}

function digitalCount(s: CashSnapshot): number {
  return Object.values(s.digitalByMethod).reduce((acc, m) => acc + m.count, 0);
}

function digitalBreakdown(s: CashSnapshot): string {
  return Object.entries(s.digitalByMethod)
    .map(([method, m]) => `${method}: ${m.count} · ${fmtMoney(m.total)}`)
    .join(" · ");
}

function diffText(diff: number): string {
  if (diff === 0) return "✅ Diferencia: $0";
  const sign = diff > 0 ? "+" : "−";
  return `⚠️ Diferencia: ${sign}${fmtMoney(Math.abs(diff))}`;
}

// Reporte de cierre — formato exacto de spec §3 (texto plano, sin parse_mode).
function buildCloseReport(r: CloseResult): string {
  const dc = digitalCount(r);
  const breakdown = digitalBreakdown(r);
  const soldCount = r.cashOrders.length + dc + r.unknownOrders.length;
  return [
    `💰 CIERRE DE CAJA #${r.sessionId} — ${fmtDateTime(r.closedAt)}`,
    `Ventana: ${fmtDateTime(r.openedAt)} → ${fmtDateTime(r.closedAt)}`,
    ``,
    `🟢 Esperado en caja: ${fmtMoney(r.expectedCash)}`,
    `   inicial ${fmtMoney(r.openingCash)} + efectivo ${fmtMoney(r.cashTotal)} + entradas ${fmtMoney(r.movementsIn)} − salidas ${fmtMoney(r.movementsOut)}`,
    `💵 Contado: ${fmtMoney(r.actualCash)}`,
    diffText(r.difference),
    ``,
    `📊 Ventas del período:`,
    `   Efectivo: ${r.cashOrders.length} pedidos · ${fmtMoney(r.cashTotal)}`,
    `   Digital:  ${dc} pedidos · ${fmtMoney(r.digitalTotal)}${breakdown ? `  (${breakdown})` : ""}`,
    `   Sin método: ${r.unknownOrders.length} pedidos · ${fmtMoney(r.unknownTotal)}`,
    `   Total vendido: ${fmtMoney(r.totalSold)} (${soldCount} pedidos)`,
    ``,
    `⏳ Cobros pendientes: ${r.pendingOrders.length} · ${fmtMoney(r.pendingTotal)}`,
    `📤 Movimientos: +${fmtMoney(r.movementsIn)} entradas / −${fmtMoney(r.movementsOut)} salidas`,
  ].join("\n");
}

// ─── openCash ────────────────────────────────────────────────────────────────
export const openCash = tool({
  description:
    "ABRIR la sesión de caja. Sin argumentos asegura que haya una caja abierta continuando la cadena (fondo inicial = conteo del último cierre). Con openingCash abre explícita con ese fondo (falla si ya hay una abierta). PREGUNTAS: 'abrí la caja', 'abrir caja con 5000 de fondo'.",
  inputSchema: z.object({
    openingCash: z.number().nonnegative().optional()
      .describe("Efectivo inicial en el cajón. Si se omite, continúa el fondo del último cierre."),
  }),
  execute: async ({ openingCash }) => {
    if (openingCash !== undefined) {
      const existing = await getOpenSession();
      if (existing) {
        return `Ya hay una caja abierta (#${existing.id} desde ${fmtDateTime(existing.openedAt)}). Para abrir con otro fondo, primero cerrala con closeCash.`;
      }
      const s = await openSession(openingCash, CLOSED_BY);
      return `💰 Caja #${s.id} abierta con ${fmtMoney(openingCash)} de fondo inicial.`;
    }
    const s = await ensureOpenSession();
    return `💰 Caja #${s.id} abierta desde ${fmtDateTime(s.openedAt)} · fondo inicial ${fmtMoney(Number(s.openingCash))}`;
  },
});

// ─── registerCashMovement ────────────────────────────────────────────────────
export const registerCashMovement = tool({
  description:
    "CARGAR una entrada o salida de efectivo del cajón (auto-abre sesión si falta). Usar directo sin preguntar cuando el admin menciona plata que entra o sale: 'salieron 800 para el delivery', 'entraron 2000 de cambio', 'pagué 1500 al proveedor'.",
  inputSchema: z.object({
    direction: z.enum(["in", "out"]).describe("in = entra efectivo al cajón, out = sale efectivo"),
    amount: z.number().positive().describe("Monto en pesos"),
    reason: z.string().trim().min(1).describe("Motivo del movimiento, ej: 'pago al delivery'"),
  }),
  execute: async ({ direction, amount, reason }) => {
    await addMovement(direction, amount, reason, CLOSED_BY);
    const label = direction === "in" ? "Entrada" : "Salida";
    return `✅ ${label} de ${fmtMoney(amount)} cargada — ${reason}`;
  },
});

// ─── getCashStatus ───────────────────────────────────────────────────────────
export const getCashStatus = tool({
  description:
    "Ver el ESTADO ACTUAL de la caja abierta: efectivo esperado, ventas del período por método, cobros pendientes y movimientos. PREGUNTAS: 'cómo viene la caja?', 'cuánto efectivo tiene que haber?', 'estado de caja'. Mostrar antes de cerrar.",
  inputSchema: z.object({}),
  execute: async () => {
    const s = await ensureOpenSession();
    const snapData = await getSnapshot(s.id);
    const dc = digitalCount(snapData);
    return [
      `💰 CAJA ABIERTA #${snapData.sessionId} — desde ${fmtDateTime(snapData.openedAt)}`,
      `🟢 Esperado en caja: ${fmtMoney(snapData.expectedCash)} (inicial ${fmtMoney(snapData.openingCash)} + efectivo ${fmtMoney(snapData.cashTotal)} + entradas ${fmtMoney(snapData.movementsIn)} − salidas ${fmtMoney(snapData.movementsOut)})`,
      `📊 Ventas: efectivo ${snapData.cashOrders.length} · ${fmtMoney(snapData.cashTotal)} | digital ${dc} · ${fmtMoney(snapData.digitalTotal)} | sin método ${snapData.unknownOrders.length} · ${fmtMoney(snapData.unknownTotal)}`,
      `   Total vendido: ${fmtMoney(snapData.totalSold)}`,
      `⏳ Cobros pendientes: ${snapData.pendingOrders.length} · ${fmtMoney(snapData.pendingTotal)}`,
      `📤 Movimientos: +${fmtMoney(snapData.movementsIn)} / −${fmtMoney(snapData.movementsOut)}`,
    ].join("\n");
  },
});

// ─── closeCash ───────────────────────────────────────────────────────────────
export const closeCash = tool({
  description:
    "CERRAR la caja: el admin cuenta el efectivo físico y pasa ese número como actualCash. Compara contra lo esperado, cierra la sesión (inmutable) y envía el reporte a los admins. PREGUNTAS: 'cerrá la caja, conté 45200', 'cierre de caja con 38000'. Si el admin no dio el conteo, pedirlo antes.",
  inputSchema: z.object({
    actualCash: z.number().nonnegative().describe("Efectivo físico contado en el cajón"),
    note: z.string().optional().describe("Nota opcional del cierre"),
  }),
  execute: async ({ actualCash, note }) => {
    const result = await closeSession(actualCash, CLOSED_BY, note);
    // closeSession devuelve { error } si la sesión ya estaba cerrada.
    if (result && typeof result === "object" && "error" in result) {
      return `No se pudo cerrar la caja: ${(result as { error: string }).error}`;
    }
    const report = buildCloseReport(result as CloseResult);
    await notifyAdmins(report);
    return report;
  },
});

// ─── getCashHistory ──────────────────────────────────────────────────────────
export const getCashHistory = tool({
  description:
    "Ver los ÚLTIMOS CIERRES de caja: fecha, esperado, contado y diferencia. PREGUNTAS: 'mostrame los últimos cierres', 'cómo cerró la caja ayer?', 'historial de caja'.",
  inputSchema: z.object({
    limit: z.number().int().positive().max(20).optional()
      .describe("Cantidad de cierres a mostrar (default 5, máx 20)"),
  }),
  execute: async ({ limit }) => {
    const rows = await getHistory(limit ?? 5);
    if (!rows.length) return "No hay cierres de caja registrados todavía.";
    return rows.map((r) => {
      const exp = Number(r.expectedCash ?? 0);
      const act = Number(r.actualCash ?? 0);
      const dif = Number(r.difference ?? 0);
      const flag = dif === 0 ? "✅" : "⚠️";
      const when = r.closedAt ? fmtDateTime(r.closedAt) : "—";
      return `#${r.id} · ${when} — esperado ${fmtMoney(exp)} · contado ${fmtMoney(act)} · dif ${fmtMoney(dif)} ${flag}`;
    }).join("\n");
  },
});

// ─── getCashMovements ────────────────────────────────────────────────────────
export const getCashMovements = tool({
  description:
    "Listar los MOVIMIENTOS de efectivo de la caja abierta, con su ID. Usar antes de corregir o borrar un movimiento (el ID identifica cuál). PREGUNTAS: 'qué movimientos cargué?', 'mostrame las salidas de caja'.",
  inputSchema: z.object({}),
  execute: async () => {
    const s = await ensureOpenSession();
    const rows = await listMovements(s.id);
    if (!rows.length) return `Caja #${s.id}: todavía no hay movimientos cargados.`;
    const lines = rows.map((m) => {
      const sign = m.direction === "in" ? "➕" : "➖";
      return `#${m.id} ${sign} ${fmtMoney(Number(m.amount))} — ${m.reason} (${fmtDateTime(m.createdAt)})`;
    });
    return `Movimientos de la caja abierta #${s.id}:\n${lines.join("\n")}`;
  },
});

// ─── updateCashMovement ──────────────────────────────────────────────────────
export const updateCashMovement = tool({
  description:
    "CORREGIR un movimiento de efectivo de la caja abierta por su ID (monto, motivo o dirección). Solo sesión abierta: los movimientos de días cerrados no se editan. PREGUNTAS: 'el movimiento 3 era 900 no 800', 'corregí el motivo de la salida 2'.",
  inputSchema: z.object({
    movementId: z.number().int().positive().describe("ID del movimiento (lo da getCashMovements)"),
    amount: z.number().positive().optional().describe("Nuevo monto en pesos"),
    reason: z.string().trim().min(1).optional().describe("Nuevo motivo"),
    direction: z.enum(["in", "out"]).optional().describe("Nueva dirección"),
  }),
  execute: async ({ movementId, amount, reason, direction }) => {
    const result = await updateMovement(movementId, { amount, reason, direction });
    if ("error" in result) {
      return `No se pudo corregir: ${result.error}`;
    }
    const label = result.direction === "in" ? "entrada" : "salida";
    return `✅ Movimiento #${result.id} corregido: ${label} de ${fmtMoney(Number(result.amount))} — ${result.reason}`;
  },
});

// ─── deleteCashMovement ──────────────────────────────────────────────────────
export const deleteCashMovement = tool({
  description:
    "BORRAR un movimiento de efectivo de la caja abierta por su ID (se cargó mal o duplicado). Solo sesión abierta: los movimientos de días cerrados no se borran, la corrección se carga como movimiento nuevo. PREGUNTAS: 'borrá el movimiento 4, lo cargué dos veces', 'eliminá esa entrada'.",
  inputSchema: z.object({
    movementId: z.number().int().positive().describe("ID del movimiento (lo da getCashMovements)"),
  }),
  execute: async ({ movementId }) => {
    const result = await deleteMovement(movementId);
    if ("error" in result) {
      return `No se pudo borrar: ${result.error}`;
    }
    return `🗑️ Movimiento #${result.id} eliminado de la caja abierta.`;
  },
});

export const cashTools = {
  openCash,
  registerCashMovement,
  getCashMovements,
  updateCashMovement,
  deleteCashMovement,
  getCashStatus,
  closeCash,
  getCashHistory,
};
