import { appendRefToMessage } from "./attribution";

/**
 * Builds a wa.me deep link. The destination number comes from the business
 * config (agent_config.phoneNumber, exposed via GET /api/business) — never
 * hardcode a number here.
 */
export function buildWhatsAppURL(message: string, refCode: string | undefined, phone: string): string {
  const finalMessage = refCode ? appendRefToMessage(message, refCode) : message;
  const encoded = encodeURIComponent(finalMessage);
  return `https://wa.me/${phone}?text=${encoded}`;
}
