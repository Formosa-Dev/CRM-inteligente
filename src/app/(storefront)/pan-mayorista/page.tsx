"use client";

import { useState, useEffect } from "react";
import { CatalogImage } from "@/components/products/catalog-image";
import { Skeleton } from "@/components/ui/skeleton";
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
import { SellerBadge } from "@/components/ui/seller-badge";
import { resolveCatalogImageUrl } from "@/lib/catalog-images";

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

const BREAD_IMAGES: Record<string, string> = {
  "pan brioche":
    "/assets/images/pan-mayorista/097707a3-f17b-4399-a6d0-66f6457ee64a.jpg",
  "pan con semillas":
    "/assets/images/pan-mayorista/5ee3b05e-fb3b-4bbc-a17f-67ceaeb509eb.jpg",
  "pan integral":
    "/assets/images/pan-mayorista/4f61b737-04bf-42d9-b033-a958cd791f6a.jpg",
  "pan de papa":
    "/assets/images/pan-mayorista/5c80c0c3-b27e-4b30-94a2-88a6f2981bca.jpg",
};

const benefits = [
  {
    icon: "🏆",
    title: "Calidad Premium",
    description:
      "Elaboración artesanal con materias primas seleccionadas y procesos tradicionales para un resultado sin igual.",
  },
  {
    icon: "📦",
    title: "Precios Mayoristas",
    description:
      "Precios competitivos en pedidos mayoristas. Trabajamos con comercios y negocios gastronómicos de todo tipo.",
  },
  {
    icon: "🚚",
    title: "Entrega Confiable",
    description:
      "Cumplimos con los plazos acordados. Tu negocio nunca se queda sin stock cuando trabajás con nosotros.",
  },
  {
    icon: "🤝",
    title: "Relación Directa",
    description:
      "Sin intermediarios. Hablás directo con quien elabora. Adaptamos formatos y cantidades a tu negocio.",
  },
];

type CatalogStatus = "loading" | "error" | "ready";

