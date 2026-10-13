import { tool } from "ai";
import { z } from "zod";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { agentMemories, chatMessages, conversations, orders } from "@/db/schema";
import {
  analyzeTone,
  argentinaDayWindow,
  buildGuidanceProposal,
  classifyOrder,
  normalizeGuidanceKey,
  redactPII,
  summarizeOutcomes,
  toneSummary,
  type ConversationEvidence,
  type MessageEvidence,
  type OrderEvidence,
  type ToneFinding,
} from "./sales-coach";

// ─── Sales Coach: loop de aprendizaje operador → agente ──────────────────────
// El admin de Telegram pide analizar ventas/chats; el agente LEE evidencia
// (solo SELECT), la cruza con el feedback del operador y devuelve hallazgos
// verificables + hipótesis rotuladas + una propuesta de comportamiento.
//
// Reglas duras:
//   - analyzeSalesChats / proposeSalesGuidance: NUNCA escriben ni entrenan.
//     Solo analizan; el texto de salida lo dice explícitamente.
//   - applySalesGuidance: única tool que persiste, y SOLO con approved=true
//     tras aprobación explícita del admin. Guarda en agent_memories con
//     prefijo `sales-guidance:` (revisable y borrable con forgetThis).

interface SalesEvidence {
  windowStart: Date;
  windowEnd: Date;
  conversations: ConversationEvidence[];
  messages: MessageEvidence[];
  orders: OrderEvidence[];
  names: string[];
  operatorFeedback: string[];
}

const MAX_QUOTES = 12;

