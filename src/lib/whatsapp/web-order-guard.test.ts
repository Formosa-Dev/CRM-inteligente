import assert from "node:assert/strict";
import test from "node:test";
import { checkoutPhone, extractWebOrderReference } from "@/lib/checkout/contract";
import { createCreateOrderTool } from "@/lib/whatsapp/tools/create-order";

// Opaque id shape emitted by crypto.randomUUID() in the storefront checkout.
const REQUEST_ID = "59142490-f403-4abc-9b12-6fcdb1b9dcc0";

// Byte-for-byte shape of the message that submitCheckout() opens in wa.me,
// including the structured summary and the trailing reference line.
function productionPrefilledMessage(requestId: string): string {
  return [
    "Hola! Soy Ramiro. Confirmé el pedido #232 en la carta digital.",
    "",
    "• 2× Deli Deli — $12.000",
    "• 1× Genesis — $5.000",
    "",
    "Subtotal: $17.000. Envío a coordinar.",
    "Quiero coordinar entrega o retiro y pago.",
    `Referencia WEB:${requestId}`,
  ].join("\n");
}

test("extracts the web reference from the exact production prefilled message", () => {
  assert.equal(extractWebOrderReference(productionPrefilledMessage(REQUEST_ID)), REQUEST_ID);
});

test("parser accepts the reference format the checkout service embeds", () => {
  // src/lib/checkout/service.ts builds `Referencia WEB:${input.requestId}`.
  assert.equal(extractWebOrderReference(`Referencia WEB:${REQUEST_ID}`), REQUEST_ID);
});

test("parser is case-insensitive on the WEB marker and the opaque id", () => {
  assert.equal(
    extractWebOrderReference(`referencia web:${REQUEST_ID.toUpperCase()}`),
    REQUEST_ID,
  );
});

test("malformed or unknown references stay safe without throwing", () => {
  const malformed = [
    "",
    "hola, quiero hacer un pedido",
    "WEB:",
    "WEB:not-a-uuid",
    "WEB:1234",
    `WEB:${REQUEST_ID.slice(0, 8)}`,
    "Referencia WEB:",
    "Referencia 59142490-f403-4abc-9b12-6fcdb1b9dcc0",
  ];
  for (const text of malformed) {
    assert.equal(extractWebOrderReference(text), null, `unexpected match for: ${JSON.stringify(text)}`);
  }
});

test("a bare UUID without the WEB: marker never resolves ownership", () => {
  assert.equal(extractWebOrderReference(REQUEST_ID), null);
});

test("a verified web order disables order creation (no duplicate insert)", async () => {
  const tool = createCreateOrderTool(1, 232);
  const asExecute = tool.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<unknown>;
  const result = await asExecute(
    {
      customerName: "Ramiro",
      orderType: "hamburguesas",
      customerPhone: "5493704111111",
    },
    { toolCallId: "test-call", messages: [] },
  );
  const text = String(result);
  assert.match(text, /#232/);
  assert.match(text, /no lo dupliques|ya está registrado/i);
});

test("target/inbound phone resolves to the same canonical digits", () => {
  // The checkout target and the inbound sender are bound through the same
  // normalizer, so a referenced order must resolve from either input shape.
  assert.equal(checkoutPhone("370 411-1111"), "5493704111111");
  assert.equal(checkoutPhone("+54 9 370 411 1111"), "5493704111111");
  assert.equal(checkoutPhone("54 370 4111111"), "5493704111111");
  assert.equal(checkoutPhone("5493704111111"), checkoutPhone("3704111111"));
});
