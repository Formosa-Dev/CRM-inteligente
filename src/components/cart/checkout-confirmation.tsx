"use client";

import { ArrowUpRight, Check } from "lucide-react";
import type { CheckoutReceipt } from "@/lib/checkout/contract";

/**
 * Order confirmation surface. Rendered by the cart surfaces (drawer, carta
 * dialog) instead of the cart contents once the provider holds a receipt — so
 * it is never unmounted by the cart emptying on success. The WhatsApp anchor is
 * the fallback for when the automatic navigation was blocked.
 */
export function CheckoutConfirmation({
  receipt,
  onDone,
}: {
  receipt: CheckoutReceipt;
  onDone?: () => void;
}) {
  return (
    <div className="checkout-confirmation" role="status">
      <Check size={20} />
      <strong>Pedido #{receipt.orderId} registrado</strong>
      <p>
        Subtotal confirmado: ${receipt.total.toLocaleString("es-AR")}. Enviá el mensaje para
        coordinar {receipt.fulfillmentMode === "pickup" ? "el retiro" : "la entrega"} y el pago.
      </p>
      <a className="menu-whatsapp-button" href={receipt.whatsappUrl}>
        Continuar en WhatsApp <ArrowUpRight size={18} />
      </a>
      {onDone && (
        <button type="button" className="menu-text-link" onClick={onDone}>
          Seguir explorando
        </button>
      )}
    </div>
  );
}
