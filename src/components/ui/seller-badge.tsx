"use client";

import { Store } from "lucide-react";
import { useBusiness } from "@/lib/hooks/use-business";

export function SellerBadge() {
  const business = useBusiness();
  return (
    <div className="glass-card flex items-center gap-3 p-3 rounded-xl w-fit">
      <div className="w-12 h-12 rounded-full flex items-center justify-center text-xl shrink-0 bg-gradient-to-br from-gold via-gold-bright to-gold-ember">
        <Store size={20} aria-hidden="true" />
      </div>
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-bold leading-tight font-heading text-gold-gradient">
          {business?.name || "Tienda"}
        </p>
        <p className="text-[11px] text-foreground/50 leading-tight">
          {business?.tagline || "Pedidos online"}
        </p>
      </div>
    </div>
  );
}
