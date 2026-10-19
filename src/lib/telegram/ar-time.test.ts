import assert from "node:assert/strict";
import test from "node:test";
import {
  argentinaDayStartForKey,
  argentinaDayStartFromInput,
  argentinaMonthStart,
  argentinaTodayRange,
  argentinaWallTime,
  argentinaWeekStart,
} from "./ar-time";

// Argentina = UTC-3 fijo (sin DST desde 2009). En producción el servidor
// corre en UTC: un borde de día calculado con new Date(y,m,d) o setHours
// corre la ventana 3 horas y mueve pedidos de turno noche al día equivocado.

test("argentinaTodayRange: el día AR empieza 03:00 UTC, no 00:00 UTC", () => {
  // Oct 19 01:00 UTC = Oct 18 22:00 AR → el día AR es el 18.
  const now = new Date("2026-10-19T01:00:00Z");
  const { start, end } = argentinaTodayRange(now);
  assert.equal(start.toISOString(), "2026-10-18T03:00:00.000Z");
  assert.equal(end.toISOString(), "2026-10-19T03:00:00.000Z");
});

test("argentinaDayStartForKey: un 'YYYY-MM-DD' es el día AR, no UTC", () => {
  // new Date("2026-10-19") sería 00:00 UTC = Oct 18 21:00 AR (día errado).
  assert.equal(
    argentinaDayStartForKey("2026-10-19").toISOString(),
    "2026-10-19T03:00:00.000Z"
  );
});

test("argentinaDayStartFromInput: fecha sola = día AR; datetime = instante", () => {
  assert.equal(
    argentinaDayStartFromInput("2026-10-19").toISOString(),
    "2026-10-19T03:00:00.000Z"
  );
  // Instant explícito: Oct 20 02:00 UTC = Oct 19 23:00 AR → día AR 19.
  assert.equal(
    argentinaDayStartFromInput("2026-10-20T02:00:00Z").toISOString(),
    "2026-10-19T03:00:00.000Z"
  );
  // Input inválido cae al día de `now`.
  const now = new Date("2026-10-19T12:00:00Z");
  assert.equal(
    argentinaDayStartFromInput("basura", now).toISOString(),
    "2026-10-19T03:00:00.000Z"
  );
});

test("argentinaWeekStart: lunes 00:00 AR, también el domingo", () => {
  // Miércoles Oct 21 AR.
  const wed = new Date("2026-10-21T15:00:00Z");
  assert.equal(
    argentinaWeekStart(wed).toISOString(),
    "2026-10-19T03:00:00.000Z"
  );
  // Domingo Oct 25 AR (getDay local ≠ día AR en UTC).
  const sun = new Date("2026-10-25T20:00:00Z");
  assert.equal(
    argentinaWeekStart(sun).toISOString(),
    "2026-10-19T03:00:00.000Z"
  );
  // Lunes a las 00:30 AR sigue siendo esa semana.
  const monEarly = new Date("2026-10-19T03:30:00Z");
  assert.equal(
    argentinaWeekStart(monEarly).toISOString(),
    "2026-10-19T03:00:00.000Z"
  );
});

test("argentinaMonthStart: día 1 del mes AR a 00:00 local", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  assert.equal(
    argentinaMonthStart(now).toISOString(),
    "2026-10-01T03:00:00.000Z"
  );
  // Oct 1 02:00 UTC = Sep 30 23:00 AR → mes AR: septiembre.
  const stillSeptember = new Date("2026-10-01T02:00:00Z");
  assert.equal(
    argentinaMonthStart(stillSeptember).toISOString(),
    "2026-09-01T03:00:00.000Z"
  );
});

test("argentinaWallTime: hora de pared AR → instante UTC correcto", () => {
  const now = new Date("2026-10-19T12:00:00Z");
  // "19/10 21:30" tiene que caer 21:30 AR = Oct 20 00:30 UTC.
  assert.equal(
    argentinaWallTime(19, 10, 21, 30, now).toISOString(),
    "2026-10-20T00:30:00.000Z"
  );
  // "DD/MM" solo → mediodía AR del año corriente.
  assert.equal(
    argentinaWallTime(5, 3, 12, 0, now).toISOString(),
    "2026-03-05T15:00:00.000Z"
  );
  // Año explícito (ISO sin zona).
  assert.equal(
    argentinaWallTime(31, 12, 23, 59, now, 2025).toISOString(),
    "2026-01-01T02:59:00.000Z"
  );
});
