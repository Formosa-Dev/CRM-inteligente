import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  broadcastText,
  getBroadcastRecipients,
  countRecentBroadcastSends,
  shouldBlockDuplicateBroadcast,
  formatBroadcastPreview,
  DUPLICATE_BROADCAST_WINDOW_MINUTES,
} from "@/lib/whatsapp/broadcast";
import type { BroadcastFilter } from "@/lib/whatsapp/broadcast";
import { normalizePhone, isValidPhone } from "@/lib/phone-utils";

// ─── WhatsApp Tools ──────────────────────────────────────────────────────

// sendWhatsAppMessage - Enviar WhatsApp a un cliente específico
export const sendWhatsAppMessage = tool({
  description:
    "Envía un mensaje de WhatsApp a un número de teléfono específico. Preguntas: 'mandar mensaje a cliente', 'enviar WhatsApp', 'notificar por WhatsApp'",
  inputSchema: z.object({
    to: z.string().describe("Número de teléfono del destinatario (ej: 5493704111111)"),
    message: z.string().describe("Texto del mensaje a enviar"),
  }),
  execute: async ({ to, message }) => {
    const normalized = normalizePhone(to);
    if (!isValidPhone(normalized)) return `No envié el WhatsApp: el teléfono ${to} no tiene un formato argentino válido.`;
    if (!message.trim()) return "No envié el WhatsApp: el mensaje está vacío.";
    const phone = `+${normalized}`;

    // Bound conversation → its account; unbound → the single active
    // account; ambiguous/unresolvable/transient → explicit failure, never a
    // global wrong-sender send.
    const { messenger } = await import("@/lib/messaging");
    const {
      resolveConversationAccountForPhone,
      resolveDefaultWhatsAppAccount,
    } = await import("@/lib/channels/router");
    const binding = await resolveConversationAccountForPhone(phone);
    if (binding.kind === "error") {
      return `Error al enviar WhatsApp a ${to}: no se pudo resolver la cuenta (error transitorio).`;
    }
    if (binding.kind === "ambiguous") {
      return `Error al enviar WhatsApp a ${to}: el teléfono está vinculado a varias cuentas (${binding.accountIds.join(", ")}).`;
    }
    if (binding.kind === "unresolvable") {
      return `Error al enviar WhatsApp a ${to}: la cuenta de canal #${binding.accountId} no es resoluble.`;
    }

    let account = binding.kind === "resolved" ? binding.account : undefined;
    if (!account) {
      const fallback = await resolveDefaultWhatsAppAccount();
      if (fallback.kind === "db-error") {
        return `Error al enviar WhatsApp a ${to}: no se pudo resolver la cuenta (error transitorio).`;
      }
      if (fallback.kind === "ambiguous") {
        return `Error al enviar WhatsApp a ${to}: hay varias cuentas activas y ninguna vinculada (${fallback.reason}).`;
      }
      if (fallback.kind === "not-found") {
        return `Error al enviar WhatsApp a ${to}: el canal está provisionado pero no tiene cuenta activa (${fallback.reason}).`;
      }
      if (fallback.kind === "resolved") account = fallback.account;
    }

    // Enviar WhatsApp
    const result = await messenger.send(
      { to: phone, type: "text", text: message },
      account ? { channel: "whatsapp", account } : {}
    );

    if (!result.ok) {
      return `Error al enviar WhatsApp a ${to}: ${result.error}`;
    }

    // Guardar en chat_messages (account stamped so later sends stay bound)
    try {
      const { findOrCreateConversation, insertMessage } = await import("@/lib/channels/router");
      const accountId = account ? Number(account.id) : null;
      const channelAccountId =
        accountId != null && Number.isInteger(accountId) && accountId > 0
          ? accountId
          : null;
      const conv = await findOrCreateConversation(
        "whatsapp",
        phone,
        undefined,
        to,
        channelAccountId
      );
      await insertMessage(
        conv.id,
        "assistant",
        message,
        undefined,
        result.providerMessageId || undefined,
        channelAccountId
      );
    } catch (err) {
      console.warn("[sendWhatsAppMessage] No se pudo guardar en DB:", err);
    }

    return `✅ Mensaje enviado a ${to}`;
  },
});

// ─── broadcastWhatsApp ────────────────────────────────────────────────────
// Envía mensajes masivos con filtros inteligentes

const filterDescriptions = `
Filtros disponibles:
- "todos" → Todos los leads registrados
- "b2b" → Solo clientes mayoristas
- "b2c" → Solo clientes consumidor final (hamburguesas)
- "24h" → Solo los que tienen la ventana de 24h activa (mensaje gratuito) — clientes cuyo ÚLTIMO MENSAJE ENTRANTE fue hace menos de 24h
- "con-pedido" → Solo los que ya hicieron algún pedido
- "buscar: TEXTO" → Busca por nombre o teléfono (ej: "buscar: juan")
`;

