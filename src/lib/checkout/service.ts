import { createHash } from "node:crypto";
import { db } from "@/db";
import { agentConfig, orders, products, promotions } from "@/db/schema";
import { and, eq, like, sql } from "drizzle-orm";
import { type CheckoutInput, type CheckoutReceipt, type PricedItem, priceCheckout, WEB_ORDER_TAG, webOrderKey } from "./contract";

export class CheckoutError extends Error { constructor(message: string, public status = 409) { super(message); } }

function webReference(requestId: string) {
  return `Referencia WEB:${requestId}`;
}

type OrderRow = {
  id: number;
  phoneNumber: string | null;
  customerName: string | null;
  items: unknown;
  notes: string | null;
};

/**
 * Best-effort rollback of stock reservations taken before a failure. The rows
 * were decremented conditionally, so adding them back only undoes our own work.
 */
async function releaseStock(reserved: Array<[number, number]>) {
  for (const [productId, qty] of reserved) {
    try {
      await db.execute(sql`UPDATE products SET stock = stock + ${qty} WHERE id = ${productId}`);
    } catch { /* leave the reservation — a manual reconcile is safer than a failed undo */ }
  }
}

/**
 * Persists a web order without an interactive transaction: the neon-http driver
 * that backs `db` does not support `db.transaction()` (it throws), which used to
 * surface as a generic 503 for every checkout. Idempotency is enforced by a
 * conditional INSERT keyed on the request reference, and stock is decremented
 * with a conditional UPDATE that compensates on any downstream failure.
 */
export async function submitCheckout(input: CheckoutInput): Promise<CheckoutReceipt> {
  const key = webOrderKey(input.requestId);
  const fingerprint = `web-payload:${createHash("sha256").update(JSON.stringify({ ...input, items: [...input.items].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)) })).digest("hex")}`;
  // agent_config was introduced by the WhatsApp agent, which some deployments
  // never provisioned. Its absence must not block checkout — fall back to env.
  let cfgPhone: string | null = null;
  try {
    const [cfg] = await db.select({ phone: agentConfig.phoneNumber }).from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);
    cfgPhone = cfg?.phone ?? null;
  } catch { /* older deployments do not have this optional table */ }
  // Stock controls were added after the original database schema. Their absence
  // must never prevent a customer from registering a valid order.
  let noBurgers = false;
  try {
    const [stockConfig] = await db.select({ noBurgers: agentConfig.hamburguesasSinStock }).from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);
    noBurgers = stockConfig?.noBurgers ?? false;
  } catch { /* older deployments do not yet have this optional column */ }
  const destination = (cfgPhone || process.env.WHATSAPP_PHONE_NUMBER || "").replace(/\D/g, "");
  if (!/^\d{10,15}$/.test(destination)) throw new CheckoutError("No podemos abrir WhatsApp en este momento. Intentá nuevamente más tarde.", 503);
  // `notes` exists in every production version of orders. The old deployment did
  // not reliably have the later `tags` column, which made a valid checkout fail
  // before it could be stored. Keep the durable correlation reference here.
  const reference = webReference(input.requestId);
  const matchReference = and(eq(orders.phoneNumber, input.phone), like(orders.notes, `%${reference}%`));

  const finalize = (order: OrderRow): CheckoutReceipt => {
    // A requestId is bound to its exact payload+phone; anything else is a replay.
    if (!order || !order.notes?.includes(fingerprint) || order.phoneNumber !== input.phone) throw new CheckoutError("Esta confirmación ya fue usada para otro pedido. Volvé a revisar tu carrito.");
    const items = order.items as PricedItem[];
    const total = items.reduce((sum, item) => sum + Math.round(item.unitPrice * 100) * item.quantity, 0) / 100;
    const message = [
      `Hola! Soy ${order.customerName}. Confirmé el pedido #${order.id} en la carta digital.`, "",
      ...items.map(item => `• ${item.quantity}× ${item.name} — $${(item.unitPrice * item.quantity).toLocaleString("es-AR")}`), "",
      `Subtotal: $${total.toLocaleString("es-AR")}. Envío a coordinar.`,
      "Quiero coordinar entrega o retiro y pago.", `Referencia WEB:${input.requestId}`,
    ].join("\n");
    return { orderId: order.id, total, whatsappUrl: `https://wa.me/${destination}?text=${encodeURIComponent(message)}` };
  };

  // Fast path: a retry (or double submit) of an already-persisted order.
  const [existing] = await db.select({
    id: orders.id,
    phoneNumber: orders.phoneNumber,
    customerName: orders.customerName,
    items: orders.items,
    notes: orders.notes,
  }).from(orders).where(matchReference).limit(1);
  if (existing) return finalize(existing);

  const [catalog, offers] = await Promise.all([db.select().from(products), db.select().from(promotions)]);
  let priced: ReturnType<typeof priceCheckout>;
  try { priced = priceCheckout(input.items, catalog, offers, noBurgers); }
  catch (error) { throw new CheckoutError(error instanceof Error ? error.message : "Revisá los productos."); }

  // Conditional stock decrement. `stock IS NULL` means unlimited — no reservation.
  const reserved: Array<[number, number]> = [];
  try {
    for (const [productId, qty] of priced.demand) {
      const updated = await db.execute(sql`
        UPDATE products SET stock = stock - ${qty}
        WHERE id = ${productId} AND stock IS NOT NULL AND stock >= ${qty}
      `);
      if ((updated.rowCount ?? 0) === 0) {
        const [p] = await db
          .select({ name: products.name, stock: products.stock })
          .from(products)
          .where(eq(products.id, productId))
          .limit(1);
        if (p && p.stock !== null) {
          throw new CheckoutError(`${p.name} no tiene disponibilidad para esa cantidad.`, 409);
        }
      } else {
        reserved.push([productId, qty]);
      }
    }
  } catch (error) {
    await releaseStock(reserved);
    throw error;
  }

  const notes = `Pedido web (${WEB_ORDER_TAG}; ${key}; ${fingerprint}). ${reference}. Coordinar entrega y pago por WhatsApp.`;
  let created: OrderRow | undefined;
  try {
    // Idempotent INSERT: a concurrent request that already stored this
    // reference wins, and this statement becomes a no-op.
    const inserted = await db.execute(sql`
      INSERT INTO orders (phone_number, customer_name, order_type, items, notes, status)
      SELECT ${input.phone}, ${input.customerName}, ${priced.orderType}::order_type, ${JSON.stringify(priced.items)}::jsonb, ${notes}, 'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM orders WHERE phone_number = ${input.phone} AND notes LIKE ${`%${reference}%`}
      )
      RETURNING id, phone_number, customer_name, items, notes
    `);
    created = (inserted.rows?.[0] as unknown as OrderRow | undefined);
  } catch (error) {
    await releaseStock(reserved);
    throw error;
  }

  if (!created) {
    // Lost the race: another request owns the reservation, so release ours.
    await releaseStock(reserved);
    const [again] = await db.select({
      id: orders.id,
      phoneNumber: orders.phoneNumber,
      customerName: orders.customerName,
      items: orders.items,
      notes: orders.notes,
    }).from(orders).where(matchReference).limit(1);
    if (!again) throw new CheckoutError("No pudimos confirmar el pedido. Reintentá en unos segundos.", 503);
    return finalize(again);
  }
  return finalize(created);
}

export async function findReferencedWebOrder(reference: string, phone: string) {
  const [order] = await db.select({ id: orders.id, status: orders.status }).from(orders)
    .where(and(eq(orders.phoneNumber, phone), like(orders.notes, `%${webReference(reference)}%`))).limit(1);
  return order;
}
