import { z } from "zod";

/**
 * Fulfillment is a customer-facing delivery/pickup choice. It is NOT the
 * catalog/business `order_type` (hamburguesas | pan_mayorista) that the server
 * derives from the priced items — the two must never be conflated.
 */
export const fulfillmentModeSchema = z.enum(["pickup", "delivery"]);
export type FulfillmentMode = z.infer<typeof fulfillmentModeSchema>;

export const FULFILLMENT_OPTIONS: ReadonlyArray<{
  value: FulfillmentMode;
  label: string;
  hint: string;
}> = [
  { value: "delivery", label: "Envío", hint: "Coordinamos el domicilio por WhatsApp" },
  { value: "pickup", label: "Retiro", hint: "Retirás por el local" },
];

export const MIN_DELIVERY_ADDRESS_LENGTH = 5;
export const MAX_DELIVERY_ADDRESS_LENGTH = 200;

export function isValidDeliveryAddress(address: string): boolean {
  const trimmed = address.trim();
  return (
    trimmed.length >= MIN_DELIVERY_ADDRESS_LENGTH &&
    trimmed.length <= MAX_DELIVERY_ADDRESS_LENGTH
  );
}

/** Client-side guard mirroring the address rule the server will own. */
export function validateFulfillment(mode: FulfillmentMode, address: string): string | null {
  if (mode === "delivery" && !isValidDeliveryAddress(address)) {
    return "Ingresá la dirección de entrega (calle, número y referencia).";
  }
  return null;
}

/**
 * Extra payload the checkout API is expected to persist once the persistence
 * branch adds it to the contract:
 *   fulfillmentMode: "pickup" | "delivery"
 *   deliveryAddress: string | null  (required when fulfillmentMode === "delivery")
 * It travels alongside the existing contract fields and is ignored by servers
 * that have not adopted it yet.
 */
export type CheckoutFulfillment = {
  fulfillmentMode: FulfillmentMode;
  deliveryAddress: string | null;
};

export function fulfillmentPayload(mode: FulfillmentMode, address: string): CheckoutFulfillment {
  return {
    fulfillmentMode: mode,
    deliveryAddress: mode === "delivery" ? address.trim() : null,
  };
}
