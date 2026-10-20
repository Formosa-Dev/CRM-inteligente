import { cartKey, type CartItem } from "./cart-context";

/** Same hard cap the checkout contract enforces on items[].quantity. */
export const MAX_LINE_QUANTITY = 99;

export type CatalogProductLike = {
  id: number;
  name: string;
  price?: string | number | null;
  promoPrice?: string | number | null;
  isPromo?: boolean;
  available?: boolean;
  comingSoon?: boolean;
  stock?: number | null;
};

export type CatalogPromoItem = {
  productId: number;
  quantity: number;
  productName?: string;
  /** Optional annotations from the public promotions payload. */
  available?: boolean;
  stock?: number | null;
};

export type CatalogPromoLike = {
  id: number;
  name: string;
  customPrice?: string | number | null;
  active?: boolean;
  items?: CatalogPromoItem[] | null;
};

export type PublicCatalog = {
  products: CatalogProductLike[];
  promos: CatalogPromoLike[];
};

export type CatalogEntry = {
  name: string;
  /** Live catalog unit price; 0 when the line cannot be priced right now. */
  price: number;
  /** Orderable right now: exists, is enabled, priced and within stock. */
  available: boolean;
  /** Max units the catalog currently allows for one cart line. */
  maxQuantity: number;
};

export type CatalogIndex = ReadonlyMap<string, CatalogEntry>;

