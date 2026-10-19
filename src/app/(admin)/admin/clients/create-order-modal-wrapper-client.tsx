"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { CreateOrderModal } from "@/components/orders/create-order-modal";
import { useIsAdmin } from "@/components/admin/role-context";

interface Props {
  clientName?: string;
  clientPhone?: string;
}

export function CreateOrderModalWrapperClient({ clientName, clientPhone }: Props) {
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  if (!isAdmin) return null;
  return (
    <>
      <button onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-lg bg-primary border border-primary/30 px-3.5 py-2 text-xs font-medium text-primary-foreground hover:bg-gold-bright transition-colors">
        <Plus className="h-3.5 w-3.5" />
        Nuevo Pedido
      </button>
      <CreateOrderModal open={open} onClose={() => setOpen(false)} clientName={clientName} clientPhone={clientPhone} />
    </>
  );
}
