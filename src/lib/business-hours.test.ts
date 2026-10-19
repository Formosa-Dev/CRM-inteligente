import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatBusinessHours } from "./business-hours";

const DAY_NAMES = [
  "Lunes",
  "Martes",
  "Miércoles",
  "Jueves",
  "Viernes",
  "Sábado",
  "Domingo",
] as const;

function adminSchedule(overrides: Partial<Record<(typeof DAY_NAMES)[number], { open?: boolean; openTime?: string; closeTime?: string } | null>> = {}) {
  return DAY_NAMES.map((day) => {
    const override = overrides[day];
    return {
      day,
      open: override === null ? false : (override?.open ?? true),
      openTime: override?.openTime ?? "10:00",
      closeTime: override?.closeTime ?? "22:00",
    };
  });
}

describe("formatBusinessHours", () => {
  it("collapses consecutive days sharing times into a range", () => {
    const schedule = adminSchedule({ Domingo: null });
    assert.equal(formatBusinessHours(schedule), "Lunes a Sábado · 10:00 a 22:00");
  });

  it("reports every day when the whole week shares one schedule", () => {
    assert.equal(formatBusinessHours(adminSchedule()), "Todos los días · 10:00 a 22:00");
  });

  it("joins two consecutive days with 'y' and splits distinct schedules", () => {
    const schedule = adminSchedule({
      Sábado: { openTime: "11:00", closeTime: "23:00" },
      Domingo: { openTime: "11:00", closeTime: "23:00" },
    });
    assert.equal(
      formatBusinessHours(schedule),
      "Lunes a Viernes · 10:00 a 22:00 — Sábado y Domingo · 11:00 a 23:00",
    );
  });

  it("reads the seed object-map shape keyed by english weekday", () => {
    const schedule = {
      monday: { open: "10:00", close: "22:00" },
      tuesday: { open: "10:00", close: "22:00" },
    };
    assert.equal(formatBusinessHours(schedule), "Lunes y Martes · 10:00 a 22:00");
  });

  it("returns undefined when nothing usable is configured", () => {
    assert.equal(formatBusinessHours(undefined), undefined);
    assert.equal(formatBusinessHours(null), undefined);
    assert.equal(formatBusinessHours([]), undefined);
    assert.equal(
      formatBusinessHours(adminSchedule({ Lunes: { open: false }, Martes: { open: false }, Miércoles: { open: false }, Jueves: { open: false }, Viernes: { open: false }, Sábado: { open: false }, Domingo: { open: false } })),
      undefined,
    );
  });
});
