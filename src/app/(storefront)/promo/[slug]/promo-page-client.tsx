"use client";

import { motion } from "framer-motion";
import {
  fadeUp,
  staggerContainer,
  cardEntrance,
  heroChild,
} from "@/lib/animation-variants";
import { WhatsAppCTA } from "@/components/attribution/whatsapp-cta";
import { PageHero } from "@/components/layout/page-hero";
import { ParallaxDivider } from "@/components/layout/parallax-divider";
import type { Campaign } from "@/lib/constants";

interface PromoMeta {
  headline: string;
  sub: string;
  emoji: string;
  badge: string;
  /** Keyword inside `headline` rendered in real italic (<em>). */
  em?: string;
}

interface PromoPageClientProps {
  slug: string;
  campaign: Campaign;
  meta: PromoMeta;
}

const trustItems = [
  { icon: "🏆", label: "Calidad Premium" },
  { icon: "⚡", label: "Respuesta Inmediata" },
  { icon: "❤️", label: "Elaboración Propia" },
];

export function PromoPageClient({ slug, campaign, meta }: PromoPageClientProps) {
  return (
    <div className="min-h-screen bg-background relative flex flex-col">
      {/* Hero */}
      <PageHero backgroundImage="/assets/images/background/1.png">
        {/* Badge */}
        <motion.span
          variants={heroChild}
          className="inline-block text-xs font-semibold uppercase tracking-[0.3em] px-4 py-1.5 rounded-full bg-primary/[0.12] border border-primary/35 text-primary"
        >
          {meta.badge}
        </motion.span>

        {/* Emoji icon */}
        <motion.div
          variants={heroChild}
          whileHover={{ scale: 1.08, rotate: 3 }}
          animate={{ y: [0, -8, 0] }}
          transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
          className="w-24 h-24 rounded-3xl flex items-center justify-center text-5xl cursor-default bg-gradient-to-br from-primary/20 to-gold-ember/[0.12] border border-primary/30"
        >
          {meta.emoji}
        </motion.div>

        {/* Headline */}
        <motion.h1
          variants={heroChild}
          className="text-4xl sm:text-6xl font-black leading-tight font-heading text-gold-gradient"
        >
          {meta.em && meta.headline.includes(meta.em) ? (
            <>
              {meta.headline.slice(0, meta.headline.indexOf(meta.em))}
              <em>{meta.em}</em>
              {meta.headline.slice(meta.headline.indexOf(meta.em) + meta.em.length)}
            </>
          ) : (
            meta.headline
          )}
        </motion.h1>

        {/* Sub */}
        <motion.p
          variants={heroChild}
          className="text-lg text-foreground/65 max-w-xl leading-relaxed"
        >
          {meta.sub}
        </motion.p>

        {/* CTA */}
        <motion.div
          variants={heroChild}
          className="mt-4 flex flex-col items-center gap-3"
        >
          <WhatsAppCTA
            campaignSlug={slug}
            message={campaign.whatsappMessage}
            label="Aprovechá la promo"
          />
          <p className="text-foreground/50 text-xs">
            Respuesta inmediata por WhatsApp
          </p>
        </motion.div>
      </PageHero>

      {/* Trust indicators */}
      <section className="py-12 px-4">
        <div className="max-w-4xl mx-auto">
          <motion.div
            className="glass-card rounded-2xl p-8"
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            <motion.div
              className="grid grid-cols-1 sm:grid-cols-3 gap-4"
              variants={staggerContainer}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
            >
              {trustItems.map((item) => (
                <motion.div
                  key={item.label}
                  variants={cardEntrance}
                  whileHover={{
                    scale: 1.05,
                    boxShadow: "0 0 16px rgba(212,160,23,0.15)",
                  }}
                  className="flex flex-col items-center gap-2 text-center py-2 rounded-xl cursor-default"
                >
                  <span className="text-2xl">{item.icon}</span>
                  <span className="text-sm font-semibold text-foreground/70">
                    {item.label}
                  </span>
                </motion.div>
              ))}
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Parallax divider between trust strip and bottom CTA */}
      <ParallaxDivider image="/assets/images/background/3.png" height="35vh" />

      {/* Bottom CTA */}
      <section className="py-16 px-4 text-center">
        <motion.div
          variants={fadeUp}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
          className="flex flex-col items-center gap-4"
        >
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-primary">
            ¿Tenés preguntas?
          </p>
          <h2 className="text-xl sm:text-2xl font-black text-foreground font-heading">
            Escribinos directamente
          </h2>
          <WhatsAppCTA
            campaignSlug={slug}
            message={campaign.whatsappMessage}
            label="Hablar con nosotros"
            variant="card"
            subtitle="Respuesta inmediata"
          />
        </motion.div>
      </section>
    </div>
  );
}
