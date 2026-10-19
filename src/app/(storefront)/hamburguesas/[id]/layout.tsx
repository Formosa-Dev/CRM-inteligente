import type { Metadata } from "next";
import { getStorefrontProduct } from "@/lib/storefront-product";

const CATEGORY = "hamburguesa";

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
    product.description?.trim() || `${product.name} — pedido online por WhatsApp.`;
  return {
    title: product.name,
    description,
    alternates: { canonical: `/hamburguesas/${product.id}` },
    openGraph: {
      title: product.name,
      description,
      ...(product.imageUrl ? { images: [{ url: product.imageUrl, alt: product.name }] } : {}),
    },
  };
}

export default function HamburguesaDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
