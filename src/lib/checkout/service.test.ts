import assert from "node:assert/strict";
import test from "node:test";
import { checkoutSchema, type CheckoutInput, type PricedItem, type Product, type Promo } from "./contract";
import { CheckoutError, submitCheckout } from "./service";
import { mapOrderRow, type CheckoutDeps, type OrderRow } from "./store";

const PRODUCTS: Product[] = [
  { id: 1, name: "Genesis", price: "7500.00", category: "hamburguesa", available: true, comingSoon: false, stock: 4 },
  { id: 2, name: "Pan brioche", price: "900.00", category: "pan_mayorista", available: true, comingSoon: false, stock: null },
];
const PROMOS: Promo[] = [
  { id: 8, name: "Promo doble", customPrice: "15000", active: true, items: [{ productId: 1, quantity: 2 }] },
];
const REQUEST_A = "550e8400-e29b-41d4-a716-446655440000";
const REQUEST_B = "550e8400-e29b-41d4-a716-446655440001";
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

function fakeDeps(options: { burgersUnavailable?: boolean } = {}) {
  const products = structuredClone(PRODUCTS);
  const promos = structuredClone(PROMOS);
  const orders: Array<OrderRow & { reference: string }> = [];
  let nextId = 1;
  const deps: CheckoutDeps = {
    async getDestinationPhone() { return "5493700000000"; },
    async getBurgersUnavailable() { return options.burgersUnavailable ?? false; },
    async findOrderByReference(phone, reference) {
      const found = orders.find(order => order.phoneNumber === phone && order.notes?.includes(reference));
      return found ? { ...found } : null;
    },
    async listProducts() { return products; },
    async listPromos() { return promos; },
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
      if (orders.some(order => order.phoneNumber === values.phone && order.notes?.includes(values.reference))) return null;
      // Mirror the real neon-http adapter: raw SQL rows arrive snake_case.
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
  };
  return { deps, orders, products };
}

test("maps raw snake_case order rows to camelCase", () => {
  const row = mapOrderRow({ id: 7, phone_number: "5493704123456", customer_name: "Ramiro", items: [], notes: "x", address: null });
  assert.equal(row.phoneNumber, "5493704123456");
  assert.equal(row.customerName, "Ramiro");
  assert.equal(row.address, null);
});

test("defaults a missing fulfillment mode to pickup for legacy clients", () => {
  const input = checkoutSchema.parse({ requestId: REQUEST_A, customerName: "Ramiro", phone: PHONE, items: [{ type: "product", id: 1, quantity: 1 }] });
  assert.equal(input.fulfillmentMode, "pickup");
});

test("persists a product order with database pricing and returns the receipt", async () => {
  const { deps, orders, products } = fakeDeps();
  const receipt = await submitCheckout(parse(), deps);
  assert.equal(orders.length, 1);
  assert.equal(receipt.total, 7500);
  assert.equal(receipt.fulfillmentMode, "pickup");
  assert.equal((orders[0].items as PricedItem[])[0].unitPrice, 7500);
  assert.equal(orders[0].address, null);
  assert.equal(products[0].stock, 3);
  assert.match(decodeURIComponent(receipt.whatsappUrl), /Retiro en el local/);
});

test("an identical retry returns the already-created receipt without a new order", async () => {
  const { deps, orders, products } = fakeDeps();
  const first = await submitCheckout(parse(), deps);
  const second = await submitCheckout(parse(), deps);
  assert.equal(orders.length, 1);
  assert.equal(second.orderId, first.orderId);
  assert.equal(second.total, first.total);
  assert.equal(products[0].stock, 3);
});

test("reusing a requestId with a different payload is rejected", async () => {
  const { deps } = fakeDeps();
  await submitCheckout(parse({ items: [{ type: "product", id: 1, quantity: 1 }] }), deps);
  await assert.rejects(
    submitCheckout(parse({ items: [{ type: "product", id: 1, quantity: 2 }] }), deps),
    (error: unknown) => error instanceof CheckoutError && /ya fue usada/.test(error.message),
  );
});

test("different requestIds create distinct orders", async () => {
  const { deps, orders } = fakeDeps();
  const first = await submitCheckout(parse({ requestId: REQUEST_A }), deps);
  const second = await submitCheckout(parse({ requestId: REQUEST_B }), deps);
  assert.equal(orders.length, 2);
  assert.notEqual(first.orderId, second.orderId);
});

