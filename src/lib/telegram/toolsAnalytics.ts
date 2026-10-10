import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { and, gte, lte, eq, ne } from "drizzle-orm";
import { resolveClientNamesBatch } from "@/lib/lead-utils";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface OrderItem {
  name: string;
  quantity: number;
  price?: number;
  unitPrice?: number;
}

function parseItems(items: unknown): OrderItem[] {
  if (!Array.isArray(items)) return [];
  return items as OrderItem[];
}

function orderTotal(items: unknown): number {
  return parseItems(items).reduce(
    (sum, item) => sum + ((item.price ?? item.unitPrice ?? 0) * (item.quantity ?? 1)),
    0
  );
}

// ─── analyticsTools: Métricas de negocio para Mrs Muzzarella ────────────────

// getSalesByDateRange - Ventas totales en un rango de fechas
export const getSalesByDateRange = tool({
  description:
    "Ventas totales por rango de fechas. Preguntas: 'cuánto vendimos esta semana', 'ventas del lunes al viernes', 'facturación de mayo'",
  inputSchema: z.object({
    startDate: z
      .string()
      .describe("Fecha inicio en formato YYYY-MM-DD"),
    endDate: z
      .string()
      .describe("Fecha fin en formato YYYY-MM-DD"),
    orderType: z
      .enum(["hamburguesas", "pan_mayorista"])
      .optional()
      .describe("Filtrar por tipo: hamburguesas | pan_mayorista"),
  }),
  execute: async ({ startDate, endDate, orderType }) => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const conditions = [
      gte(orders.createdAt, start),
      lte(orders.createdAt, end),
      ne(orders.status, "cancelled"),
    ];

    if (orderType) {
      conditions.push(eq(orders.orderType, orderType));
    }

    const rows = await db
      .select({
        id: orders.id,
        orderType: orders.orderType,
        items: orders.items,
        status: orders.status,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(...conditions))
      .orderBy(orders.createdAt);

    let totalRevenue = 0;
    let totalItems = 0;
    const byType: Record<string, { count: number; revenue: number }> = {};
    const byDay: Record<string, { count: number; revenue: number }> = {};

    for (const row of rows) {
      const revenue = orderTotal(row.items);
      totalRevenue += revenue;

      const items = parseItems(row.items);
      for (const item of items) {
        totalItems += item.quantity ?? 1;
      }

      const type = row.orderType ?? "otro";
      if (!byType[type]) byType[type] = { count: 0, revenue: 0 };
      byType[type].count += 1;
      byType[type].revenue += revenue;

      const day = row.createdAt?.toLocaleDateString("es-AR", {
        weekday: "short",
        day: "2-digit",
        month: "2-digit",
      }) ?? "?";
      if (!byDay[day]) byDay[day] = { count: 0, revenue: 0 };
      byDay[day].count += 1;
      byDay[day].revenue += revenue;
    }

    return {
      periodo: `${start.toLocaleDateString("es-AR")} → ${end.toLocaleDateString("es-AR")}`,
      pedidosTotales: rows.length,
      itemsDespachados: totalItems,
      ventaTotal: `$${totalRevenue.toLocaleString("es-AR")}`,
      porTipo: Object.entries(byType).map(
        ([type, data]) =>
          `${type === "hamburguesas" ? "Hamburguesas" : "Pan mayorista"}: ${data.count} pedidos — $${data.revenue.toLocaleString("es-AR")}`
      ),
      porDia: Object.entries(byDay).map(
        ([day, data]) => `${day}: ${data.count} pedidos — $${data.revenue.toLocaleString("es-AR")}`
      ),
    };
  },
});

// getTopProducts - Productos más vendidos
export const getTopProducts = tool({
  description:
    "Productos más vendidos. Preguntas: 'qué hamburguesa se vende más', 'top productos', 'cuál es el más pedido'",
  inputSchema: z.object({
    period: z
      .enum(["week", "month", "all"])
      .optional()
      .describe("Período: week | month | all (default month)"),
    limit: z.number().optional().describe("Cuántos mostrar (default 10)"),
  }),
  execute: async ({ period = "month", limit = 10 }) => {
    const now = new Date();
    let start: Date;

    if (period === "week") {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    } else if (period === "month") {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      start = new Date(2020, 0, 1);
    }

    const rows = await db
      .select({ items: orders.items, orderType: orders.orderType })
      .from(orders)
      .where(
        and(
          gte(orders.createdAt, start),
          ne(orders.status, "cancelled")
        )
      );

    const productMap: Record<string, { quantity: number; revenue: number; type: string }> = {};

    for (const row of rows) {
      const items = parseItems(row.items);
      for (const item of items) {
        const key = item.name.toLowerCase().trim();
        if (!productMap[key]) {
          productMap[key] = { quantity: 0, revenue: 0, type: row.orderType ?? "otro" };
        }
        productMap[key].quantity += item.quantity ?? 1;
        productMap[key].revenue += (item.price ?? 0) * (item.quantity ?? 1);
      }
    }

    const sorted = Object.entries(productMap)
      .sort(([, a], [, b]) => b.quantity - a.quantity)
      .slice(0, limit);

    const periodLabels = { week: "esta semana", month: "este mes", all: "histórico" };

    return {
      periodo: periodLabels[period],
      totalProductosDistintos: Object.keys(productMap).length,
      ranking: sorted.map(([name, data], i) => ({
        posicion: i + 1,
        producto: name,
        cantidadVendida: data.quantity,
        ingresos: `$${data.revenue.toLocaleString("es-AR")}`,
        linea: data.type,
      })),
    };
  },
});

