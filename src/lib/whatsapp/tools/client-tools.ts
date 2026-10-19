import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { products, orders, leads, agentConfig } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { normalizePhone } from "@/lib/phone-utils";
import { resolveAgentConfigId, currentAgentConfigScope } from "@/lib/agent-config-scope";

// checkProductAvailability - Verificar stock
export const checkProductAvailabilityTool = tool({
  description: "Verifica si un producto está disponible actualmente",
  inputSchema: z.object({
    name: z.string().describe("Nombre del producto"),
  }),
  execute: async ({ name }) => {
    const allProducts = await db
      .select({
        name: products.name,
        available: products.available,
      })
      .from(products);

    const normalizedName = name.toLowerCase();
    const found = allProducts.find((p) =>
      p.name?.toLowerCase().includes(normalizedName)
    );

    if (!found) {
      return `No encontré "${name}" en nuestro menú. ¿Querés ver qué tenemos?`;
    }

    if (!found.available) {
      return `${found.name} no está disponible en este momento. ¿Querés ver otras opciones?`;
    }

    return `✅ ${found.name} está disponible!`;
  },
});

// suggestProducts - Sugerir según historial
export const suggestProductsTool = tool({
  description: "Sugiere productos basados en el historial de pedidos del cliente. Si es B2C (hamburguesas) pasá linea='b2c'. Si es B2B (pan mayorista) pasá linea='b2b'.",
  inputSchema: z.object({
    phone: z.string().optional().describe("Teléfono del cliente (opcional)"),
    linea: z.enum(["b2c", "b2b"]).optional().describe("Línea de negocio: b2c = hamburguesas/tragos, b2b = pan mayorista"),
  }),
  execute: async ({ phone, linea }) => {
    // ─── Verificar si hay stock de hamburguesas ──────────────────────────
    if (!linea || linea === "b2c") {
      try {
        const [cfg] = await db
          .select({ sinStock: agentConfig.hamburguesasSinStock })
          .from(agentConfig)
          .where(eq(agentConfig.id, await resolveAgentConfigId()))
          .limit(1);
        if (cfg?.sinStock) {
          if (linea === "b2c") {
            return "Hoy no tenemos hamburguesas. Solo estamos vendiendo pan mayorista. ¿Querés ver el menú de pan?";
          }
          // si no hay línea especificada, ofrecer ambas
        }
      } catch {
        // non-fatal
      }
    }

    if (!phone) {
      if (linea === "b2b") {
        return "Tenemos pan de lomito x4, prepizza x docena, pan de hamburguesa x4, pan de pancho x4. ¿Cuál te interesa y qué cantidad?";
      }
      return "Nuestros más pedidos: Bookbinder, Toro Asado y Classic Carne. ¿Querés que te recomiende algo en especial?";
    }

    phone = normalizePhone(phone);

    // Si hay línea, filtrar pedidos por orderType
    const conditions = [eq(orders.phoneNumber, phone)];
    if (linea === "b2b") {
      conditions.push(eq(orders.orderType, "pan_mayorista"));
    } else if (linea === "b2c") {
      conditions.push(eq(orders.orderType, "hamburguesas"));
    }

    // A bound account only reads orders owned by its own leads — a customer
    // shared across provisioned accounts never gets cross-account history.
    const scopeAccountId = currentAgentConfigScope().channelAccountId ?? null;
    const recentOrders = scopeAccountId != null
      ? await db
        .select({ items: orders.items, orderType: orders.orderType })
        .from(orders)
        .innerJoin(leads, eq(orders.leadId, leads.id))
        .where(and(...conditions, eq(leads.channelAccountId, scopeAccountId)))
        .orderBy(desc(orders.createdAt))
        .limit(5)
      : await db
        .select({ items: orders.items, orderType: orders.orderType })
        .from(orders)
        .where(and(...conditions))
        .orderBy(desc(orders.createdAt))
        .limit(5);

    if (recentOrders.length === 0) {
      if (linea === "b2b") {
        return "No tenés pedidos de pan mayorista registrados. ¿Querés ver el menú de pan? Tenemos pan de lomito, prepizza, pan de hamburguesa y pan de pancho.";
      }
      return "Aún no tenés pedidos registrados. ¿Querés ver el menú?";
    }

    const productCounts: Record<string, number> = {};
    for (const order of recentOrders) {
      const items = order.items as { name: string }[];
      if (Array.isArray(items)) {
        for (const item of items) {
          productCounts[item.name] = (productCounts[item.name] || 0) + 1;
        }
      }
    }

    const topProducts = Object.entries(productCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    const lineLabel = linea === "b2b" ? "pan mayorista" : "hamburguesas";
    return `Basado en tus pedidos anteriores de ${lineLabel}: ${topProducts.join(", ")}. ¿Querés pedir algo de eso?`;
  },
});

// ─── getClientHistory ───────────────────────────────────────────────────────
export const getClientHistoryTool = tool({
  description:
    "Obtiene el historial completo de un cliente: pedidos anteriores, lead info, frecuencia. Usar para venta consultiva.",
  inputSchema: z.object({
    phone: z.string().describe("Teléfono del cliente"),
  }),
  execute: async ({ phone }) => {
    phone = normalizePhone(phone);
    // Bound account: only the lead row owned by this account is visible, and
    // orders attribute through it. NULL scope keeps the legacy global reads.
    const scopeAccountId = currentAgentConfigScope().channelAccountId ?? null;
    // Buscar lead
    const leadRows = await db
      .select({
        name: leads.name,
        phone: leads.phone,
        address: leads.address,
        status: leads.status,
        tags: leads.tags,
        firstMessage: leads.firstMessage,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(
        scopeAccountId != null
          ? and(eq(leads.phone, phone), eq(leads.channelAccountId, scopeAccountId))
          : eq(leads.phone, phone)
      )
      .limit(1);

    // Buscar pedidos
    const orderRows = scopeAccountId != null
      ? await db
        .select({
          id: orders.id,
          items: orders.items,
          status: orders.status,
          orderType: orders.orderType,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .innerJoin(leads, eq(orders.leadId, leads.id))
        .where(and(eq(orders.phoneNumber, phone), eq(leads.channelAccountId, scopeAccountId)))
        .orderBy(desc(orders.createdAt))
        .limit(10)
      : await db
        .select({
          id: orders.id,
          items: orders.items,
          status: orders.status,
          orderType: orders.orderType,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(eq(orders.phoneNumber, phone))
        .orderBy(desc(orders.createdAt))
        .limit(10);

    const lead = leadRows[0];
    const parts: string[] = [];

    if (lead) {
      parts.push(
        `👤 ${lead.name || "Sin nombre"} (${lead.status})`,
        `📞 ${lead.phone}`,
        `📅 Cliente desde: ${lead.createdAt ? new Date(lead.createdAt).toLocaleDateString("es-AR") : "desconocido"}`
      );
      if (lead.address) parts.push(`📍 Direccion guardada: ${lead.address}`);
      const tags = lead.tags as string[] | null;
      if (tags?.length) parts.push(`🏷️ Tags: ${tags.join(", ")}`);
    } else {
      parts.push("👤 Cliente no registrado como lead");
    }

    if (orderRows.length === 0) {
      parts.push("\n📦 Sin pedidos anteriores");
    } else {
      parts.push(`\n📦 ${orderRows.length} pedido(s):`);
      for (const o of orderRows.slice(0, 5)) {
        const items = o.items as { name: string; quantity: number }[];
        const itemSummary = Array.isArray(items)
          ? items.map((i) => `${i.quantity}x ${i.name}`).join(", ")
          : "sin detalle";
        const date = o.createdAt
          ? new Date(o.createdAt).toLocaleDateString("es-AR")
          : "";
        parts.push(`  #${o.id} (${o.status}) ${date}: ${itemSummary}`);
      }
    }

    return parts.join("\n");
  },
});