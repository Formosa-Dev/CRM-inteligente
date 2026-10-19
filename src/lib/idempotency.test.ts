import assert from "node:assert/strict";
import test from "node:test";
import {
  checkIdempotency,
  createIdempotencyKey,
  setIdempotency,
} from "./idempotency";

test("updates distintos del mismo segundo NO colisionan", () => {
  // Regresión A-41: antes la clave era (chatId, message.date) con date en
  // segundos — dos mensajes distintos del operador en el mismo segundo se
  // deduplicaban entre sí y el segundo se perdía.
  const keyA = createIdempotencyKey(8001);
  const keyB = createIdempotencyKey(8002);

  assert.notEqual(keyA, keyB);

  setIdempotency(keyA);
  assert.equal(checkIdempotency(keyA), true, "el mismo update reentregado deduplica");
  assert.equal(checkIdempotency(keyB), false, "un update distinto nunca es duplicado");
});

test("la misma entrega reintentada sí se deduplica", () => {
  const key = createIdempotencyKey(9001);
  assert.equal(checkIdempotency(key), false);
  setIdempotency(key);
  assert.equal(checkIdempotency(key), true);
});

test("acepta ids como string", () => {
  assert.equal(createIdempotencyKey("42"), createIdempotencyKey(42));
});
