import assert from "node:assert/strict";
import test from "node:test";
import { planOrderStatusTransition } from "./order-lifecycle";

// Misma tabla de decisión que el camino admin: delivered guarda deliveredAt,
// agenda follow-up (solo en la primera transición) y notifica al cliente;
// ready solo notifica; cancelled repone stock solo desde estados no
// terminales. El resto no dispara efectos.

test("delivered desde pending: deliveredAt + follow-up + notify", () => {
  assert.deepEqual(planOrderStatusTransition("pending", "delivered"), {
    markDeliveredAt: true,
    scheduleFollowUp: true,
    notify: true,
    restoreStock: false,
  });
});

test("delivered re-marcado no re-encola el follow-up", () => {
  const plan = planOrderStatusTransition("delivered", "delivered");
  assert.equal(plan.markDeliveredAt, true);
  assert.equal(plan.scheduleFollowUp, false);
  assert.equal(plan.notify, true);
  assert.equal(plan.restoreStock, false);
});

test("ready notifica pero no toca deliveredAt ni follow-up", () => {
  assert.deepEqual(planOrderStatusTransition("preparing", "ready"), {
    markDeliveredAt: false,
    scheduleFollowUp: false,
    notify: true,
    restoreStock: false,
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

test("cancel desde estados activos repone stock", () => {
  for (const status of ["pending", "preparing", "ready", null] as const) {
    assert.equal(
      planOrderStatusTransition(status, "cancelled").restoreStock,
      true,
      String(status)
    );
  }
});

test("cancel desde estados terminales NO repone stock", () => {
  // cancelled→cancelled: la reposición ya ocurrió, duplicarla inflaría stock.
  // delivered→cancelled: los items ya salieron físicamente.
  for (const status of ["cancelled", "delivered"] as const) {
    const plan = planOrderStatusTransition(status, "cancelled");
    assert.equal(plan.restoreStock, false, status);
    assert.equal(plan.notify, false, status);
    assert.equal(plan.markDeliveredAt, false, status);
  }
});
