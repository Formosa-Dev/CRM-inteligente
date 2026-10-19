"use server";

import { auth } from "@/auth";
import { db } from "@/db";
import { conversations, chatMessages, leads, orders } from "@/db/schema";
import { eq, desc, sql, count } from "drizzle-orm";
import { resolveClientNamesBatch } from "@/lib/lead-utils";
import { requireAdmin } from "@/lib/auth/require-admin";
import { conversationListWhere } from "@/lib/conversations/filters";

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
  // Fetch the LATEST `limit` messages (DESC) — offset paginates backwards
  // into older history — then restore chronological order for display.
  // Ordering ASC + LIMIT would return the first N messages forever, which
  // breaks the chat view for conversations with more than `limit` messages.
  const rows = await db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.conversationId, conversationId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(limit)
    .offset(offset);
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
 * Actualiza el estado de una conversación (active / closed / archived).
 */
export async function updateConversationStatus(
  conversationId: number,
  status: "active" | "closed" | "archived"
): Promise<{ success: boolean }> {
  if (!(await requireAdmin())) return { success: false };
  if (!["active", "closed", "archived"].includes(status)) return { success: false };
  try {
    await db
      .update(conversations)
      .set({ status, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
    return { success: true };
  } catch (error) {
    console.error("[updateConversationStatus] Error:", error);
    return { success: false };
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
 * Obtiene el lead vinculado a una conversación.
 */
export async function getLeadByConversation(conversationId: number) {
  await requireSession();
  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.conversationId, conversationId))
    .limit(1);
  return lead ?? null;
}

/**
 * Obtiene las órdenes de un lead.
 */
export async function getOrdersByLead(leadId: number) {
  await requireSession();
  return db
    .select()
    .from(orders)
    .where(eq(orders.leadId, leadId))
    .orderBy(desc(orders.createdAt))
    .limit(20);
}
