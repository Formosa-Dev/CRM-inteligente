"use server";

import { db } from "@/db";
import { orders, leads } from "@/db/schema";
import { desc, count, sql, eq } from "drizzle-orm";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth/require-admin";
import { revalidatePath } from "next/cache";
import { normalizePhone } from "@/lib/phone-utils";

const PAGE_SIZE = 30;

export interface ClientSummary {
  phone: string;
  name: string | null;
  totalOrders: number;
  lastOrderDate: Date | null;
  lastOrderType: string | null;
  lastOrderStatus: string | null;
  leadStatus: string | null;
  type: string | null;
  totalConversations: number;
  lastConversationDate: Date | null;
  tags: string[];
}

export interface ClientsResponse {
  clients: ClientSummary[];
  total: number;
  totalPages: number;
  currentPage: number;
}

/**
 * Obtiene la lista unificada de clientes combinando orders + leads + conversations
 */
export async function fetchClients(params: {
  search?: string;
  page?: number;
}): Promise<ClientsResponse> {
  const session = await auth();
  if (!session) return { clients: [], total: 0, totalPages: 1, currentPage: 1 };

  const page = Math.max(1, params.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE;

  // Get all unique phones from orders only (clients are leads who ordered)
  const orderPhones = await db
    .select({
      phone: orders.phoneNumber,
      name: orders.customerName,
      orderCount: count(),
      lastDate: sql<string>`MAX(${orders.createdAt})`,
      lastType: sql<string>`(SELECT ${orders.orderType} FROM ${orders} o2 WHERE o2.phone_number = ${orders.phoneNumber} ORDER BY o2.created_at DESC LIMIT 1)`,
      lastStatus: sql<string>`(SELECT ${orders.status} FROM ${orders} o3 WHERE o3.phone_number = ${orders.phoneNumber} ORDER BY o3.created_at DESC LIMIT 1)`,
    })
    .from(orders)
    .groupBy(orders.phoneNumber, orders.customerName)
    .orderBy(desc(sql`MAX(${orders.createdAt})`));

  const leadPhones = await db
    .select({
      phone: leads.phone,
      name: leads.name,
      status: leads.status,
      tags: leads.tags,
      type: leads.type,
    })
    .from(leads)
    .groupBy(leads.phone, leads.name, leads.status, leads.tags, leads.type);

  // Merge by phone
  const phoneMap = new Map<string, ClientSummary>();

  for (const o of orderPhones) {
      phoneMap.set(o.phone, {
      phone: o.phone,
      name: o.name,
      totalOrders: o.orderCount,
      lastOrderDate: o.lastDate ? new Date(o.lastDate) : null,
      lastOrderType: o.lastType,
      lastOrderStatus: o.lastStatus,
      leadStatus: null,
      type: null,
      totalConversations: 0,
      lastConversationDate: null,
      tags: [],
    });
  }

  for (const l of leadPhones) {
    const existing = phoneMap.get(l.phone);
    if (existing) {
      existing.leadStatus = l.status;
      existing.type = l.type;
      existing.name = l.name || existing.name;
      if (l.tags) existing.tags = l.tags;
    }
    // leads without orders are NOT added as clients
  }

  let clients = Array.from(phoneMap.values());

  // Search filter
  if (params.search) {
    const s = params.search.toLowerCase();
    clients = clients.filter(
      (c) =>
        c.phone.includes(s) ||
        (c.name && c.name.toLowerCase().includes(s)) ||
        (c.tags && c.tags.some((t) => t.includes(s)))
    );
  }

  // Sort by most recent activity
  clients.sort((a, b) => {
    const dateA = a.lastOrderDate ?? a.lastConversationDate ?? new Date(0);
    const dateB = b.lastOrderDate ?? b.lastConversationDate ?? new Date(0);
    return dateB.getTime() - dateA.getTime();
  });

  const total = clients.length;
  const paged = clients.slice(offset, offset + PAGE_SIZE);

  return {
    clients: paged,
    total,
    totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    currentPage: page,
  };
}

/**
 * Actualiza datos de un cliente en la tabla leads.
 */
export async function updateClient(
  phone: string,
  data: { name?: string; email?: string; address?: string; type?: "b2c" | "b2b" | null; notes?: string; tags?: string[] }
): Promise<{ success: boolean; error?: string }> {
  if (!(await requireAdmin())) return { success: false, error: "No autorizado"  };

  try {
    // Normalizar teléfono para la búsqueda
    const normalizedPhone = normalizePhone(phone);

    // Buscar el lead por teléfono normalizado para obtener su ID
    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.phone, normalizedPhone))
      .limit(1);

    if (!lead) {
      return { success: false, error: "Cliente no encontrado" };
    }

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.email !== undefined) updateData.email = data.email;
    if (data.address !== undefined) updateData.address = data.address;
    if (data.type !== undefined) updateData.type = data.type;
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.tags !== undefined) updateData.tags = data.tags;

    // Actualizar por ID (más seguro que por teléfono)
    await db.update(leads).set(updateData).where(eq(leads.id, lead.id));

    // Revalidar TODAS las páginas que muestran datos del cliente
    revalidatePath("/admin/clients");
    revalidatePath("/admin/clients/[id]", "page");
    revalidatePath("/admin/clients/[id]");
    revalidatePath("/admin/leads");
    revalidatePath("/admin/orders");
    revalidatePath("/admin/conversations");
    revalidatePath("/admin");
    revalidatePath("/admin/conversations/[id]", "page");

    return { success: true };
  } catch {
    return { success: false, error: "Error al actualizar" };
  }
}

/**
 * Elimina un lead y todas sus órdenes asociadas
 */
export async function deleteLead(
  phone: string
): Promise<{ success: boolean; error?: string }> {
  if (!(await requireAdmin())) return { success: false, error: "No autorizado"  };

  try {
    // Normalizar teléfono
    const normalizedPhone = normalizePhone(phone);
    // Buscar lead ID primero
    const [lead] = await db
      .select({ id: leads.id })
      .from(leads)
      .where(eq(leads.phone, normalizedPhone))
      .limit(1);

    if (!lead) return { success: false, error: "Lead no encontrado" };

    // Eliminar lead + órdenes asociadas en una sola transacción, buscando por
    // teléfono normalizado (órdenes) — el lead ya se resolvió por ID arriba.
    await db.transaction(async (tx) => {
      await tx.delete(orders).where(eq(orders.phoneNumber, normalizedPhone));
      await tx.delete(leads).where(eq(leads.id, lead.id));
    });

    return { success: true };
  } catch {
    return { success: false, error: "Error al eliminar" };
  }
}
