import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { leads, orders, agentConfig, conversations, chatMessages, products } from "@/db/schema";
import { eq, desc, ilike, or, gte, lte, count, and, asc, sql, type Column, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { normalizePhone } from "@/lib/phone-utils";
import { getArgentinaDayIndex } from "@/lib/argentina-time";

// Formatos soportados de agent_config.business_hours: array por día (admin UI)
// u objeto legacy { enabled, days, open, close }
type BusinessHoursEntry = { day?: string; open?: boolean; openTime?: string; closeTime?: string };
type BusinessHoursData = BusinessHoursEntry[] | { enabled?: boolean; days?: string; open?: string; close?: string };

// ─── manageManagement: Tools de gestión interna ──────────────────────────────

// getClientsTool - Listar últimos 20 clientes/leads
export const getClientsTool = tool({
  description:
    "LISTA los últimos 20 clientes/leads registrados, con nombre, teléfono y estado. USAR cuando el admin pregunta: 'cuántos clientes tenemos', 'mostrame los clientes', 'quiénes se registraron', 'clientes'. Responde con el conteo total y los últimos.",
  inputSchema: z.object({}),
  execute: async () => {
    const rows = await db
      .select({
        id: leads.id,
        name: leads.name,
        phone: leads.phone,
        status: leads.status,
        tags: leads.tags,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .orderBy(desc(leads.createdAt))
      .limit(20);

    if (rows.length === 0) return "No hay clientes registrados.";

    return rows
      .map(
        (r) =>
          `• ${r.name ?? "Sin nombre"} (${r.phone}) — ${r.status}${
            (r.tags as string[])?.length
              ? ` [${(r.tags as string[]).join(", ")}]`
              : ""
          }`
      )
      .join("\n");
  },
});

// getClientDetailTool - Detalle completo por teléfono o nombre
export const getClientDetailTool = tool({
  description:
    "DETALLE COMPLETO de un cliente: datos del lead + últimos 3 pedidos. Busca por teléfono, nombre o alias. USAR cuando el admin pregunta: 'dame todo de X', 'detalle de X', 'quién es X', 'ficha de X'. Más completo que searchClient.",
  inputSchema: z.object({
    query: z.string().describe("Teléfono o nombre del cliente"),
  }),
  execute: async ({ query }) => {
    // Si el query parece un teléfono (contiene dígitos y +, espacios, guiones), normalizarlo
    const phoneQuery = /^[+\d\s\-()]+$/.test(query) ? normalizePhone(query) : query;
    // Buscar por teléfono exacto primero, luego por nombre o alias parcial
    const [lead] = await db
      .select({
        id: leads.id,
        name: leads.name,
        phone: leads.phone,
        email: leads.email,
        status: leads.status,
        notes: leads.notes,
        alias: leads.alias,
        tags: leads.tags,
        firstMessage: leads.firstMessage,
        utmSource: leads.utmSource,
        utmCampaign: leads.utmCampaign,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(
        or(
          eq(leads.phone, phoneQuery),
          ilike(leads.name, `%${query}%`),
          ilike(leads.alias, `%${query}%`)
        )
      )
      .orderBy(desc(leads.createdAt))
      .limit(1);

    if (!lead) {
      return `No encontré ningún cliente que coincida con "${query}".`;
    }

    // Últimos 3 pedidos del cliente
    const recentOrders = await db
      .select({
        id: orders.id,
        orderType: orders.orderType,
        status: orders.status,
        items: orders.items,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(eq(orders.phoneNumber, lead.phone ?? ""))
      .orderBy(desc(orders.createdAt))
      .limit(3);

    const statusLabels: Record<string, string> = {
      pending: "pendiente",
      preparing: "preparando",
      ready: "listo",
      delivered: "entregado",
      cancelled: "cancelado",
    };

    const lines: string[] = [
      `👤 ${lead.name ?? "Sin nombre"} | ${lead.phone}`,
      `Estado: ${lead.status}`,
    ];
    if (lead.email) lines.push(`Email: ${lead.email}`);
    if ((lead.tags as string[])?.length)
      lines.push(`Tags: ${(lead.tags as string[]).join(", ")}`);
    if (lead.notes) lines.push(`Notas: ${lead.notes}`);
    if (lead.utmSource) lines.push(`Fuente: ${lead.utmSource}${lead.utmCampaign ? ` / ${lead.utmCampaign}` : ""}`);
    if (lead.firstMessage) lines.push(`Primer mensaje: "${lead.firstMessage}"`);
    lines.push(`Registrado: ${lead.createdAt?.toLocaleDateString("es-AR")}`);

    if (recentOrders.length > 0) {
      lines.push(`\nÚltimos pedidos (${recentOrders.length}):`);
      for (const o of recentOrders) {
        lines.push(
          `  #${o.id} — ${o.orderType ?? "?"} — ${statusLabels[o.status ?? "pending"] ?? o.status} — ${o.createdAt?.toLocaleDateString("es-AR")}`
        );
      }
    } else {
      lines.push("\nSin pedidos registrados.");
    }

    return lines.join("\n");
  },
});

// searchClientTool - Buscar clientes por nombre, teléfono, email o alias
export const searchClientTool = tool({
  description:
    "BUSCAR clientes por nombre, teléfono, email o apodo. Devuelve hasta 10 coincidencias parciales. USAR CUANDO: el admin da un nombre y no sabés el teléfono. 'buscá a García', 'hay algún cliente con email xxx', 'buscá el Flaco'. Es el PRIMER PASO para encontrar un cliente.",
  inputSchema: z.object({
    query: z.string().describe("Nombre, teléfono o email a buscar"),
  }),
  execute: async ({ query }) => {
    // Si el query parece un teléfono, también buscar con el formato normalizado
    const phoneQuery = /^[+\d\s\-()]+$/.test(query) ? normalizePhone(query) : query;
    const rows = await db
      .select({
        id: leads.id,
        name: leads.name,
        phone: leads.phone,
        email: leads.email,
        status: leads.status,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .where(
        or(
          ilike(leads.name, `%${query}%`),
          ilike(leads.phone, `%${phoneQuery}%`),
          ilike(leads.email, `%${query}%`),
          ilike(leads.alias, `%${query}%`)
        )
      )
      .orderBy(desc(leads.createdAt))
      .limit(10);

    if (rows.length === 0) {
      return `No encontré clientes que coincidan con "${query}".`;
    }

    const lines = [`Encontré ${rows.length} cliente(s):`];
    for (const r of rows) {
      lines.push(
        `• #${r.id} ${r.name ?? "Sin nombre"} — ${r.phone}${r.email ? ` — ${r.email}` : ""} — ${r.status}`
      );
    }
    return lines.join("\n");
  },
});

// updateOrderStatusTool - Cambiar estado de un pedido (alias mejorado)
export const updateOrderStatusTool = tool({
  description:
    "Cambia el estado de un pedido. Preguntas: 'el pedido 5 está listo', 'marcá el pedido 3 como entregado', 'cancelá el pedido 7'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
    status: z
      .enum(["preparing", "ready", "delivered", "cancelled"])
      .describe("Nuevo estado: preparing | ready | delivered | cancelled"),
  }),
  execute: async ({ orderId, status }) => {
    const [existing] = await db
      .select({ id: orders.id, status: orders.status, customerName: orders.customerName })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return `No encontré el pedido #${orderId}.`;
    }

    const statusLabels: Record<string, string> = {
      pending: "pendiente",
      preparing: "en preparación",
      ready: "listo para retirar",
      delivered: "entregado",
      cancelled: "cancelado",
    };

    await db
      .update(orders)
      .set({ status, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return `✅ Pedido #${orderId}${existing.customerName ? ` (${existing.customerName})` : ""} marcado como *${statusLabels[status]}*.`;
  },
});

// getAnalyticsTool - Métricas de ventas por período
export const getAnalyticsTool = tool({
  description:
    "Métricas de ventas por período. Preguntas: 'cómo vamos hoy', 'ventas de esta semana', 'resumen del mes', 'estadísticas'",
  inputSchema: z.object({
    period: z
      .enum(["today", "week", "month"])
      .describe("Período: today | week | month"),
  }),
  execute: async ({ period }) => {
    const now = new Date();
    let start: Date;

    if (period === "today") {
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (period === "week") {
      const day = now.getDay(); // 0=dom, 1=lun...
      const diff = (day === 0 ? 6 : day - 1); // lunes como inicio
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - diff);
    } else {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const end = new Date(now.getTime() + 1); // +1ms para incluir ahora

    // Pedidos del período
    const periodOrders = await db
      .select({
        id: orders.id,
        status: orders.status,
        orderType: orders.orderType,
        items: orders.items,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, start), lte(orders.createdAt, end)));

    // Nuevos leads del período
    const newLeadsResult = await db
      .select({ count: count() })
      .from(leads)
      .where(and(gte(leads.createdAt, start), lte(leads.createdAt, end)));

    const newLeadsCount = newLeadsResult[0]?.count ?? 0;

    // Conteo por estado
    const byStatus: Record<string, number> = {};
    let totalItems = 0;

    for (const o of periodOrders) {
      const s = o.status ?? "unknown";
      byStatus[s] = (byStatus[s] ?? 0) + 1;

      const items = o.items as { name: string; quantity: number }[];
      if (Array.isArray(items)) {
        for (const item of items) {
          totalItems += item.quantity ?? 1;
        }
      }
    }

    const periodLabels = { today: "hoy", week: "esta semana", month: "este mes" };

    const statusLabels: Record<string, string> = {
      pending: "pendiente",
      preparing: "preparando",
      ready: "listo",
      delivered: "entregado",
      cancelled: "cancelado",
    };

    const lines = [
      `📊 Resumen ${periodLabels[period]}:`,
      `• Pedidos totales: ${periodOrders.length}`,
      `• Items despachados: ${totalItems}`,
      `• Nuevos leads: ${newLeadsCount}`,
      ``,
      `Por estado:`,
    ];

    for (const [s, c] of Object.entries(byStatus)) {
      lines.push(`  ${statusLabels[s] ?? s}: ${c}`);
    }

    if (periodOrders.length === 0) {
      lines.push("  Sin pedidos en este período.");
    }

    return lines.join("\n");
  },
});

// getBusinessHoursTool - Ver horarios de atención y si está abierto ahora
export const getBusinessHoursTool = tool({
  description:
    "Muestra los horarios de atención del negocio y si está abierto ahora. Preguntas: 'estamos abiertos?', 'cuáles son los horarios', 'a qué hora cerramos'",
  inputSchema: z.object({}),
  execute: async () => {
    const [config] = await db
      .select({ businessHours: agentConfig.businessHours })
      .from(agentConfig)
      .limit(1);

    if (!config?.businessHours) {
      return "No hay horarios configurados todavía.";
    }

    const data = config.businessHours as BusinessHoursData;

    // Soporte para ambos formatos: array (admin UI) y objeto legacy
    let days: (string | undefined)[], openTime: string, closeTime: string, isEnabled: boolean;

    if (Array.isArray(data)) {
      // Formato array: [{ day: "Lunes", openTime: "05:00", ... }]
      const abiertos = data.filter((d) => d.open !== false);
      if (abiertos.length === 0) return "Los horarios automáticos están desactivados.";
      days = abiertos.map((d) => d.day);
      openTime = abiertos[0]?.openTime || "—";
      closeTime = abiertos[0]?.closeTime || "—";
      isEnabled = true;
    } else {
      // Formato objeto legacy: { enabled, days, open, close }
      if (!data.enabled) return "Los horarios automáticos están desactivados.";
      days = (data.days || "").split(/,\s*/);
      openTime = data.open || "—";
      closeTime = data.close || "—";
      isEnabled = true;
    }

    const { getArgentinaMinutes } = await import("@/lib/argentina-time");
    const currentMinutes = getArgentinaMinutes();
    const parseTime = (t: string) => { const [h, m] = t.split(":").map(Number); return h * 60 + (m ?? 0); };
    const openM = parseTime(openTime);
    const closeM = parseTime(closeTime);
    const isOpen = isEnabled && currentMinutes >= openM && currentMinutes < closeM;

    const timeStr = new Date().toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit" });

    return [
      `🕐 Horarios de atención:`,
      `• Días: ${days.join(", ")}`,
      `• Apertura: ${openTime}`,
      `• Cierre: ${closeTime}`,
      ``,
      isOpen
        ? `✅ Ahora estamos ABIERTOS (${timeStr})`
        : `❌ Ahora estamos CERRADOS (${timeStr})`,
    ].join("\n");
  },
});

// ─── updateBusinessHoursTool ─────────────────────────────────────────────────
const ALL_DAYS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

function parseDays(daysStr: string): string[] {
  const s = daysStr.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // "todos los dias" o "todos" → todos
  if (s.includes("todos") || s.includes("siempre")) return [...ALL_DAYS];
  // "lunes a viernes" → lunes, martes, miercoles, jueves, viernes
  const rangeMatch = s.match(/(\w+)\s*a\s*(\w+)/);
  if (rangeMatch) {
    const from = rangeMatch[1];
    const to = rangeMatch[2];
    const startIdx = ALL_DAYS.findIndex(d => d.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").startsWith(from));
    const endIdx = ALL_DAYS.findIndex(d => d.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").startsWith(to));
    if (startIdx !== -1 && endIdx !== -1) {
      return ALL_DAYS.slice(startIdx, endIdx + 1);
    }
  }
  // "lunes, martes, miercoles" → lista separada por comas
  const dayNames = s.split(/[,;]+/).map(d => d.trim()).filter(Boolean);
  if (dayNames.length > 0) {
    const matched = dayNames.map(d => ALL_DAYS.find(ad => ad.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").startsWith(d.slice(0, 3)))).filter(Boolean) as string[];
    if (matched.length > 0) return matched;
  }
  // "hoy" → día actual
  if (s.includes("hoy")) {
    const todayIdx = getArgentinaDayIndex(); // 0=domingo
    return [ALL_DAYS[todayIdx === 0 ? 6 : todayIdx - 1]]; // ajustar a array empezando lunes
  }
  // fallback: todos
  return [...ALL_DAYS];
}

export const updateBusinessHoursTool = tool({
  description:
    "ACTUALIZA los horarios de atención del negocio. Usar cuando el admin pida cambiar horarios. Parámetros: enabled (true/false), days (ej: 'Lunes a Viernes', 'todos los dias', 'hoy'), openTime (ej: '05:00'), closeTime (ej: '23:45'). SIEMPRE actualizá con los datos que te den, no preguntes de más.",
  inputSchema: z.object({
    enabled: z.boolean().describe("true si el negocio está abierto, false si cerrado"),
    days: z.string().describe("Días de atención. Ej: 'Lunes a Viernes', 'todos los dias', 'hoy', 'Lunes y Martes'"),
    openTime: z.string().describe("Hora de apertura formato HH:MM. Ej: '05:00'"),
    closeTime: z.string().describe("Hora de cierre formato HH:MM. Ej: '23:45'"),
  }),
  execute: async ({ enabled, days, openTime, closeTime }) => {
    const resolvedDays = parseDays(days);
    
    // Guardar en el MISMO formato que el admin UI (array de objetos)
    const businessHoursArray = resolvedDays.map(day => ({
      day,
      open: enabled,
      openTime,
      closeTime,
    }));

    const [existing] = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    if (existing) {
      await db
        .update(agentConfig)
        .set({
          businessHours: businessHoursArray,
          updatedAt: new Date(),
        })
        .where(eq(agentConfig.id, 1));
    } else {
      await db.insert(agentConfig).values({
        id: 1,
        businessHours: businessHoursArray,
      });
    }

    return `✅ Horarios actualizados:
• Días: ${resolvedDays.join(", ")}
• Apertura: ${openTime}
• Cierre: ${closeTime}
• Estado: ${enabled ? "Abierto" : "Cerrado"}`;
  },
});

// ─── getConversationsTool ────────────────────────────────────────────────────
export const getConversationsTool = tool({
  description:
    "Lista las últimas conversaciones de WhatsApp. Preguntas: 'mostrame los chats', 'conversaciones recientes', 'qué están hablando los clientes'",
  inputSchema: z.object({
    limit: z.number().optional().default(10).describe("Cantidad de conversaciones a mostrar (max 20)"),
  }),
  execute: async ({ limit }) => {
    const { conversations: convTable } = await import("@/db/schema");
    const rows = await db
      .select({
        id: convTable.id,
        customerName: convTable.customerName,
        customerPhone: convTable.customerPhone,
        status: convTable.status,
        lastMessageAt: convTable.lastMessageAt,
        lastMessagePreview: convTable.lastMessagePreview,
      })
      .from(convTable)
      .orderBy(desc(convTable.lastMessageAt))
      .limit(Math.min(limit, 20));

    if (rows.length === 0) return "No hay conversaciones.";

    return rows.map((r) =>
      `• #${r.id} ${r.customerName ?? "?"} (${r.customerPhone}) — ${r.status}${r.lastMessageAt ? ` — ${r.lastMessageAt.toLocaleString("es-AR")}` : ""}${r.lastMessagePreview ? `: "${r.lastMessagePreview.slice(0, 50)}"` : ""}`
    ).join("\n");
  },
});

// ─── updateAgentConfigTool ──────────────────────────────────────────────────
export const updateAgentConfigTool = tool({
  description:
    "ACTUALIZA cualquier configuración del negocio en tiempo real. Usar cuando el admin pida cambios en: cocina (isCooking), hamburguesas sin stock (hamburguesasSinStock), stock de pan (stockPanDocenas), alias de pago (aliasB2c/aliasB2b), tiempo de espera (tiempoEspera), o cualquier campo de configuración. Solo envía los campos que querés cambiar.",
  inputSchema: z.object({
    isCooking: z.boolean().optional().describe("true = cocina abierta, false = cocina cerrada"),
    hamburguesasSinStock: z.boolean().optional().describe("true = sin stock de hamburguesas, false = hay stock"),
    stockPanDocenas: z.number().int().min(0).optional().describe("Stock de pan en docenas"),
    aliasB2c: z.string().optional().describe("Alias de Mercado Pago para hamburguesas (B2C)"),
    aliasB2b: z.string().optional().describe("Alias de Mercado Pago para pan mayorista (B2B)"),
    tiempoEspera: z.string().optional().describe("Tiempo de espera estimado. Ej: '30-40 min'"),
  }),
  execute: async (args) => {
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    const changed: string[] = [];

    if (args.isCooking !== undefined) { updates.isCooking = args.isCooking; changed.push(`cocina: ${args.isCooking ? "abierta" : "cerrada"}`); }
    if (args.hamburguesasSinStock !== undefined) { updates.hamburguesasSinStock = args.hamburguesasSinStock; changed.push(`hamburguesas sin stock: ${args.hamburguesasSinStock ? "si" : "no"}`); }
    if (args.stockPanDocenas !== undefined) { updates.stockPanDocenas = args.stockPanDocenas; changed.push(`stock pan: ${args.stockPanDocenas} doc`); }
    if (args.aliasB2c !== undefined) { updates.aliasB2c = args.aliasB2c; changed.push(`alias B2C: ${args.aliasB2c}`); }
    if (args.aliasB2b !== undefined) { updates.aliasB2b = args.aliasB2b; changed.push(`alias B2B: ${args.aliasB2b}`); }
    if (args.tiempoEspera !== undefined) { updates.tiempoEspera = args.tiempoEspera; changed.push(`tiempo espera: ${args.tiempoEspera}`); }

    if (changed.length === 0) return "No especificaste qué cambiar. Pasá al menos un parámetro.";

    const [existing] = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    if (existing) {
      await db.update(agentConfig).set(updates).where(eq(agentConfig.id, 1));
    } else {
      await db.insert(agentConfig).values({ id: 1, ...updates });
    }

    return `✅ Configuración actualizada:\n${changed.join("\n")}`;
  },
});

// ─── queryDataTool ──────────────────────────────────────────────────────────
// Tool genérica para consultar CUALQUIER tabla de la base de datos
// con filtros inteligentes. El LLM decide qué tabla, columnas y filtros usar.
export const queryDataTool = tool({
  description:
    "META-TOOL: consultar tablas de la base de datos. Sirve para TODO lo que no cubren las otras tools específicas: filtrar pedidos por fecha, buscar productos por precio, contar registros, etc. Tablas: conversations (chats), leads (clientes), orders (pedidos), products (productos), chat_messages (mensajes). USAR cuando: 'mostrame los pedidos de la semana', 'cuántos leads nuevos hoy', 'qué productos cuestan menos de 5000'.",
  inputSchema: z.object({
    table: z.enum(["conversations", "leads", "orders", "products", "chat_messages"])
      .describe("Nombre de la tabla a consultar"),
    filters: z.array(z.object({
      column: z.string().describe("Nombre de la columna. Ej: 'id', 'name', 'phone', 'status', 'customerName', 'orderType'"),
      operator: z.enum(["eq", "neq", "like", "gt", "gte", "lt", "lte"]).describe("Operador: eq (igual), neq (distinto), like (contiene), gt/gte/lt/lte (mayor/menor que)"),
      value: z.string().describe("Valor a buscar. Para texto usá el texto, para números usá el número como string"),
    })).optional().describe("Filtros a aplicar. Se combinan con AND."),
    orderBy: z.string().optional().describe("Columna por la que ordenar. Por defecto: createdAt o id"),
    orderDir: z.enum(["asc", "desc"]).optional().default("desc").describe("Dirección del orden"),
    limit: z.number().int().min(1).max(50).optional().default(20).describe("Cantidad máxima de resultados"),
  }),
  execute: async ({ table, filters, orderBy, orderDir, limit }) => {
    try {
      // Map table names to actual drizzle queries.
      // `users` (password hashes) and `agent_config` (ycloudApiKey,
      // metaAccessToken) are excluded — the LLM context must never see
      // credentials even via prompt injection.
      const tableMap: Record<string, PgTable> = {
        conversations, leads, orders, products, chatMessages,
      };

      const tbl = tableMap[table];
      if (!tbl) return `Tabla "${table}" no disponible para consulta directa.`;

      // Acceso dinámico a columnas por nombre (filtros declarativos del tool)
      const cols = tbl as unknown as Record<string, Column>;

      // Build WHERE conditions
      const conditions: SQL[] = [];
      for (const f of filters || []) {
        const col = cols[f.column];
        if (!col) continue; // skip unknown columns

        if (f.operator === "eq") conditions.push(eq(col, f.value));
        else if (f.operator === "neq") conditions.push(sql`${col} != ${f.value}`);
        else if (f.operator === "like") conditions.push(ilike(col, `%${f.value}%`));
        else if (f.operator === "gt") conditions.push(sql`${col} > ${f.value}::numeric`);
        else if (f.operator === "gte") conditions.push(sql`${col} >= ${f.value}::numeric`);
        else if (f.operator === "lt") conditions.push(sql`${col} < ${f.value}::numeric`);
        else if (f.operator === "lte") conditions.push(sql`${col} <= ${f.value}::numeric`);
      }

      // Default order
      const orderFn = orderDir === "asc" ? asc : desc;
      const finalOrder = orderBy ? orderFn(cols[orderBy]) : desc(cols.createdAt || cols.id);

      const rows = await db
        .select()
        .from(tbl)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(finalOrder)
        .limit(limit);

      if (rows.length === 0) return `No se encontraron resultados en "${table}" con esos filtros.`;

      // Format results as compact text
      const headers = Object.keys(rows[0]).slice(0, 8); // max 8 columns
      return rows.map((row: Record<string, unknown>) => {
        return headers.map((h) => {
          const val = row[h];
          if (val === null || val === undefined) return "";
          if (val instanceof Date) return val.toLocaleString("es-AR");
          if (typeof val === "object") return JSON.stringify(val).slice(0, 100);
          return String(val).slice(0, 80);
        }).filter(Boolean).join(" | ");
      }).join("\n");
    } catch (e: unknown) {
      return `Error al consultar: ${(e as Error).message || "desconocido"}`;
    }
  },
});

// ─── getBusinessSummary ──────────────────────────────────────────────────────
// Resumen ejecutivo del negocio en UNA sola llamada (cocina, pedidos pendientes, data rápida)
export const getBusinessSummaryTool = tool({
  description:
    "RESUMEN EJECUTIVO del negocio en UNA llamada. Devuelve: estado de cocina, pedidos pendientes, pedidos hoy, leads nuevos, stock de pan, alias configurados. PREGUNTAS: 'cómo vamos?', 'resumen del negocio', 'qué onda hoy?', 'dame el panorama general'",
  inputSchema: z.object({}),
  execute: async () => {
    const [config] = await db.select().from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [pendingOrders] = await db
      .select({ count: count() }).from(orders)
      .where(eq(orders.status, "pending"));

    const [todayOrders] = await db
      .select({ count: count() }).from(orders)
      .where(and(gte(orders.createdAt, today), lte(orders.createdAt, new Date(today.getTime() + 86400000))));

    const [newLeads] = await db
      .select({ count: count() }).from(leads)
      .where(gte(leads.createdAt, today));

    const lines = [
      `📊 *RESUMEN DEL NEGOCIO*`,
      ``,
      `👨‍🍳 Cocina: ${config?.isCooking ? "✅ Abierta" : "❌ Cerrada"}`,
      `🍔 Hamburguesas: ${config?.hamburguesasSinStock ? "❌ Sin stock" : "✅ Con stock"}`,
      `⏰ Horarios: ${config?.businessHours ? `${(config.businessHours as { days?: string; open?: string; close?: string }).days || "?"} ${(config.businessHours as { open?: string }).open || "?"}-${(config.businessHours as { close?: string }).close || "?"}` : "No configurados"}`,
      `📦 Pedidos pendientes: ${pendingOrders?.count || 0}`,
      `📅 Pedidos hoy: ${todayOrders?.count || 0}`,
      `🆕 Leads hoy: ${newLeads?.count || 0}`,
      `🍞 Stock pan: ${config?.stockPanDocenas || 0} docenas`,
      `🏷️ Alias B2C: ${config?.aliasB2c || "—"}`,
      `🏷️ Alias B2B: ${config?.aliasB2b || "—"}`,
      `⏱ Tiempo espera: ${config?.tiempoEspera || "30-40 min"}`,
    ];

    return lines.join("\n");
  },
});

// ─── getConversationMessages ─────────────────────────────────────────────────
// Ver el historial de mensajes de una conversación específica
export const getConversationMessagesTool = tool({
  description:
    "Muestra el historial COMPLETO de mensajes de una conversación de WhatsApp. PREGUNTAS: 'mostrame el chat con Hector', 'qué dijo el cliente X?', 'historial de la conversación 5'",
  inputSchema: z.object({
    conversationId: z.number().optional().describe("ID de la conversación (si se sabe)"),
    customerPhone: z.string().optional().describe("Teléfono del cliente para buscar su conversación"),
    customerName: z.string().optional().describe("Nombre del cliente para buscar"),
  }),
  execute: async ({ conversationId, customerPhone, customerName }) => {
    let convId = conversationId;

    if (!convId) {
      if (customerName) {
        // Buscar por customerName O leads.name (managed name)
        const otherConditions = [];
        if (customerPhone) otherConditions.push(eq(conversations.customerPhone, customerPhone));

        const [conv] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .leftJoin(leads, eq(leads.phone, conversations.customerPhone))
          .where(
            and(
              or(
                ilike(conversations.customerName, `%${customerName}%`),
                ilike(leads.name, `%${customerName}%`)
              ),
              ...otherConditions
            )
          )
          .orderBy(desc(conversations.lastMessageAt))
          .limit(1);

        if (!conv) return "No encontré esa conversación.";
        convId = conv.id;
      } else if (customerPhone) {
        const [conv] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.customerPhone, customerPhone))
          .orderBy(desc(conversations.lastMessageAt))
          .limit(1);

        if (!conv) return "No encontré esa conversación.";
        convId = conv.id;
      } else {
        return "Necesito un ID de conversación, teléfono o nombre del cliente.";
      }
    }

    const messages = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
        contentAttributes: chatMessages.contentAttributes,
      })
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, convId))
      .orderBy(asc(chatMessages.createdAt))
      .limit(50);

    if (messages.length === 0) return `La conversación #${convId} no tiene mensajes.`;

    return messages.map((m) => {
      const time = m.createdAt ? m.createdAt.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "";
      const role = m.role === "user" ? "👤 Cliente" : "🤖 Bot";
      const content = m.content?.slice(0, 200) || "";
      return `${time} ${role}: ${content}`;
    }).join("\n");
  },
});

// ─── getActivePromotions ─────────────────────────────────────────────────────
// Lee las promociones activas desde la config del WhatsApp agent
export const getActivePromotionsTool = tool({
  description:
    "Lee las PROMOCIONES ACTIVAS configuradas desde el panel admin. Esto es lo mismo que usa el agente de WhatsApp para ofrecer descuentos. PREGUNTAS: 'qué promos hay?', 'promociones activas', 'qué ofertas tenemos?'",
  inputSchema: z.object({}),
  execute: async () => {
    const [config] = await db
      .select({ promos: agentConfig.whatsappPromociones, aliasB2c: agentConfig.aliasB2c })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    if (!config?.promos || !config.promos.trim()) {
      return "No hay promociones activas configuradas. Agregalas desde el panel admin → Agente IA.";
    }

    return `🏷️ *PROMOCIONES ACTIVAS:*\n${config.promos}`;
  },
});

// ─── getCustomerFullProfileTool - Perfil completo del cliente ────────────────

export const getCustomerFullProfileTool = tool({
  description:
    "Obtiene el perfil COMPLETO de un cliente: datos del lead, pedidos anteriores, pedido actual, direcciones guardadas, items del pedido en curso, tipo de cliente (b2c/b2b), preferencias de productos. Preguntas: 'dame el perfil de flor', 'qué sabe de Juan', 'cómo viene el pedido de María'",
  inputSchema: z.object({
    query: z.string().describe("Nombre o teléfono del cliente a buscar"),
  }),
  execute: async ({ query }) => {
    // Si el query parece un teléfono, normalizarlo para la búsqueda
    const phoneQuery = /^[+\d\s\-()]+$/.test(query) ? normalizePhone(query) : query;
    // 1. Buscar el lead
    const [lead] = await db
      .select()
      .from(leads)
      .where(
        or(
          ilike(leads.name, `%${query}%`),
          ilike(leads.phone, `%${phoneQuery}%`)
        )
      )
      .limit(1);

    if (!lead) return `No encontré un cliente para "${query}".`;

    const sections: string[] = [];
    sections.push(`📋 PERFIL DE ${lead.name?.toUpperCase() || "SIN NOMBRE"}`);
    sections.push(`📱 ${lead.phone}${lead.email ? ` — ${lead.email}` : ""}`);
    sections.push(`🏷️ ${lead.status || "sin estado"}${lead.type ? ` — ${lead.type === "b2b" ? "BUSINESS" : "CONSUMIDOR"}` : ""}`);
    if (lead.address) sections.push(`📍 ${lead.address}`);
    if (lead.notes) sections.push(`📝 ${lead.notes}`);

    // 2. Pedidos anteriores
    const clientOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.phoneNumber, lead.phone ?? ""))
      .orderBy(desc(orders.createdAt))
      .limit(10);

    if (clientOrders.length > 0) {
      sections.push(`\n📦 PEDIDOS (${clientOrders.length}):`);
      for (const o of clientOrders.slice(0, 5)) {
        const items = o.items as { name?: string; quantity?: number; unitPrice?: number | string; price?: number | string }[] | null;
        const summary = items?.slice(0, 2).map(i => `${i.quantity || 1}x ${i.name || ""}`).join(", ") || "";
        const delivery = o.deliveryFee && Number(o.deliveryFee) > 0 ? ` + $${Number(o.deliveryFee)} delivery` : "";
        const total = items?.reduce((s, i) => s + (i.quantity || 0) * Number(i.unitPrice || i.price || 0), 0) || 0;
        sections.push(`• #${o.id} ${o.status}: ${summary} — $${total}${delivery}`);
      }
    } else {
      sections.push(`\n📦 Sin pedidos (es lead, no cliente)`);
    }

    // 3. Direcciones guardadas
    try {
      const { getCustomerAddresses } = await import("@/lib/addresses");
      const addrs = await getCustomerAddresses(lead.phone ?? "");
      if (addrs.length > 0) {
        sections.push(`\n📍 DIRECCIONES (${addrs.length}):`);
        for (const a of addrs) {
          sections.push(`• ${a.address}${a.mapsLink ? ` — ${a.mapsLink}` : ""}`);
        }
      }
    } catch {}

    // 4. Items del pedido en curso (order context)
    try {
      const { getOrderContextSummary, formatOrderSummary } = await import("@/lib/order-context");
      if (lead.conversationId) {
        const ctxItems = await getOrderContextSummary(lead.conversationId);
        if (ctxItems.length > 0) {
          const ctxText = formatOrderSummary(ctxItems);
          sections.push(`\n${ctxText}`);
        }
      }
    } catch {}

    return sections.join("\n");
  },
});

// ─── getConversationContextTool - Contexto completo de conversación WhatsApp ───
// Combina: items del pedido actual + direcciones + tipo de cliente + historial
export const getConversationContextTool = tool({
  description:
    "Obtiene el contexto COMPLETO de una conversación de WhatsApp: items del pedido actual, direcciones guardadas, tipo de cliente (b2c/b2b), y últimos mensajes. PREGUNTAS: 'mostrame el pedido de Hector', 'qué contexto tiene la conversación 5', 'cómo viene el chat con Maria'",
  inputSchema: z.object({
    conversationId: z
      .number()
      .optional()
      .describe("ID de la conversación en WhatsApp"),
    customerPhone: z
      .string()
      .optional()
      .describe("Teléfono del cliente para buscar su conversación"),
  }),
  execute: async ({ conversationId, customerPhone }) => {
    let convId = conversationId;

    // Resolver conversationId por phone si es necesario
    if (!convId) {
      if (!customerPhone)
        return "Necesito un ID de conversación o un teléfono de cliente.";
      const [conv] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.customerPhone, customerPhone))
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1);
      if (!conv)
        return `No encontré una conversación para el teléfono ${customerPhone}.`;
      convId = conv.id;
    }

    const sections: string[] = [];
    sections.push(`📋 CONTEXTO DE CONVERSACIÓN #${convId}`);

    // 1. Datos de la conversación (nombre + teléfono)
    const [conv] = await db
      .select({
        customerPhone: conversations.customerPhone,
        customerName: conversations.customerName,
      })
      .from(conversations)
      .where(eq(conversations.id, convId))
      .limit(1);

    if (!conv) return `No encontré la conversación #${convId}.`;

    const phone = conv.customerPhone;
    if (conv.customerName) sections.push(`👤 Cliente: ${conv.customerName}`);
    if (phone) sections.push(`📱 Tel: ${phone}`);

    // 2. Tipo de cliente (b2c/b2b)
    if (phone) {
      const [lead] = await db
        .select({ type: leads.type, name: leads.name })
        .from(leads)
        .where(eq(leads.phone, phone))
        .limit(1);
      if (lead) {
        sections.push(
          `🏷️ Tipo: ${lead.type === "b2b" ? "BUSINESS (B2B)" : "CONSUMIDOR (B2C)"}`
        );
      }
    }

    // 3. Direcciones guardadas
    if (phone) {
      try {
        const { getCustomerAddresses, formatAddressesForPrompt } = await import(
          "@/lib/addresses"
        );
        const addrs = await getCustomerAddresses(phone);
        const addrText = formatAddressesForPrompt(addrs);
        if (addrText) sections.push(addrText);
      } catch {}
    }

    // 4. Items del pedido actual (order context)
    try {
      const { getOrderContextSummary, formatOrderSummary } = await import(
        "@/lib/order-context"
      );
      const ctxItems = await getOrderContextSummary(convId);
      const ctxText = formatOrderSummary(ctxItems);
      if (ctxText) sections.push(ctxText);
    } catch {}

    // 5. Últimos 10 mensajes
    const recentMessages = await db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.conversationId, convId),
          sql`${chatMessages.role} IN ('user', 'assistant')`
        )
      )
      .orderBy(desc(chatMessages.createdAt))
      .limit(10);

    if (recentMessages.length > 0) {
      sections.push(`\n💬 ÚLTIMOS MENSAJES:`);
      for (const m of recentMessages.reverse()) {
        const role =
          m.role === "user" ? "👤 Cliente" : "🤖 Karen";
        const time = m.createdAt
          ? m.createdAt.toLocaleTimeString("es-AR", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
        sections.push(`${time} ${role}: ${m.content?.slice(0, 150) || ""}`);
      }
    }

    return (
      sections.join("\n") ||
      `No se encontró contexto para la conversación #${convId}.`
    );
  },
});

