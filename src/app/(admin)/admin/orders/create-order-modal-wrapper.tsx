"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { CreateOrderModal } from "@/components/orders/create-order-modal";
import { useIsAdmin } from "@/components/admin/role-context";

export function CreateOrderModalWrapper() {
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return (
    <>
      <button onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-gold-bright transition-colors">
        <Plus className="h-3.5 w-3.5" />
        Nuevo Pedido
      </button>
      <CreateOrderModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
