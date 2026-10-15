"use client";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowLeft, Plus, ArrowUpRight } from "lucide-react";
import { CatalogImage } from "./catalog-image";
import { getCatalogProductImage } from "@/lib/catalog-images";
import { useEditorialMotion, EditorialHeading } from "@/components/storefront/motion";
import { useBusiness } from "@/lib/hooks/use-business";

type ProductFromAPI = { id: number; name: string; description: string | null; price: string | null; promoPrice?: string | null; isPromo?: boolean; stock?: number | null; category: string; imageUrl: string | null; available: boolean; comingSoon: boolean; sortOrder: number; ingredients?: string | null; hasFreeShipping?: boolean };
export function ProductDetail({ product, onAddToCart }: { product: ProductFromAPI; onAddToCart?: (product: ProductFromAPI) => void }) {
  const { reveal } = useEditorialMotion();
  const business = useBusiness();
  const price = Number(product.isPromo && product.promoPrice != null ? product.promoPrice : product.price);
  const canOrder = product.available && !product.comingSoon && product.stock !== 0 && price > 0 && Number.isFinite(price);
  return <div className="max-w-6xl mx-auto">
    <Link href={product.category === "pan_mayorista" ? "/pan-mayorista" : `/carta-digital?category=${product.category}`} className="inline-flex items-center gap-3 text-xs text-stone-400 hover:text-stone-100 mb-8"><ArrowLeft size={16} /> Volver al catálogo</Link>
    <motion.div className="public-detail" variants={reveal} initial="hidden" animate="visible">
      <div className="public-detail-photo"><CatalogImage src={getCatalogProductImage(product)} alt={product.name} contain eager sizes="(max-width: 760px) 100vw, 50vw" /></div>
      <div><p className="menu-eyebrow">{business?.name || "La carta"} / Cocina propia</p><h1><EditorialHeading>{product.name}</EditorialHeading></h1>
        <p className="text-stone-400 leading-loose text-sm">{product.description || product.ingredients}</p>
        <div className="menu-detail-footer mt-8"><strong>{price > 0 && Number.isFinite(price) ? `$${price.toLocaleString("es-AR")}` : "Precio a consultar"}</strong>
          {canOrder && onAddToCart ? <button className="menu-add-button" onClick={() => onAddToCart({ ...product, price: String(price) })}><Plus size={16} /> Agregar al pedido</button> : <span className="menu-unavailable">{product.comingSoon ? "Próximamente" : product.stock === 0 ? "Sin stock" : !product.available ? "No disponible" : ""}</span>}
        </div>
        <p className="text-xs text-stone-500 mt-5">{product.hasFreeShipping ? "Envío gratis" : "Entrega o retiro y pago a coordinar por WhatsApp."}</p>
        <Link href="/carta-digital" className="menu-text-link">Ver la carta completa <ArrowUpRight size={17} /></Link>
      </div>
    </motion.div>
  </div>;
}
export default ProductDetail;