// getTopClients - Mejores clientes
export const getTopClients = tool({
  description:
    "Mejores clientes por cantidad de pedidos o gasto. Preguntas: 'quién es nuestro mejor cliente', 'top clientes', 'quiénes piden más'",
  inputSchema: z.object({
    period: z
      .enum(["week", "month", "all"])
      .optional()
      .describe("Período: week | month | all (default month)"),
    sortBy: z
      .enum(["orders", "revenue"])
      .optional()
      .describe("Ordenar por: orders (cantidad) | revenue (gasto). Default: orders"),
    limit: z.number().optional().describe("Cuántos mostrar (default 10)"),
  }),
  execute: async ({ period = "month", sortBy = "orders", limit = 10 }) => {
    const now = new Date();
    let start: Date;

    if (period === "week") {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    } else if (period === "month") {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      start = new Date(2020, 0, 1);
    }

    const rows = await db
      .select({
        phoneNumber: orders.phoneNumber,
        customerName: orders.customerName,
        items: orders.items,
      })
      .from(orders)
      .where(
        and(
          gte(orders.createdAt, start),
          ne(orders.status, "cancelled")
        )
      );

    const clientMap: Record<string, { name: string; orders: number; revenue: number }> = {};

    for (const row of rows) {
      const phone = row.phoneNumber;
      if (!clientMap[phone]) {
        clientMap[phone] = { name: row.customerName ?? "Sin nombre", orders: 0, revenue: 0 };
      }
      clientMap[phone].orders += 1;
      clientMap[phone].revenue += orderTotal(row.items);
    }

    // Resolver nombres desde leads para clientes con pedidos
    const phones = Array.from(Object.keys(clientMap));
    const nameMap = await resolveClientNamesBatch(phones);
    for (const [phone, data] of Object.entries(clientMap)) {
      const resolvedName = nameMap.get(phone);
      if (resolvedName) data.name = resolvedName;
    }

    const sorted = Object.entries(clientMap)
      .sort(([, a], [, b]) =>
        sortBy === "revenue" ? b.revenue - a.revenue : b.orders - a.orders
      )
      .slice(0, limit);

    const periodLabels = { week: "esta semana", month: "este mes", all: "histórico" };

    return {
      periodo: periodLabels[period],
      totalClientes: Object.keys(clientMap).length,
      ranking: sorted.map(([phone, data], i) => ({
        posicion: i + 1,
        nombre: data.name,
        telefono: phone,
        pedidos: data.orders,
        gastoTotal: `$${data.revenue.toLocaleString("es-AR")}`,
      })),
    };
  },
});

// getAverageTicket - Ticket promedio
export const getAverageTicket = tool({
  description:
    "Ticket promedio del negocio. Preguntas: 'cuál es el ticket promedio', 'cuánto gasta la gente en promedio', 'valor promedio de pedido'",
  inputSchema: z.object({
    period: z
      .enum(["today", "week", "month", "all"])
      .optional()
      .describe("Período: today | week | month | all (default month)"),
    orderType: z
      .enum(["hamburguesas", "pan_mayorista"])
      .optional()
      .describe("Filtrar por tipo"),
  }),
  execute: async ({ period = "month", orderType }) => {
    const now = new Date();
    let start: Date;

    if (period === "today") {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === "week") {
      const day = now.getDay();
      const diff = day === 0 ? 6 : day - 1;
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    } else if (period === "month") {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else {
      start = new Date(2020, 0, 1);
    }

    const conditions = [
      gte(orders.createdAt, start),
      ne(orders.status, "cancelled"),
    ];

    if (orderType) {
      conditions.push(eq(orders.orderType, orderType));
    }

    const rows = await db
      .select({ items: orders.items, orderType: orders.orderType })
      .from(orders)
      .where(and(...conditions));

    if (rows.length === 0) {
      return { periodo: period, mensaje: "Sin pedidos en este período." };
    }

    let totalRevenue = 0;
    let minTicket = Infinity;
    let maxTicket = 0;
    const ticketsByType: Record<string, { total: number; count: number }> = {};

    for (const row of rows) {
      const ticket = orderTotal(row.items);
      totalRevenue += ticket;
      if (ticket < minTicket) minTicket = ticket;
      if (ticket > maxTicket) maxTicket = ticket;

      const type = row.orderType ?? "otro";
      if (!ticketsByType[type]) ticketsByType[type] = { total: 0, count: 0 };
      ticketsByType[type].total += ticket;
      ticketsByType[type].count += 1;
    }

    const avgTicket = totalRevenue / rows.length;
    const periodLabels = { today: "hoy", week: "esta semana", month: "este mes", all: "histórico" };

    return {
      periodo: periodLabels[period],
      pedidosAnalizados: rows.length,
      ticketPromedio: `$${Math.round(avgTicket).toLocaleString("es-AR")}`,
      ticketMinimo: `$${Math.round(minTicket).toLocaleString("es-AR")}`,
      ticketMaximo: `$${Math.round(maxTicket).toLocaleString("es-AR")}`,
      ventaTotal: `$${Math.round(totalRevenue).toLocaleString("es-AR")}`,
      porTipo: Object.entries(ticketsByType).map(([type, data]) => ({
        tipo: type === "hamburguesas" ? "Hamburguesas" : "Pan mayorista",
        ticketPromedio: `$${Math.round(data.total / data.count).toLocaleString("es-AR")}`,
        pedidos: data.count,
      })),
    };
  },
});

// ─── Export ─────────────────────────────────────────────────────────────────

export const analyticsTools = {
  getSalesByDateRange,
  getTopProducts,
  getTopClients,
  getAverageTicket,
};
