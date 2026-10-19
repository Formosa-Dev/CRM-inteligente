import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { addOrderContextItem, getOrderContextSummary, formatOrderSummary } from "@/lib/order-context";
import { getCustomerAddresses, formatAddressesForPrompt } from "@/lib/addresses";
import { resolveItems, validateResolvedOrderItems } from "@/lib/order-utils";
import { resolveAgentConfigId } from "@/lib/agent-config-scope";

export function createAddOrderItemTool(conversationId: number, phone: string) {
  return tool({
    description: "Agrega un producto al pedido actual del cliente. Usá esto cuando el cliente pida un producto específico para no olvidarlo.",
    inputSchema: z.object({
      productName: z.string().describe("Nombre del producto (ej: Genesis, Deli Deli)"),
      quantity: z.number().int().positive().optional().default(1).describe("Cantidad"),
      variant: z.string().optional().describe("Variante si aplica (ej: Con Crema, Sin Crema)"),
      notes: z.string().optional().describe("Notas del cliente (ej: sin cebolla, punto jugoso)"),
    }),
    execute: async ({ productName, quantity, variant, notes }) => {
      // ─── Verificar si hay stock de hamburguesas ──────────────────────────
      try {
        const [cfg] = await db
          .select({ sinStock: agentConfig.hamburguesasSinStock })
          .from(agentConfig)
          .where(eq(agentConfig.id, await resolveAgentConfigId()))
          .limit(1);
        if (cfg?.sinStock) {
          const burgerKeywords = ["hamburguesa", "bookbinder", "genesis", "deli", "crispy", "classic", "especiale", "italiano", "torro", "smash", "cheddar", "bacon", "bbq"];
          const isBurger = burgerKeywords.some(k => productName.toLowerCase().includes(k));
          if (isBurger) {
            return "No estamos vendiendo hamburguesas hoy. Solo tenemos pan mayorista. Disculpá.";
          }
        }
      } catch {
        // non-fatal
      }

      const [resolved] = await resolveItems([{ name: productName, quantity }]);
      const itemError = validateResolvedOrderItems(resolved ? [resolved] : []);
      if (itemError) return itemError;
      await addOrderContextItem(conversationId, phone, resolved.name, String(resolved.unitPrice), quantity, variant, notes);
      const summary = await getOrderContextSummary(conversationId);
      return `✅ Agregado: ${quantity}x ${resolved.name}${variant ? ` (${variant})` : ""}. Llevás ${summary.length} producto(s).`;
    },
  });
}

export function createGetOrderSummaryTool(conversationId: number) {
  return tool({
    description: "Obtené el resumen de todo lo que pidió el cliente hasta ahora en esta conversación.",
    inputSchema: z.object({}),
    execute: async () => {
      const items = await getOrderContextSummary(conversationId);
      if (items.length === 0) return "El cliente todavía no pidió nada en esta conversación.";
      return formatOrderSummary(items);
    },
  });
}

export function createGetAddressesTool(phone: string) {
  return tool({
    description: "Mostrá las direcciones guardadas del cliente para preguntarle a cuál enviar el pedido.",
    inputSchema: z.object({}),
    execute: async () => {
      const addresses = await getCustomerAddresses(phone);
      if (addresses.length === 0) return "El cliente no tiene direcciones guardadas.";
      return formatAddressesForPrompt(addresses);
    },
  });
}