const toNumber = (value: string | number | null | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function componentStatus(
  part: CatalogPromoItem,
  component: CatalogProductLike | undefined,
): { available: boolean; stock: number | null } {
  // The promotions API annotates each component with live availability and
  // stock; without annotations we fall back to the products list, where an
  // absent component is not sellable.
  const available =
    part.available !== undefined
      ? part.available !== false
      : component !== undefined &&
        component.available !== false &&
        !component.comingSoon &&
        component.stock !== 0;
  const stock = part.stock !== undefined ? part.stock : (component?.stock ?? null);
  return { available, stock };
}

/**
 * Normalizes the public catalog (products + promos) into a lookup keyed by
 * cartKey so cart lines can be reconciled against live price, availability and
 * stock. A promo is only orderable when every component can still be
 * fulfilled, matching the server's `priceCheckout` rules.
 */
export function buildCatalogIndex(catalog: PublicCatalog): CatalogIndex {
  const productsById = new Map(catalog.products.map((product) => [product.id, product]));
  const index = new Map<string, CatalogEntry>();

  for (const product of catalog.products) {
    const raw =
      product.isPromo && product.promoPrice != null ? product.promoPrice : product.price;
    const price = toNumber(raw);
    const maxQuantity =
      product.stock == null
        ? MAX_LINE_QUANTITY
        : Math.min(MAX_LINE_QUANTITY, Math.max(0, product.stock));
    index.set(cartKey("product", product.id), {
      name: product.name,
      price,
      available:
        product.available !== false &&
        !product.comingSoon &&
        product.stock !== 0 &&
        price > 0 &&
        maxQuantity > 0,
      maxQuantity,
    });
  }

  for (const promo of catalog.promos) {
    const price = toNumber(promo.customPrice);
    let available = promo.active !== false && price > 0;
    let maxQuantity = MAX_LINE_QUANTITY;
    for (const part of promo.items ?? []) {
      const status = componentStatus(part, productsById.get(part.productId));
      if (!status.available || !Number.isSafeInteger(part.quantity) || part.quantity <= 0) {
        available = false;
      }
      if (status.stock !== null && part.quantity > 0) {
        maxQuantity = Math.min(maxQuantity, Math.floor(status.stock / part.quantity));
      }
    }
    if (maxQuantity <= 0) available = false;
    index.set(cartKey("promo", promo.id), {
      name: promo.name,
      price,
      available,
      maxQuantity: Math.max(0, maxQuantity),
    });
  }

  return index;
}

export type ReconciledStatus = "ok" | "price_changed" | "out_of_range" | "unavailable";

export type ReconciledLine = {
  item: CartItem;
  /** Catalog entry the line resolved to; null while the catalog is unknown. */
  entry: CatalogEntry | null;
  status: ReconciledStatus;
  /** Line can go to /api/checkout right now. */
  orderable: boolean;
  /** Price to show and charge: live catalog price when orderable, else the stored snapshot. */
  effectivePrice: number;
};

/**
 * Reconciles the persisted cart against a catalog index. A null catalog keeps
 * every numeric line at its stored snapshot — a failed refresh must never mark
 * the whole cart unavailable and soft-lock the customer.
 */
export function reconcileCart(items: CartItem[], catalog: CatalogIndex | null) {
  const lines: ReconciledLine[] = items.map((item) => {
    const numericId = Number(item.product.id);
    const entry = catalog?.get(cartKey(item.type, item.product.id)) ?? null;
    let status: ReconciledStatus;
    // Checkout only accepts positive integer catalog ids — entries persisted
    // before real ids existed can never be submitted.
    if (!Number.isSafeInteger(numericId) || numericId <= 0) status = "unavailable";
    else if (catalog === null) status = "ok";
    else if (!entry || !entry.available) status = "unavailable";
    else if (item.quantity > entry.maxQuantity) status = "out_of_range";
    else status = entry.price !== item.product.price ? "price_changed" : "ok";
    return {
      item,
      entry,
      status,
      orderable: status === "ok" || status === "price_changed",
      effectivePrice: entry?.price ?? item.product.price,
    };
  });
  const orderable = lines.filter((line) => line.orderable);
  return {
    lines,
    orderable,
    /** Lines the customer must fix or remove before checking out. */
    hasBlocked: lines.some((line) => !line.orderable),
    /** At least one orderable line was re-priced against the stored snapshot. */
    pricesChanged: lines.some((line) => line.status === "price_changed"),
    /** Orderable total at catalog prices. */
    total: orderable.reduce(
      (sum, line) => sum + Math.round(line.effectivePrice * 100) * line.item.quantity,
      0,
    ) / 100,
    checkoutLines: orderable.map((line) => ({
      type: line.item.type,
      id: Number(line.item.product.id),
      quantity: line.item.quantity,
    })),
  };
}

/**
 * Signature of the cart exactly as the customer is reviewing it: line
 * identities, quantities and the prices on screen. Comparing it before and
 * after a catalog re-fetch tells checkout whether the cart being confirmed is
 * still the cart the customer saw.
 */
export function orderReviewSignature(items: CartItem[], catalog: CatalogIndex | null): string {
  return reconcileCart(items, catalog)
    .lines.map((line) =>
      line.orderable
        ? `${line.item.type}:${line.item.product.id}:${line.item.quantity}:${line.effectivePrice}`
        : `${line.item.type}:${line.item.product.id}:blocked`,
    )
    .sort()
    .join("|");
}

/**
 * Live public catalog used to reconcile the cart. Throws on transport or
 * payload problems so callers keep the last known catalog instead of marking
 * every line unavailable off a malformed response.
 */
export async function fetchPublicCatalog(
  fetcher: typeof fetch = fetch,
): Promise<PublicCatalog> {
  const [productsResponse, promosResponse] = await Promise.all([
    fetcher("/api/products?available=true"),
    fetcher("/api/promotions?active=true"),
  ]);
  if (!productsResponse.ok || !promosResponse.ok) {
    throw new Error("catalog fetch failed");
  }
  const [products, promos] = await Promise.all([
    productsResponse.json(),
    promosResponse.json(),
  ]);
  if (!Array.isArray(products) || !Array.isArray(promos)) {
    throw new Error("catalog payload invalid");
  }
  return {
    products: products as CatalogProductLike[],
    promos: promos as CatalogPromoLike[],
  };
}
