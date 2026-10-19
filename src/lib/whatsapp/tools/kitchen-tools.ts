import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { agentConfig, products } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { resolveAgentConfigId, currentAgentConfigScope } from "@/lib/agent-config-scope";

// ─── checkKitchenStatus ─────────────────────────────────────────────────────
// Consulta si la cocina está operativa (is_cooking)
export const checkKitchenStatusTool = tool({
  description:
    "Verifica si la cocina está operativa. Si isCooking=false, el local NO está cocinando hoy.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const rows = await db
        .select({ isCooking: agentConfig.isCooking })
        .from(agentConfig)
        .where(eq(agentConfig.id, await resolveAgentConfigId()))
        .limit(1);

      const cooking = rows[0]?.isCooking ?? true;
      return { isCooking: cooking };
    } catch {
      return { isCooking: true }; // fallback: asumir que sí
    }
  },
});

// ─── checkHamburguesasStock ────────────────────────────────────────────────
// Consulta si hay stock de hamburguesas disponible
export const checkHamburguesasStockTool = tool({
  description:
    "Verifica si hay stock de hamburguesas disponible para la venta. Si hamburguesasSinStock=true, NO se pueden vender hamburguesas.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const rows = await db
        .select({ sinStock: agentConfig.hamburguesasSinStock })
        .from(agentConfig)
        .where(eq(agentConfig.id, await resolveAgentConfigId()))
        .limit(1);
      return { hamburguesasSinStock: rows[0]?.sinStock ?? false };
    } catch {
      return { hamburguesasSinStock: false };
    }
  },
});

// ─── checkPanStock ──────────────────────────────────────────────────────────
// Consulta stock de pan al por mayor en docenas
export const checkPanStockTool = tool({
  description:
    "Consulta el stock de pan al por mayor disponible (en docenas). Usar cuando pidan pan para negocio.",
  inputSchema: z.object({}),
  execute: async () => {
    try {
      const rows = await db
        .select({ stock: agentConfig.stockPanDocenas })
        .from(agentConfig)
        .where(eq(agentConfig.id, await resolveAgentConfigId()))
        .limit(1);

      const stock = rows[0]?.stock ?? 0;
      return { docenasDisponibles: stock };
    } catch {
      return { docenasDisponibles: 0 };
    }
  },
});

// ─── checkProductStockTool ────────────────────────────────────────────────
// Consulta stock de un producto específico (stock por producto en DB)
export const checkProductStockTool = tool({
  description:
    "Consulta si un producto específico tiene stock disponible. Usá esto cuando el cliente pida un producto en particular para verificar si hay stock. Si stock es null significa stock ilimitado.",
  inputSchema: z.object({
    productId: z.number().optional().describe("ID del producto a consultar"),
    productName: z.string().optional().describe("Nombre del producto a consultar (búsqueda por nombre)"),
  }),
  execute: async ({ productId, productName }) => {
    try {
      const conditions = [eq(products.available, true)];
      if (productId) {
        conditions.push(eq(products.id, productId));
      } else if (productName) {
        // coincidencia parcial por nombre
        const matching = await db
          .select({ id: products.id })
          .from(products)
          .where(eq(products.name, productName))
          .limit(1);
        if (matching.length > 0) {
          conditions.push(eq(products.id, matching[0].id));
        } else {
          return { disponible: true, mensaje: "No se encontró el producto exacto, asumimos disponible." };
        }
      } else {
        return { disponible: true, mensaje: "Sin referencia de producto, asumimos disponible." };
      }

      const rows = await db
        .select({ name: products.name, stock: products.stock })
        .from(products)
        .where(and(...conditions))
        .limit(1);

      if (rows.length === 0) {
        return { disponible: false, mensaje: "Producto no encontrado o no disponible." };
      }

      const p = rows[0];
      if (p.stock === null) {
        return { disponible: true, stock: null, mensaje: `${p.name} tiene stock ilimitado.` };
      }
      if (p.stock <= 0) {
        return { disponible: false, stock: 0, mensaje: `${p.name} no tiene stock en este momento.` };
      }
      return { disponible: true, stock: p.stock, mensaje: `${p.name} tiene ${p.stock} unidades disponibles.` };
    } catch {
      return { disponible: true, mensaje: "Error al consultar stock, asumimos disponible." };
    }
  },
});

// ─── saveAddressTool ──────────────────────────────────────────────────────
// Guarda una dirección en la DB cuando el cliente la manda
export const saveAddressTool = tool({
  description:
    "GUARDA la dirección del cliente. Ejecutá SIEMPRE que el cliente escriba una dirección, ubicación, o diga 'mi dirección es'. Recibe phone, address, y opcionalmente mapsLink.",
  inputSchema: z.object({
    phone: z.string().describe("Teléfono del cliente (normalizado, sin +)"),
    address: z.string().describe("Dirección escrita por el cliente"),
    mapsLink: z.string().optional().describe("Link de Google Maps si el cliente compartió ubicación"),
    label: z.string().optional().describe("Etiqueta opcional: 'Casa', 'Trabajo', etc."),
  }),
  execute: async ({ phone, address, mapsLink, label }) => {
    const { addresses } = await import("@/db/schema");
    const { normalizePhone } = await import("@/lib/phone-utils");
    // The conversation's server-side customer phone wins over the model arg —
    // a customer must never write an address under another phone.
    const cleanedPhone =
      currentAgentConfigScope().customerPhone ?? normalizePhone(phone);

    // Verificar si ya existe
    const [existing] = await db
      .select({ id: addresses.id })
      .from(addresses)
      .where(and(eq(addresses.phone, cleanedPhone), eq(addresses.address, address)))
      .limit(1);

    if (existing) {
      // Actualizar lastUsedAt
      await db
        .update(addresses)
        .set({ lastUsedAt: new Date(), mapsLink: mapsLink || null, label: label || null })
        .where(eq(addresses.id, existing.id));
      return `Dirección actualizada: ${address}`;
    }

    // Insertar nueva
    await db.insert(addresses).values({
      phone: cleanedPhone,
      address,
      mapsLink: mapsLink || null,
      label: label || null,
    });

    return `Dirección guardada: ${address}`;
  },
});

// ─── getPaymentAlias ────────────────────────────────────────────────────────
// Obtiene el alias de pago según tipo: b2c (hamburguesas) o b2b (pan mayorista)
export const getPaymentAliasTool = tool({
  description:
    "Obtiene el alias de Mercado Pago para transferencias. Usar b2c para hamburguesas, b2b para pan mayorista.",
  inputSchema: z.object({
    tipo: z
      .enum(["b2c", "b2b"])
      .describe("b2c = hamburguesas (alias particular), b2b = pan mayorista (alias negocio)"),
  }),
  execute: async ({ tipo }) => {
    try {
      const rows = await db
        .select({
          aliasB2c: agentConfig.aliasB2c,
          aliasB2b: agentConfig.aliasB2b,
        })
        .from(agentConfig)
        .where(eq(agentConfig.id, await resolveAgentConfigId()))
        .limit(1);

      const config = rows[0];
      const alias = tipo === "b2b" ? config?.aliasB2b : config?.aliasB2c;

      if (!alias) {
        return { tieneAlias: false, tipo, mensaje: `No hay alias configurado para ${tipo}.` };
      }
      return { tieneAlias: true, tipo, alias };
    } catch {
      return { tieneAlias: false, mensaje: "Error al consultar alias." };
    }
  },
});
