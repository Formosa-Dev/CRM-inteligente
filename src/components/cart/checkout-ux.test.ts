import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CHECKOUT_ATTEMPT_KEY,
  clearAttempt,
  normalizeAttemptSignature,
  resolveAttempt,
  type AttemptSignatureInput,
  type AttemptStorage,
} from "./checkout-attempt";
import {
  AMBIGUOUS_ORDER_MESSAGE,
  checkoutFailureMessage,
  interpretCheckoutOutcome,
  shouldClearAfter,
} from "./checkout-outcome";
import {
  fulfillmentPayload,
  isValidDeliveryAddress,
  validateFulfillment,
} from "./fulfillment";

function memoryStorage(): AttemptStorage & { raw: Map<string, string> } {
  const raw = new Map<string, string>();
  return {
    raw,
    getItem: (key) => raw.get(key) ?? null,
    setItem: (key, value) => {
      raw.set(key, value);
    },
    removeItem: (key) => {
      raw.delete(key);
    },
  };
}

const baseInput: AttemptSignatureInput = {
  phone: "5493704123456",
  customerName: "Ramiro",
  fulfillmentMode: "delivery",
  deliveryAddress: "Av. Siempre Viva 742",
  items: [
    { type: "product", id: 3, quantity: 2 },
    { type: "promo", id: 8, quantity: 1 },
  ],
};

// ─── pickup / delivery choice + conditional address ──────────────────────────

test("pickup needs no address and delivery requires one", () => {
  assert.equal(validateFulfillment("pickup", ""), null);
  assert.notEqual(validateFulfillment("delivery", ""), null);
});

test("delivery address rule enforces a usable minimum", () => {
  assert.equal(isValidDeliveryAddress(""), false);
  assert.equal(isValidDeliveryAddress("   "), false);
  assert.equal(isValidDeliveryAddress("Casa"), false);
  assert.equal(isValidDeliveryAddress("Rivadavia 123"), true);
  assert.equal(validateFulfillment("delivery", ""), "Ingresá la dirección de entrega (calle, número y referencia).");
  assert.equal(validateFulfillment("delivery", "Rivadavia 123"), null);
});

test("fulfillment payload nulls the address on pickup and trims on delivery", () => {
  assert.deepEqual(fulfillmentPayload("pickup", "Av. Siempre Viva 742"), {
    fulfillmentMode: "pickup",
    deliveryAddress: null,
  });
  assert.deepEqual(fulfillmentPayload("delivery", "  Av. Siempre Viva 742  "), {
    fulfillmentMode: "delivery",
    deliveryAddress: "Av. Siempre Viva 742",
  });
});

// ─── one stable semantic attempt id ──────────────────────────────────────────

test("identical intent reuses one request id across remounts", () => {
  const storage = memoryStorage();
  const signature = normalizeAttemptSignature(baseInput);
  const first = resolveAttempt(storage, signature);
  // Simulate a remount/renavigation re-reading the same storage.
  const second = resolveAttempt(storage, signature);
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.requestId.length, 36);
});

test("signature ignores item order and UI-only fields", () => {
  const reordered = normalizeAttemptSignature({
    ...baseInput,
    items: [
      { type: "promo", id: 8, quantity: 1 },
      { type: "product", id: 3, quantity: 2 },
    ],
  });
  assert.equal(reordered, normalizeAttemptSignature(baseInput));
});

test("a different intent mints exactly one new id", () => {
  const storage = memoryStorage();
  const first = resolveAttempt(storage, normalizeAttemptSignature(baseInput));
  const changed = resolveAttempt(
    storage,
    normalizeAttemptSignature({ ...baseInput, items: [{ type: "product", id: 3, quantity: 3 }] }),
  );
  assert.notEqual(changed.requestId, first.requestId);
});

test("only clearing after success rotates the id", () => {
  const storage = memoryStorage();
  const signature = normalizeAttemptSignature(baseInput);
  const before = resolveAttempt(storage, signature);
  clearAttempt(storage);
  assert.equal(storage.raw.has(CHECKOUT_ATTEMPT_KEY), false);
  const after = resolveAttempt(storage, signature);
  assert.notEqual(after.requestId, before.requestId);
});

// ─── failure classification + false-409 regression ───────────────────────────

