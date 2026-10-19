import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CAMPAIGNS } from "@/lib/constants";
import { PromoPageClient } from "./promo-page-client";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateStaticParams() {
  return CAMPAIGNS.filter((c) => c.active).map((c) => ({ slug: c.slug }));
}

// Campaign-specific visual config
const CAMPAIGN_META: Record<
  string,
  { headline: string; sub: string; emoji: string; badge: string; em?: string }
> = {
  hamburguesas: {
    headline: "Las Hamburguesas que te vuelan la cabeza",
    sub: "Elaboradas a mano con ingredientes frescos. Sin apuro, con amor y mucho fuego.",
    emoji: "🍔",
    badge: "Menú Especial",
    em: "Hamburguesas",
  },
  mayorista: {
    headline: "Pan Artesanal para tu Negocio",
    sub: "Fermentación lenta, sin conservantes. El pan que tus clientes van a notar.",
    emoji: "🍞",
    badge: "Distribución Mayorista",
    em: "Negocio",
  },
  "promo-muzza": {
    headline: "La Promo de Muzza que no podés perder",
    sub: "Mozzarella derretida, masa artesanal, ingredientes de primera. Por tiempo limitado.",
    emoji: "🧀",
    badge: "Promo Exclusiva",
    em: "perder",
  },
  "2x1-empanadas": {
    headline: "2x1 en Empanadas — Solo por Hoy",
    sub: "Las empanadas más buscadas del barrio. Aprovechá la promo antes que se acaben.",
    emoji: "🥟",
    badge: "Oferta Limitada",
    em: "Empanadas",
  },
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const campaign = CAMPAIGNS.find((c) => c.slug === slug && c.active);
  if (!campaign) return { title: "Promo no encontrada" };
  const meta = CAMPAIGN_META[slug];
  const title = meta?.headline ?? campaign.name;
  const description = meta?.sub ?? campaign.name;
  return {
    title,
    description,
    alternates: { canonical: `/promo/${slug}` },
    openGraph: { title, description },
  };
}

export default async function PromoPage({ params }: PageProps) {
  const { slug } = await params;
  const campaign = CAMPAIGNS.find((c) => c.slug === slug && c.active);
  if (!campaign) notFound();

  const meta = CAMPAIGN_META[slug] ?? {
    headline: campaign.name,
    sub: "Contactanos para más información.",
    emoji: "⭐",
    badge: "Promo",
  };

  return (
    <PromoPageClient
      slug={slug}
      campaign={campaign}
      meta={meta}
    />
  );
}
