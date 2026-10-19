import { db } from "@/db";
import { leads, conversations, chatMessages } from "@/db/schema";
import { eq, and, or, ilike, desc, gte, isNotNull, sql } from "drizzle-orm";
import { messenger } from "@/lib/messaging";
import { findOrCreateConversation } from "@/lib/channels/router";
import { insertMessage } from "@/lib/channels/router";

export type BroadcastFilter =
  | { type: "all" }
  | { type: "b2b" }
  | { type: "b2c" }
  | { type: "24h-window" }
  | { type: "search"; query: string }
  | { type: "has-ordered" };

export interface BroadcastRecipient {
  phone: string;
  name: string | null;
}

export interface BroadcastResult {
  phone: string;
  name: string | null;
  success: boolean;
  error?: string;
}

const DELAY_BETWEEN_MS = 2_500; // 2.5s entre mensajes para no rate-limitear

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Safety cap — a broadcast never resolves more recipients than this. */
export const BROADCAST_HARD_LIMIT = 500;

/**
 * Obtiene todos los destinatarios que matchean el filtro (hasta BROADCAST_HARD_LIMIT).
 * El caller decide cuántos enviar con `maxRecipients` (slice).
 */
export async function getBroadcastRecipients(
  filter: BroadcastFilter,
  hardLimit: number = BROADCAST_HARD_LIMIT
): Promise<BroadcastRecipient[]> {
  let rows: { phone: string | null; name: string | null }[] = [];

  switch (filter.type) {
    case "b2b":
      rows = await db
        .select({ phone: leads.phone, name: leads.name })
        .from(leads)
        .where(and(
          eq(leads.type, "b2b"),
          isNotNull(leads.phone),
        ))
        .orderBy(desc(leads.createdAt))
        .limit(hardLimit);
      break;

    case "b2c":
      rows = await db
        .select({ phone: leads.phone, name: leads.name })
        .from(leads)
        .where(and(
          eq(leads.type, "b2c"),
          isNotNull(leads.phone),
        ))
        .orderBy(desc(leads.createdAt))
        .limit(hardLimit);
      break;

    case "24h-window": {
      // Ventana real de WhatsApp: se abre con el último mensaje INBOUND del cliente.
      // conversations.lastMessageAt también la tocan los mensajes del bot (incluidos
      // broadcasts), así que hay que mirar chat_messages con role = 'user'.
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const activeConversations = await db
        .select({ customerPhone: conversations.customerPhone })
        .from(conversations)
        .where(
          and(
            eq(conversations.channel, "whatsapp"),
            sql`exists (
              select 1 from chat_messages m
              where m.conversation_id = ${conversations.id}
                and m.role = 'user'
                and m.created_at >= ${twentyFourHoursAgo}
            )`,
          ),
        )
        .orderBy(desc(conversations.lastMessageAt))
        .limit(hardLimit);

      const phones = activeConversations
        .map((c) => c.customerPhone)
        .filter((p): p is string => !!p);

      if (phones.length === 0) return [];

      // Obtener nombres desde leads
      const leadRows = await db
        .select({ phone: leads.phone, name: leads.name })
        .from(leads)
        .where(
          and(
            isNotNull(leads.phone),
            or(...phones.map((p) => eq(leads.phone, p))),
          ),
        );

      const nameMap = new Map(leadRows.map((l) => [l.phone, l.name]));

      rows = phones.map((p) => ({
        phone: p,
        name: nameMap.get(p) || null,
      }));
      break;
    }

    case "has-ordered": {
      // Clientes que tienen al menos un pedido (tienen tipo b2c o b2b)
      rows = await db
        .select({ phone: leads.phone, name: leads.name })
        .from(leads)
        .where(and(
          isNotNull(leads.phone),
          or(eq(leads.type, "b2c"), eq(leads.type, "b2b")),
        ))
        .orderBy(desc(leads.createdAt))
        .limit(hardLimit);
      break;
    }

    case "search":
      rows = await db
        .select({ phone: leads.phone, name: leads.name })
        .from(leads)
        .where(
          and(
            isNotNull(leads.phone),
            or(
              ilike(leads.name, `%${filter.query}%`),
              ilike(leads.phone, `%${filter.query}%`),
            ),
          ),
        )
        .orderBy(desc(leads.createdAt))
        .limit(hardLimit);
      break;

    case "all":
      rows = await db
        .select({ phone: leads.phone, name: leads.name })
        .from(leads)
        .where(isNotNull(leads.phone))
        .orderBy(desc(leads.createdAt))
        .limit(hardLimit);
      break;
  }

  return rows.filter((r): r is BroadcastRecipient => !!r.phone?.trim());
}