export default function PanMayoristaPage() {
  const [products, setProducts] = useState<ProductFromAPI[]>([]);
  const [status, setStatus] = useState<CatalogStatus>("loading");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function fetchProducts() {
      try {
        const res = await fetch("/api/products?available=true");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        // Filter for pan mayorista
        const panProducts = Array.isArray(data)
          ? data.filter((p: ProductFromAPI) => p.category === "pan_mayorista")
          : [];
        setProducts(panProducts);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        console.error("[pan-mayorista] fetch error:", err);
        setStatus("error");
      }
    }
    fetchProducts();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <div className="min-h-screen bg-background relative">
      {/* Hero */}
      <PageHero backgroundImage="/assets/images/background/1.png">
        <motion.span
          variants={heroChild}
          className="inline-block text-xs font-semibold uppercase tracking-[0.3em] px-4 py-1.5 rounded-full bg-primary/10 border border-primary/30 text-primary"
        >
          Servicio Mayorista
        </motion.span>

        <motion.h1
          variants={heroChild}
          className="text-gold-shimmer text-4xl sm:text-6xl font-black leading-tight font-heading"
        >
          Productos Artesanales
          <br />
          para tu <em>Negocio</em>
        </motion.h1>

        <motion.p
          variants={heroChild}
          className="text-lg text-foreground/65 max-w-2xl leading-relaxed"
        >
          Proveemos productos artesanales de calidad premium para comercios y
          negocios gastronómicos. Sin conservantes, con elaboración propia y el
          detalle que tus clientes van a notar.
        </motion.p>

        <motion.div variants={heroChild} className="mt-2">
          <SellerBadge />
        </motion.div>

        <motion.div variants={heroChild}>
          <WhatsAppCTA
            campaignSlug="mayorista"
            message="Hola! Me interesa información sobre venta mayorista"
            label="Consultá Precios y Disponibilidad"
            className="btn-gold inline-flex items-center justify-center gap-2 px-8 py-4 text-sm font-bold uppercase tracking-widest mt-4"
          />
        </motion.div>
      </PageHero>

      {/* Benefits grid */}
      <section className="py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <motion.h2
            className="text-center text-2xl sm:text-3xl font-black text-foreground mb-10"
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            Por qué elegirnos
          </motion.h2>

          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"
            variants={staggerContainer}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            {benefits.map((benefit) => (
              <motion.div
                key={benefit.title}
                variants={cardEntrance}
                whileHover={{
                  scale: 1.03,
                  boxShadow: "0 0 24px rgba(212,160,23,0.2)",
                }}
                className="glass-card shine-sweep flex flex-col gap-3 p-6 rounded-2xl transition-colors duration-300 cursor-default"
              >
                <span className="text-3xl">{benefit.icon}</span>
                <h3 className="font-bold text-base text-gold-gradient">
                  {benefit.title}
                </h3>
                <p className="text-sm text-foreground/60 leading-relaxed">
                  {benefit.description}
                </p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* Parallax divider between benefits and products */}
      <ParallaxDivider image="/assets/images/background/2.png" height="40vh" />

      {/* Products */}
      <section className="py-16 px-4">
        <div className="max-w-6xl mx-auto">
          <motion.div
            className="text-center mb-10"
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            <h2 className="text-2xl sm:text-3xl font-black text-foreground mb-2">
              Nuestras Variedades
            </h2>
            <p className="text-foreground/50 text-sm">
              Todos los precios son por pedido cerrado. Consultá disponibilidad y
              pedido mínimo.
            </p>
          </motion.div>

          {status === "loading" && (
            <div
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"
              aria-busy="true"
            >
              <span className="sr-only">Cargando variedades…</span>
              {Array.from({ length: 4 }).map((_, index) => (
                <div
                  key={index}
                  className="bg-card border border-border rounded-xl overflow-hidden"
                  aria-hidden="true"
                >
                  <Skeleton variant="shimmer" className="aspect-[4/3] w-full rounded-none" />
                  <div className="space-y-2 p-5">
                    <Skeleton variant="shimmer" className="h-4 w-2/3" />
                    <Skeleton variant="shimmer" className="h-3 w-full" />
                    <Skeleton variant="shimmer" className="h-8 w-28" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {status === "error" && (
            <div role="alert" className="flex flex-col items-center gap-4 py-10 text-center">
              <p className="text-sm text-foreground/60 max-w-md">
                No pudimos cargar las variedades. Revisá tu conexión e intentá
                de nuevo.
              </p>
              <button
                type="button"
                onClick={() => {
                  setStatus("loading");
                  setAttempt((a) => a + 1);
                }}
                className="btn-outline-gold px-6 py-3 text-sm uppercase tracking-widest"
              >
                Reintentar
              </button>
            </div>
          )}

          {status === "ready" && products.length === 0 && (
            <p className="py-10 text-center text-sm text-foreground/60">
              Estamos actualizando el catálogo mayorista. Consultanos por
              WhatsApp para precios y disponibilidad.
            </p>
          )}

          {status === "ready" && products.length > 0 && (
          <motion.div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6"
            variants={staggerContainer}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            {products.map((bread) => {
              const imageSrc = resolveCatalogImageUrl(bread.imageUrl) ?? BREAD_IMAGES[bread.name.trim().toLowerCase()];
              return (
              <motion.div
                key={bread.id}
                variants={cardEntrance}
                className="bg-card border border-border rounded-xl overflow-hidden flex flex-col shine-sweep"
              >
                {/* Real bread image */}
                <div className="relative w-full aspect-[4/3] overflow-hidden">
                  <CatalogImage src={imageSrc} alt={bread.name} sizes="(max-width: 640px) 100vw, 33vw" />
                </div>

                <div className="flex flex-col gap-2 p-5">
                  <h3 className="font-bold text-base text-gold-gradient">
                    {bread.name}
                  </h3>
                  <p className="text-xs text-foreground/55 leading-relaxed">
                    {bread.description}
                  </p>
                  <WhatsAppCTA
                    campaignSlug="mayorista"
                    message="Hola! Me interesa información sobre venta mayorista"
                    label="Consultar Precio"
                    className="mt-3 text-center text-xs font-semibold uppercase tracking-wider py-2.5 px-4 rounded-full transition-all duration-200 hover:scale-105"
                  />
                </div>
              </motion.div>
              );
            })}
          </motion.div>
          )}
        </div>
      </section>

      {/* Parallax divider between products and final CTA */}
      <ParallaxDivider image="/assets/images/background/b4.png" height="35vh" />

      {/* Final CTA */}
      <section className="py-20 px-4">
        <div className="max-w-3xl mx-auto text-center">
          <motion.div
            className="flex flex-col items-center gap-5"
            variants={fadeUp}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            <h2 className="text-2xl sm:text-3xl font-black font-heading text-gold-gradient">
              ¿Listo para trabajar juntos?
            </h2>
            <p className="text-foreground/60 leading-relaxed max-w-lg">
              Escribinos por WhatsApp y te respondemos en el día. Armamos una
              propuesta adaptada a tu volumen y necesidades.
            </p>
            <WhatsAppCTA
              campaignSlug="mayorista"
              message="Hola! Me interesa información sobre venta mayorista"
              label="Escribinos por WhatsApp"
              variant="card"
              subtitle="Respondemos en el día"
            />
          </motion.div>
        </div>
      </section>
    </div>
  );
}