test("response mapping clears only on confirmed success", () => {
  assert.equal(interpretCheckoutOutcome(true, 200), "success");
  assert.equal(shouldClearAfter("success"), true);
  for (const [status, code, expected] of [
    [400, null, "rejected"],
    // The origin check runs before anything is created — a 403 is a definite rejection.
    [403, null, "rejected"],
    [413, null, "rejected"],
    [415, null, "rejected"],
    [422, null, "rejected"],
    [422, "catalog_changed", "rejected"],
    [429, null, "rejected"],
    // The 409 idempotency/replay path stays ambiguous — an order may exist.
    [409, null, "ambiguous"],
    [500, null, "ambiguous"],
    [503, null, "ambiguous"],
    // A missing WhatsApp destination rejects before any order is created.
    [503, "no_destination", "rejected"],
  ] as const) {
    const outcome = interpretCheckoutOutcome(false, status, code);
    assert.equal(outcome, expected, `status ${status}`);
    assert.equal(shouldClearAfter(outcome), false, `status ${status} must not clear`);
  }
});

test("catalog conflicts are rejected with an update-the-cart message, never ambiguous", () => {
  const outcome = interpretCheckoutOutcome(false, 422, "catalog_changed");
  assert.equal(outcome, "rejected");
  assert.equal(shouldClearAfter(outcome), false);
  // The server tells the customer what changed; the fallback asks to fix the cart.
  assert.equal(
    checkoutFailureMessage(outcome, "Genesis no tiene disponibilidad para esa cantidad.", "catalog_changed"),
    "Genesis no tiene disponibilidad para esa cantidad.",
  );
  assert.match(checkoutFailureMessage(outcome, null, "catalog_changed"), /Actualizá tu carrito/);
  assert.doesNotMatch(checkoutFailureMessage(outcome, null, "catalog_changed"), /Verificá el estado/);
});

test("a missing WhatsApp destination tells the customer to consult, not to verify", () => {
  const outcome = interpretCheckoutOutcome(false, 503, "no_destination");
  assert.equal(outcome, "rejected");
  assert.equal(shouldClearAfter(outcome), false);
  const message = checkoutFailureMessage(outcome, null, "no_destination");
  assert.match(message, /Consultanos por WhatsApp/);
  assert.doesNotMatch(message, /Verificá el estado/);
});

test("a catalog conflict still carries the code at status 409", () => {
  // Even if a proxy rewrites the status, an explicit catalog_changed code is
  // always a pre-creation rejection — never the ambiguous replay path.
  assert.equal(interpretCheckoutOutcome(false, 409, "catalog_changed"), "rejected");
});

test("a reused-confirmation 409 is reported as ambiguous, never auto-retried", () => {
  const storage = memoryStorage();
  const signature = normalizeAttemptSignature(baseInput);
  const attempt = resolveAttempt(storage, signature);

  const outcome = interpretCheckoutOutcome(false, 409);
  assert.equal(outcome, "ambiguous");
  assert.equal(shouldClearAfter(outcome), false);
  assert.equal(
    checkoutFailureMessage(outcome, "Esta confirmación ya fue usada para otro pedido. Volvé a revisar tu carrito."),
    AMBIGUOUS_ORDER_MESSAGE,
  );

  // Regression: because we never clear on this path, the retry keeps the SAME
  // id and therefore cannot create a duplicate order.
  const retry = resolveAttempt(storage, signature);
  assert.equal(retry.requestId, attempt.requestId);
});

test("rejected payloads surface the server message and keep the same id", () => {
  const message = checkoutFailureMessage("rejected", "Revisá tu nombre, WhatsApp y las cantidades del pedido.");
  assert.equal(message, "Revisá tu nombre, WhatsApp y las cantidades del pedido.");
  const network = checkoutFailureMessage("ambiguous");
  assert.match(network, /Verificá el estado del pedido/);
});

// ─── source invariants: single POST, clear-once, cart kept on failure ────────

const formSource = readFileSync("src/components/cart/checkout-form.tsx", "utf8");

