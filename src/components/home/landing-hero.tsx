"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { HeroParallax } from "@/components/hero/hero-parallax";
import { heroEntrance, heroChild } from "@/lib/animation-variants";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { TextReveal } from "@/components/motion/text-reveal";
import { Magnetic } from "@/components/motion/magnetic";
import { useBusiness } from "@/lib/hooks/use-business";

/**
 * Landing hero. Primary CTA opens the full Carta Digital (the single
 * full-catalog journey); the secondary CTA scrolls into the anchored menu
 * sections below instead of sending users to a legacy route.
 */
export function LandingHero() {
  const prefersReduced = useReducedMotion();
  const business = useBusiness();
  const heroText = (business?.name || "Mi Negocio").replace(" ", "\n");

  return (
    <HeroParallax>
      <motion.div
        className="flex flex-col items-center gap-6"
        variants={heroEntrance}
        initial="hidden"
        animate="visible"
      >
        <motion.span
          variants={heroChild}
          className="inline-block rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.3em] text-primary"
        >
          Productos Artesanales Premium
        </motion.span>

        <TextReveal
          as="h1"
          text={heroText}
          delay={0.35}
          stagger={0.14}
          className="font-heading text-5xl font-black leading-none tracking-tight sm:text-6xl md:text-8xl"
          emLines={[heroText.split("\n").length - 1]}
          wordStyle={{
            background:
              "linear-gradient(135deg, var(--color-gold) 0%, var(--color-gold-bright) 50%, var(--color-gold-ember) 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            backgroundClip: "text",
          }}
        />

        <motion.p
          variants={heroChild}
          className="max-w-xl text-lg font-light leading-relaxed text-foreground/70 sm:text-xl"
        >
          {business?.tagline ||
            "Sabores únicos, ingredientes de primera. Cada pedido es una experiencia que no vas a olvidar."}
        </motion.p>

        <motion.div
          variants={heroChild}
          className="mt-4 flex flex-col gap-4 sm:flex-row"
        >
          <Magnetic>
            <Link
              href="/carta-digital"
              className="btn-gold shine-sweep inline-flex items-center justify-center px-8 py-4 text-sm font-bold uppercase tracking-widest"
            >
              Ver la carta
            </Link>
          </Magnetic>
          <Magnetic>
            <a
              href="#menu"
              className="btn-outline-gold shine-sweep inline-flex items-center justify-center px-8 py-4 text-sm uppercase tracking-widest"
            >
              Explorar el menú
            </a>
          </Magnetic>
        </motion.div>

        <motion.div
          variants={heroChild}
          className="mt-12 flex flex-col items-center gap-2 opacity-40"
        >
          <span className="text-xs uppercase tracking-widest text-foreground/60">
            Scroll
          </span>
          <motion.div
            className="h-8 w-px rounded-full bg-gradient-to-b from-primary/60 to-transparent"
            animate={prefersReduced ? {} : { opacity: [0.3, 1, 0.3] }}
            transition={
              prefersReduced
                ? {}
                : { duration: 2, repeat: Infinity, ease: "easeInOut" }
            }
          />
        </motion.div>
      </motion.div>
    </HeroParallax>
  );
}
