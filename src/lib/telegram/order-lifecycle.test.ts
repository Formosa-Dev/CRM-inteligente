import assert from "node:assert/strict";
import test from "node:test";
import { planOrderStatusTransition } from "./order-lifecycle";

// Misma tabla de decisión que el camino admin: delivered guarda deliveredAt,
// agenda follow-up (solo en la primera transición) y notifica al cliente;
// ready solo notifica. El resto no dispara efectos.

test("delivered desde pending: deliveredAt + follow-up + notify", () => {
  assert.deepEqual(planOrderStatusTransition("pending", "delivered"), {
    markDeliveredAt: true,
    scheduleFollowUp: true,
    notify: true,
  });
});

test("delivered re-marcado no re-encola el follow-up", () => {
  const plan = planOrderStatusTransition("delivered", "delivered");
  assert.equal(plan.markDeliveredAt, true);
  assert.equal(plan.scheduleFollowUp, false);
  assert.equal(plan.notify, true);
});

test("ready notifica pero no toca deliveredAt ni follow-up", () => {
  assert.deepEqual(planOrderStatusTransition("preparing", "ready"), {
    markDeliveredAt: false,
    scheduleFollowUp: false,
    notify: true,
  });
});

test("pending/preparing/cancelled no tienen efectos de entrega ni notify", () => {
  for (const status of ["pending", "preparing", "cancelled"] as const) {
    const plan = planOrderStatusTransition("ready", status);
    assert.equal(plan.markDeliveredAt, false, status);
    assert.equal(plan.scheduleFollowUp, false, status);
    assert.equal(plan.notify, false, status);
  }
});

test("status previo null (fila legacy) agenda follow-up al entregar", () => {
  assert.equal(
    planOrderStatusTransition(null, "delivered").scheduleFollowUp,
    true
  );
});
