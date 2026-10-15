import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { orders, products } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveItems, decrementStockBestEffort } from "@/lib/order-utils";

// ─── checkHours ───────────────────────────────────────────────────────────────

export const checkHours = tool({
  description:
    "Verifica si el local está abierto ahora mismo (horario Argentina).",
  inputSchema: z.object({}),
  execute: async () => {
    const now = new Date();
    const argTime = new Intl.DateTimeFormat("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).format(now);

    const [hourStr, minuteStr] = argTime.split(":");
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);
    const totalMinutes = hour * 60 + minute;

    const openMinutes = 11 * 60; // 11:00
    const closeMinutes = 23 * 60; // 23:00

    const isOpen = totalMinutes >= openMinutes && totalMinutes < closeMinutes;

    return {
      isOpen,
      currentTime: argTime,
      hours: "Lunes a domingo de 11:00 a 23:00 (hora Argentina)",
      message: isOpen
        ? `Sí, estamos abiertos. Son las ${argTime} y atendemos hasta las 23:00.`
        : `Estamos cerrados en este momento. Son las ${argTime}. Atendemos de 11:00 a 23:00.`,
    };
  },
});

// ─── getMenu ──────────────────────────────────────────────────────────────────

export const getMenu = tool({
  description:
    "Devuelve el menú actualizado desde la base de datos. Podés filtrar por categoría.",
  inputSchema: z.object({
    category: z
      .enum(["hamburguesa", "acompanamiento", "pan_mayorista"])
      .optional()
      .describe("Categoría del producto (opcional)"),
  }),
  execute: async ({ category }) => {
    try {
      const conditions = [eq(products.available, true)];
      if (category) {
        conditions.push(eq(products.category, category));
      }

      const items = await db
        .select({
          name: products.name,
          description: products.description,
          price: products.price,
          category: products.category,
        })
        .from(products)
        .where(and(...conditions))
        .orderBy(products.sortOrder);

      if (items.length === 0) {
        return { items: [], message: "No hay productos disponibles en este momento." };
      }

      const formatted = items
        .map((item) => {
          const price = item.price ? ` - $${item.price}` : "";
          const desc = item.description ? ` (${item.description})` : "";
          return `• ${item.name}${price}${desc}`;
        })
        .join("\n");

      return {
        items,
        formatted,
        message: `Menú disponible:\n${formatted}`,
      };
    } catch {
      return {
        items: [],
        message:
          "No pude cargar el menú en este momento. Escribinos directo y te ayudamos.",
      };
    }
  },
});

// ─── checkDelivery ────────────────────────────────────────────────────────────

export const checkDelivery = tool({
  description: "Devuelve información sobre zonas de entrega y envío a domicilio.",
  inputSchema: z.object({}),
  execute: async () => {
    return {
      available: true,
      zones: [
        "Zona centro y alrededores",
        "Consultar disponibilidad para zonas más alejadas",
      ],
      info:
        "Hacemos delivery! Las zonas y costos de envío varían. Confirmamos al momento del pedido si llegamos a tu dirección.",
      minimumOrder: "Pedido mínimo para delivery: consultar al confirmar",
    };
  },
});

// ─── captureOrder factory (injects phoneNumber at call time) ──────────────────

export function makeCaptureOrder(phoneNumber: string) {
  return tool({
    description:
      "Registra un pedido confirmado por el cliente en la base de datos. IMPORTANTE: Preguntale el nombre al cliente si no lo sabés todavía.",
    inputSchema: z.object({
      customerName: z
        .string()
        .describe("Nombre del cliente (preguntalo si no lo sabés)"),
      orderType: z
        .enum(["hamburguesas", "pan_mayorista"])
        .describe("Tipo de pedido: hamburguesas (rotisería nocturna) o pan_mayorista (pedido al por mayor)"),
      items: z
        .array(
          z.object({
            productName: z.string().describe("Nombre del producto pedido"),
            quantity: z.number().int().min(1).describe("Cantidad"),
          })
        )
        .min(1)
        .describe("Lista de ítems del pedido"),
      customerNotes: z
        .string()
        .optional()
        .describe("Notas adicionales del cliente (dirección, aclaraciones, etc.)"),
    }),
    execute: async ({ customerName, orderType, items, customerNotes }) => {
      try {
        await db.insert(orders).values({
          phoneNumber,
          customerName,
          orderType,
          items: items as unknown as Record<string, unknown>[],
          notes: customerNotes ?? null,
          status: "pending",
        });

        const resolved = await resolveItems(
          items.map((i) => ({ name: i.productName, quantity: i.quantity })),
        );
        await decrementStockBestEffort(resolved);

        const itemsSummary = items
          .map((i) => `${i.quantity}x ${i.productName}`)
          .join(", ");

        return {
          success: true,
          message: `Pedido registrado exitosamente: ${itemsSummary}. ¡Ya lo estamos preparando!`,
          orderedItems: items,
        };
      } catch {
        return {
          success: false,
          message:
            "Hubo un error al registrar el pedido. Por favor contactá directamente al local.",
        };
      }
    },
  });
}