async function gatherSalesEvidence(days: number, now: Date = new Date()): Promise<SalesEvidence> {
  const { start, end } = argentinaDayWindow(days, now);

  const rows = await db
    .select({
      convId: conversations.id,
      customerName: conversations.customerName,
      customerPhone: conversations.customerPhone,
      humanOverrideUntil: conversations.humanOverrideUntil,
      role: chatMessages.role,
      content: chatMessages.content,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .innerJoin(conversations, eq(chatMessages.conversationId, conversations.id))
    .where(
      and(
        eq(conversations.channel, "whatsapp"),
        gte(chatMessages.createdAt, start),
        lt(chatMessages.createdAt, end),
      ),
    )
    .orderBy(chatMessages.createdAt);

  const convMap = new Map<number, ConversationEvidence>();
  const humanCounts = new Map<number, number>();
  const names = new Set<string>();
  const messages: MessageEvidence[] = [];

  for (const r of rows) {
    if (r.customerName) names.add(r.customerName);
    if (!convMap.has(r.convId)) {
      convMap.set(r.convId, {
        id: r.convId,
        phone: r.customerPhone,
        humanOverrideUntil: r.humanOverrideUntil,
        humanMessages: 0,
      });
    }
    if (r.role === "human") humanCounts.set(r.convId, (humanCounts.get(r.convId) ?? 0) + 1);
    messages.push({ role: r.role, content: r.content });
  }
  for (const conv of convMap.values()) {
    conv.humanMessages = humanCounts.get(conv.id) ?? 0;
  }

  const orderRows = await db
    .select({
      id: orders.id,
      createdAt: orders.createdAt,
      phoneNumber: orders.phoneNumber,
      tags: orders.tags,
      notes: orders.notes,
      status: orders.status,
    })
    .from(orders)
    .where(and(gte(orders.createdAt, start), lt(orders.createdAt, end)));

  // Feedback del operador: mensajes recientes del admin por Telegram (read-only).
  const tgRows = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .innerJoin(conversations, eq(chatMessages.conversationId, conversations.id))
    .where(and(eq(conversations.channel, "telegram"), eq(chatMessages.role, "user"), gte(chatMessages.createdAt, start)))
    .orderBy(desc(chatMessages.createdAt))
    .limit(15);

  return {
    windowStart: start,
    windowEnd: end,
    conversations: [...convMap.values()],
    messages,
    orders: orderRows,
    names: [...names],
    operatorFeedback: tgRows.map((r) => r.content).filter(Boolean),
  };
}

function formatWindow(ev: SalesEvidence): string {
  const f = (d: Date) =>
    d.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", day: "2-digit", month: "2-digit", year: "numeric" });
  return `${f(ev.windowStart)} → ${f(new Date(ev.windowEnd.getTime() - 1))} (hora Argentina)`;
}

function formatEvidenceReport(ev: SalesEvidence): { report: string; findings: ToneFinding[] } {
  const summary = summarizeOutcomes(ev.orders, ev.conversations);
  const findings = analyzeTone(ev.messages, ev.names);
  const tone = toneSummary(findings);

  const lines: string[] = [];
  lines.push(`ANÁLISIS DE VENTAS — ${formatWindow(ev)}`);
  lines.push(`Conversaciones WhatsApp: ${ev.conversations.length} · Mensajes: ${ev.messages.length} · Pedidos: ${ev.orders.length}`);
  lines.push(
    `Resultado (criterio: fila en orders): bot=${summary.byKind.bot} · operador=${summary.byKind.operator} · web=${summary.byKind.web} · sin-conversación=${summary.byKind.unresolved} · conv. sin venta=${summary.conversationsWithoutOrder}`,
  );

  lines.push("");
  lines.push("HALLAZGOS VERIFICADOS (cita textual redactada):");
  if (findings.length === 0) {
    lines.push("- Sin fallos de tono detectados en los mensajes del bot.");
  } else {
    for (const f of findings.slice(0, MAX_QUOTES)) {
      lines.push(`- [${f.category}/${f.severity}] "${f.quote}"`);
    }
  }
  lines.push(
    `Conteo por categoría: estado-prematuro=${tone.premature_status} · promesa-sin-respaldo=${tone.ungrounded_promise} · confirmación-asumida=${tone.presumed_confirmation} · familiaridad=${tone.pressured_familiarity}`,
  );

  lines.push("");
  lines.push("PATRONES DE OPERADOR OBSERVADOS (a preservar — cita redactada):");
  const operatorQuotes = ev.messages
    .filter((m) => m.role === "human" && m.content.trim().length > 0 && m.content.trim().length <= 60)
    .slice(0, 8)
    .map((m) => redactPII(m.content, ev.names));
  if (operatorQuotes.length === 0) lines.push("- Sin mensajes de operador en la ventana.");
  else for (const q of operatorQuotes) lines.push(`- "${q}"`);

  lines.push("");
  lines.push("HIPÓTESIS (NO verificadas — requieren juicio del admin):");
  lines.push(
    `- Si los pedidos se concentran en operador, el bot estaría soltando la conversación antes de cerrar (proporción bot/operador arriba).`,
  );
  lines.push("- La causa raíz de cada fallo de tono no puede probarse solo con el texto; revisá las citas antes de aceptar una regla.");

  lines.push("");
  lines.push("ALCANCE: análisis read-only. No entrené ni modifiqué ningún prompt, memoria ni dato de producción.");

  return { report: lines.join("\n"), findings };
}

export interface SalesEvidenceLike {
  conversations: ConversationEvidence[];
  messages: MessageEvidence[];
  orders: OrderEvidence[];
}

/** Expuesto para tests: clasifica sin tocar la DB. */
export function classifyOrdersForWindows(ev: SalesEvidenceLike) {
  return ev.orders.map((o) => {
    const conv = ev.conversations.find((c) => String(c.phone ?? "").replace(/\D/g, "") === String(o.phoneNumber).replace(/\D/g, ""));
    return classifyOrder(o, conv);
  });
}

// ─── analyzeSalesChats ───────────────────────────────────────────────────────

export const analyzeSalesChats = tool({
  description:
    "ANALIZA (solo lectura) las ventas y conversaciones de WhatsApp de los últimos N días en hora Argentina, y las cruza con el feedback del operador. Devuelve resultados clasificados (bot/operador/web/sin-conversación), fallos de tono VERIFICADOS con cita y patrones de operador. NO entrena ni modifica nada. Usar cuando el admin diga 'analizá las ventas de hoy', 'cómo vende el bot', 'qué falló en los chats', 'revisá el tono'.",
  inputSchema: z.object({
    days: z.number().int().min(1).max(30).optional().default(1).describe("Ventana en días (default 1 = hoy)"),
  }),
  execute: async ({ days }) => {
    const ev = await gatherSalesEvidence(days ?? 1);
    return formatEvidenceReport(ev).report;
  },
});

// ─── proposeSalesGuidance ────────────────────────────────────────────────────

export const proposeSalesGuidance = tool({
  description:
    "PROPONE (sin aplicar) un cambio de comportamiento COMPACTO para el agente de ventas, cruzando el feedback del operador con la evidencia real de los chats. Devuelve las líneas propuestas para que el admin las revise. NUNCA aplica ni entrena: para que tome efecto el admin debe aprobar y llamar applySalesGuidance. Usar cuando el admin diga 'proponeme mejoras', 'qué reglas agregarías', 'armá una guía para el bot'.",
  inputSchema: z.object({
    adminFeedback: z.string().min(1).describe("Qué observó/pidió el operador sobre el tono o el comportamiento del agente"),
    days: z.number().int().min(1).max(30).optional().default(3).describe("Ventana de evidencia en días (default 3)"),
  }),
  execute: async ({ adminFeedback, days }) => {
    const ev = await gatherSalesEvidence(days ?? 3);
    const findings = analyzeTone(ev.messages, ev.names);
    const operatorPatterns = ev.messages
      .filter((m) => m.role === "human" && m.content.trim().length > 0 && m.content.trim().length <= 40)
      .slice(0, 3)
      .map((m) => redactPII(m.content, ev.names));

    const feedbackQuotes = redactPII(adminFeedback.slice(0, 160), ev.names);
    const proposal = buildGuidanceProposal(findings, operatorPatterns);

    return [
      `PROPUESTA DE GUÍA (revisar y aprobar — todavía NO aplicada)`,
      `Feedback del operador: "${feedbackQuotes}"`,
      `Ventana: ${formatWindow(ev)} · pedidos=${ev.orders.length} · conversaciones=${ev.conversations.length}`,
      ``,
      proposal.text,
      ``,
      `Base de la propuesta: ${proposal.basedOn.join("; ") || "sin evidencia"}.`,
      `Para aplicarla decime "aplicá la guía" (la guardo de forma revisable en memoria). No entrené ni cambie nada todavía.`,
    ].join("\n");
  },
});

// ─── applySalesGuidance ──────────────────────────────────────────────────────

export const applySalesGuidance = tool({
  description:
    "APLICA (persiste) una guía de comportamiento YA APROBADA por el admin para el agente de ventas de WhatsApp. Solo llamar cuando el admin apruebe EXPLÍCITAMENTE (approved=true). Guarda cada línea como memoria revisable en agent_memories con prefijo 'sales-guidance:' (se puede ver con recallMemories y quitar con forgetThis). NUNCA llamar por iniciativa propia ni sin aprobación.",
  inputSchema: z.object({
    label: z.string().min(3).max(60).describe("Etiqueta corta de esta guía (ej: 'tono-directo')"),
    guidance: z.string().min(1).describe("Texto de la guía aprobada; una regla por línea, en español"),
    approved: z.literal(true).describe("Debe ser true, y solo si el admin aprobó explícitamente esta guía"),
  }),
  execute: async ({ label, guidance, approved }) => {
    if (approved !== true) {
      return "No aplico nada: falta la aprobación explícita del admin (approved=true).";
    }
    const lines = guidance
      .split("\n")
      .map((l) => l.replace(/^[-•\s]+/, "").trim())
      .filter((l) => l.length > 0)
      .slice(0, 8);

    if (lines.length === 0) return "No apliqué nada: la guía está vacía.";

    const keys: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const key = normalizeGuidanceKey(`${label}-${i + 1}`);
      await db
        .insert(agentMemories)
        .values({ key, type: "preference", content: lines[i], source: "sales-coach", active: true })
        .onConflictDoUpdate({ target: agentMemories.key, set: { content: lines[i], active: true, updatedAt: new Date() } });
      keys.push(key);
    }

    return [
      `✅ Guía aplicada: ${lines.length} regla(s) guardadas como memoria revisable.`,
      `Claves: ${keys.join(", ")}`,
      `Efecto: se inyectan en el prompt del agente de ventas de WhatsApp en el próximo turno. Revisables con recallMemories; se quitan con forgetThis.`,
    ].join("\n");
  },
});

export const salesCoachTools = {
  analyzeSalesChats,
  proposeSalesGuidance,
  applySalesGuidance,
};
