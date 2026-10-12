import assert from "node:assert/strict";
import test from "node:test";
import { checkoutSchema, type CheckoutInput, type Product, type Promo } from "./contract";
import { submitCheckout } from "./service";
import { mapOrderRow, type CheckoutDeps, type OrderRow } from "./store";
import type { OrderNotification } from "@/lib/telegram/notifier";

const PRODUCTS: Product[] = [
  { id: 1, name: "Genesis", price: "7500.00", category: "hamburguesa", available: true, comingSoon: false, stock: 4 },
];
const PROMOS: Promo[] = [];
const REQUEST_A = "550e8400-e29b-41d4-a716-446655440000";
const PHONE = "370 4123456";

function parse(overrides: Record<string, unknown> = {}): CheckoutInput {
  return checkoutSchema.parse({
    requestId: REQUEST_A,
    customerName: "Ramiro",
    phone: PHONE,
    items: [{ type: "product", id: 1, quantity: 1 }],
    ...overrides,
  });
}

function fakeDeps(notifications: OrderNotification[], options: { loseRace?: boolean } = {}) {
  const products = structuredClone(PRODUCTS);
  const orders: Array<OrderRow & { reference: string }> = [];
  let nextId = 1;
  const deps: CheckoutDeps = {
    async getDestinationPhone() { return "5493700000000"; },
    async getBurgersUnavailable() { return false; },
    async findOrderByReference(phone, reference) {
      const found = orders.find(order => order.phoneNumber === phone && order.notes?.includes(reference));
      return found ? { ...found } : null;
    },
    async listProducts() { return products; },
    async listPromos() { return PROMOS; },
    async reserveStock(id, quantity) {
      const product = products.find(p => p.id === id);
      if (!product || product.stock === null || product.stock < quantity) return 0;
      product.stock -= quantity;
      return 1;
    },
    async getProductStock(id) {
      const product = products.find(p => p.id === id);
      return product ? { name: product.name, stock: product.stock } : null;
    },
    async releaseStock(id, quantity) {
      const product = products.find(p => p.id === id);
      if (product && product.stock !== null) product.stock += quantity;
    },
    async insertOrderIfAbsent(values) {
      // Lost-the-race: a competitor owns the reservation and already stored it.
      if (options.loseRace) {
        const winner = mapOrderRow({
          id: nextId++,
          phone_number: values.phone,
          customer_name: values.customerName,
          items: values.items,
          notes: values.notes,
          address: values.address,
        });
        orders.push({ ...winner, reference: values.reference });
        return null;
      }
      if (orders.some(order => order.phoneNumber === values.phone && order.notes?.includes(values.reference))) return null;
      const order = mapOrderRow({
        id: nextId++,
        phone_number: values.phone,
        customer_name: values.customerName,
        items: values.items,
        notes: values.notes,
        address: values.address,
      });
      orders.push({ ...order, reference: values.reference });
      return order;
    },
    notifyNewOrder(order) { notifications.push(order); },
  };
  return { deps, orders, products };
}

test("notifies the ops bot exactly once for a brand-new web order", async () => {
  const notifications: OrderNotification[] = [];
  const { deps } = fakeDeps(notifications);
  const receipt = await submitCheckout(parse(), deps);

  assert.equal(notifications.length, 1);
  const [notification] = notifications;
  assert.equal(notification.id, receipt.orderId);
  assert.equal(notification.customerName, "Ramiro");
  assert.equal(notification.orderType, "hamburguesas");
  assert.equal(notification.status, "pending");
  assert.equal(notification.total, 7500);
  assert.equal(notification.phoneNumber, "5493704123456");
  assert.match(notification.notes ?? "", /Pedido web/);
});

test("does not notify on an idempotent retry of the same order", async () => {
  const notifications: OrderNotification[] = [];
  const { deps, orders } = fakeDeps(notifications);
  const first = await submitCheckout(parse(), deps);
  const second = await submitCheckout(parse(), deps);

  assert.equal(orders.length, 1);
  assert.equal(second.orderId, first.orderId);
  assert.equal(notifications.length, 1);
});

test("does not notify when another request won the insert race", async () => {
  const notifications: OrderNotification[] = [];
  const { deps, orders } = fakeDeps(notifications, { loseRace: true });
  const receipt = await submitCheckout(parse(), deps);

  assert.equal(orders.length, 1);
  assert.equal(receipt.orderId, orders[0].id);
  assert.equal(notifications.length, 0);
});
