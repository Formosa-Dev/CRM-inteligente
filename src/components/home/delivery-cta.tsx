"use client";

import { motion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { fadeUp, staggerContainer } from "@/lib/animation-variants";
import { buildWhatsAppURL } from "@/lib/whatsapp";
import { useBusiness } from "@/lib/hooks/use-business";

function PhoneIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.61 3.32 2 2 0 0 1 3.62 1h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.29 6.29l.96-.96a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z" />
    </svg>
  );
}

export function DeliveryCTA() {
  const business = useBusiness();
  const whatsappUrl = business?.whatsappPhone
    ? buildWhatsAppURL("Hola! Quiero hacer un pedido a domicilio", undefined, business.whatsappPhone)
    : null;
  const instagram = business?.instagram;

  return (
    <section
      className="w-full px-4 py-14 sm:py-20 relative"
      style={{
        background: "linear-gradient(180deg, var(--background) 0%, rgba(212,160,23,0.05) 50%, var(--background) 100%)",
      }}
    >
      <motion.div
        className="flex flex-col items-center text-center gap-8"
        variants={staggerContainer}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: "-80px" }}
      >
        {/* Decorative top line */}
        <motion.div
          variants={fadeUp}
          className="w-24 h-px mx-auto bg-gradient-to-br from-gold via-gold-bright to-gold-ember"
        />

        {/* Heading */}
        <motion.h2
          variants={fadeUp}
          className="text-4xl sm:text-5xl font-black leading-tight font-heading text-gold-gradient"
        >
          Delivery a <em>Domicilio</em>
        </motion.h2>

        {/* Subtitle */}
        {business?.tagline && (
          <motion.p
            variants={fadeUp}
            className="text-lg text-foreground/60"
          >
            {business.tagline}
          </motion.p>
        )}

        {/* Phone number */}
        {business?.phoneDisplay && (
          <motion.div
            variants={fadeUp}
            className="flex items-center gap-3 text-foreground/90"
          >
            <PhoneIcon />
            <span className="text-2xl font-bold tracking-wide">{business.phoneDisplay}</span>
          </motion.div>
        )}

        {/* CTA buttons */}
        <motion.div
          variants={fadeUp}
          className="flex flex-col sm:flex-row items-center gap-4 w-full max-w-md"
        >
          {whatsappUrl && (
            <a
              href={whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="cta-card w-full text-left"
            >
              <span className="cta-card-icon"><WhatsAppIcon /></span>
              <span className="flex-1">
                <span className="block text-[17px] font-bold leading-tight">Pedir por WhatsApp</span>
                <span className="block text-xs opacity-70">Respuesta inmediata</span>
              </span>
              <span className="cta-card-chevron"><ChevronRight size={20} aria-hidden="true" /></span>
            </a>
          )}

          {instagram && (
            <a
              href={`https://instagram.com/${instagram}`}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-outline-gold px-8 py-4 text-sm uppercase tracking-widest"
            >
              @{instagram}
            </a>
          )}
        </motion.div>

        {/* Hours — rendered only when the business configured them */}
        {business?.hours && (
          <motion.p
            variants={fadeUp}
            className="text-sm text-foreground/50"
          >
            {business.hours}
          </motion.p>
        )}
      </motion.div>
    </section>
  );
}
