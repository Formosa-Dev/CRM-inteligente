"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { conversations, chatMessages, leads, orders } from "@/db/schema";
import { eq, desc, sql, count } from "drizzle-orm";
import { resolveClientNamesBatch } from "@/lib/lead-utils";
import { requireAdmin } from "@/lib/auth/require-admin";
import { conversationListWhere } from "@/lib/conversations/filters";
import type { CustomerProfile, OrderSummary } from "@/types/chat";

const PAGE_SIZE = 50;

// Server actions are public POST endpoints — reads require a session
// (viewer role is read-only); mutations require the admin role.
async function requireSession() {
  const session = await auth();
  if (!session) throw new Error("No autorizado");
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type GetConversationsParams = {
  page?: number;
  channel?: string;
  account?: string;
  status?: string;
  search?: string;
};

export type GetConversationsResult = {
  conversations: (typeof conversations.$inferSelect)[];
  total: number;
  page: number;
  pageSize: number;
};

// ─── Actions ──────────────────────────────────────────────────────────────────

/**
 * Obtiene conversaciones paginadas con filtros opcionales por canal, cuenta
 * conectada, estado y búsqueda.
 */
export async function getConversations(
  params: GetConversationsParams
): Promise<GetConversationsResult> {
  await requireSession();
  const { page = 1, channel, account, status, search } = params;
  const offset = (page - 1) * PAGE_SIZE;

  const where = conversationListWhere({ channel, account, status, search });

  // COALESCE en SQL: ordena por lastMessageAt si existe, sino por updatedAt
  const orderExpr = sql`COALESCE(${conversations.lastMessageAt}, ${conversations.updatedAt}) DESC`;

  const [rows, totalResult] = await Promise.all([
    db
      .select()
      .from(conversations)
      .where(where)
      .orderBy(orderExpr)
      .limit(PAGE_SIZE)
      .offset(offset),
    db.select({ count: count() }).from(conversations).where(where),
  ]);

  // Enriquecer con el nombre del lead (el de la DB, no el de WhatsApp) — batch
  // query to avoid an N+1 (2 extra queries per row → 2 queries total per page).
  let resolvedNames = new Map<string, string>();
  try {
    resolvedNames = await resolveClientNamesBatch(
      rows.map((c) => c.customerPhone).filter((p): p is string => Boolean(p))
    );
  } catch {}
  const enriched = rows.map((conv) => {
    const resolvedName = conv.customerPhone ? resolvedNames.get(conv.customerPhone) : undefined;
    return resolvedName && resolvedName !== conv.customerName
      ? { ...conv, customerName: resolvedName }
      : conv;
  });

  return {
    conversations: enriched,
    total: totalResult[0]?.count ?? 0,
    page,
    pageSize: PAGE_SIZE,
  };
}

/**
 * Obtiene los mensajes de una conversación, ordenados cronológicamente.
 */
export async function getMessages(
  conversationId: number,
  limit = 100,
  offset = 0
) {
  await requireSession();
  // Client-controlled limit gets clamped — an unbounded value would dump
  // the whole chat_messages table into the response.
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const safeOffset = Math.max(0, Math.floor(offset));
  // Fetch the LATEST `limit` messages (DESC) — offset paginates backwards
  // into older history — then restore chronological order for display.
  // Ordering ASC + LIMIT would return the first N messages forever, which
  // breaks the chat view for conversations with more than `limit` messages.
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(safeLimit)
    .offset(safeOffset);
  return rows.reverse();
}

/**
 * Envía una respuesta desde el admin delegando al router de canales.
 * Usa dynamic import para no romper si el router aún no existe.
 */
export async function sendReply(
  conversationId: number,
  content: string
): Promise<{ success: boolean; error?: string }> {
  if (!(await requireAdmin())) return { success: false, error: "No autorizado" };
  const trimmed = (content ?? "").trim();
  if (!trimmed) return { success: false, error: "Mensaje vacío" };
  // WhatsApp API rejects oversized payloads; cap well below the hard limit.
  if (trimmed.length > 4000) return { success: false, error: "Mensaje demasiado largo" };
  try {
    const { sendOutboundMessage } = await import("@/lib/channels/router");
    await sendOutboundMessage(conversationId, trimmed, "human");
    return { success: true };
  } catch (error) {
    console.error("[sendReply] Error:", error);
    // Surface the real failure (e.g. unresolvable channel account, no
    // registered provider) so the operator sees why the send failed — the
    // message itself carries no secrets.
    const detail = error instanceof Error ? error.message : "desconocido";
    return { success: false, error: `Error al enviar mensaje: ${detail}` };
  }
}

/**
 * Activa o desactiva el override humano con una ventana de 24 horas.
 * Cuando se desactiva, limpia la fecha.
 */
export async function toggleHumanOverride(
  conversationId: number,
  enabled: boolean
): Promise<{ success: boolean }> {
  if (!(await requireAdmin())) return { success: false };
  try {
    const until = enabled
      ? new Date(Date.now() + 24 * 60 * 60 * 1000) // +24h desde ahora
      : null;

    await db
      .update(conversations)
      .set({ humanOverrideUntil: until, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    return { success: true };
  } catch (error) {
    console.error("[toggleHumanOverride] Error:", error);
    return { success: false };
  }
}

/**
 * Obtiene los detalles completos de una conversación por ID.
 * Retorna null si no existe.
 */
export async function getConversation(
  conversationId: number
): Promise<(typeof conversations.$inferSelect) | null> {
  await requireSession();
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  return conv ?? null;
}

/**
 * Perfil del cliente para el context panel del inbox.
 * Lookup en dos pasos: lead vinculado a la conversación, o fallback por el
 * teléfono de la conversación (mismo criterio que usaba el queryFn client-side
 * que reemplaza — corre server-side porque el browser no tiene DATABASE_URL).
 */
export async function getCustomerProfile(
  conversationId: number
): Promise<CustomerProfile | null> {
  await requireSession();

  // Try 1: lead auto-vinculado a la conversación
  let [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.conversationId, conversationId))
    .limit(1);

  // Try 2: fallback — buscar por teléfono de la conversación
  if (!lead) {
    const [conv] = await db
      .select({ phone: conversations.customerPhone })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);

    if (conv?.phone) {
      [lead] = await db
        .select()
        .from(leads)
        .where(eq(leads.phone, conv.phone))
        .limit(1);
    }
  }

  if (!lead) return null;

  return {
    id: lead.id,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    address: lead.address,
    status: lead.status as CustomerProfile["status"],
    tags: (lead.tags ?? []) as string[],
    notes: lead.notes,
    platform: lead.platform,
    utmSource: lead.utmSource,
    utmMedium: lead.utmMedium,
    utmCampaign: lead.utmCampaign,
    utmContent: lead.utmContent,
    adId: lead.adId,
    campaignId: lead.campaignId,
    conversationId: lead.conversationId,
    createdAt: lead.createdAt instanceof Date
      ? lead.createdAt.toISOString()
      : String(lead.createdAt),
  };
}

/**
 * Órdenes recientes de un lead para el context panel (más nuevas primero).
 */
export async function getCustomerOrders(
  leadId: number
): Promise<OrderSummary[]> {
  await requireSession();
  const rows = await db
    .select({
      id: orders.id,
      orderType: orders.orderType,
      status: orders.status,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(eq(orders.leadId, leadId))
    .orderBy(desc(orders.createdAt))
    .limit(20);

  return rows.map((r) => ({
    id: r.id,
    orderType: r.orderType,
    status: r.status,
    total: null,
    createdAt: r.createdAt instanceof Date
      ? r.createdAt.toISOString()
      : String(r.createdAt),
  }));
}
