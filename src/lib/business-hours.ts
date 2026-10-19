/**
 * Formats agent_config.business_hours into a display-ready opening-hours
 * line. Two persisted shapes are supported:
 *
 * - Admin UI array:  [{ day: "Lunes", open: true, openTime: "09:00", closeTime: "22:00" }, …]
 * - Seed object map: { monday: { open: "10:00", close: "22:00" }, … }
 *
 * Consecutive open days sharing the same times collapse into a range:
 * "Lunes a Sábado · 10:00 a 22:00". Returns undefined when no usable
 * schedule exists — callers must omit the line rather than show a fallback.
 */

const WEEKDAY_LABELS = [
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
  "Domingo",
] as const;

const WEEKDAY_KEYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

interface DaySlot {
  open: boolean;
  openTime: string;
  closeTime: string;
}

function normalize(raw: unknown): (DaySlot | null)[] {
  const days: (DaySlot | null)[] = Array(7).fill(null);
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const idx = typeof e.day === "string" ? WEEKDAY_LABELS.indexOf(e.day as never) : -1;
      if (idx < 0) continue;
      days[idx] = {
        open: e.open === true,
        openTime: typeof e.openTime === "string" ? e.openTime : "",
        closeTime: typeof e.closeTime === "string" ? e.closeTime : "",
      };
    }
  } else if (raw && typeof raw === "object") {
    const map = raw as Record<string, { open?: unknown; close?: unknown }>;
    WEEKDAY_KEYS.forEach((key, idx) => {
      const slot = map[key];
      if (slot && typeof slot.open === "string" && typeof slot.close === "string") {
        days[idx] = { open: true, openTime: slot.open, closeTime: slot.close };
      }
    });
  }
  return days;
}

export function formatBusinessHours(raw: unknown): string | undefined {
  const days = normalize(raw);
  const groups: { from: number; to: number; openTime: string; closeTime: string }[] = [];
  for (let i = 0; i < 7; i++) {
    const day = days[i];
    if (!day?.open || !day.openTime || !day.closeTime) continue;
    const last = groups[groups.length - 1];
    if (last && last.to === i - 1 && last.openTime === day.openTime && last.closeTime === day.closeTime) {
      last.to = i;
    } else {
      groups.push({ from: i, to: i, openTime: day.openTime, closeTime: day.closeTime });
    }
  }
  if (groups.length === 0) return undefined;
  return groups
    .map((g) => {
      const range =
        g.from === 0 && g.to === 6
          ? "Todos los días"
          : g.from === g.to
            ? WEEKDAY_LABELS[g.from]
            : g.to === g.from + 1
              ? `${WEEKDAY_LABELS[g.from]} y ${WEEKDAY_LABELS[g.to]}`
              : `${WEEKDAY_LABELS[g.from]} a ${WEEKDAY_LABELS[g.to]}`;
      return `${range} · ${g.openTime} a ${g.closeTime}`;
    })
    .join(" — ");
}