// ─── setHumanOverrideTool - Activar/desactivar control humano ─────────────────
export const setHumanOverrideTool = tool({
  description:
    "ACTIVA o DESACTIVA el control humano sobre una conversación de WhatsApp. Cuando está activado, el AI de WhatsApp DEJA de responder y el admin toma control. Cuando se desactiva, el AI vuelve a responder. PREGUNTAS: 'tomá control del chat 5', 'desactivá override de la conversación 3', 'modo manual para Maria'",
  inputSchema: z.object({
    conversationId: z.number().describe("ID de la conversación"),
    enabled: z
      .boolean()
      .describe(
        "true = activar override (AI deja de responder), false = desactivar (AI vuelve a responder)"
      ),
  }),
  execute: async ({ conversationId, enabled }) => {
    const [existing] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!existing)
      return `No encontré la conversación #${conversationId}.`;

    await db
      .update(conversations)
      .set({
        humanOverrideUntil: enabled
          ? new Date(Date.now() + 24 * 60 * 60 * 1000)
          : null,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    return enabled
      ? `✅ Control humano ACTIVADO para conversación #${conversationId}. El AI de WhatsApp no responderá automáticamente. Usá sendMessageAsOperator para mandar mensajes.`
      : `✅ Control humano DESACTIVADO para conversación #${conversationId}. El AI de WhatsApp vuelve a responder normalmente.`;
  },
});

// ─── sendMessageAsOperatorTool - Enviar mensaje como operador humano ──────────
export const sendMessageAsOperatorTool = tool({
  description:
    "Envía un mensaje como operador humano a una conversación (WhatsApp, Telegram u otro canal conectado). El mensaje se envía al cliente por el canal de la conversación y queda registrado en el historial. USAR DESPUÉS de activar setHumanOverride para mantener el control, aunque también funciona sin override. PREGUNTAS: 'mandale un mensaje a Hector', 'decile que ya le llega', 'respondé al chat 5'",
  inputSchema: z.object({
    conversationId: z.number().describe("ID de la conversación"),
    text: z.string().describe("Texto del mensaje a enviar al cliente"),
  }),
  execute: async ({ conversationId, text }) => {
    // 1. Obtener datos de la conversación (S15: canal + cuenta de canal)
    const [conv] = await db
      .select({
        customerPhone: conversations.customerPhone,
        customerName: conversations.customerName,
        channel: conversations.channel,
        channelAccountId: conversations.channelAccountId,
        externalUserId: conversations.externalUserId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (!conv)
      return `No encontré la conversación #${conversationId}.`;

    const channel = conv.channel || "whatsapp";
    const { insertMessage } = await import("@/lib/channels/router");

    // 2a. Telegram usa el bot interno — fuera del modelo de proveedores.
    if (channel === "telegram") {
      const { sendTelegramMessage, getTelegramConfigFromDB } = await import(
        "@/lib/telegram/bot"
      );
      const tgConfig = await getTelegramConfigFromDB();
      if (!tgConfig?.botToken || !conv.externalUserId)
        return `La conversación #${conversationId} no tiene un chat de Telegram resoluble.`;
      await sendTelegramMessage(
        tgConfig.botToken,
        Number(conv.externalUserId),
        text
      );
      await insertMessage(conversationId, "assistant", text);
      return `✅ Mensaje enviado a ${conv.customerName || conv.externalUserId}: "${text.slice(0, 100)}"`;
    }

    if (!conv.customerPhone)
      return `La conversación #${conversationId} no tiene teléfono de cliente.`;

    // 2b. Resolver la cuenta de canal y enviar (S15 — fail closed):
    //     - channelAccountId set → send as that channel account
    //     - whatsapp unbound → placeholder path identical to before
    //     - other channels unbound → channel-level resolution; no provider
    //       → surfaced error, never a silent drop or wrong-sender send
    const { messenger, resolveChannelAccount, resolveChannelAccountById } =
      await import("@/lib/messaging");

    let result;
    if (conv.channelAccountId != null) {
      const account = await resolveChannelAccountById(conv.channelAccountId);
      if (!account)
        return `Error al enviar mensaje: la cuenta de canal #${conv.channelAccountId} no es resoluble (faltante, inactiva o proveedor no registrado).`;
      result = await messenger.send(
        { to: conv.customerPhone, type: "text", text },
        { channel, account }
      );
    } else if (channel === "whatsapp") {
      result = await messenger.send({ to: conv.customerPhone, type: "text", text });
    } else {
      const account = await resolveChannelAccount(channel);
      if (!account)
        return `Error al enviar mensaje: no hay proveedor registrado para el canal '${channel}'.`;
      result = await messenger.send(
        { to: conv.customerPhone, type: "text", text },
        { channel, account }
      );
    }

    if (!result.ok) {
      return `Error al enviar mensaje: ${result.error}`;
    }

    // 3. Registrar en el historial de la conversación
    await insertMessage(conversationId, "assistant", text);

    return `✅ Mensaje enviado a ${conv.customerName || conv.customerPhone}: "${text.slice(0, 100)}"`;
  },
});

// ─── injectCustomerNoteTool - Agregar nota interna a un lead ─────────────────
export const injectCustomerNoteTool = tool({
  description:
    "AGREGA una nota interna al perfil de un cliente (lead). La nota se ve cuando el agente de WhatsApp procese el próximo mensaje del cliente. Se concatena con las notas existentes con timestamp. PREGUNTAS: 'agregale una nota a Hector', 'dejale una nota a Maria', 'poné que prefiere carne'",
  inputSchema: z.object({
    phone: z
      .string()
      .describe(
        "Teléfono del cliente (con código de país, ej: +5491112345678)"
      ),
    note: z.string().describe("Texto de la nota a agregar"),
  }),
  execute: async ({ phone, note }) => {
    phone = normalizePhone(phone);
    const [lead] = await db
      .select({ id: leads.id, notes: leads.notes })
      .from(leads)
      .where(eq(leads.phone, phone))
      .limit(1);

    if (!lead)
      return `No encontré un lead con teléfono ${phone}.`;

    const now = new Date();
    const timestamp =
      now.toLocaleDateString("es-AR", {
        day: "2-digit",
        month: "2-digit",
      }) +
      " " +
      now.toLocaleTimeString("es-AR", {
        hour: "2-digit",
        minute: "2-digit",
      });
    const newNote = lead.notes
      ? `${lead.notes}\n[Admin ${timestamp}] ${note}`
      : `[Admin ${timestamp}] ${note}`;

    await db
      .update(leads)
      .set({ notes: newNote })
      .where(eq(leads.id, lead.id));

    return `✅ Nota agregada al lead de ${phone}: "${note}"`;
  },
});

// ─── deleteLeadTool - Eliminar un lead ─────────────────────────────────────
export const deleteLeadTool = tool({
  description:
    "ELIMINAR un lead/cliente del sistema. Pregunta: 'borra a X', 'elimina el lead 89', 'saca a fulano'. Primero busca por nombre o ID, despues elimina. Pide confirmacion antes de eliminar: 'Confirmas eliminacion de X?'.",
  inputSchema: z.object({
    id: z.number().describe("ID del lead a eliminar"),
  }),
  execute: async ({ id }) => {
    try {
      const [lead] = await db.select({ id: leads.id, name: leads.name }).from(leads).where(eq(leads.id, id)).limit(1);
      if (!lead) return `No encontre un lead con ID ${id}.`;
      await db.delete(orders).where(eq(orders.leadId, id));
      await db.delete(leads).where(eq(leads.id, id));
      return `✅ Lead #${id} (${lead.name || "sin nombre"}) eliminado.`;
    } catch (e) {
      return `Error al eliminar: ${e instanceof Error ? e.message : "desconocido"}`;
    }
  },
});

export const managementTools = {
  deleteLead: deleteLeadTool,
  getClients: getClientsTool,
  getClientDetail: getClientDetailTool,
  searchClient: searchClientTool,
  updateOrderStatusNew: updateOrderStatusTool,
  getAnalytics: getAnalyticsTool,
  getBusinessHours: getBusinessHoursTool,
  updateBusinessHours: updateBusinessHoursTool,
  getConversations: getConversationsTool,
  updateAgentConfig: updateAgentConfigTool,
  queryData: queryDataTool,
  getBusinessSummary: getBusinessSummaryTool,
  getConversationMessages: getConversationMessagesTool,
  getActivePromotions: getActivePromotionsTool,
  getCustomerFullProfile: getCustomerFullProfileTool,
  getConversationContext: getConversationContextTool,
  setHumanOverride: setHumanOverrideTool,
  sendMessageAsOperator: sendMessageAsOperatorTool,
  injectCustomerNote: injectCustomerNoteTool,
};
