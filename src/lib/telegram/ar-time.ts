// ─── Argentina calendar boundaries for Telegram tools ────────────────────────
// El servidor corre en UTC; el negocio opera en America/Argentina/Buenos_Aires
// (UTC-3 fijo, sin DST). Todo borde de día/semana/mes para queries de pedidos
// tiene que resolverse contra el calendario local, no contra `new Date(y,m,d)`
// server-local. Wrappers finos sobre los helpers canónicos de
// whatsapp/temporal-context (misma fuente de verdad que usa el agente WA).

import {
  argentinaDayKey,
  argentinaDayStart,
} from "@/lib/whatsapp/temporal-context";

export { argentinaDayStart, argentinaDayKey };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Ventana [start, end) del día calendario Argentina que contiene `now`. */
export function argentinaTodayRange(now: Date = new Date()): {
  start: Date;
  end: Date;
} {
  const start = argentinaDayStart(now);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * Instante UTC de 00:00 Argentina en el día `dayKey` ("YYYY-MM-DD").
 * `argentinaDayStart` no acepta un dayKey directo (un string ISO se parsea
 * como UTC y puede caer en el día AR anterior), así que anclamos el input al
 * mediodía UTC de esa fecha — siempre dentro del día AR buscado.
 */
export function argentinaDayStartForKey(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return argentinaDayStart(new Date(Date.UTC(year, month - 1, day, 12)));
}

/**
 * Resuelve el input libre del LLM ("YYYY-MM-DD", ISO con hora, o basura) al
 * inicio del día calendario Argentina que el operador quiso decir. Un string
 * de solo fecha se interpreta como día AR; un datetime completo como
 * instante; input inválido cae al día de `now`.
 */
export function argentinaDayStartFromInput(
  input: string,
  now: Date = new Date()
): Date {
  const trimmed = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return argentinaDayStartForKey(trimmed);
  }
  const parsed = new Date(trimmed);
  return argentinaDayStart(Number.isNaN(parsed.getTime()) ? now : parsed);
}

/** Lunes 00:00 Argentina de la semana (lunes→domingo) que contiene `now`. */
export function argentinaWeekStart(now: Date = new Date()): Date {
  const todayStart = argentinaDayStart(now);
  // 00:00 AR = 03:00 UTC del mismo día → getUTCDay() del instante es el
  // weekday del calendario Argentina.
  const day = todayStart.getUTCDay();
  const diff = day === 0 ? 6 : day - 1; // lunes como inicio
  return new Date(todayStart.getTime() - diff * DAY_MS);
}

/** Día 1 del mes Argentina (00:00 local) que contiene `now`. */
export function argentinaMonthStart(now: Date = new Date()): Date {
  const dayOfMonth = Number(argentinaDayKey(now).split("-")[2]);
  return new Date(
    argentinaDayStart(now).getTime() - (dayOfMonth - 1) * DAY_MS
  );
}

/**
 * Interpreta una hora de pared Argentina (día/mes del año AR corriente) y
 * devuelve el instante UTC correspondiente. Para backfills como "12/03" o
 * "12/03 21:30" — sin esto, `new Date(y,m,d,h)` arma la fecha en UTC y el
 * pedido cae fuera de la ventana de caja.
 */
export function argentinaWallTime(
  day: number,
  month: number,
  hour = 12,
  minute = 0,
  now: Date = new Date(),
  year?: number
): Date {
  const resolvedYear =
    year ?? Number(argentinaDayKey(now).split("-")[0]);
  const key = `${resolvedYear}-${String(month).padStart(2, "0")}-${String(
    day
  ).padStart(2, "0")}`;
  const dayStart = argentinaDayStartForKey(key);
  return new Date(dayStart.getTime() + (hour * 60 + minute) * 60 * 1000);
}
