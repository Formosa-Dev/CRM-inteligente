"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { ProductGrid } from "@/components/products/product-grid";
import { LINEA_CARNE } from "@/lib/constants";
import { fadeUp } from "@/lib/animation-variants";

type ProductFromAPI = {
  id: number;
  name: string;
  description: string | null;
  price: string | null;
  category: string;

  imageUrl: string | null;
  available: boolean;
  comingSoon: boolean;
  sortOrder: number;
};

export function FeaturedProductsSection() {
  const [products, setProducts] = useState<ProductFromAPI[]>([]);
  const [, setLoading] = useState(true);
  const [, setError] = useState(false);

  useEffect(() => {
    async function fetchProducts() {
      try {
        const res = await fetch("/api/products?available=true");
        if (!res.ok) throw new Error("API error");
        const data = await res.json();
        setProducts(data);
      } catch (err) {
        console.warn("[FeaturedProductsSection] API unavailable, using fallback", err);
        setError(true);
        // Fallback to constants
        const mapped = LINEA_CARNE.map((p, i) => ({
          id: i,
          name: p.name,
          description: p.ingredients,
          price: p.price ? `$${p.price}` : null,
          category: "hamburguesa",

          imageUrl: null,
          available: !p.comingSoon,
          comingSoon: p.comingSoon || false,
          sortOrder: i,
        }));
        setProducts(mapped);
      } finally {
        setLoading(false);
      }
    }
    fetchProducts();
  }, []);

  // Admin is the source of truth: featured only ever shows burgers.
  const burgers = products.filter((p) => p.category === "hamburguesa");

  return (
    <section className="py-14 sm:py-24 px-4 bg-background relative">
      <div className="max-w-7xl mx-auto">
        <motion.div
          className="flex flex-col items-center text-center gap-4 mb-8 sm:mb-12"
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
        >
          <span className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
            Productos Destacados
          </span>
          <h2 className="text-3xl sm:text-4xl font-black leading-tight font-heading text-gold-gradient">
            Nuestras Favoritas
          </h2>
          <p className="text-foreground/60 max-w-lg leading-relaxed">
            Las hamburguesas que el ama de casa (nuestra mejor jueza) recomienda.
          </p>
        </motion.div>

        <ProductGrid products={burgers} />
      </div>
    </section>
  );
}
