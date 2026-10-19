"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowUpRight, Plus } from "lucide-react";
import { CatalogImage } from "@/components/products/catalog-image";
import { getCatalogProductImage } from "@/lib/catalog-images";
import { useCart } from "@/lib/cart/cart-context";
import { useEditorialMotion } from "@/components/storefront/motion";

export type LandingProduct = {
  id: number;
  name: string;
  description: string | null;
  price: number | null;
  imageUrl: string | null;
  category: string;
  comingSoon: boolean;
  stock: number | null;
};

const CATEGORY_EMOJI: Record<string, string> = {
  hamburguesa: "🍔",
  acompanamiento: "🍟",
  empanadas: "🥟",
  bebidas: "🥤",
  pan_mayorista: "🍞",
  tragos_vip: "🍹",
  alcohol: "🍺",
};

/**
 * Compact product tile for the landing. Preview + add-to-cart share the
 * existing shared cart (CartProvider). "Ver más" journeys live in the
 * category section header that renders these.
 */
export function LandingProductCard({
  product,
  categoryKey,
}: {
  product: LandingProduct;
  categoryKey: string;
}) {
  const { addItem, items: cartItems } = useCart();
  const { reveal } = useEditorialMotion();
  const href = `/carta-digital?category=${categoryKey}`;
  const price = product.price;
  const canOrder =
    !product.comingSoon && price !== null && price > 0 && product.stock !== 0;
  // stock === null means unlimited; otherwise the cart can never hold more
  // units than the catalog can fulfill (checkout's 99 per-line cap applies too).
  const maxQuantity =
    product.stock == null ? 99 : Math.min(99, Math.max(0, product.stock));
  const inCart =
    cartItems.find(
      (line) => line.type === "product" && line.product.id === String(product.id),
    )?.quantity ?? 0;
  const atMax = canOrder && inCart >= maxQuantity;

  function handleAdd() {
    if (price === null || price <= 0 || atMax) return;
    addItem(
      {
        id: String(product.id),
        name: product.name,
        price,
        emoji: CATEGORY_EMOJI[product.category] ?? "🛒",
      },
      1,
      { type: "product", imageUrl: getCatalogProductImage(product) },
    );
  }

  return (
    <motion.article
      variants={reveal}
      className="card-gold-glow group flex flex-col overflow-hidden rounded-2xl border border-border bg-card"
    >
      <Link
        href={href}
        aria-label={`Ver ${product.name} en la carta`}
        className="relative block aspect-square overflow-hidden bg-muted/30"
      >
        <CatalogImage
          src={getCatalogProductImage(product)}
          alt={product.name}
          sizes="(max-width: 640px) 45vw, (max-width: 1024px) 33vw, 25vw"
        />
        <span className="pointer-events-none absolute bottom-2 right-2 grid h-8 w-8 place-items-center rounded-full border border-border bg-background/70 text-foreground opacity-0 backdrop-blur-sm transition-opacity duration-300 group-hover:opacity-100">
          <ArrowUpRight size={16} aria-hidden="true" />
        </span>
      </Link>

      <div className="flex flex-1 flex-col gap-2 p-3 sm:p-4">
        <div className="flex-1">
          <h3 className="font-heading text-base font-bold leading-tight text-foreground sm:text-lg">
            {product.name}
          </h3>
          {product.description && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-foreground/55 sm:text-sm">
              {product.description}
            </p>
          )}
        </div>

        <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/60 pt-3">
          <strong className="font-heading text-base font-bold tabular-nums text-primary sm:text-lg">
            {price && price > 0 ? `$${price.toLocaleString("es-AR")}` : "Consultar"}
          </strong>

          {canOrder ? (
            <button
              type="button"
              onClick={handleAdd}
              disabled={atMax}
              className="btn-gold inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus size={14} aria-hidden="true" />
              {atMax ? "En tu pedido" : "Agregar"}
            </button>
          ) : (
            <span className="text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {product.comingSoon
                ? "Próximamente"
                : product.stock === 0
                  ? "Sin stock"
                  : "Consultar"}
            </span>
          )}
        </div>
      </div>
    </motion.article>
  );
}
