"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { staggerContainer } from "@/lib/animation-variants";
import { LandingProductCard, type LandingProduct } from "./landing-product-card";

export type LandingCategory = {
  /** Catalog category key used for the /carta-digital deep link. */
  category: string;
  /** Anchor id for on-page navigation. */
  id: string;
  eyebrow: string;
  title: string;
  highlight?: string;
  description?: string;
};

type CategorySectionProps = LandingCategory & {
  products: LandingProduct[];
};

/**
 * One anchored landing section for a catalog category. Shows up to the four
 * principal products and deep-links to that category inside /carta-digital.
 */
export function CategorySection({
  id,
  category,
  eyebrow,
  title,
  highlight,
  description,
  products,
}: CategorySectionProps) {
  if (products.length === 0) return null;

  return (
    <section
      id={id}
      className="scroll-mt-24 border-t border-border/60 px-4 py-12 sm:py-16"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 sm:mb-8">
          <div>
            <span className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
              {eyebrow}
            </span>
            <h2 className="mt-2 font-heading text-2xl font-black leading-tight text-foreground sm:text-3xl">
              {title}
              {highlight && (
                <>
                  {" "}
                  <em className="text-gold-gradient">{highlight}</em>
                </>
              )}
            </h2>
            {description && (
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-foreground/55">
                {description}
              </p>
            )}
          </div>

          <Link
            href={`/carta-digital?category=${category}`}
            className="btn-outline-gold inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold uppercase tracking-widest"
          >
            Ver más
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>

        <motion.div
          className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4"
          variants={staggerContainer}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
        >
          {products.map((product) => (
            <LandingProductCard
              key={product.id}
              product={product}
              categoryKey={category}
            />
          ))}
        </motion.div>
      </div>
    </section>
  );
}
