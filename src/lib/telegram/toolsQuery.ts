import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { orders } from "@/db/schema";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { resolveClientNamesBatch } from "@/lib/lead-utils";
import { argentinaDayStartFromInput, argentinaTodayRange } from "./ar-time";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getTodayRange() {
  return argentinaTodayRange();
}

const statusLabels: Record<string, string> = {
  pending: "pendiente",
  preparing: "preparando",
  ready: "listo para retirar",
  delivered: "entregado",
  cancelled: "cancelado",
};

// ─── queryOrder: Herramientas de consulta de pedidos ──────────────────────

// getOrderById - Consultar un pedido específico
export const getOrderById = tool({
  description:
    "Consulta un pedido específico por su ID. Preguntas: 'dame el pedido 5', 'qué es del pedido 3'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido a consultar"),
  }),
  execute: async ({ orderId }) => {
    const [row] = await db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!row) {
      return { error: `No encontré el pedido #${orderId}` };
    }

    const nameMap = await resolveClientNamesBatch(
      row.phoneNumber ? [row.phoneNumber] : []
    );
    const customer = nameMap.get(row.phoneNumber) ?? row.customerName ?? "Sin nombre";

    return {
      id: row.id,
      customer,
      phone: row.phoneNumber,
      type: row.orderType,
      status: statusLabels[row.status ?? "pending"] ?? row.status,
      items: row.items,
      notes: row.notes,
      createdAt: row.createdAt?.toLocaleString("es-AR"),
    };
  },
});

// getOrderStatus - Ver estado de un pedido
export const getOrderStatus = tool({
  description:
    "Consulta el estado de un pedido. Preguntas: 'estado del pedido 5', 'cómo va mi pedido'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
  }),
  execute: async ({ orderId }) => {
    const [row] = await db
      .select({
        id: orders.id,
        status: orders.status,
        updatedAt: orders.updatedAt,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!row) {
      return { error: `No encontré el pedido #${orderId}` };
    }

    const status = row.status ?? "pending";
    const statusEmoji: Record<string, string> = {
      pending: "⏳",
      preparing: "🔥",
      ready: "✅",
      delivered: "📦",
      cancelled: "❌",
    };

    return {
      id: row.id,
      status: statusLabels[status] ?? status,
      emoji: statusEmoji[status] ?? "❓",
      updatedAt: row.updatedAt?.toLocaleString("es-AR"),
    };
  },
});

// getOrderHistory - Ver historial de pedidos
export const getOrderHistory = tool({
  description:
    "Consulta el historial de pedidos. Preguntas: 'historial de pedidos', 'qué pedidos tuvo'",
  inputSchema: z.object({
    phone: z.string().optional().describe("Teléfono del cliente"),
    limit: z.number().optional().describe("Límite de resultados (default 20)"),
  }),
  execute: async ({ phone, limit = 20 }) => {
    const where = phone
      ? eq(orders.phoneNumber, phone)
      : undefined;

    const rows = await db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        phoneNumber: orders.phoneNumber,
        orderType: orders.orderType,
        status: orders.status,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt))
      .limit(limit);

    const phones = rows.map((r) => r.phoneNumber).filter(Boolean);
    const nameMap = await resolveClientNamesBatch(phones);

    return {
      count: rows.length,
      orders: rows.map((r) => ({
        id: r.id,
        customer: nameMap.get(r.phoneNumber) ?? r.customerName ?? "Sin nombre",
        type: r.orderType,
        status: statusLabels[r.status ?? "pending"] ?? r.status,
        date: r.createdAt?.toLocaleDateString("es-AR", {
          day: "2-digit",
          month: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
      })),
    };
  },
});

