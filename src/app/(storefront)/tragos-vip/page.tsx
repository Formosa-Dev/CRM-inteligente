"use client";
import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import Link from "next/link";
import { ArrowUpRight, Plus } from "lucide-react";
import { CatalogImage } from "@/components/products/catalog-image";
import { EditorialHeading, useEditorialMotion } from "@/components/storefront/motion";
import { getCatalogProductImage } from "@/lib/catalog-images";
import { useCart } from "@/lib/cart/cart-context";
import { useBusiness } from "@/lib/hooks/use-business";

type Product = { id: number; name: string; description: string | null; price: string | null; isPromo?: boolean; promoPrice?: string | null; stock?: number | null; imageUrl: string | null; comingSoon: boolean; variants?: { name: string; priceDelta: number; default?: boolean }[] };
export default function TragosVIPPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const { addItem } = useCart();
  const business = useBusiness();
  const { reveal, reduced } = useEditorialMotion();
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/products?available=true&category=tragos_vip", { signal: controller.signal }).then(response => {
      if (!response.ok) throw new Error("catalog"); return response.json();
    }).then(setProducts).catch(cause => { if (cause.name !== "AbortError") setError(true); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  return <div className="digital-menu px-5 sm:px-10 pt-32">
    <header className="max-w-6xl mx-auto border-b border-[var(--menu-border)] pb-14 sm:pb-20">
      <p className="menu-eyebrow">{business?.name || "La carta"} / La noche</p>
      <h1 className="text-5xl sm:text-8xl tracking-[-.06em] font-normal my-7" style={{ fontFamily: "var(--font-playfair), Georgia, serif" }}><EditorialHeading>La noche,</EditorialHeading><EditorialHeading><em className="text-[#d7c198]">a tu gusto.</em></EditorialHeading></h1>
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-6"><p className="text-sm text-stone-400 max-w-sm leading-loose">Descubrí nuestra selección de tragos. Elegí tu favorito y sumalo al pedido.</p><Link href="/carta-digital" className="menu-text-link">Explorá la carta completa <ArrowUpRight size={18} /></Link></div>
    </header>
    <section className="max-w-6xl mx-auto pt-12" aria-label="Tragos V.I.P.">
      {error ? <p role="alert" className="menu-empty">No pudimos cargar los tragos. <button onClick={() => window.location.reload()} className="menu-add-button">Reintentar</button></p> : loading ? <div className="grid sm:grid-cols-3 gap-8" role="status" aria-label="Cargando tragos">{[0,1,2].map(i => <div key={i} className="aspect-[3/4] menu-shimmer" />)}</div> : !products.length ? <p className="menu-empty">Pronto, nuevas opciones para tu noche.</p> : <motion.div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-12" initial="hidden" animate="visible" variants={{ visible: { transition: { staggerChildren: reduced ? 0 : .07 } } }}>
        {products.map(product => {
          const price = Number(product.isPromo && product.promoPrice != null ? product.promoPrice : product.price);
          return <motion.article key={product.id} variants={reveal} className="public-product-card">
            <div className="relative aspect-[4/5] overflow-hidden"><CatalogImage src={getCatalogProductImage(product)} alt={product.name} contain sizes="(max-width:640px) 100vw, 33vw" /></div>
            <div className="menu-item-body"><div><h3>{product.name}</h3><p>{product.description}</p></div>
              {product.variants?.length ? <p className="menu-includes">{product.variants.map(v => `${v.name}${v.priceDelta > 0 ? ` (+$${v.priceDelta.toLocaleString("es-AR")})` : ""}`).join(" · ")}. Variantes a coordinar por WhatsApp.</p> : null}
              <div className="menu-item-action"><strong>{price > 0 ? `$${price.toLocaleString("es-AR")}` : "Consultar"}</strong>{price > 0 && !product.comingSoon && product.stock !== 0 && <button className="menu-add-button" onClick={() => addItem({ id: String(product.id), name: product.name, price, emoji: "🍸" }, 1, { type: "product", imageUrl: getCatalogProductImage(product) })}><Plus size={16} />Agregar</button>}</div>
            </div>
          </motion.article>;
        })}
      </motion.div>}
    </section>
  </div>;
}
