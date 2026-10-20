"use client";

import { motion } from "framer-motion";
import { ChevronRight, Smartphone } from "lucide-react";
import Link from "next/link";
import { GlassPanel } from "@/components/ui/glass-panel";
import { AnimatedStatCard } from "@/components/ui/animated-stat-card";
import { fadeUp } from "@/lib/animation-variants";
import { LandingHero } from "@/components/home/landing-hero";
import { LandingMenu } from "@/components/home/landing-menu";
import { ClientGallery } from "@/components/home/client-gallery";
import { BreadShowcase } from "@/components/home/bread-showcase";
import { DeliveryCTA } from "@/components/home/delivery-cta";
import { Marquee } from "@/components/motion/marquee";
import { useBusiness } from "@/lib/hooks/use-business";

const MARQUEE_ITEMS = [
  "Productos artesanales",
  "Elaboración propia",
  "Ingredientes frescos",
  "Hecho al momento",
  "Envío a domicilio",
];

const STATS = [
  { value: "100%", label: "Ingredientes frescos" },
  { value: "6+", label: "Variedades de producto" },
  { value: "Propia", label: "Elaboración artesanal" },
  { value: "♥", label: "Hecho con amor" },
];

export default function HomePage() {
  const business = useBusiness();
  const marqueeItems = business?.tagline
    ? [...MARQUEE_ITEMS, business.tagline]
    : MARQUEE_ITEMS;

  return (
    <>
      <div className="paint-veil" aria-hidden="true" />
      <LandingHero />

      <Marquee items={marqueeItems} />

      {/* One scrollable menu: real catalog grouped into anchored sections. */}
      <LandingMenu />

      <section className="relative overflow-hidden bg-background px-4 py-14 sm:py-20">
        <div
          className="orb-glow orb-1"
          style={{
            width: "450px",
            height: "450px",
            background: "radial-gradient(circle, rgba(212,160,23,0.08), transparent 70%)",
            top: "-10%",
            right: "-5%",
          }}
        />
        <div
          className="orb-glow orb-2"
          style={{
            width: "350px",
            height: "350px",
            background: "radial-gradient(circle, rgba(232,113,42,0.06), transparent 70%)",
            bottom: "-15%",
            left: "-5%",
          }}
        />
        <div className="relative z-10 mx-auto max-w-5xl">
          <GlassPanel>
            <div className="grid grid-cols-1 items-center gap-10 md:grid-cols-2">
              <motion.div
                className="flex flex-col gap-5"
                variants={fadeUp}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
              >
                <span className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
                  Sobre Nosotros
                </span>
                <h2 className="font-heading text-3xl font-black leading-tight text-foreground sm:text-4xl">
                  Más que una <em className="marker-gold">hamburguesa</em>
                </h2>
                <p className="leading-relaxed text-foreground/65">
                  {business?.description ||
                    `En ${business?.name ?? "nuestro negocio"} creemos que cada ingrediente importa. Trabajamos con productores locales, elaboramos nuestros propios productos y preparamos cada pedido al momento. Sin compromiso. Sin atajos.`}
                </p>
                <p className="leading-relaxed text-foreground/65">
                  También proveemos productos artesanales a comercios y cocinas que, como nosotros, no se conforman con lo mediocre.
                </p>
                <div className="mt-2 flex flex-wrap gap-4">
                  <Link
                    href="/carta-digital"
                    className="btn-gold shine-sweep inline-flex items-center justify-center px-6 py-3 text-sm font-bold uppercase tracking-widest"
                  >
                    Ver la carta
                  </Link>
                  <a
                    href="#menu"
                    className="btn-outline-gold shine-sweep inline-flex items-center justify-center px-6 py-3 text-sm uppercase tracking-widest"
                  >
                    Explorar el menú
                  </a>
                </div>
              </motion.div>

              <div className="grid grid-cols-2 gap-4">
                {STATS.map((stat) => (
                  <AnimatedStatCard key={stat.label} value={stat.value} label={stat.label} />
                ))}
              </div>
            </div>
          </GlassPanel>
        </div>
      </section>

      <section className="bg-background px-4 py-12 sm:py-16">
        <div className="mx-auto max-w-2xl text-center">
          <span className="mx-auto mb-6 block h-px w-24 bg-gradient-to-br from-gold via-gold-bright to-gold-ember" />
          <p className="font-heading text-xl font-black leading-snug text-foreground sm:text-2xl">
            &quot;Cada pedido cuenta una historia.{" "}
            <span className="text-primary">
              La <em>nuestra</em> empieza con ingredientes reales.&quot;
            </span>
          </p>
        </div>
      </section>

      <ClientGallery />
      <BreadShowcase />

      {/* Single dedicated full-catalog CTA route. */}
      <section className="relative overflow-hidden bg-background px-4 py-14 sm:py-20">
        <div
          className="orb-glow orb-1"
          style={{
            width: "400px",
            height: "400px",
            background: "radial-gradient(circle, rgba(212,160,23,0.07), transparent 70%)",
            top: "-20%",
            left: "10%",
          }}
        />
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <motion.div
            className="flex flex-col items-center gap-4"
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            <h2 className="font-heading text-2xl font-black text-gold-gradient sm:text-3xl">
              Carta <em>Digital</em>
            </h2>
            <p className="max-w-md leading-relaxed text-foreground/60">
              Deslizá todos nuestros productos, armá tu pedido y enviá directo por WhatsApp. Rápido y sin vueltas.
            </p>
            <a href="/carta-digital" className="cta-card w-full max-w-md text-left">
              <span className="cta-card-icon">
                <Smartphone size={20} aria-hidden="true" />
              </span>
              <span className="flex-1">
                <span className="block text-[17px] font-bold leading-tight">
                  Abrir Carta Digital
                </span>
                <span className="block text-xs opacity-70">Pedí directo por WhatsApp</span>
              </span>
              <span className="cta-card-chevron">
                <ChevronRight size={20} aria-hidden="true" />
              </span>
            </a>
          </motion.div>
        </div>
      </section>

      <DeliveryCTA />
    </>
  );
}
