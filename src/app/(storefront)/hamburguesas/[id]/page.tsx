"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ProductDetail } from "@/components/products/product-detail";
import { useCart } from "@/lib/cart/cart-context";
import { getCatalogProductImage } from "@/lib/catalog-images";

type ProductFromAPI = {
  id: number;
  name: string;
  description: string | null;
  price: string | null;
  isPromo?: boolean;
  promoPrice?: string | null;
  stock?: number | null;
  category: string;

  imageUrl: string | null;
  available: boolean;
  comingSoon: boolean;
  sortOrder: number;
};

export default function ProductDetailPage() {
  const params = useParams();
  const router = useRouter();
  const productId = params.id as string;
  
  const [product, setProduct] = useState<ProductFromAPI | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productId) return;

    async function fetchProduct() {
      try {
        const res = await fetch(`/api/products`);
        const data = await res.json();
        const found = data.find((p: ProductFromAPI) => String(p.id) === productId);
        
        if (found) {
          setProduct(found);
        } else {
          setError("Producto no encontrado");
        }
      } catch (err) {
        console.error("[product] fetch error:", err);
        setError("Error al cargar producto");
      } finally {
        setLoading(false);
      }
    }
    fetchProduct();
  }, [productId]);

  const { addItem } = useCart();

  function handleAddToCart(p: ProductFromAPI) {
    const raw = p.isPromo && p.promoPrice != null ? p.promoPrice : p.price;
    const price = raw ? Number(raw) : 0;
    addItem(
      {
        id: String(p.id),
        name: p.name,
        price,
        emoji: "🍔",
      },
      1,
      { type: "product", imageUrl: getCatalogProductImage(p) },
    );
  }

  if (loading) {
    return (
      <div className="digital-menu p-4">
        <div className="max-w-4xl mx-auto">
          <div className="space-y-4">
            <div className="h-8 menu-shimmer rounded w-24" />
            <div className="h-96 menu-shimmer rounded-2xl" />
            <div className="h-32 menu-shimmer rounded-xl" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !product) {
    return (
      <div className="digital-menu p-4 flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-400 mb-4">{error ?? "Producto no encontrado"}</p>
          <button
            onClick={() => router.push("/hamburguesas")}
            className="text-[var(--menu-gold)] hover:underline text-sm"
          >
            Volver al menú
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="digital-menu px-5 sm:px-10 pt-28">
      <ProductDetail product={product} onAddToCart={handleAddToCart} />
    </div>
  );
}