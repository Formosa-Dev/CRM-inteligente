import type { Metadata } from "next";
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

export default function PanMayoristaDetailLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
