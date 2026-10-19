"use client";

import { useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { useCart } from "@/lib/cart/cart-context";
import {
  checkoutPhone,
  checkoutSchema,
  type CheckoutLine,
  type CheckoutReceipt,
} from "@/lib/checkout/contract";
import {
  FULFILLMENT_OPTIONS,
  fulfillmentPayload,
  validateFulfillment,
  type FulfillmentMode,
} from "./fulfillment";
import {
  clearAttempt,
  normalizeAttemptSignature,
  resolveAttempt,
  type AttemptStorage,
  type CheckoutAttempt,
} from "./checkout-attempt";
import {
  checkoutFailureMessage,
  interpretCheckoutOutcome,
  OFFLINE_MESSAGE,
  shouldClearAfter,
} from "./checkout-outcome";
import { useBusiness } from "@/lib/hooks/use-business";

function attemptStorage(): AttemptStorage | null {
  return typeof window === "undefined" ? null : window.sessionStorage;
}

export function CheckoutForm({ items }: { items: CheckoutLine[] }) {
  const { completeOrder } = useCart();
  const business = useBusiness();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [fulfillmentMode, setFulfillmentMode] = useState<FulfillmentMode>("delivery");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  // Hard guards: one request at a time, one terminal success per attempt.
  const inFlight = useRef(false);
  const completed = useRef(false);
  const attemptRef = useRef<CheckoutAttempt | null>(null);

  const deliverySelected = fulfillmentMode === "delivery";

  /** Reuses the persisted id when the semantic signature is unchanged. */
  function stableAttempt(signature: string): CheckoutAttempt {
    if (attemptRef.current?.signature === signature) return attemptRef.current;
    attemptRef.current = resolveAttempt(attemptStorage(), signature);
    return attemptRef.current;
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || completed.current || !items.length) return;
    setError("");
    setErrorCode(null);
    // Offline pre-flight: nothing reaches the server, so this can never be an
    // ambiguous "maybe registered" failure — tell the customer to reconnect.
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setError(OFFLINE_MESSAGE);
      return;
    }
    const fulfillmentError = validateFulfillment(fulfillmentMode, deliveryAddress);
    if (fulfillmentError) {
      setError(fulfillmentError);
      return;
    }
    // Canonical signature: sorted semantic fields only. Reordering UI lines or
    // re-rendering must not mint a new id for the same intent.
    const signature = normalizeAttemptSignature({
      phone: checkoutPhone(phone),
      customerName: name,
      fulfillmentMode,
      deliveryAddress: deliverySelected ? deliveryAddress : null,
      items: items.map((item) => ({ type: item.type, id: item.id, quantity: item.quantity })),
    });
    const attempt = stableAttempt(signature);
    const parsed = checkoutSchema.safeParse({
      requestId: attempt.requestId,
      customerName: name,
      phone,
      items,
    });
    if (!parsed.success) {
      setError("Ingresá tu nombre y WhatsApp con código de área, sin 0 ni 15. Ejemplo: 370 4123456.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...parsed.data,
          ...fulfillmentPayload(fulfillmentMode, deliveryAddress),
        }),
      });
      let data: Partial<CheckoutReceipt> & { error?: string; code?: string } = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }
      const outcome = interpretCheckoutOutcome(response.ok, response.status, data.code);
      if (!shouldClearAfter(outcome)) {
        // Keep the stable attempt id and the cart. No automatic retry.
        setErrorCode(typeof data.code === "string" ? data.code : null);
        setError(checkoutFailureMessage(outcome, data.error, data.code));
        return;
      }
      if (completed.current) return;
      completed.current = true;
      clearAttempt(attemptStorage());
      attemptRef.current = null;
      // The receipt is lifted to the provider in the same commit that empties
      // the cart, so the confirmation survives the cart-lines branch unmounting.
      completeOrder(data as CheckoutReceipt);
      // The business URL is only opened after the server confirmed the order.
      if (typeof data.whatsappUrl === "string" && data.whatsappUrl) {
        window.location.assign(data.whatsappUrl);
      }
    } catch {
      // Offline mid-request can never have created an order. Any other network
      // failure may have reached the server: preserve the cart, keep the id,
      // and ask the customer to verify before retrying.
      setError(
        typeof navigator !== "undefined" && navigator.onLine === false
          ? OFFLINE_MESSAGE
          : checkoutFailureMessage("ambiguous"),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="checkout-form" onSubmit={submit}>
      <div className="checkout-fields">
        <label>
          Tu nombre
          <input
            name="name"
            autoComplete="name"
            required
            minLength={2}
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            placeholder="¿Cómo te llamás?"
          />
        </label>
        <label>
          Tu WhatsApp
          <input
            name="tel"
            type="tel"
            autoComplete="tel"
            required
            maxLength={30}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            disabled={busy}
            placeholder="370 4123456"
            aria-describedby="checkout-phone-help"
          />
        </label>
      </div>
      <p id="checkout-phone-help" className="menu-cart-note">
        Usá el número desde el que vas a escribirnos para que reconozcamos tu pedido.
      </p>

      <fieldset className="checkout-fulfillment">
        <legend>¿Cómo lo querés recibir?</legend>
        <div className="checkout-fulfillment-options">
          {FULFILLMENT_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="checkout-fulfillment-option"
              data-selected={fulfillmentMode === option.value}
            >
              <input
                type="radio"
                name="fulfillment"
                value={option.value}
                checked={fulfillmentMode === option.value}
                onChange={() => setFulfillmentMode(option.value)}
                disabled={busy}
              />
              <b>{option.label}</b>
              <small>{option.hint}</small>
            </label>
          ))}
        </div>
      </fieldset>

      {deliverySelected && (
        <div className="checkout-address">
          <label>
            Dirección de entrega
            <input
              name="address"
              autoComplete="street-address"
              maxLength={200}
              value={deliveryAddress}
              onChange={(event) => setDeliveryAddress(event.target.value)}
              disabled={busy}
              placeholder="Calle, número y referencia"
              aria-required="true"
            />
          </label>
        </div>
      )}

      {error && (
        <p className="checkout-error" role="alert">
          {error}{" "}
          {errorCode === "no_destination" && business?.whatsappPhone ? (
            <a
              href={`https://wa.me/${business.whatsappPhone}`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Escribinos por WhatsApp
            </a>
          ) : null}
        </p>
      )}
      <button className="menu-whatsapp-button" type="submit" disabled={busy || !items.length}>
        {busy ? (
          <>
            <LoaderCircle className="animate-spin" size={18} /> Registrando pedido…
          </>
        ) : (
          <>
            Confirmar y abrir WhatsApp <ArrowUpRight size={18} />
          </>
        )}
      </button>
      <p className="menu-cart-note">
        El pedido queda registrado al confirmar. En WhatsApp, tocá Enviar para hablar con nuestro
        asistente.
      </p>
    </form>
  );
}
