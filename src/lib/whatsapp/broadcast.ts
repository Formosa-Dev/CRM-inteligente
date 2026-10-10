import { db } from "@/db";
import { leads, conversations } from "@/db/schema";
import { eq, and, or, ilike, desc, gte, isNotNull } from "drizzle-orm";
import { sendText, sendImage } from "@/lib/ycloud";
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

/**
 * Obtiene los destinatarios según el filtro seleccionado.
 */
export async function getBroadcastRecipients(
  filter: BroadcastFilter,
  maxRecipients: number
): Promise<BroadcastRecipient[]> {
  let rows: { phone: string; name: string | null }[] = [];

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
        .limit(maxRecipients);
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
        .limit(maxRecipients);
      break;

    case "24h-window": {
      // Clientes con actividad en las últimas 24h (ventana gratuita de WhatsApp)
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const activeConversations = await db
        .select({ customerPhone: conversations.customerPhone })
        .from(conversations)
        .where(
          and(
            eq(conversations.channel, "whatsapp"),
            gte(conversations.lastMessageAt, twentyFourHoursAgo),
          ),
        )
        .orderBy(desc(conversations.lastMessageAt))
        .limit(maxRecipients);

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
        .limit(maxRecipients);
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
        .limit(maxRecipients);
      break;

    case "all":
      rows = await db
        .select({ phone: leads.phone, name: leads.name })
        .from(leads)
        .where(isNotNull(leads.phone))
        .orderBy(desc(leads.createdAt))
        .limit(maxRecipients);
      break;
  }

  return rows.filter((r) => r.phone?.trim());
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
      // 1. Enviar WhatsApp
      let wamid: string | undefined;
      if (imageUrl) {
        const imgResult = await sendImage(phone, imageUrl, text);
        if (!imgResult.ok) {
          result.error = imgResult.error;
          results.push(result);
          failed++;
          onProgress?.(i + 1, recipients.length, result);
          await sleep(DELAY_BETWEEN_MS);
          continue;
        }
      } else {
        const txResult = await sendText(phone, text);
        if (!txResult.ok) {
          result.error = txResult.error;
          results.push(result);
          failed++;
          onProgress?.(i + 1, recipients.length, result);
          await sleep(DELAY_BETWEEN_MS);
          continue;
        }
        wamid = txResult.wamid;
      }

      // 2. Encontrar o crear conversación
      const conv = await findOrCreateConversation(
        "whatsapp",
        phone,
        r.name || undefined,
        r.phone,
      );

      // 3. Guardar el mensaje en chat_messages
      if (imageUrl) {
        await insertMessage(conv.id, "assistant", text, [
          { type: "image", url: imageUrl, caption: text },
        ]);
      } else {
        await insertMessage(conv.id, "assistant", text, undefined, wamid);
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