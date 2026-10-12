import assert from "node:assert/strict";
import test from "node:test";
import { buildOrderNotificationMessage, type OrderNotification } from "./notifier";

function order(overrides: Partial<OrderNotification> = {}): OrderNotification {
  return {
    id: 12,
    customerName: "Ramiro",
    orderType: "hamburguesas",
    items: [{ name: "Genesis", quantity: 1 }],
    total: 7500,
    status: "pending",
    phoneNumber: "+54 9 370 412-3456",
    ...overrides,
  };
}

test("includes the direct wa.me customer link with digits-only phone", () => {
  const message = buildOrderNotificationMessage(order(), "Ramiro");
  assert.match(message, /Nuevo Pedido #12/);
  assert.match(message, /https:\/\/wa\.me\/5493704123456/);
  assert.match(message, /Tipo: Hamburguesas/);
  assert.match(message, /Estado: pending/);
});

test("labels pan mayorista and keeps the urgency line", () => {
  const message = buildOrderNotificationMessage(order({ orderType: "pan_mayorista" }), "Ramiro");
  assert.match(message, /Tipo: Pan mayorista/);
  assert.match(message, /al por mayor/);
  assert.match(message, /https:\/\/wa\.me\/5493704123456/);
});

test("omits the link when no phone number is present", () => {
  const message = buildOrderNotificationMessage(order({ phoneNumber: "" }), "Ramiro");
  assert.doesNotMatch(message, /wa\.me/);
});