test("checkout form issues exactly one POST and never schedules a retry", () => {
  assert.equal((formSource.match(/fetch\("\/api\/checkout"/g) ?? []).length, 1);
  assert.doesNotMatch(formSource, /setTimeout|setInterval|location\.reload/);
});

test("checkout form only clears on confirmed success, exactly once", () => {
  assert.equal((formSource.match(/clearCart\(\)/g) ?? []).length, 1);
  assert.equal((formSource.match(/clearAttempt\(/g) ?? []).length, 1);
  const guard = formSource.indexOf("shouldClearAfter(outcome)");
  const clear = formSource.indexOf("clearCart()");
  assert.ok(guard !== -1 && clear !== -1 && guard < clear, "clear must be gated by success");
  const catchStart = formSource.lastIndexOf("} catch {");
  const catchBlock = formSource.slice(catchStart, formSource.indexOf("} finally {"));
  assert.ok(catchBlock.length > 0, "form must catch transport failures");
  assert.doesNotMatch(catchBlock, /clearCart|clearAttempt/);
});

test("checkout form keeps one stable attempt id per signature", () => {
  assert.match(formSource, /normalizeAttemptSignature\(/);
  assert.match(formSource, /resolveAttempt\(/);
  assert.doesNotMatch(formSource, /crypto\.randomUUID|newRequestId\(/);
});

test("checkout form detects offline and forwards the server error code", () => {
  // navigator.onLine gates both the pre-flight guard and the catch path so an
  // offline customer never sees the ambiguous "maybe registered" message.
  assert.match(formSource, /navigator\.onLine === false/);
  assert.match(formSource, /interpretCheckoutOutcome\(response\.ok, response\.status, data\.code\)/);
  assert.match(formSource, /checkoutFailureMessage\(outcome, data\.error, data\.code\)/);
});

test("cart clear persists synchronously so a redirect cannot resurrect it", () => {
  const context = readFileSync("src/lib/cart/cart-context.tsx", "utf8");
  const start = context.indexOf("const clearCart");
  const block = context.slice(start, start + 400);
  assert.match(block, /saveCart\(\[\]\)/);
});

// ─── unified cart: every visible orderable card uses the shared cart ─────────

test("products and promos enter the same shared cart from every card", () => {
  const productCards = [
    "src/components/home/landing-product-card.tsx",
    "src/components/products/product-card.tsx",
    "src/components/products/upsell-modal.tsx",
  ];
  for (const file of productCards) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /addItem\(/, `${file} must add to the shared cart`);
    assert.match(src, /type: "product"/, `${file} must tag product lines`);
  }
  // Las páginas de categoría legacy redirigen a la carta digital (superficie única).
  for (const file of [
    "src/app/(storefront)/hamburguesas/page.tsx",
    "src/app/(storefront)/tragos-vip/page.tsx",
  ]) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /redirect\("\/carta-digital\?category=/, `${file} must redirect to carta-digital`);
  }
  const promos = readFileSync("src/components/home/promos-section.tsx", "utf8");
  assert.match(promos, /addItem\(/);
  assert.match(promos, /type: "promo"/);
  const detailPages = [
    "src/app/(storefront)/hamburguesas/[id]/page.tsx",
    "src/app/(storefront)/pan-mayorista/[id]/page.tsx",
  ];
  for (const file of detailPages) {
    const src = readFileSync(file, "utf8");
    assert.match(src, /addItem\(/, `${file} must add to the shared cart`);
    assert.match(src, /type: "product"/, `${file} must tag product lines`);
  }
});

test("no stale parallel cart or manual message builder survives", () => {
  assert.throws(() => readFileSync("src/lib/cart/build-order-message.ts", "utf8"));
  const context = readFileSync("src/lib/cart/cart-context.tsx", "utf8");
  assert.match(context, /muzapp-digital-cart/, "legacy key must still be purged");
});

// ─── narrow mobile layout invariants ─────────────────────────────────────────

test("mobile cart sheet scrolls in one region with safe-area padding", () => {
  const drawer = readFileSync("src/components/cart/cart-drawer.tsx", "utf8");
  assert.match(drawer, /max-h-\[85svh\]/);
  assert.match(drawer, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(drawer, /overscroll-contain/);
  assert.match(drawer, /env\(safe-area-inset-bottom\)/);
  // Row cannot clip: copy shrinks, controls/thumbnail never do.
  assert.match(drawer, /min-w-0 flex-1/);
  assert.match(drawer, /truncate/);
  assert.match(drawer, /shrink-0/);
});

test("fulfillment controls and cart quantity are laid out to avoid clipping", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  assert.match(css, /\.checkout-fulfillment-options\{display:grid;grid-template-columns:1fr 1fr/);
  assert.match(css, /\.checkout-fulfillment-option\[data-selected="true"\]/);
  assert.match(css, /\.checkout-address label\{/);
  assert.match(css, /\.menu-cart-line \.menu-quantity\{flex-shrink:0\}/);
});