test("persists a promotion with database pricing and component stock", async () => {
  const { deps, orders, products } = fakeDeps();
  const receipt = await submitCheckout(parse({ items: [{ type: "promo", id: 8, quantity: 1 }] }), deps);
  assert.equal(receipt.total, 15000);
  assert.equal((orders[0].items as PricedItem[])[0].name, "Promo doble");
  assert.equal(products[0].stock, 2);
});

test("catalog conflicts reject with 422 + catalog_changed, never the ambiguous 409", async () => {
  const { deps } = fakeDeps();
  await assert.rejects(
    submitCheckout(parse({ items: [{ type: "product", id: 1, quantity: 99 }] }), deps),
    (error: unknown) =>
      error instanceof CheckoutError &&
      error.status === 422 &&
      error.code === "catalog_changed",
  );
});

test("a missing WhatsApp destination rejects as no_destination before anything else", async (t) => {
  const { deps } = fakeDeps();
  deps.getDestinationPhone = async () => null;
  const envPhone = process.env.WHATSAPP_PHONE_NUMBER;
  process.env.WHATSAPP_PHONE_NUMBER = "";
  t.after(() => {
    if (envPhone === undefined) delete process.env.WHATSAPP_PHONE_NUMBER;
    else process.env.WHATSAPP_PHONE_NUMBER = envPhone;
  });
  await assert.rejects(
    submitCheckout(parse(), deps),
    (error: unknown) =>
      error instanceof CheckoutError &&
      error.status === 503 &&
      error.code === "no_destination" &&
      /WhatsApp/.test(error.message),
  );
});

test("a deactivated promo rejects as a catalog conflict", async () => {
  const { deps } = fakeDeps();
  deps.listPromos = async () => [{ ...PROMOS[0], active: false }];
  await assert.rejects(
    submitCheckout(parse({ items: [{ type: "promo", id: 8, quantity: 1 }] }), deps),
    (error: unknown) =>
      error instanceof CheckoutError &&
      error.status === 422 &&
      error.code === "catalog_changed",
  );
});

test("persists the delivery address and includes it in the WhatsApp message", async () => {
  const { deps, orders } = fakeDeps();
  const receipt = await submitCheckout(parse({ fulfillmentMode: "delivery", deliveryAddress: "Av. Siempre Viva 742, Formosa" }), deps);
  assert.equal(orders[0].address, "Av. Siempre Viva 742, Formosa");
  assert.equal(receipt.fulfillmentMode, "delivery");
  const message = decodeURIComponent(receipt.whatsappUrl);
  assert.match(message, /Envío a: Av. Siempre Viva 742, Formosa/);
});

test("pickup ignores a stray address", async () => {
  const { deps, orders } = fakeDeps();
  await submitCheckout(parse({ fulfillmentMode: "pickup", deliveryAddress: "Calle Falsa 123" }), deps);
  assert.equal(orders[0].address, null);
});

test("rejects a delivery order without an address", () => {
  const result = checkoutSchema.safeParse({
    requestId: REQUEST_A,
    customerName: "Ramiro",
    phone: PHONE,
    fulfillmentMode: "delivery",
    items: [{ type: "product", id: 1, quantity: 1 }],
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues[0]?.message, "Ingresá la dirección de entrega.");
});

// The storefront sends `fulfillmentMode` plus an explicit `deliveryAddress` on
// every request: a string for delivery, `null` for pickup. The server schema
// must accept that exact shape — a rejected `null` would fail every pickup sale
// before anything is persisted.
test("accepts the exact storefront pickup payload with deliveryAddress: null", async () => {
  const storefrontBody = {
    requestId: REQUEST_A,
    customerName: "Ramiro",
    phone: PHONE,
    items: [{ type: "product", id: 1, quantity: 1 }],
    fulfillmentMode: "pickup",
    deliveryAddress: null,
  };
  const parsed = checkoutSchema.safeParse(storefrontBody);
  assert.equal(parsed.success, true);

  const { deps, orders } = fakeDeps();
  const first = await submitCheckout(parsed.data!, deps);
  const second = await submitCheckout(parsed.data!, deps);
  assert.equal(orders.length, 1);
  assert.equal(second.orderId, first.orderId);
  assert.equal(orders[0].address, null);
});

test("rejects a delivery payload whose deliveryAddress is explicitly null", () => {
  const result = checkoutSchema.safeParse({
    requestId: REQUEST_A,
    customerName: "Ramiro",
    phone: PHONE,
    fulfillmentMode: "delivery",
    deliveryAddress: null,
    items: [{ type: "product", id: 1, quantity: 1 }],
  });
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error.issues[0]?.message, "Ingresá la dirección de entrega.");
});
