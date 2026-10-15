import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { products, agentConfig } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export const getMenuTool = tool({
  description: "Obtiene el menú de productos disponibles. Categorías: hamburguesa, pizzas, empanadas, acompanamiento, pan_mayorista, tragos_vip (Tragos V.I.P), bebidas, alcohol",
  inputSchema: z.object({
    category: z.enum(["hamburguesa", "acompanamiento", "pan_mayorista", "tragos_vip", "bebidas", "alcohol", "empanadas", "pizzas"]).optional()
      .describe("Categoría para filtrar. tragos_vip = Tragos V.I.P de 1 Litro. Si no se especifica, devuelve todo el menú"),
  }),
  execute: async ({ category }) => {
    // ─── Si no hay stock de hamburguesas, ocultarlas del menú ──────────
    if (!category || category === "hamburguesa") {
      try {
        const [cfg] = await db
          .select({ sinStock: agentConfig.hamburguesasSinStock })
          .from(agentConfig)
          .where(eq(agentConfig.id, 1))
          .limit(1);
        if (cfg?.sinStock && category === "hamburguesa") {
          return "Hoy no tenemos hamburguesas disponibles.";
        }
      } catch {
        // non-fatal
      }
    }

    const conditions = [eq(products.available, true)];
    if (category) conditions.push(eq(products.category, category));

    // Si hamburguesas sin stock, excluir categoría hamburguesa del menú completo
    try {
      const [cfg] = await db
        .select({ sinStock: agentConfig.hamburguesasSinStock })
        .from(agentConfig)
        .where(eq(agentConfig.id, 1))
        .limit(1);
      if (cfg?.sinStock && !category) {
        conditions.push(eq(products.category, "pan_mayorista"));
      }
    } catch {
      // non-fatal
    }

    const items = await db
      .select({
        name: products.name,
        description: products.description,
        price: products.price,
        category: products.category,
        imageUrl: products.imageUrl,
      })
      .from(products)
      .where(and(...conditions))
      .orderBy(products.sortOrder);

    if (items.length === 0) return "No hay productos disponibles en este momento.";

    return items.map(i => `• ${i.name} - $${i.price}${i.description ? ` — ${i.description}` : ""}`).join("\n");
  },
});
