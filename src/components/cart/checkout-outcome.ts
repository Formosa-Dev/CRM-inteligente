/**
 * Client reaction to a /api/checkout response.
 *
 * "success"   — the order is persisted; clear cart + stored attempt exactly once.
 * "rejected"  — the server rejected before creating anything (bad payload,
 *               catalog drift, oversized body, rate limit, disallowed origin).
 *               Cart is kept and a manual retry with the SAME attempt id is safe.
 * "ambiguous" — the request may already have created an order (409 conflict on
 *               the idempotency path, server/proxy error, or a lost response).
 *               The cart is preserved, the attempt id stays stable, and no
 *               automatic retry happens: the customer is told to verify the
 *               order status first.
 */
export type CheckoutOutcome = "success" | "rejected" | "ambiguous";

export function interpretCheckoutOutcome(
  ok: boolean,
  status: number,
  code?: string | null,
): CheckoutOutcome {
  if (ok) return "success";
  // Server-tagged pre-creation rejections: nothing was persisted, so the cart
  // stays editable and the message can tell the customer how to fix it.
  if (code === "catalog_changed") return "rejected";
  if (
    status === 400 ||
    status === 413 ||
    status === 415 ||
    status === 422 ||
    status === 429
  ) {
    return "rejected";
  }
  return "ambiguous";
}

/** Only a confirmed success may clear the cart and the stored attempt. */
export function shouldClearAfter(outcome: CheckoutOutcome): boolean {
  return outcome === "success";
}

export const AMBIGUOUS_ORDER_MESSAGE =
  "No pudimos confirmar si el pedido quedó registrado. No vuelvas a confirmar todavía: revisá tu WhatsApp o esperá la confirmación del local.";

export const VERIFY_STATUS_HINT =
  "Verificá el estado del pedido antes de volver a confirmar.";

export const CATALOG_CHANGED_FALLBACK =
  "Actualizá tu carrito: cambió la disponibilidad o el precio de algún producto.";

const REUSED_CONFIRMATION = /ya fue usada/i;

export function checkoutFailureMessage(
  outcome: CheckoutOutcome,
  serverError?: string | null,
  code?: string | null,
): string {
  const error = (serverError ?? "").trim();
  if (outcome === "rejected") {
    if (error) return error;
    return code === "catalog_changed"
      ? CATALOG_CHANGED_FALLBACK
      : "Revisá los datos del pedido e intentá de nuevo.";
  }
  if (REUSED_CONFIRMATION.test(error)) return AMBIGUOUS_ORDER_MESSAGE;
  return `${error || "No pudimos confirmar el pedido."} ${VERIFY_STATUS_HINT}`.trim();
}
