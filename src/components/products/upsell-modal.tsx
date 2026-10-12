"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence, useDragControls, type PanInfo } from "framer-motion";
import { X, ShoppingCart, Sparkles } from "lucide-react";
import { useCart } from "@/lib/cart/cart-context";
import { getCatalogProductImage } from "@/lib/catalog-images";
import { useMediaQuery } from "@/hooks/use-media-query";

const STORAGE_KEY = "muzapp-upsell-shown";

type ApiProduct = {
  id: number;
  name: string;
  price: string | null;
  isPromo?: boolean;
  promoPrice?: string | null;
  stock?: number | null;
  category: string;
  comingSoon?: boolean;
  imageUrl?: string | null;
};

const SUGGESTED_CATEGORIES = ["acompanamiento", "bebidas"] as const;
const CATEGORY_EMOJI: Record<string, string> = {
  acompanamiento: "🍟",
  bebidas: "🥤",
};

function effectivePrice(p: ApiProduct) {
  return Number(p.isPromo && p.promoPrice != null ? p.promoPrice : p.price);
}

function orderable(p: ApiProduct) {
  return effectivePrice(p) > 0 && !p.comingSoon && p.stock !== 0;
}

interface UpsellModalProps {
  /** Función para scrollear/highlight la sección de papas */
  onNavigateToPapas?: () => void;
}

export function UpsellModal({ onNavigateToPapas }: UpsellModalProps) {
  const [show, setShow] = useState(false);
  const [suggestions, setSuggestions] = useState<ApiProduct[]>([]);
  const { addItem } = useCart();
  // Bottom-anchored only under md — sheet affordance lives there too.
  const isMobile = useMediaQuery("(max-width: 767px)");
  const dragControls = useDragControls();

  function handleDragEnd(_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) {
    if (info.offset.y > 120 || info.velocity.y > 500) setShow(false);
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem(STORAGE_KEY)) return;

    let timer: number | undefined;
    fetch("/api/products?available=true")
      .then((res) => (res.ok ? res.json() : []))
      .then((data: ApiProduct[]) => {
        const picks = SUGGESTED_CATEGORIES
          .map((cat) => data.find((p) => p.category === cat && orderable(p)))
          .filter((p): p is ApiProduct => Boolean(p));
        if (!picks.length) return;
        setSuggestions(picks);
        timer = window.setTimeout(() => {
          setShow(true);
          sessionStorage.setItem(STORAGE_KEY, "1");
        }, 5000);
      })
      .catch(() => {});

    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  const handleAdd = (product: ApiProduct) => {
    addItem(
      {
        id: String(product.id),
        name: product.name,
        price: effectivePrice(product),
        emoji: CATEGORY_EMOJI[product.category] ?? "⭐",
      },
      1,
      { type: "product", imageUrl: getCatalogProductImage(product) },
    );
    setShow(false);
    if (product.category === "acompanamiento") onNavigateToPapas?.();
  };

  return (
    <AnimatePresence>
      {show && suggestions.length > 0 && (
        <>
          {/* Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={() => setShow(false)}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            drag={isMobile ? "y" : false}
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.15 }}
            onDragEnd={handleDragEnd}
            className="fixed z-50 inset-x-4 bottom-4 md:inset-auto md:top-1/2 md:left-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-[420px] rounded-3xl border border-primary/20 bg-card p-5 max-md:pt-1 pb-[max(20px,env(safe-area-inset-bottom))] shadow-[0_20px_50px_-4px_rgba(0,0,0,.7)]"
          >
            {isMobile && (
              <div className="sheet-handle" aria-hidden="true"
                onPointerDown={(event) => dragControls.start(event)} />
            )}
            {/* Close */}
            <button
              onClick={() => setShow(false)}
              className="absolute top-3 right-3 p-1 rounded-lg hover:bg-muted/40 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Header */}
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="h-4 w-4 text-primary" />
              <p className="text-sm font-medium text-foreground">
                ¿Te falta el combo perfecto?
              </p>
            </div>
            <p className="text-xs text-muted-foreground mb-5">
              Añade el toque final a tu pedido
            </p>

            {/* Options — real orderable products from the admin catalog */}
            <div className="flex gap-3">
              {suggestions.map((product) => (
                <button
                  key={product.id}
                  onClick={() => handleAdd(product)}
                  className="flex-1 flex flex-col items-center gap-2 rounded-xl border border-border bg-muted/40 p-4 hover:border-primary/40 hover:bg-muted/60 transition-all group"
                >
                  <span className="text-3xl">{CATEGORY_EMOJI[product.category] ?? "⭐"}</span>
                  <span className="text-xs font-medium text-foreground">{product.name}</span>
                  <span className="text-xs text-primary font-semibold">
                    ${effectivePrice(product).toLocaleString("es-AR")}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-primary/70 group-hover:text-primary transition-colors">
                    <ShoppingCart className="h-3 w-3" />
                    Añadir
                  </span>
                </button>
              ))}
            </div>

            {/* Skip */}
            <button
              onClick={() => setShow(false)}
              className="w-full mt-4 text-[11px] text-muted-foreground/70 hover:text-muted-foreground transition-colors"
            >
              No, gracias
            </button>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
