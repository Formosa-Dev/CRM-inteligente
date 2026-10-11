"use client";

import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { CategorySection, type LandingCategory } from "./category-section";
import { PromosSection, type LandingPromo } from "./promos-section";
import type { LandingProduct } from "./landing-product-card";

type ApiProduct = {
  id: number;
  name: string;
  description: string | null;
  price: string | null;
  category: string;
  imageUrl: string | null;
  available: boolean;
  comingSoon: boolean;
  stock: number | null;
  sortOrder: number;
};

type ApiPromo = {
  id: number;
  name: string;
  description: string | null;
  imageUrl: string | null;
  customPrice: string | null;
  items: { productId: number; productName: string; quantity: number }[] | null;
};

/** Fixed display order + copy for each anchored category section. A section
 *  only renders when the real catalog actually has products in it. */
const CATEGORY_SECTIONS: LandingCategory[] = [
  {
    category: "hamburguesa",
    id: "hamburguesas",
    eyebrow: "Las clásicas",
    title: "Hamburguesas",
    highlight: "artesanales",
    description: "Carne, pollo y combinaciones con pan de elaboración propia.",
  },
  {
    category: "acompanamiento",
    id: "acompanantes",
    eyebrow: "Para completar",
    title: "Acompañamientos",
    description: "Papas y agregados para sumar a tu pedido.",
  },
  {
    category: "empanadas",
    id: "empanadas",
    eyebrow: "Recién salidas",
    title: "Empanadas",
    description: "Variedades para compartir.",
  },
  {
    category: "bebidas",
    id: "bebidas",
    eyebrow: "Para tomar",
    title: "Bebidas",
    description: "Gaseosas y opciones sin alcohol.",
  },
  {
    category: "pan_mayorista",
    id: "pan-mayorista",
    eyebrow: "Pan artesanal",
    title: "Pan mayorista",
    description: "Elaboración propia para restaurantes y negocios.",
  },
  {
    category: "tragos_vip",
    id: "tragos-vip",
    eyebrow: "V.I.P.",
    title: "Tragos",
    description: "Un litro de sabor para la previa.",
  },
  {
    category: "alcohol",
    id: "alcohol",
    eyebrow: "Con alcohol",
    title: "Alcohol",
    description: "Cervezas y opciones para adultos.",
  },
];

const MAX_PER_CATEGORY = 4;

const toNumber = (value: string | null) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function toLandingProduct(product: ApiProduct): LandingProduct {
  const price = toNumber(product.price);
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    price: price > 0 ? price : null,
    imageUrl: product.imageUrl,
    category: product.category,
    comingSoon: product.comingSoon,
    stock: product.stock ?? null,
  };
}

function toLandingPromo(promo: ApiPromo): LandingPromo {
  const price = toNumber(promo.customPrice);
  return {
    id: promo.id,
    name: promo.name,
    description: promo.description,
    imageUrl: promo.imageUrl,
    price: price > 0 ? price : null,
    items: promo.items ?? [],
  };
}

/**
 * Landing menu: pulls the real catalog (available products + active promos),
 * groups it into anchored, deep-linkable category sections, and lets the user
 * add any previewed product straight into the shared cart.
 */
export function LandingMenu() {
  const [products, setProducts] = useState<ApiProduct[] | null>(null);
  const [promos, setPromos] = useState<LandingPromo[]>([]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/products?available=true")
        .then((res) => (res.ok ? res.json() : []))
        .catch(() => []),
      fetch("/api/promotions?active=true")
        .then((res) => (res.ok ? res.json() : []))
        .catch(() => []),
    ]).then(([productData, promoData]) => {
      if (cancelled) return;
      setProducts(Array.isArray(productData) ? productData : []);
      setPromos(
        Array.isArray(promoData) ? (promoData as ApiPromo[]).map(toLandingPromo) : [],
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const presentCategories = useMemo(
    () => new Set((products ?? []).map((product) => product.category)),
    [products],
  );

  const orderedProducts = (category: string) =>
    (products ?? [])
      .filter((product) => product.category === category)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .slice(0, MAX_PER_CATEGORY)
      .map(toLandingProduct);

  const visibleCategories = CATEGORY_SECTIONS.filter((section) =>
    presentCategories.has(section.category),
  );
  const hasPromos = promos.length > 0;
  const loading = products === null;
  const empty = !loading && products.length === 0 && !hasPromos;

  const anchors = [
    ...(hasPromos ? [{ id: "promos", label: "Promos" }] : []),
    ...visibleCategories.map((section) => ({
      id: section.id,
      label: section.title,
    })),
  ];

  return (
    <div id="menu" className="scroll-mt-20 bg-background">
      <div className="mx-auto max-w-6xl px-4 pt-12 sm:pt-16">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
            Nuestra carta
          </span>
          <h2 className="font-heading text-3xl font-black leading-tight text-foreground sm:text-4xl">
            Todo lo que <em className="text-gold-gradient">hacemos</em>
          </h2>
          <p className="max-w-lg text-sm leading-relaxed text-foreground/55 sm:text-base">
            Elegí lo que te gusta y sumalo al pedido. Para ver la carta completa
            con todas las opciones, abrí la Carta Digital.
          </p>
        </div>

        {anchors.length > 1 && (
          <nav
            aria-label="Secciones de la carta"
            className="mt-8 flex snap-x gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {anchors.map((anchor) => (
              <a
                key={anchor.id}
                href={`#${anchor.id}`}
                className="shrink-0 snap-start rounded-full border border-border px-4 py-2 text-xs font-semibold text-foreground/70 transition-colors hover:border-primary/50 hover:text-primary"
              >
                {anchor.label}
              </a>
            ))}
          </nav>
        )}
      </div>

      {loading && (
        <div className="mx-auto max-w-6xl px-4 py-12 sm:py-16">
          <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="overflow-hidden rounded-2xl border border-border bg-card"
              >
                <Skeleton variant="shimmer" className="aspect-square w-full rounded-none" />
                <div className="space-y-2 p-4">
                  <Skeleton variant="shimmer" className="h-4 w-2/3" />
                  <Skeleton variant="shimmer" className="h-3 w-full" />
                  <Skeleton variant="shimmer" className="h-8 w-24" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {empty && (
        <div className="mx-auto max-w-6xl px-4 py-12 text-center sm:py-16">
          <p className="text-foreground/55">
            Estamos actualizando la carta. Mientras tanto, podés verla completa.
          </p>
          <a
            href="/carta-digital"
            className="btn-gold mt-4 inline-flex items-center px-6 py-3 text-sm font-bold uppercase tracking-widest"
          >
            Abrir Carta Digital
          </a>
        </div>
      )}

      {!loading && (
        <>
          <PromosSection promos={promos} />
          {visibleCategories.map((section) => (
            <CategorySection
              key={section.category}
              {...section}
              products={orderedProducts(section.category)}
            />
          ))}
        </>
      )}
    </div>
  );
}
