import { db } from "@/db";
import { conversations, chatMessages } from "@/db/schema";
import { eq, and, asc, gt, sql } from "drizzle-orm";

/**
 * Scan barato (solo SQL, sin LLM): detecta conversaciones de WhatsApp con
 * mensajes sin reconciliar. El deep pass corre solo sobre estas.
 */

export type ReconcileTarget = {
  conversationId: number;
  customerName: string | null;
  customerPhone: string | null;
  pendingMessages: number;
  lastMessageAt: Date;
  lastReconciledAt: Date | null;
};

export async function findConversationsNeedingReconcile(opts: {
  minMessages?: number;
  limit?: number;
  lookbackHours?: number;
}): Promise<ReconcileTarget[]> {
  const minMessages = opts.minMessages ?? 4;
  const limit = opts.limit ?? 8;
  const lookbackHours = opts.lookbackHours ?? 36;
  const lookbackStart = new Date(Date.now() - lookbackHours * 3600 * 1000);

  // Mensajes del cliente (user) o del dueño escribiendo a mano (human)
  // posteriores a la última marca de reconciliación. Si nunca se reconcilió,
  // se mira solo la ventana de lookback para no escanear todo el historial.
  const result = await db.execute(sql`
    SELECT
      c.id AS "conversationId",
      c.customer_name AS "customerName",
      c.customer_phone AS "customerPhone",
      COUNT(m.id)::int AS "pendingMessages",
      MAX(m.created_at) AS "lastMessageAt",
      c.last_reconciled_at AS "lastReconciledAt"
    FROM conversations c
    JOIN chat_messages m
      ON m.conversation_id = c.id
      AND m.role IN ('user', 'human')
      AND m.created_at > COALESCE(c.last_reconciled_at, ${lookbackStart})
    WHERE c.channel = 'whatsapp'
      AND c.status != 'archived'
    GROUP BY c.id, c.customer_name, c.customer_phone, c.last_reconciled_at
    HAVING COUNT(m.id) >= ${minMessages}
    ORDER BY MAX(m.created_at) DESC
    LIMIT ${limit}
  `);

  const rows = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? []);

  return (rows as Record<string, unknown>[]).map((r) => ({
    conversationId: Number(r.conversationId),
    customerName: (r.customerName as string) ?? null,
    customerPhone: (r.customerPhone as string) ?? null,
    pendingMessages: Number(r.pendingMessages),
    lastMessageAt: new Date(r.lastMessageAt as string),
    lastReconciledAt: r.lastReconciledAt ? new Date(r.lastReconciledAt as string) : null,
  }));
}

/** Marca el punto hasta el que la conversación quedó reconciliada. */
export async function markConversationReconciled(
  conversationId: number,
  upTo: Date
): Promise<void> {
  await db
    .update(conversations)
    .set({ lastReconciledAt: upTo, updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

export type TranscriptEntry = {
  at: Date;
  role: string;
  content: string;
};

/**
 * Trae los mensajes de una conversación desde `since` (o las últimas `limit`
 * entradas si es null). Incluye todos los roles para contexto completo:
 * user=cliente, human=dueño a mano, assistant=bot, system=eventos.
 */
export async function fetchTranscript(
  conversationId: number,
  since: Date | null,
  limit = 80
): Promise<TranscriptEntry[]> {
  const conditions = [eq(chatMessages.conversationId, conversationId)];
  if (since) conditions.push(gt(chatMessages.createdAt, since));

  const rows = await db
    .select({
      createdAt: chatMessages.createdAt,
      role: chatMessages.role,
      content: chatMessages.content,
    })
    .from(chatMessages)
    .where(and(...conditions))
    .orderBy(asc(chatMessages.createdAt))
    .limit(limit);

  return rows.map((r) => ({
    at: r.createdAt,
    role: r.role,
    content: r.content,
  }));
}
