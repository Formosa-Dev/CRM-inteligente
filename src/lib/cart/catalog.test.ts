import assert from "node:assert/strict";
import test from "node:test";
import type { CartItem } from "./cart-context";
import { buildCatalogIndex, reconcileCart } from "./catalog";

const PRODUCTS = [
  { id: 1, name: "Genesis", price: "7500.00", stock: 4 },
  { id: 2, name: "Pan brioche", price: "900.00", stock: null },
  { id: 3, name: "Agotada", price: "5000.00", stock: 0 },
];
const PROMOS = [
  {
    id: 8,
    name: "Promo doble",
    customPrice: "14000",
    active: true,
    items: [{ productId: 1, productName: "Genesis", quantity: 2 }],
  },
];

const line = (overrides: Partial<CartItem> = {}): CartItem => ({
  product: { id: "1", name: "Genesis", price: 7500 },
  quantity: 1,
  type: "product",
  ...overrides,
});

test("catalog index prices live and caps quantity at stock", () => {
  const index = buildCatalogIndex({ products: PRODUCTS, promos: PROMOS });
  const product = index.get("product:1");
  assert.equal(product?.price, 7500);
  assert.equal(product?.maxQuantity, 4);
  assert.equal(index.get("product:2")?.maxQuantity, 99);
  assert.equal(index.get("product:3")?.available, false);
});

test("a promo is orderable only while every component can be fulfilled", () => {
  const index = buildCatalogIndex({ products: PRODUCTS, promos: PROMOS });
  // 2 units per promo over a stock of 4 → at most 2 promos.
  assert.equal(index.get("promo:8")?.available, true);
  assert.equal(index.get("promo:8")?.maxQuantity, 2);

  const archived = buildCatalogIndex({ products: PRODUCTS.slice(1), promos: PROMOS });
  assert.equal(archived.get("promo:8")?.available, false);

  const annotated = buildCatalogIndex({
    products: PRODUCTS,
    promos: [
      {
        ...PROMOS[0],
        items: [{ productId: 1, productName: "Genesis", quantity: 2, available: false }],
      },
    ],
  });
  assert.equal(annotated.get("promo:8")?.available, false);
});

test("reconcileCart keeps orphaned lines listed but out of the orderable set", () => {
  const index = buildCatalogIndex({ products: PRODUCTS, promos: PROMOS });
  const result = reconcileCart(
    [
      line(),
      line({ product: { id: "99", name: "Archivada", price: 1000 }, quantity: 2 }),
    ],
    index,
  );
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[1].status, "unavailable");
  assert.equal(result.lines[1].orderable, false);
  assert.equal(result.hasBlocked, true);
  assert.equal(result.orderable.length, 1);
  assert.deepEqual(result.checkoutLines, [{ type: "product", id: 1, quantity: 1 }]);
  // The honest total only sums what can still be ordered.
  assert.equal(result.total, 7500);
});

test("reconcileCart flags a price drift against the stored snapshot", () => {
  const moved = buildCatalogIndex({
    products: [{ ...PRODUCTS[0], price: "8200.00" }],
    promos: [],
  });
  const result = reconcileCart([line()], moved);
  assert.equal(result.lines[0].status, "price_changed");
  assert.equal(result.lines[0].orderable, true);
  assert.equal(result.pricesChanged, true);
  assert.equal(result.total, 8200);
});

test("reconcileCart flags quantities beyond current stock", () => {
  const index = buildCatalogIndex({ products: PRODUCTS, promos: [] });
  const result = reconcileCart([line({ quantity: 6 })], index);
  assert.equal(result.lines[0].status, "out_of_range");
  assert.equal(result.lines[0].orderable, false);
  assert.equal(result.hasBlocked, true);
});

test("reconcileCart never dead-ends when the catalog refresh failed", () => {
  const result = reconcileCart([line(), line({ product: { id: "99", name: "X", price: 1 } })], null);
  assert.equal(result.hasBlocked, false);
  assert.equal(result.lines.every((l) => l.orderable), true);
});

test("reconcileCart marks non-catalog ids as unorderable", () => {
  const result = reconcileCart(
    [line({ product: { id: "custom-abc", name: "Viejo", price: 10 } })],
    buildCatalogIndex({ products: PRODUCTS, promos: [] }),
  );
  assert.equal(result.lines[0].status, "unavailable");
  assert.equal(result.lines[0].orderable, false);
});
