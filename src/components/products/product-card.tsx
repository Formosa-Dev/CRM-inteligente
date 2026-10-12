"use client";
import type { Product } from "@/lib/constants";
import { getCatalogProductImage } from "@/lib/catalog-images";
import { CatalogImage } from "./catalog-image";
import Link from "next/link";
import { motion } from "framer-motion";
import { Plus, ArrowUpRight } from "lucide-react";
import { useCart } from "@/lib/cart/cart-context";
import { useEditorialMotion } from "@/components/storefront/motion";

export function ProductCard({ product }: { product: Product; index?: number }) {
  const { addItem } = useCart();
  const { reveal } = useEditorialMotion();
  const canOrder = !product.comingSoon && product.price !== null && product.price > 0 && product.stock !== 0;
  return <motion.article variants={reveal} className="product-card bg-card border border-border rounded-xl overflow-hidden flex flex-col">
    <Link href={`/hamburguesas/${product.id}`} className="menu-item-preview" aria-label={`Ver ${product.name}`}>
      <CatalogImage src={getCatalogProductImage(product)} alt={product.name} sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw" />
      <span className="menu-preview-arrow"><ArrowUpRight size={20} /></span>
    </Link>
    <div className="menu-item-body">
      <div><h3><Link href={`/hamburguesas/${product.id}`}>{product.name}</Link></h3><p>{product.ingredients}</p></div>
      {product.comingSoon && <span className="menu-unavailable">Próximamente</span>}
      {product.stock === 0 && <span className="menu-unavailable">Sin stock</span>}
      <div className="menu-item-action">
        <div>{product.originalPrice && product.originalPrice > (product.price ?? Infinity) ? <del className="block text-xs text-foreground/40">${product.originalPrice.toLocaleString("es-AR")}</del> : null}<strong>{product.price && product.price > 0 ? `$${product.price.toLocaleString("es-AR")}` : "Consultar"}</strong></div>
        {canOrder && <button type="button" className="menu-add-button" onClick={() => addItem({ id: product.id, name: product.name, price: product.price!, emoji: product.emoji }, 1, { type: "product", imageUrl: getCatalogProductImage(product) })}><Plus size={16} />Agregar</button>}
      </div>
    </div>
  </motion.article>;
}
export default ProductCard;
