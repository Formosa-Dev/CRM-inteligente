import { createHash } from "node:crypto";
import { type CheckoutInput, type CheckoutReceipt, type PricedItem, priceCheckout, WEB_ORDER_TAG, webOrderKey, webReference } from "./contract";
import { createDbCheckoutDeps, type CheckoutDeps, type OrderRow } from "./store";

export class CheckoutError extends Error { constructor(message: string, public status = 409) { super(message); } }

function buildReceipt(order: OrderRow, input: CheckoutInput, fingerprint: string, destination: string): CheckoutReceipt {
  // A requestId is bound to its exact payload+phone; anything else is a replay.
  if (!order || !order.notes?.includes(fingerprint) || order.phoneNumber !== input.phone) {
    throw new CheckoutError("Esta confirmación ya fue usada para otro pedido. Volvé a revisar tu carrito.");
  }
  const items = order.items as PricedItem[];
  const total = items.reduce((sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity, 0) / 100;
  const fulfillment = input.fulfillmentMode === "delivery"
    ? `Envío a: ${input.deliveryAddress?.trim()}.`
    : "Retiro en el local.";
  const message = [
    `Hola! Soy ${order.customerName}. Confirmé el pedido #${order.id} en la carta digital.`, "",
    ...items.map(item => `• ${item.quantity}× ${item.name} — $${(item.unitPrice * item.quantity).toLocaleString("es-AR")}`), "",
    `Subtotal: $${total.toLocaleString("es-AR")}. ${fulfillment}`,
    "Quiero coordinar entrega o retiro y pago.", `Referencia WEB:${input.requestId}`,
  ].join("\n");
  return {
    orderId: order.id,
    total,
    whatsappUrl: `https://wa.me/${destination}?text=${encodeURIComponent(message)}`,
    fulfillmentMode: input.fulfillmentMode,
  };
}

/**
 * Persists a web order without an interactive transaction: the neon-http driver
 * that backs `db` does not support `db.transaction()` (it throws), which used to
 * surface as a generic 503 for every checkout. Idempotency is enforced by a
 * conditional INSERT keyed on the request reference, and stock is decremented
 * with a conditional UPDATE that compensates on any downstream failure.
 */
export async function submitCheckout(input: CheckoutInput, deps: CheckoutDeps = createDbCheckoutDeps()): Promise<CheckoutReceipt> {
  const key = webOrderKey(input.requestId);
  const fingerprint = `web-payload:${createHash("sha256").update(JSON.stringify({ ...input, items: [...input.items].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)) })).digest("hex")}`;
  const destination = ((await deps.getDestinationPhone()) || process.env.WHATSAPP_PHONE_NUMBER || "").replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(destination)) throw new CheckoutError("No podemos abrir WhatsApp en este momento. Intentá nuevamente más tarde.", 503);
  const noBurgers = await deps.getBurgersUnavailable();
  const address = input.fulfillmentMode === "delivery" ? (input.deliveryAddress?.trim() || null) : null;
  const reference = webReference(input.requestId);

  // Fast path: a retry (or double submit) of an already-persisted order.
  const existing = await deps.findOrderByReference(input.phone, reference);
  if (existing) return buildReceipt(existing, input, fingerprint, destination);

  const [catalog, offers] = await Promise.all([deps.listProducts(), deps.listPromos()]);
  let priced: ReturnType<typeof priceCheckout>;
  try { priced = priceCheckout(input.items, catalog, offers, noBurgers); }
  catch (error) { throw new CheckoutError(error instanceof Error ? error.message : "Revisá los productos."); }

  // Conditional stock decrement. `stock IS NULL` means unlimited — no reservation.
  const reserved: Array<[number, number]> = [];
  const releaseAll = async () => {
    for (const [productId, qty] of reserved) {
      try { await deps.releaseStock(productId, qty); } catch { /* manual reconcile is safer than a failed undo */ }
    }
  };
  try {
    for (const [productId, qty] of priced.demand) {
      const updated = await deps.reserveStock(productId, qty);
      if (updated === 0) {
        const p = await deps.getProductStock(productId);
        if (p && p.stock !== null) throw new CheckoutError(`${p.name} no tiene disponibilidad para esa cantidad.`, 409);
      } else {
        reserved.push([productId, qty]);
      }
    }
  } catch (error) {
    await releaseAll();
    throw error;
  }

  const notes = `Pedido web (${WEB_ORDER_TAG}; ${key}; ${fingerprint}; ${input.fulfillmentMode}). ${reference}. Coordinar entrega y pago por WhatsApp.`;
  let created: OrderRow | null;
  try {
    created = await deps.insertOrderIfAbsent({
      phone: input.phone,
      customerName: input.customerName,
      orderType: priced.orderType,
      items: priced.items,
      notes,
      address,
      reference,
    });
  } catch (error) {
    await releaseAll();
    throw error;
  }

  if (!created) {
    // Lost the race: another request owns the reservation, so release ours.
    await releaseAll();
    const again = await deps.findOrderByReference(input.phone, reference);
    if (!again) throw new CheckoutError("No pudimos confirmar el pedido. Reintentá en unos segundos.", 503);
    return buildReceipt(again, input, fingerprint, destination);
  }
  return buildReceipt(created, input, fingerprint, destination);
}

export { findReferencedWebOrder } from "./store";
