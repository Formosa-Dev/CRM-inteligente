import { db } from "@/db";
import { products, leads, orders } from "@/db/schema";
import { sql, gte, desc, eq, lt, and, or } from "drizzle-orm";
import { resolveClientNamesBatch } from "@/lib/lead-utils";

import { DashboardClient } from "./dashboard-client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tiempoRelativo(fecha: Date): string {
  const ahora = new Date();
  const diffMs = ahora.getTime() - fecha.getTime();
  const diffMin = Math.floor(diffMs / 1000 / 60);
  const diffHoras = Math.floor(diffMin / 60);
  const diffDias = Math.floor(diffHoras / 24);

  if (diffMin < 1) return "hace un momento";
  if (diffMin < 60) return `hace ${diffMin} min`;
  if (diffHoras < 24) return `hace ${diffHoras} ${diffHoras === 1 ? "hora" : "horas"}`;
  return `hace ${diffDias} ${diffDias === 1 ? "día" : "días"}`;
}

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function getStats() {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);

  const [totalProducts] = await db
    .select({ count: sql<number>`count(*)` })
    .from(products);

  const [totalOrders] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orders);

  const [ordersToday] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orders)
    .where(gte(orders.createdAt, todayStart));

  const [newLeads] = await db
    .select({ count: sql<number>`count(*)` })
    .from(leads)
    .where(gte(leads.createdAt, weekStart));

  const [newClients] = await db
    .select({ count: sql<number>`count(distinct ${leads.phone})` })
    .from(leads)
    .where(gte(leads.createdAt, weekStart));

  const [totalLeads] = await db
    .select({ count: sql<number>`count(*)` })
    .from(leads);

  return {
    totalProducts: Number(totalProducts?.count ?? 0),
    totalOrders: Number(totalOrders?.count ?? 0),
    ordersToday: Number(ordersToday?.count ?? 0),
    newLeads: Number(newLeads?.count ?? 0),
    newClients: Number(newClients?.count ?? 0),
    totalLeads: Number(totalLeads?.count ?? 0),
  };
}

export type ActivityItem =
  | { type: "lead"; id: number; name: string | null; phone: string | null; createdAt: Date; timeLabel: string }
  | { type: "order"; id: number; name: string | null; phone: string; createdAt: Date; timeLabel: string };