// ─── Dedup guard: misma copy no se manda dos veces en una ventana corta ────
// El broadcast del 15/10 salió duplicado (dos rondas a ~3 min, wamids distintos)
// porque el agente ejecutó la tool dos veces. Este guard lo vuelve imposible.

export const DUPLICATE_BROADCAST_WINDOW_MINUTES = 15;
export const DUPLICATE_BROADCAST_THRESHOLD = 3;

/**
 * Cuenta a cuántas conversaciones distintas salió este texto exacto como
 * mensaje assistant en los últimos `withinMinutes` minutos.
 */
export async function countRecentBroadcastSends(
  message: string,
  withinMinutes: number = DUPLICATE_BROADCAST_WINDOW_MINUTES,
): Promise<number> {
  const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
  const [row] = await db
    .select({ count: sql<number>`count(distinct ${chatMessages.conversationId})::int` })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.role, "assistant"),
        eq(chatMessages.content, message),
        gte(chatMessages.createdAt, cutoff),
      ),
    );
  return row?.count ?? 0;
}

/**
 * Un envío es duplicado si el mismo texto ya llegó a varias conversaciones
 * dentro de la ventana, salvo override explícito del admin.
 */
export function shouldBlockDuplicateBroadcast(
  recentCount: number,
  allowDuplicate: boolean,
  threshold: number = DUPLICATE_BROADCAST_THRESHOLD,
): boolean {
  if (allowDuplicate) return false;
  return recentCount >= threshold;
}

/**
 * Preview para dryRun: audiencia real sin enviar nada.
 */
export function formatBroadcastPreview(opts: {
  filterLabel: string;
  totalMatched: number;
  recipients: BroadcastRecipient[];
  maxRecipients: number;
  capped: boolean;
}): string {
  const { filterLabel, totalMatched, recipients, maxRecipients, capped } = opts;
  const lines: string[] = [
    `👀 Preview — filtro "${filterLabel}":`,
    `👥 ${totalMatched} destinatario${totalMatched === 1 ? "" : "s"} matchean${capped ? ` (se mandaría a los primeros ${maxRecipients})` : ""}`,
    "",
  ];
  for (const r of recipients.slice(0, 40)) {
    lines.push(`• ${r.name || "sin nombre"} — ${r.phone}`);
  }
  if (recipients.length > 40) {
    lines.push(`... y ${recipients.length - 40} más`);
  }
  lines.push("", "No envié nada. Para mandarlo: mismo filtro y mensaje, dryRun=false.");
  return lines.join("\n");
}

/**
 * Envía un mensaje de texto a una lista de destinatarios.
 * Cada mensaje se guarda en chat_messages.
 */
