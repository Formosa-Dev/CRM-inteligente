"use client";

import Link from "next/link";
import { useMemo } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Plus } from "lucide-react";
import { CatalogImage } from "@/components/products/catalog-image";
import { staggerContainer } from "@/lib/animation-variants";
import { useEditorialMotion } from "@/components/storefront/motion";
import { cartKey, useCart } from "@/lib/cart/cart-context";
import { buildCatalogIndex } from "@/lib/cart/catalog";

export type LandingPromo = {
  id: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  price: number | null;
  items: {
    productId: number;
    productName: string;
    quantity: number;
    /** Live annotations from /api/promotions. */
    available?: boolean;
    stock?: number | null;
  }[];
};

/**
 * Promotions surfaced from the real promotions table. Each active promo is
 * orderable straight into the shared cart (same cart as products); the link
 * into /carta-digital remains as a secondary path.
 */
export function PromosSection({ promos }: { promos: LandingPromo[] }) {
  const { reveal } = useEditorialMotion();
  const { addItem, items: cartItems } = useCart();
  // Component availability/stock comes annotated on each item; the index turns
  // it into a single orderable flag + max quantity per promo.
  const catalogIndex = useMemo(
    () =>
      buildCatalogIndex({
        products: [],
        promos: promos.map((promo) => ({
          id: promo.id,
          name: promo.name,
          customPrice: promo.price,
          active: true,
          items: promo.items,
        })),
      }),
    [promos],
  );
  if (promos.length === 0) return null;

  const entryOf = (promo: LandingPromo) => catalogIndex.get(cartKey("promo", promo.id));
  const inCart = (promo: LandingPromo) =>
    cartItems.find((line) => line.type === "promo" && line.product.id === String(promo.id))
      ?.quantity ?? 0;

  function addPromo(promo: LandingPromo) {
    const entry = entryOf(promo);
    if (!entry?.available || inCart(promo) >= entry.maxQuantity) return;
    addItem(
      { id: String(promo.id), name: promo.name.trim(), price: promo.price ?? 0 },
      1,
      { type: "promo", imageUrl: promo.imageUrl },
    );
  }

  return (
    <section
      id="promos"
      className="scroll-mt-24 border-t border-border/60 px-4 py-12 sm:py-16"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
          <div>
            <span className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
              Aprovechá
            </span>
            <h2 className="mt-2 font-heading text-2xl font-black leading-tight text-foreground sm:text-3xl">
              Promos <em className="text-gold-gradient">para compartir</em>
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground/55">
              Combos pensados para reuniones, cumpleaños y eventos.
            </p>
          </div>

          <Link
            href="/carta-digital?category=promos"
            className="btn-outline-gold inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest"
          >
            Ver más
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>

        <motion.div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5"
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
        >
          {promos.map((promo) => {
            const entry = entryOf(promo);
            const canOrder = !!entry?.available;
            const atMax = canOrder && inCart(promo) >= (entry?.maxQuantity ?? 0);
            return (
            <motion.article
              key={promo.id}
              variants={reveal}
              className="card-gold-glow flex flex-col overflow-hidden rounded-2xl border border-border bg-card sm:flex-row"
            >
              <Link
                href="/carta-digital?category=promos"
                aria-label={`Ver ${promo.name} en la carta`}
                className="relative block aspect-[4/3] overflow-hidden bg-muted/30 sm:aspect-auto sm:w-2/5 sm:shrink-0"
              >
                <CatalogImage
                  src={promo.imageUrl}
                  alt={promo.name}
                  sizes="(max-width: 640px) 90vw, 30vw"
                />
              </Link>

              <div className="flex flex-1 flex-col gap-2 p-4">
                <h3 className="font-heading text-lg font-bold leading-tight text-foreground">
                  {promo.name}
                </h3>
                {promo.description && (
                  <p className="text-xs leading-relaxed text-foreground/55 sm:text-sm">
                    {promo.description}
                  </p>
                )}
                {promo.items.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-foreground/45">
                    {promo.items.map((item) => (
                      <li key={`${promo.id}-${item.productId}`}>
                        <span className="tabular-nums text-foreground/70">
                          {item.quantity}×
                        </span>{" "}
                        {item.productName}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-auto flex items-center justify-between gap-2 border-t border-border/60 pt-3">
                  <strong className="font-heading text-lg font-bold tabular-nums text-primary">
                    {promo.price && promo.price > 0
                      ? `$${promo.price.toLocaleString("es-AR")}`
                      : "Consultar"}
                  </strong>
                  {promo.price && promo.price > 0 ? (
                    canOrder ? (
                      <button
                        type="button"
                        onClick={() => addPromo(promo)}
                        disabled={atMax}
                        aria-label={
                          atMax
                            ? `${promo.name} ya está en tu pedido`
                            : `Agregar ${promo.name}`
                        }
                        className="btn-gold inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <Plus size={14} aria-hidden="true" />
                        {atMax ? "En tu pedido" : "Agregar"}
                      </button>
                    ) : (
                      <span className="text-right text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        No disponible
                      </span>
                    )
                  ) : (
                    <Link
                      href="/carta-digital?category=promos"
                      className="btn-gold inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-bold uppercase tracking-wider"
                    >
                      Ver en la carta
                      <ArrowRight size={13} aria-hidden="true" />
                    </Link>
                  )}
                </div>
              </div>
            </motion.article>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
