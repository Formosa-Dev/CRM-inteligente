import { db } from "@/db";
import { orderContextItems } from "@/db/schema";
import { eq, and, gt, gte, sql } from "drizzle-orm";
import { argentinaDayStart, filterSameDayActiveCartRows } from "@/lib/whatsapp/temporal-context";

const TTL_MINUTES = 30;

export type OrderContextItem = {
  id: number;
  productName: string;
  productPrice: string | null;
  quantity: number;
  variant: string | null;
  notes: string | null;
};

/**
 * Agrega o actualiza un item en el pedido actual de la conversación.
 * Si el mismo producto ya existe, suma cantidad.
 */
export async function addOrderContextItem(
  conversationId: number,
  phone: string,
  productName: string,
  productPrice?: string | null,
  quantity = 1,
  variant?: string | null,
  notes?: string | null
): Promise<void> {
  // Limpiar expirados primero
  await cleanExpiredItems(conversationId);

  const now = new Date();

  // Buscar si ya existe este producto activo (mismo nombre y variante) DEL DÍA
  // LOCAL ACTUAL. Un item de un día anterior no debe fusionarse: si el cliente
  // vuelve a pedir tras la medianoche, se registra como item nuevo de hoy.
  const [existing] = await db
    .select()
    .from(orderContextItems)
    .where(
      and(
        eq(orderContextItems.conversationId, conversationId),
        eq(orderContextItems.productName, productName),
        eq(orderContextItems.status, "active"),
        variant ? eq(orderContextItems.variant, variant) : sql`${orderContextItems.variant} IS NULL`,
        gt(orderContextItems.expiresAt, now),
        gte(orderContextItems.createdAt, argentinaDayStart(now)),
      )
    )
    .limit(1);

  if (existing) {
    // Sumar cantidad
    await db
      .update(orderContextItems)
      .set({
        quantity: existing.quantity + quantity,
        expiresAt: futureDate(TTL_MINUTES),
      })
      .where(eq(orderContextItems.id, existing.id));
  } else {
    // Insertar nuevo
    await db.insert(orderContextItems).values({
      conversationId,
      phone,
      productName,
      productPrice: productPrice ?? null,
      quantity,
      variant: variant ?? null,
      notes: notes ?? null,
      status: "active",
      expiresAt: futureDate(TTL_MINUTES),
    });
  }
}

/**
 * Obtiene el resumen del pedido actual (items activos no expirados).
 */
export async function getOrderContextSummary(
  conversationId: number
): Promise<OrderContextItem[]> {
  const now = new Date();
  const rows = await db
    .select()
    .from(orderContextItems)
    .where(
      and(
        eq(orderContextItems.conversationId, conversationId),
        eq(orderContextItems.status, "active"),
        gt(orderContextItems.expiresAt, now),
      )
    )
    .orderBy(orderContextItems.createdAt);

  // Solo el carrito del día local actual es visible/usable: un carrito activo
  // de un día anterior no debe presentarse como "pedido actual".
  const items = filterSameDayActiveCartRows(rows, now);

  return items.map((i) => ({
    id: i.id,
    productName: i.productName,
    productPrice: i.productPrice,
    quantity: i.quantity,
    variant: i.variant,
    notes: i.notes,
  }));
}

/**
 * Limpia items expirados.
 */
async function cleanExpiredItems(conversationId: number): Promise<void> {
  await db
    .update(orderContextItems)
    .set({ status: "ordered" })
    .where(
      and(
        eq(orderContextItems.conversationId, conversationId),
        eq(orderContextItems.status, "active"),
        sql`${orderContextItems.expiresAt} < NOW()`,
      )
    );
}

function futureDate(minutes: number): Date {
  return new Date(Date.now() + minutes * 60 * 1000);
}

/**
 * Convierte el resumen del pedido a texto para inyectar en el prompt.
 */
export function formatOrderSummary(items: OrderContextItem[]): string {
  if (items.length === 0) return "";
  const lines = items.map(
    (i) => `• ${i.quantity}x ${i.productName}${i.variant ? ` (${i.variant})` : ""}${i.productPrice ? ` — $${Number(i.productPrice).toLocaleString("es-AR")} c/u` : ""}${i.notes ? ` [${i.notes}]` : ""}`
  );
  return `\n🛒 PEDIDO ACTUAL (pendiente de confirmar):\n${lines.join("\n")}\n⚠️ No preguntes de nuevo lo que ya está acá.`;
}
