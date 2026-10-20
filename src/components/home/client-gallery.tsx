"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { staggerContainer, clipReveal, blurIn } from "@/lib/animation-variants";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { reducedMotionVariant } from "@/lib/animation-variants";
import { useBusiness } from "@/lib/hooks/use-business";

const PHOTOS = [
  {
    src: "/assets/images/clientes/0e8b8f68-b346-4eba-9425-dd8aeb190717.jpg",
    alt: "Productos vista desde arriba",
  },
  {
    src: "/assets/images/clientes/141af1da-1d38-47a3-ab71-9ce2590ec6ee.jpg",
    alt: "Producto destacado",
  },
  {
    src: "/assets/images/clientes/5dd2b730-fe87-4ccf-abe5-67b1b06900c8.jpg",
    alt: "Productos y bebidas",
  },
  {
    src: "/assets/images/clientes/779de895-c46b-448a-83db-ecf9479af136.jpg",
    alt: "Foto de cliente",
  },
  {
    src: "/assets/images/clientes/96af04d8-a13d-46dc-92d0-566cb964d641.jpg",
    alt: "Foto de cliente",
  },
  {
    src: "/assets/images/clientes/ea162775-7a2f-48ac-bdda-183092939f89.jpg",
    alt: "Foto de cliente",
  },
];

export function ClientGallery() {
  const prefersReduced = useReducedMotion();
  const business = useBusiness();
  const instagram = business?.instagram || "";

  const containerVariants = prefersReduced
    ? reducedMotionVariant(staggerContainer)
    : staggerContainer;

  const itemVariants = prefersReduced
    ? reducedMotionVariant(clipReveal)
    : clipReveal;

  const headingVariants = prefersReduced
    ? reducedMotionVariant(blurIn)
    : blurIn;

  return (
    <section className="px-4 py-14 sm:py-20 bg-background relative">
      <div className="max-w-7xl mx-auto">
        {/* Heading */}
        <motion.div
          className="text-center mb-10"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={containerVariants}
        >
          <motion.h2
            variants={headingVariants}
            className="text-4xl sm:text-5xl font-black leading-tight mb-4 font-heading text-gold-gradient"
          >
            Nuestros Clientes Disfrutan
          </motion.h2>
          <motion.p
            variants={headingVariants}
            className="text-foreground/60 text-lg font-light"
          >
            Lo que dicen en Instagram
          </motion.p>
        </motion.div>

        {/* Grid */}
        <motion.div
          className="grid grid-cols-2 md:grid-cols-3 gap-4"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          variants={containerVariants}
        >
          {PHOTOS.map((photo) => (
            <motion.div
              key={photo.src}
              variants={itemVariants}
              className="relative aspect-square md:aspect-[3/4] rounded-2xl overflow-hidden group border border-primary/20"
              whileHover={
                prefersReduced
                  ? {}
                  : {
                      scale: 1.05,
                      boxShadow: "0 0 20px rgba(212,160,23,0.3)",
                      borderColor: "rgba(212,160,23,0.6)",
                    }
              }
              transition={{ duration: 0.3, ease: "easeOut" }}
            >
              <Image
                src={photo.src}
                alt={photo.alt}
                fill
                className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                sizes="(max-width: 768px) 50vw, 33vw"
              />

              {/* Bottom gradient overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent pointer-events-none" />

              {/* Instagram tag */}
              {instagram ? (
                <span className="absolute bottom-3 left-3 text-xs text-foreground/70 font-medium select-none">
                  @{instagram.replace(/^@/, "")}
                </span>
              ) : null}
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