// searchOrdersByDate - Buscar pedidos por fecha
export const searchOrdersByDate = tool({
  description:
    "Busca pedidos por fecha. Preguntas: 'qué se vendió ayer', 'pedidos del lunes'",
  inputSchema: z.object({
    date: z.string().optional().describe("Fecha en formato YYYY-MM-DD (default hoy)"),
  }),
  execute: async ({ date }) => {
    // El parámetro es un día calendario Argentina: el rango tiene que
    // cubrir 00:00→24:00 hora local, no el día UTC del servidor.
    const start = date
      ? argentinaDayStartFromInput(date)
      : argentinaTodayRange().start;
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        phoneNumber: orders.phoneNumber,
        orderType: orders.orderType,
        status: orders.status,
        items: orders.items,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, start), lte(orders.createdAt, end)))
      .orderBy(orders.createdAt);

    const byStatus: Record<string, number> = {};
    for (const row of rows) {
      const s = row.status ?? "unknown";
      byStatus[s] = (byStatus[s] ?? 0) + 1;
    }

    const phones = rows.map((r) => r.phoneNumber).filter(Boolean);
    const nameMap = await resolveClientNamesBatch(phones);

    return {
      date: start.toLocaleDateString("es-AR"),
      total: rows.length,
      byStatus: Object.entries(byStatus).map(
        ([key, count]) => `${count} ${statusLabels[key] ?? key}`
      ),
      orders: rows.slice(0, 10).map((r) => ({
        id: r.id,
        customer: nameMap.get(r.phoneNumber) ?? r.customerName ?? "Sin nombre",
        type: r.orderType,
        status: statusLabels[r.status ?? "pending"] ?? r.status,
      })),
    };
  },
});

// getPendingOrders - Ver pedidos pendientes
export const getPendingOrders = tool({
  description:
    "Lista todos los pedidos pendientes. Preguntas: 'qué hay pendiente', 'pedidos por hacer'",
  inputSchema: z.object({}).optional(),
  execute: async () => {
    const rows = await db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        phoneNumber: orders.phoneNumber,
        orderType: orders.orderType,
        items: orders.items,
        notes: orders.notes,
        status: orders.status,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.status, "pending"))
      .orderBy(orders.createdAt);

    const pendingCount = rows.filter((r) => r.status === "pending").length;
    const preparingCount = rows.filter((r) => r.status === "preparing").length;
    const readyCount = rows.filter((r) => r.status === "ready").length;

    const phones = rows.map((r) => r.phoneNumber).filter(Boolean);
    const nameMap = await resolveClientNamesBatch(phones);

    return {
      pending: pendingCount,
      preparing: preparingCount,
      ready: readyCount,
      total: rows.length,
      orders: rows.map((r) => ({
        id: r.id,
        customer: nameMap.get(r.phoneNumber) ?? r.customerName ?? "Sin nombre",
        type: r.orderType,
        items: r.items,
        status: statusLabels[r.status ?? "pending"] ?? r.status,
        createdAt: r.createdAt?.toLocaleTimeString("es-AR", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      })),
    };
  },
});

// getTodaysOrders - Pedidos del día (ya existía, renombrado)
export const getTodaysOrders = tool({
  description:
    "Obtiene resumen de pedidos del día. Preguntas: 'cuántos pedidos hoy', 'qué se vendió hoy'",
  inputSchema: z.object({}).optional(),
  execute: async () => {
    const { start, end } = getTodayRange();

    const rows = await db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        phoneNumber: orders.phoneNumber,
        orderType: orders.orderType,
        status: orders.status,
        items: orders.items,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, start), lte(orders.createdAt, end)))
      .orderBy(orders.createdAt);

    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};

    for (const row of rows) {
      const s = row.status ?? "unknown";
      const t = row.orderType ?? "unknown";
      byStatus[s] = (byStatus[s] ?? 0) + 1;
      byType[t] = (byType[t] ?? 0) + 1;
    }

    const phones = rows.map((r) => r.phoneNumber).filter(Boolean);
    const nameMap = await resolveClientNamesBatch(phones);

    return {
      date: start.toLocaleDateString("es-AR"),
      total: rows.length,
      byStatus: Object.entries(byStatus).map(
        ([key, count]) => `${count} ${statusLabels[key] ?? key}`
      ),
      byType: Object.entries(byType).map(([key, count]) => {
        if (key === "hamburguesas") return `${count} hamburguesas`;
        if (key === "pan_mayorista") return `${count} pan mayorista`;
        return `${count} ${key}`;
      }),
      recentOrders: rows.slice(0, 5).map((r) => ({
        id: r.id,
        customer: nameMap.get(r.phoneNumber) ?? r.customerName ?? "Sin nombre",
        type: r.orderType,
        status: statusLabels[r.status ?? "pending"] ?? r.status,
      })),
    };
  },
});

// Export all queryOrder tools
export const queryOrderTools = {
  getOrderById,
  getOrderStatus,
  getOrderHistory,
  searchOrdersByDate,
  getPendingOrders,
  getTodaysOrders,
};