export async function broadcastText(
  recipients: BroadcastRecipient[],
  text: string,
  onProgress?: (done: number, total: number, current: BroadcastResult) => void,
  imageUrl?: string,
): Promise<{ results: BroadcastResult[]; sent: number; failed: number }> {
  const results: BroadcastResult[] = [];
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const phone = r.phone.startsWith("+") ? r.phone : `+${r.phone}`;
    const result: BroadcastResult = { phone: r.phone, name: r.name, success: false };

    try {
      // 1. Enviar WhatsApp — bound conversation → its account; unbound →
      //    the single active account. Ambiguous/unresolvable/transient
      //    bindings fail closed per recipient, never a global send.
      const {
        resolveConversationAccountForPhone,
        resolveDefaultWhatsAppAccount,
      } = await import("@/lib/channels/router");
      const binding = await resolveConversationAccountForPhone(phone);
      if (binding.kind === "error") {
        result.error = "no se pudo resolver la cuenta del canal (error transitorio)";
        results.push(result);
        failed++;
        onProgress?.(i + 1, recipients.length, result);
        await sleep(DELAY_BETWEEN_MS);
        continue;
      }
      if (binding.kind === "ambiguous") {
        result.error = `teléfono vinculado a varias cuentas (${binding.accountIds.join(", ")})`;
        results.push(result);
        failed++;
        onProgress?.(i + 1, recipients.length, result);
        await sleep(DELAY_BETWEEN_MS);
        continue;
      }
      if (binding.kind === "unresolvable") {
        result.error = `cuenta de canal #${binding.accountId} no es resoluble (${binding.reason})`;
        results.push(result);
        failed++;
        onProgress?.(i + 1, recipients.length, result);
        await sleep(DELAY_BETWEEN_MS);
        continue;
      }

      let account = binding.kind === "resolved" ? binding.account : undefined;
      if (!account) {
        const fallback = await resolveDefaultWhatsAppAccount();
        if (fallback.kind === "db-error") {
          result.error = "no se pudo resolver la cuenta por defecto (error transitorio)";
          results.push(result);
          failed++;
          onProgress?.(i + 1, recipients.length, result);
          await sleep(DELAY_BETWEEN_MS);
          continue;
        }
        if (fallback.kind === "ambiguous") {
          result.error = `varias cuentas activas y ninguna vinculada (${fallback.reason})`;
          results.push(result);
          failed++;
          onProgress?.(i + 1, recipients.length, result);
          await sleep(DELAY_BETWEEN_MS);
          continue;
        }
        if (fallback.kind === "resolved") account = fallback.account;
      }

      const accountId = account ? Number(account.id) : undefined;
      const channelAccountId =
        accountId != null && Number.isInteger(accountId) && accountId > 0
          ? accountId
          : null;
      const sendOpts = account
        ? { channel: "whatsapp" as const, account }
        : {};

      let wamid: string | undefined;
      if (imageUrl) {
        const imgResult = await messenger.send(
          {
            to: phone,
            type: "image",
            mediaUrl: imageUrl,
            text,
          },
          sendOpts
        );
        if (!imgResult.ok) {
          result.error = imgResult.error;
          results.push(result);
          failed++;
          onProgress?.(i + 1, recipients.length, result);
          await sleep(DELAY_BETWEEN_MS);
          continue;
        }
      } else {
        const txResult = await messenger.send(
          { to: phone, type: "text", text },
          sendOpts
        );
        if (!txResult.ok) {
          result.error = txResult.error;
          results.push(result);
          failed++;
          onProgress?.(i + 1, recipients.length, result);
          await sleep(DELAY_BETWEEN_MS);
          continue;
        }
        wamid = txResult.providerMessageId || undefined;
      }

      // 2. Encontrar o crear conversación
      const conv = await findOrCreateConversation(
        "whatsapp",
        phone,
        r.name || undefined,
        r.phone,
        channelAccountId
      );

      // 3. Guardar el mensaje en chat_messages (stamped with the same account)
      if (imageUrl) {
        await insertMessage(
          conv.id,
          "assistant",
          text,
          [{ type: "image", url: imageUrl, caption: text }],
          undefined,
          channelAccountId
        );
      } else {
        await insertMessage(
          conv.id,
          "assistant",
          text,
          undefined,
          wamid,
          channelAccountId
        );
      }

      result.success = true;
      sent++;
    } catch (err) {
      result.error = err instanceof Error ? err.message : String(err);
      failed++;
    }

    results.push(result);
    onProgress?.(i + 1, recipients.length, result);

    // Delay entre mensajes
    if (i < recipients.length - 1) {
      await sleep(DELAY_BETWEEN_MS);
    }
  }

  return { results, sent, failed };
}