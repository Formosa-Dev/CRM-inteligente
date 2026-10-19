import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { products, orders as ordersTable } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";
import { resolveAgentConfig } from "@/lib/agent-config-scope";

// --- HELPERS ---
// Lee las zonas de delivery desde la DB (configurables desde UI)
async function getDeliveryZonesFromDB(): Promise<{ zona: string; disponible: boolean; tiempo: string; costo: number }[]> {
  try {
    const config = await resolveAgentConfig();
    const zonas = config?.whatsappZonasDelivery as { zona: string; disponible: boolean; tiempo: string; costo: number }[] | null;
    if (zonas && zonas.length > 0) return zonas;
  } catch {
    // fallback silencioso
  }
  return [
    { zona: "centro", disponible: true, tiempo: "20-30 min", costo: 0 },
    { zona: "norte", disponible: true, tiempo: "25-35 min", costo: 0 },
    { zona: "sur", disponible: true, tiempo: "30-40 min", costo: 0 },
  ];
}

// --- CHECK DELIVERY TOOL ---
// Verifica si hacemos delivery a una zona

export const checkDeliveryTool = tool({
  description: "Verifica si hacemos delivery a una zona. Usá esto cuando el cliente pregunte si llegamos a cierta zona o barrio.",
  inputSchema: z.object({
    zona: z.string().optional().describe("Zona o barrio (ej: centro, norte, sur)"),
    direccion: z.string().optional().describe("Dirección exacta"),
  }),
  execute: async ({ zona, direccion: _direccion }) => {
    const deliveryZones = await getDeliveryZonesFromDB();
    const zonaNormalizada = (zona || "centro").toLowerCase();
    
    const zonaEncontrada = deliveryZones.find(z => 
      zonaNormalizada.includes(z.zona.toLowerCase()) || z.zona.toLowerCase().includes(zonaNormalizada)
    );
    
    if (zonaEncontrada && zonaEncontrada.disponible) {
      return `✅ Sí, delivery a ${zonaEncontrada.zona}!
🕐 Tiempo: ${zonaEncontrada.tiempo}
${zonaEncontrada.costo === 0 ? "💰 Sin costo adicional" : `$${zonaEncontrada.costo}`}`;}
    
    return `✅ Sí, hacemos delivery! El costo de envío estándar es de $3500. Mandanos tu dirección exacta y te confirmamos.`;
  },
});

// --- GET DELIVERY TIME TOOL ---
// Obtiene tiempo estimado de entrega

export const getDeliveryTimeTool = tool({
  description: "Obtiene el tiempo estimado de delivery según la zona",
  inputSchema: z.object({
    zona: z.string().optional(),
  }),
  execute: async ({ zona }) => {
    const deliveryZones = await getDeliveryZonesFromDB();
    const zonaNormalizada = (zona || "centro").toLowerCase();
    const zonaEncontrada = deliveryZones.find(z => 
      zonaNormalizada.includes(z.zona.toLowerCase()) || z.zona.toLowerCase().includes(zonaNormalizada)
    );
    
    return zonaEncontrada?.tiempo || "30-40 min";
  },
});

// --- GET WAIT TIME ---
// Calcula tiempo de demora basado en pedidos pendientes
// Cada hamburguesa: 7 minutos. 1 delivery.
export const getWaitTimeTool = tool({
  description: "Calcula el tiempo de demora estimado segun la cantidad de pedidos pendientes. Cada hamburguesa tarda 7 min en hacerse. Hay 1 delivery.",
  inputSchema: z.object({}),
  execute: async () => {
    const pendingOrders = await db
      .select({ items: ordersTable.items })
      .from(ordersTable)
      .where(eq(ordersTable.status, "pending"))
      .orderBy(desc(ordersTable.createdAt));

    // Contar hamburguesas totales en pedidos pendientes
    let totalBurgers = 0;
    for (const o of pendingOrders) {
      const items = o.items as { name?: string; quantity?: number }[] | null;
      if (!items) continue;
      for (const item of items) {
        if (item.name && item.quantity) {
          totalBurgers += item.quantity;
        }
      }
    }

    const minutosCoccion = totalBurgers * 7;
    const minutosDelivery = 15; // tiempo fijo de delivery
    const totalMinutos = minutosCoccion + minutosDelivery;

    return {
      pedidosPendientes: pendingOrders.length,
      hamburguesasEnCola: totalBurgers,
      minutosEstimado: totalMinutos,
      mensaje: `Hay ${pendingOrders.length} pedido(s) antes. ${totalBurgers} hamburguesas en cola. A 7 min cada una, serían ${totalMinutos} min aproximadamente.`,
    };
  },
});

// --- LISTA DE PRODUCTOS CON STOCK ---
export const listAvailableProductsTool = tool({
  description: "Lista todos los productos disponibles actualmente",
  inputSchema: z.object({
    category: z.enum(["hamburguesa", "acompanamiento", "pan_mayorista", "tragos_vip", "bebidas", "alcohol", "empanadas", "pizzas"]).optional().describe("Categoría a filtrar"),
  }),
  execute: async ({ category }) => {
    const conditions = [eq(products.available, true)];

    if (category) {
      conditions.push(eq(products.category, category));
    }
    
    const items = await db
      .select({
        name: products.name,
        price: products.price,
        description: products.description,
        category: products.category,
      })
      .from(products)
      .where(and(...conditions))
      .orderBy(products.sortOrder);
    
    if (items.length === 0) {
      return "No hay productos disponibles en este momento.";
    }
    
    return items
      .map(i => `• ${i.name} - $${Number(i.price || 0).toLocaleString("es-AR")}${i.description ? ` — ${i.description}` : ""}`)
      .join("\n");
  },
});