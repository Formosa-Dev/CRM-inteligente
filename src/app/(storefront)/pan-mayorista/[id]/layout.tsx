import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getStorefrontProduct } from "@/lib/storefront-product";

const CATEGORY = "pan_mayorista";

interface Params {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { id } = await params;
  const product = await getStorefrontProduct(id);
  if (!product || product.category !== CATEGORY) {
    return { title: "Producto no encontrado" };
  }
  const description =
    product.description?.trim() || `${product.name} — pedido mayorista por WhatsApp.`;
  return {
    title: product.name,
    description,
    alternates: { canonical: `/pan-mayorista/${product.id}` },
    openGraph: {
      title: product.name,
      description,
      ...(product.imageUrl ? { images: [{ url: product.imageUrl, alt: product.name }] } : {}),
    },
  };
}

// Category gate: this URL must not render a product from another
// category — that would duplicate /hamburguesas/[id] content under a
// second canonical URL.
export default async function PanMayoristaDetailLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const product = await getStorefrontProduct(id);
  if (!product || product.category !== CATEGORY) notFound();
  return children;
}
