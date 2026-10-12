import { z } from "zod";

export function checkoutPhone(value: string) {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `549${digits}`;
  if (digits.startsWith("549") && digits.length === 13) return digits;
  if (digits.startsWith("54") && digits.length === 12) return `549${digits.slice(2)}`;
  return digits;
}
export const fulfillmentModeSchema = z.enum(["pickup", "delivery"]);
export type FulfillmentMode = z.infer<typeof fulfillmentModeSchema>;
export const checkoutSchema = z.object({
  requestId: z.uuid(),
  customerName: z.string().trim().min(2).max(100),
  phone: z.string().max(30).transform(checkoutPhone).pipe(z.string().regex(/^549\d{10}$/, "Ingresá tu WhatsApp con código de área, sin 0 ni 15.")),
  // The storefront sends the explicit mode. A missing mode defaults to pickup so
  // the legacy WhatsApp form keeps working while the UX worktree adds the
  // selector — an in-flight sale must never be lost to a missing field.
  fulfillmentMode: fulfillmentModeSchema.default("pickup"),
  // The storefront always sends this key: a non-null address on delivery and an
  // explicit `null` on pickup. `nullish()` accepts both `null` (storefront) and
  // an omitted key (legacy/agent callers) without rejecting a valid sale.
  deliveryAddress: z.string().trim().max(300).nullish(),
  items: z.array(z.object({ type: z.enum(["product", "promo"]), id: z.number().int().positive(), quantity: z.number().int().min(1).max(99) })).min(1).max(40),
}).refine(
  (data) => data.fulfillmentMode !== "delivery" || (data.deliveryAddress?.length ?? 0) >= 5,
  { message: "Ingresá la dirección de entrega.", path: ["deliveryAddress"] },
);
export type CheckoutInput = z.infer<typeof checkoutSchema>;
export type CheckoutLine = CheckoutInput["items"][number];
export type CheckoutReceipt = { orderId: number; total: number; whatsappUrl: string; fulfillmentMode: FulfillmentMode };
export const WEB_ORDER_TAG = "Carta digital";
export const webOrderKey = (id: string) => `web-checkout:${id}`;
export const webReference = (requestId: string) => `Referencia WEB:${requestId}`;
export function extractWebOrderReference(text: string): string | null {
  return text.match(/\bWEB:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1].toLowerCase() ?? null;
}

export type Product = { id: number; name: string; price: string | null; promoPrice?: string | null; isPromo?: boolean; category: string; available: boolean; comingSoon: boolean; stock: number | null };
export type Promo = { id: number; name: string; customPrice: string | null; active: boolean; items: { productId: number; quantity: number }[] | null };
export type PricedItem = { name: string; quantity: number; price: number; unitPrice: number };
export function priceCheckout(lines: CheckoutLine[], products: Product[], promos: Promo[], burgersUnavailable = false) {
  const demand = new Map<number, number>();
  const categories = new Set<string>();
  const seen = new Set<string>();
  const addDemand = (id: number, quantity: number) => demand.set(id, (demand.get(id) ?? 0) + quantity);
  const items: PricedItem[] = lines.map(line => {
    const key = `${line.type}:${line.id}`;
    if (seen.has(key)) throw new Error("Hay productos repetidos. Revisá las cantidades.");
    seen.add(key);
    let name: string, rawPrice: string | null;
    if (line.type === "product") {
      const product = products.find(p => p.id === line.id);
      if (!product) throw new Error("Un producto ya no está disponible. Actualizá la carta.");
      name = product.name; rawPrice = product.isPromo && product.promoPrice != null ? product.promoPrice : product.price;
      addDemand(product.id, line.quantity);
    } else {
      const promo = promos.find(p => p.id === line.id && p.active);
      if (!promo) throw new Error("Una promoción ya no está disponible. Actualizá la carta.");
      name = promo.name; rawPrice = promo.customPrice;
      // Component items only drive stock demand — a priced promo without them
      // is still orderable, matching the storefront's availability check.
      for (const part of promo.items ?? []) {
        if (!Number.isSafeInteger(part.quantity) || part.quantity <= 0) throw new Error("La promoción necesita revisión. Consultanos por WhatsApp.");
        addDemand(part.productId, part.quantity * line.quantity);
      }
    }
    const cents = Math.round(Number(rawPrice) * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error(`El precio de ${name} requiere confirmación.`);
    return { name: name.trim(), quantity: line.quantity, price: cents / 100, unitPrice: cents / 100 };
  });
  for (const [id, quantity] of demand) {
    const p = products.find(p => p.id === id);
    if (!p || !p.available || p.comingSoon || (p.stock !== null && p.stock < quantity) || (p.category === "hamburguesa" && burgersUnavailable)) {
      throw new Error(`${p?.name ?? "Un producto de la promoción"} no tiene disponibilidad para esa cantidad.`);
    }
    categories.add(p.category);
  }
  return {
    items,
    demand,
    orderType: categories.size === 1 && categories.has("pan_mayorista") ? "pan_mayorista" as const : "hamburguesas" as const,
  };
}