async function getRecentActivity(): Promise<ActivityItem[]> {
  const [recentLeads, recentOrders] = await Promise.all([
    db
      .select({
        id: leads.id,
        name: leads.name,
        phone: leads.phone,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .orderBy(desc(leads.createdAt))
      .limit(5),
    db
      .select({
        id: orders.id,
        phone: orders.phoneNumber,
        createdAt: orders.createdAt,
      })
      .from(orders)
      .orderBy(desc(orders.createdAt))
      .limit(5),
  ]);

  const leadsItems: ActivityItem[] = recentLeads.map((l) => ({
    type: "lead",
    id: l.id,
    name: l.name,
    phone: l.phone,
    createdAt: l.createdAt,
    timeLabel: tiempoRelativo(l.createdAt),
  }));

  // Resolve names for activity orders too
  const orderPhones = recentOrders.map((o) => o.phone).filter(Boolean) as string[];
  const activityNameMap = await resolveClientNamesBatch(orderPhones);

  const ordersItems: ActivityItem[] = recentOrders.map((o) => ({
    type: "order",
    id: o.id,
    name: activityNameMap.get(o.phone) ?? null,
    phone: o.phone,
    createdAt: o.createdAt,
    timeLabel: tiempoRelativo(o.createdAt),
  }));

  return [...leadsItems, ...ordersItems]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, 10);
}

async function getRecentOrders() {
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
    .orderBy(desc(orders.createdAt))
    .limit(8);

  // Enrich with managed client names
  const phones = rows.map((r) => r.phoneNumber).filter(Boolean) as string[];
  const nameMap = await resolveClientNamesBatch(phones);
  for (const row of rows) {
    const resolved = nameMap.get(row.phoneNumber);
    if (resolved) row.customerName = resolved;
  }

  return rows;
}

export type DashboardCard = {
  title: string;
  value: number | null;
  iconName: "package" | "message" | "users" | "bot" | "cart" | "dollar" | "userplus" | "trending";
  description: string;
  badge?: boolean;
};

export type ActionCardItem = {
  id: string | number;
  label: string;
  subtitle: string;
  phone?: string;
  conversationId?: number;
  orderId?: number;
  type: "order" | "chat" | "lead";
};

export type ActionCard = {
  id: string;
  icon: string;
  title: string;
  color: "red" | "amber" | "blue" | "green" | "purple";
  items: ActionCardItem[];
  actions: { label: string; action: "mark-delivered" | "mark-ready" | "mark-paid" | "open-chat" | "trigger-agent" | "view-lead" }[];
};

export type RecentOrder = {
  id: number;
  customerName: string | null;
  phoneNumber: string;
  orderType: string | null;
  status: string;
  items: unknown;
  createdAt: Date;
};

// ─── Action Cards (dashboard vivo) ─────────────────────────────────────────────

async function getActionCards() {
  const now = new Date();
  const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
  const fortyFiveMinAgo = new Date(now.getTime() - 45 * 60 * 1000);
  const fifteenMinAgo = new Date(now.getTime() - 15 * 60 * 1000);

  // 🔴 Pedidos listos sin entregar
  const readyOrders = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      phoneNumber: orders.phoneNumber,
      orderType: orders.orderType,
      address: orders.address,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(
      eq(orders.status, "ready"),
      lt(orders.createdAt, thirtyMinAgo),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(5);

  // 🟠 Pedidos en preparación hace rato (>45min)
  const stuckPreparing = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      phoneNumber: orders.phoneNumber,
      orderType: orders.orderType,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(
      eq(orders.status, "preparing"),
      lt(orders.createdAt, fortyFiveMinAgo),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(5);

  // 💵 Pagos pendientes (pedidos activos sin pagar)
  const unpaidOrders = await db
    .select({
      id: orders.id,
      customerName: orders.customerName,
      phoneNumber: orders.phoneNumber,
      orderType: orders.orderType,
      paymentStatus: orders.paymentStatus,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(
      eq(orders.paymentStatus, "pending"),
      or(
        eq(orders.status, "pending"),
        eq(orders.status, "preparing"),
        eq(orders.status, "ready"),
      ),
    ))
    .orderBy(desc(orders.createdAt))
    .limit(5);

  // 💬 Chats sin respuesta del agente
  // Último mensaje es del usuario + hace >15min sin respuesta del assistant
  const staleConversations = await db.execute(sql`
    SELECT c.id, c.customer_phone, c.customer_name, cm.role as last_role,
           cm.content as last_content, cm.created_at as last_msg_at
    FROM conversations c
    JOIN LATERAL (
      SELECT role, content, created_at
      FROM chat_messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) cm ON true
    WHERE c.status = 'active'
      AND c.channel = 'whatsapp'
      AND cm.role = 'user'
      AND cm.created_at < ${fifteenMinAgo.toISOString()}::timestamptz
    ORDER BY cm.created_at DESC
    LIMIT 5
  `);

  // 📥 Leads nuevos sin atender
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const freshLeads = await db
    .select({
      id: leads.id,
      name: leads.name,
      phone: leads.phone,
      createdAt: leads.createdAt,
    })
    .from(leads)
    .where(and(
      eq(leads.status, "new"),
      lt(leads.createdAt, oneHourAgo),
    ))
    .orderBy(desc(leads.createdAt))
    .limit(5);

  const cards: ActionCard[] = [];

  // 🔴 Card: Listos para entregar
  if (readyOrders.length > 0) {
    cards.push({
      id: "ready",
      icon: "truck",
      title: "Listos para entregar",
      color: "red",
      items: readyOrders.map((o) => ({
        id: o.id,
        label: o.customerName || "Sin nombre",
        subtitle: `#${o.id} · ${o.orderType === "pan_mayorista" ? "🍞 Pan" : "🍔 Hamburguesas"}${o.address ? " · Delivery" : ""}`,
        phone: o.phoneNumber || undefined,
        orderId: o.id,
        type: "order" as const,
      })),
      actions: [{ label: "✔️ Marcar Entregado", action: "mark-delivered" }],
    });
  }

  // 🟠 Card: Preparando hace rato
  if (stuckPreparing.length > 0) {
    cards.push({
      id: "stuck",
      icon: "clock",
      title: "Preparando hace rato",
      color: "amber",
      items: stuckPreparing.map((o) => ({
        id: o.id,
        label: o.customerName || "Sin nombre",
        subtitle: `#${o.id} · ${tiempoRelativo(o.createdAt)}`,
        phone: o.phoneNumber || undefined,
        orderId: o.id,
        type: "order" as const,
      })),
      actions: [{ label: "👉 Marcar Listo", action: "mark-ready" }],
    });
  }

  // 💬 Card: Chats sin respuesta
  const staleRows = staleConversations.rows as {
    id: number;
    customer_phone: string;
    customer_name: string | null;
    last_role: string;
    last_content: string;
    last_msg_at: string;
  }[];
  if (staleRows.length > 0) {
    cards.push({
      id: "stale-chats",
      icon: "message",
      title: "Chats sin respuesta",
      color: "blue",
      items: staleRows.map((r) => ({
        id: r.id,
        label: r.customer_name || "Sin nombre",
        subtitle: r.customer_phone,
        phone: r.customer_phone,
        conversationId: r.id,
        type: "chat" as const,
      })),
      actions: [
        { label: "💬 Abrir Chat", action: "open-chat" },
        { label: "🤖 Activar IA", action: "trigger-agent" },
      ],
    });
  }

  // 💵 Card: Pagos pendientes
  if (unpaidOrders.length > 0) {
    cards.push({
      id: "unpaid",
      icon: "dollar",
      title: "Pagos pendientes",
      color: "green",
      items: unpaidOrders.map((o) => ({
        id: o.id,
        label: o.customerName || "Sin nombre",
        subtitle: `#${o.id} · ${o.orderType === "pan_mayorista" ? "Pan" : "Hamburguesas"}`,
        phone: o.phoneNumber || undefined,
        orderId: o.id,
        type: "order" as const,
      })),
      actions: [{ label: "💵 Marcar Pagado", action: "mark-paid" }],
    });
  }

  // 📥 Card: Leads nuevos
  if (freshLeads.length > 0) {
    cards.push({
      id: "fresh-leads",
      icon: "userplus",
      title: "Leads nuevos",
      color: "purple",
      items: freshLeads.map((l) => ({
        id: l.id,
        label: l.name || "Sin nombre",
        subtitle: l.phone ?? "",
        phone: l.phone || undefined,
        type: "lead" as const,
      })),
      actions: [{ label: "👤 Ver Lead", action: "view-lead" }],
    });
  }

  return cards;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function AdminDashboard() {
  const [stats, activity, recentOrders, actionCards] = await Promise.all([
    getStats(),
    getRecentActivity(),
    getRecentOrders(),
    getActionCards(),
  ]);

  const cards: DashboardCard[] = [
    {
      title: "Total Pedidos",
      value: stats.totalOrders,
      iconName: "cart",
      description: "Pedidos registrados",
    },
    {
      title: "Ingresos Hoy",
      value: stats.ordersToday,
      iconName: "dollar",
      description: "Pedidos recibidos hoy",
    },
    {
      title: "Clientes Nuevos",
      value: stats.newClients,
      iconName: "userplus",
      description: "Últimos 7 días",
    },
    {
      title: "Leads Totales",
      value: stats.totalLeads,
      iconName: "trending",
      description: "Leads en la base",
    },
  ];

  return <DashboardClient cards={cards} activity={activity} recentOrders={recentOrders} actionCards={actionCards} />;
}