export const broadcastWhatsApp = tool({
  description:
    `Envía un mensaje MASIVO de WhatsApp a múltiples clientes con filtros inteligentes. Los mensajes se guardan automáticamente en el historial de chats.\n${filterDescriptions}\nFlujo recomendado: 1) llamá con dryRun=true para ver la audiencia real (count + lista), 2) mostrás texto + audiencia al admin, 3) si aprueba, ejecutás con dryRun=false con el MISMO filtro y mensaje. Sin repreguntar una vez confirmado.`,
  inputSchema: z.object({
    filter: z.string().describe(
      "Filtro: 'todos', 'b2b', 'b2c', '24h', 'con-pedido', o 'buscar: TEXTO'"
    ),
    message: z.string().describe("Texto del mensaje a enviar a TODOS los destinatarios"),
    maxRecipients: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .default(50)
      .describe("Máximo de destinatarios (default 50, máximo 200)"),
    attachMenu: z
      .boolean()
      .optional()
      .default(false)
      .describe("Si es true, adjunta el menú de hamburguesas al mensaje"),
    dryRun: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Si es true, NO envía nada: devuelve la audiencia real (count + lista de nombres/teléfonos). Usalo SIEMPRE primero para mostrarle al admin quiénes recibirían el mensaje antes de confirmar el envío."
      ),
    allowDuplicate: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Si es true, fuerza el envío aunque el mismo texto ya se haya mandado recién. Solo si el admin pide reenviar explícitamente."
      ),
  }),
  execute: async ({ filter, message, maxRecipients, attachMenu, dryRun, allowDuplicate }) => {
    // 1. Resolver filtro
    let broadcastFilter: BroadcastFilter;

    if (filter === "todos") {
      broadcastFilter = { type: "all" };
    } else if (filter === "b2b") {
      broadcastFilter = { type: "b2b" };
    } else if (filter === "b2c") {
      broadcastFilter = { type: "b2c" };
    } else if (filter === "24h") {
      broadcastFilter = { type: "24h-window" };
    } else if (filter === "con-pedido") {
      broadcastFilter = { type: "has-ordered" };
    } else if (filter.startsWith("buscar:")) {
      const query = filter.slice("buscar:".length).trim();
      if (!query) return "Usá 'buscar: TEXTO' con un término de búsqueda.";
      broadcastFilter = { type: "search", query };
    } else {
      return `Filtro no válido. Usá uno de: todos, b2b, b2c, 24h, con-pedido, buscar: TEXTO`;
    }

    // 2. Resolver TODOS los destinatarios que matchean (para reportar el total real)
    const matched = await getBroadcastRecipients(broadcastFilter);
    const recipients = matched.slice(0, maxRecipients);
    const capped = matched.length > recipients.length;

    if (matched.length === 0) {
      return `No se encontraron destinatarios para el filtro "${filter}".`;
    }

    // 3. dryRun → preview de audiencia sin enviar
    if (dryRun) {
      return formatBroadcastPreview({
        filterLabel: filter,
        totalMatched: matched.length,
        recipients,
        maxRecipients,
        capped,
      });
    }

    // 4. Guard anti doble-envío: mismo texto no sale dos veces en una ventana corta
    const recentSends = await countRecentBroadcastSends(message);
    if (shouldBlockDuplicateBroadcast(recentSends, allowDuplicate)) {
      return (
        `⚠️ No mandé el broadcast: ese mismo texto ya se envió a ${recentSends} conversaciones ` +
        `hace menos de ${DUPLICATE_BROADCAST_WINDOW_MINUTES} minutos. ` +
        `Si es un reenvío intencional, confirmalo con el admin y ejecutá con allowDuplicate=true.`
      );
    }

    // 5. Obtener URL del menú si attachMenu
    let imageUrl: string | undefined;
    if (attachMenu) {
      try {
        const [cfg] = await db
          .select({ urls: agentConfig.menuImageUrlsHamburguesas })
          .from(agentConfig)
          .where(eq(agentConfig.id, 1))
          .limit(1);
        imageUrl = (cfg?.urls && cfg.urls.length > 0) ? cfg.urls[0] : undefined;
      } catch {
        // non-fatal
      }
    }

    // 6. Enviar broadcast
    const { results, sent, failed } = await broadcastText(
      recipients,
      message,
      undefined,
      imageUrl,
    );

    // 7. Armar resumen
    const lines: string[] = [
      `📨 Broadcast completado:`,
      `✅ Enviados: ${sent}`,
      `❌ Fallaron: ${failed}`,
      `👥 Destinatarios: ${recipients.length} de ${matched.length} que matchean`,
      ``,
      `Detalle:`,
    ];

    if (capped) {
      lines.splice(4, 0, `⚠️ El filtro matchea ${matched.length} pero el límite es ${maxRecipients} — quedaron ${matched.length - recipients.length} sin enviar. Subí maxRecipients o afiná el filtro si querés llegar a todos.`);
    }

    for (const r of results.slice(0, 20)) {
      const icon = r.success ? "✅" : "❌";
      lines.push(`${icon} ${r.name || "—"} (${r.phone})${r.error ? `: ${r.error}` : ""}`);
    }

    if (results.length > 20) {
      lines.push(`... y ${results.length - 20} más`);
    }

    return lines.join("\n");
  },
});

// Exportar todas las herramientas WhatsApp
export const whatsAppTools = {
  sendWhatsAppMessage,
  broadcastWhatsApp,
};
