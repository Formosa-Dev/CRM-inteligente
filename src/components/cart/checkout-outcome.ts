/**
 * Client reaction to a /api/checkout response.
 *
 * "success"   — the order is persisted; clear cart + stored attempt exactly once.
 * "rejected"  — the server rejected before creating anything (bad payload,
 *               oversized body, rate limit). Cart is kept and a manual retry
 *               with the SAME attempt id is safe.
 * "ambiguous" — the request may already have created an order (409 conflict,
 *               server/proxy error, or a lost response). The cart is preserved,
 *               the attempt id stays stable, and no automatic retry happens:
 *               the customer is told to verify the order status first.
 */
export type CheckoutOutcome = "success" | "rejected" | "ambiguous";

export function interpretCheckoutOutcome(ok: boolean, status: number): CheckoutOutcome {
  if (ok) return "success";
  if (status === 400 || status === 413 || status === 415 || status === 429) {
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

const REUSED_CONFIRMATION = /ya fue usada/i;

export function checkoutFailureMessage(
  outcome: CheckoutOutcome,
  serverError?: string | null,
): string {
  const error = (serverError ?? "").trim();
  if (outcome === "rejected") return error || "Revisá los datos del pedido e intentá de nuevo.";
  if (REUSED_CONFIRMATION.test(error)) return AMBIGUOUS_ORDER_MESSAGE;
  return `${error || "No pudimos confirmar el pedido."} ${VERIFY_STATUS_HINT}`.trim();
}
