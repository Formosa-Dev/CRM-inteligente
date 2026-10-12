/**
 * One stable semantic checkout attempt per distinct order intent.
 *
 * The request id is the server's idempotency key. It must survive remounts and
 * navigation, and it must NOT change for an identical cart. Only a confirmed
 * success clears it, so a later genuinely-new order gets a fresh id while a
 * retry of the same attempt is deduplicated server-side.
 */
export const CHECKOUT_ATTEMPT_KEY = "muzapp-checkout-attempt";

export type CheckoutAttempt = { signature: string; requestId: string };

export type AttemptStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type AttemptSignatureInput = {
  /** Canonical E.164-ish digits — normalize before calling, never raw input. */
  phone: string;
  customerName: string;
  fulfillmentMode: "pickup" | "delivery";
  deliveryAddress: string | null;
  items: Array<{ type: "product" | "promo"; id: number; quantity: number }>;
};

/**
 * Canonical, order-independent signature. Only semantic fields participate:
 * UI-only decoration (emoji, image URL, layout) never appears, and item order
 * is sorted out so re-rendering the same cart cannot mint a new attempt id.
 */
export function normalizeAttemptSignature(input: AttemptSignatureInput): string {
  const items = input.items
    .map((item) => `${item.type}:${item.id}:${item.quantity}`)
    .sort()
    .join("|");
  return [
    input.customerName.trim(),
    input.phone,
    input.fulfillmentMode,
    input.deliveryAddress?.trim() ?? "",
    items,
  ].join("::");
}

export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Returns the stable attempt for a signature, reusing the persisted id across
 * remounts/navigation. A different signature gets exactly one new id.
 */
export function resolveAttempt(
  storage: AttemptStorage | null,
  signature: string,
  generate: () => string = newRequestId,
): CheckoutAttempt {
  let saved: unknown = null;
  try {
    saved = JSON.parse(storage?.getItem(CHECKOUT_ATTEMPT_KEY) ?? "null");
  } catch {
    saved = null;
  }
  const candidate = saved as Partial<CheckoutAttempt> | null;
  if (
    candidate &&
    candidate.signature === signature &&
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0
  ) {
    return { signature, requestId: candidate.requestId };
  }
  const attempt: CheckoutAttempt = { signature, requestId: generate() };
  try {
    storage?.setItem(CHECKOUT_ATTEMPT_KEY, JSON.stringify(attempt));
  } catch {
    /* storage unavailable — the in-memory ref still keeps retries stable */
  }
  return attempt;
}

/** Clears the stored attempt. Called exactly once, only after confirmed success. */
export function clearAttempt(storage: AttemptStorage | null): void {
  try {
    storage?.removeItem(CHECKOUT_ATTEMPT_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}
