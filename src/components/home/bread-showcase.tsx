"use client";

import Image from "next/image";
import { motion } from "framer-motion";
import { fadeUp, staggerContainer, clipReveal } from "@/lib/animation-variants";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { reducedMotionVariant } from "@/lib/animation-variants";
import { WhatsAppCTA } from "@/components/attribution/whatsapp-cta";

const BREAD_FEATURES = [
  "Elaboración artesanal",
  "Materias primas seleccionadas",
  "Formatos para cada negocio",
];

export function BreadShowcase() {
  const prefersReduced = useReducedMotion();

  const containerVariants = prefersReduced
    ? reducedMotionVariant(staggerContainer)
    : staggerContainer;

  const itemVariants = prefersReduced
    ? reducedMotionVariant(fadeUp)
    : fadeUp;

  const imageVariants = prefersReduced
    ? reducedMotionVariant(clipReveal)
    : clipReveal;

  return (
    <section className="px-4 py-14 sm:py-20 bg-background relative">
      <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-10 items-center">
        {/* LEFT — Text */}
        <motion.div
          className="flex flex-col gap-6"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={containerVariants}
        >
          {/* Tag */}
          <motion.span
            variants={itemVariants}
            className="self-start text-xs font-semibold uppercase tracking-[0.3em] px-4 py-1.5 rounded-full border border-primary/40 text-primary bg-primary/[0.06]"
          >
            Elaboración Artesanal
          </motion.span>

          {/* Heading */}
          <motion.h2
            variants={itemVariants}
            className="text-4xl sm:text-5xl font-black leading-tight font-heading text-gold-gradient"
          >
            Al por Mayor
          </motion.h2>

          {/* Description */}
          <motion.p variants={itemVariants} className="text-foreground/65 leading-relaxed">
            Proveemos productos artesanales a comercios y negocios gastronómicos que no se conforman con lo mediocre. Elaboración propia, ingredientes frescos, entrega directa.
          </motion.p>

          {/* Features */}
          <motion.ul variants={containerVariants} className="flex flex-col gap-3">
            {BREAD_FEATURES.map((feature) => (
              <motion.li
                key={feature}
                variants={itemVariants}
                className="flex items-center gap-3 text-foreground/80"
              >
                <span className="w-2 h-2 rounded-full shrink-0 bg-primary" />
                {feature}
              </motion.li>
            ))}
          </motion.ul>

          {/* CTA */}
          <motion.div variants={itemVariants} className="mt-2">
            <WhatsAppCTA
              campaignSlug="mayorista-landing"
              message="Hola! Me interesa información sobre venta mayorista"
              label="Consultar Precios"
              className="btn-gold inline-flex items-center justify-center gap-2 px-8 py-4 text-sm font-bold uppercase tracking-widest"
            />
          </motion.div>
        </motion.div>

        {/* RIGHT — Images */}
        <motion.div
          className="grid grid-cols-2 gap-3 md:relative md:block md:h-[480px]"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          variants={containerVariants}
        >
          {/* Main image */}
          <motion.div
            variants={imageVariants}
            className="col-span-2 relative aspect-[4/3] md:absolute md:inset-x-0 md:top-0 md:max-h-[340px] rounded-2xl overflow-hidden border border-primary/30"
            whileHover={
              prefersReduced
                ? {}
                : {
                    scale: 1.02,
                    boxShadow: "0 0 24px rgba(212,160,23,0.25)",
                  }
            }
            transition={{ duration: 0.35, ease: "easeOut" }}
          >
            <Image
              src="/assets/images/pan-mayorista/097707a3-f17b-4399-a6d0-66f6457ee64a.jpg"
              alt="Productos artesanales en bandeja"
              fill
              className="object-cover"
              sizes="(max-width: 768px) 100vw, 50vw"
            />
          </motion.div>

          {/* Smaller image */}
          <motion.div
            variants={imageVariants}
            className="relative aspect-square md:absolute md:bottom-0 md:right-0 md:w-48 rounded-2xl overflow-hidden border border-primary/40"
            style={{
              zIndex: 10,
            }}
            whileHover={
              prefersReduced
                ? {}
                : {
                    scale: 1.05,
                    boxShadow: "0 0 20px rgba(212,160,23,0.35)",
                  }
            }
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <Image
              src="/assets/images/pan-mayorista/5ee3b05e-fb3b-4bbc-a17f-67ceaeb509eb.jpg"
              alt="Productos con semillas"
              fill
              className="object-cover"
              sizes="(max-width: 768px) 50vw, 192px"
            />
          </motion.div>

          {/* Small accent image */}
          <motion.div
            variants={imageVariants}
            className="relative aspect-[3/2] md:absolute md:bottom-8 md:left-0 md:w-36 rounded-2xl overflow-hidden border border-primary/35"
            style={{
              zIndex: 10,
            }}
            whileHover={
              prefersReduced
                ? {}
                : {
                    scale: 1.05,
                    boxShadow: "0 0 20px rgba(212,160,23,0.3)",
                  }
            }
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <Image
              src="/assets/images/pan-mayorista/4f61b737-04bf-42d9-b033-a958cd791f6a.jpg"
              alt="Productos alargados"
              fill
              className="object-cover"
              sizes="(max-width: 768px) 50vw, 144px"
            />
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
