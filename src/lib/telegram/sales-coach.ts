// ─── Sales coach: lógica pura y testeable del loop de aprendizaje ────────────
// Este módulo NO toca la base de datos ni envía mensajes. Recibe filas ya
// leídas y devuelve clasificaciones, hallazgos de tono y una propuesta de
// guía de comportamiento. La capa con DB vive en toolsSalesCoach.ts.
//
// Principio rector: evidencia verificable ≠ hipótesis. Una venta se clasifica
// SOLO por la fila de `orders` (nunca por intención). Un hallazgo de tono es
// "verificado" solo si hay una cita textual observable; lo demás es hipótesis
// y se rotula como tal.

export const GUIDANCE_KEY_PREFIX = "sales-guidance:";

// Argentina no tiene horario de verano: offset fijo UTC-3.
const AR_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Ventana [start, end) de los últimos `days` días calendario en hora Argentina.
 * Determinista y testeable; no depende del TZ del servidor.
 */
export function argentinaDayWindow(days: number, now: Date = new Date()): { start: Date; end: Date } {
  const safeDays = Math.max(1, Math.floor(days));
  const arWall = new Date(now.getTime() - AR_OFFSET_MS);
  const y = arWall.getUTCFullYear();
  const m = arWall.getUTCMonth();
  const d = arWall.getUTCDate();
  const startWallUtc = Date.UTC(y, m, d - (safeDays - 1), 0, 0, 0);
  const endWallUtc = Date.UTC(y, m, d + 1, 0, 0, 0);
  return {
    start: new Date(startWallUtc + AR_OFFSET_MS),
    end: new Date(endWallUtc + AR_OFFSET_MS),
  };
}

export type SalesOutcomeKind = "web" | "operator" | "bot" | "unresolved";

export interface OrderEvidence {
  id: number;
  createdAt: Date | string;
  phoneNumber: string;
  tags?: readonly string[] | null;
  notes?: string | null;
  status?: string | null;
}

export interface ConversationEvidence {
  id: number;
  phone?: string | null;
  humanOverrideUntil?: Date | string | null;
  humanMessages?: number;
}

export interface ClassifiedOrder {
  orderId: number;
  conversationId?: number;
  kind: SalesOutcomeKind;
  reasons: string[];
}

export interface OutcomeSummary {
  total: number;
  byKind: Record<SalesOutcomeKind, number>;
  conversationsWithoutOrder: number;
}

const WEB_TAG = "Carta digital";
const WEB_NOTE_RE = /pedido web/i;

export function toDigits(value: string | null | undefined): string {
  return String(value ?? "").replace(/\D/g, "");
}

function toTime(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Clasifica una venta. Autoridad: la fila existe en `orders`. La intención
 * nunca crea una venta. Precedencia: web → operador → bot → unresolved.
 */
export function classifyOrder(
  order: OrderEvidence,
  conversation: ConversationEvidence | undefined,
): ClassifiedOrder {
  const reasons: string[] = [];

  const isWeb =
    (Array.isArray(order.tags) && order.tags.includes(WEB_TAG)) ||
    WEB_NOTE_RE.test(order.notes ?? "");
  if (isWeb) {
    reasons.push("tag/nota de pedido web");
    return { orderId: order.id, conversationId: conversation?.id, kind: "web", reasons };
  }

  if (!conversation) {
    reasons.push("sin conversación WhatsApp asociada");
    return { orderId: order.id, kind: "unresolved", reasons };
  }

  const overrideTime = toTime(conversation.humanOverrideUntil);
  const orderTime = toTime(order.createdAt);
  const overrideActive =
    overrideTime !== null && (orderTime === null || overrideTime > orderTime);
  if (overrideActive || (conversation.humanMessages ?? 0) > 0) {
    reasons.push(
      overrideActive ? "override humano activo al momento del pedido" : "respuestas de operador en la conversación",
    );
    return { orderId: order.id, conversationId: conversation.id, kind: "operator", reasons };
  }

  reasons.push("conversación WhatsApp sin intervención de operador");
  return { orderId: order.id, conversationId: conversation.id, kind: "bot", reasons };
}

export function summarizeOutcomes(
  orders: readonly OrderEvidence[],
  conversations: readonly ConversationEvidence[],
): OutcomeSummary {
  const byKind: Record<SalesOutcomeKind, number> = { web: 0, operator: 0, bot: 0, unresolved: 0 };
  const withOrder = new Set<number>();

  for (const order of orders) {
    const digits = toDigits(order.phoneNumber);
    const conversation = conversations.find((c) => toDigits(c.phone) === digits);
    const classified = classifyOrder(order, conversation);
    byKind[classified.kind] += 1;
    if (classified.conversationId !== undefined) withOrder.add(classified.conversationId);
  }

  const conversationsWithoutOrder = conversations.filter((c) => !withOrder.has(c.id)).length;
  return { total: orders.length, byKind, conversationsWithoutOrder };
}

// ─── De-identificación ───────────────────────────────────────────────────────

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const LONG_DIGITS_RE = /\b\d{5,}\b/g;

/**
 * Redacta PII de un texto para que se pueda inspeccionar sin exponer datos:
 * nombres conocidos, teléfonos/IDs largos y emails. No imprime el URL ni
 * secretos (no los recibe).
 */
export function redactPII(text: string, names: readonly string[] = []): string {
  let out = String(text ?? "");
  const sorted = [...names]
    .filter((n) => typeof n === "string" && n.trim().length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "gi"), "[CLIENTE]");
  }
  return out
    .replace(/\b(adri(?:an|i)?)\b/gi, "[ADMIN]")
    .replace(EMAIL_RE, "[EMAIL]")
    .replace(LONG_DIGITS_RE, "[NUM]")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Análisis de tono ────────────────────────────────────────────────────────

export type ToneCategory =
  | "premature_status"
  | "ungrounded_promise"
  | "presumed_confirmation"
  | "pressured_familiarity"
  | "contradiction";

export interface ToneFinding {
  category: ToneCategory;
  /** Cita textual ya redactada que respalda el hallazgo. */
  quote: string;
  severity: "high" | "medium" | "low";
}

export interface MessageEvidence {
  role: string;
  content: string;
}

interface ToneRule {
  category: ToneCategory;
  severity: ToneFinding["severity"];
  test: RegExp;
  description: string;
}

// Reglas ancladas a los fallos observados en producción: afirmar estados sin
// respaldo, prometer envío/uber/pago antes de confirmación, familiaridad
// forzada y frases que asumen la venta.
const TONE_RULES: ToneRule[] = [
  {
    category: "premature_status",
    severity: "high",
    test: /\bya\s+est[áa](\s+todo)?\b|\bya\s+sali[óo]?\b|\bsale\s+en\s+\d/i,
    description: "afirma estado listo/enviado sin que una tool lo respalde",
  },
  {
    category: "ungrounded_promise",
    severity: "high",
    test: /\b(despu[ée]s\s+)?me\s+pas[áa]s\s+el\s+comprobante\b|\bte\s+la\s+mandamos\b|\bte\s+lo\s+mandamos\b|\bpedime\s+uber\b/i,
    description: "promete envío/uber/comprobante antes de que el cliente confirme",
  },
  {
    category: "presumed_confirmation",
    severity: "medium",
    test: /\bdale,?\s+te\s+(la|lo)\b|\blisto,?\s+te\s+(la|lo)\b/i,
    description: "asume la confirmación del cliente sin que la haya dado",
  },
  {
    category: "pressured_familiarity",
    severity: "low",
    test: /\bamigo\b/i,
    description: "familiaridad forzada ('amigo') que puede sonar a presión",
  },
];

export function analyzeTone(
  messages: readonly MessageEvidence[],
  names: readonly string[] = [],
): ToneFinding[] {
  const findings: ToneFinding[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const quote = redactPII(message.content, names);
    for (const rule of TONE_RULES) {
      if (!rule.test.test(message.content)) continue;
      const key = `${rule.category}:${quote.slice(0, 60)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ category: rule.category, quote, severity: rule.severity });
    }
  }

  return findings;
}

export function toneSummary(findings: readonly ToneFinding[]): Record<ToneCategory, number> {
  const base: Record<ToneCategory, number> = {
    premature_status: 0,
    ungrounded_promise: 0,
    presumed_confirmation: 0,
    pressured_familiarity: 0,
    contradiction: 0,
  };
  for (const f of findings) base[f.category] += 1;
  return base;
}

// ─── Propuesta de guía (compacta y revisable) ────────────────────────────────

export interface GuidanceProposal {
  lines: string[];
  text: string;
  basedOn: string[];
}

/**
 * Construye una propuesta de comportamiento BREVE y revisable. Solo incluye
 * reglas respaldadas por evidencia provista; nunca inventa. Máximo 8 líneas.
 */
export function buildGuidanceProposal(
  findings: readonly ToneFinding[],
  operatorPatterns: readonly string[] = [],
): GuidanceProposal {
  const lines: string[] = [];
  const basedOn: string[] = [];
  const summary = toneSummary(findings);

  const push = (line: string, evidence: string) => {
    if (lines.length >= 8) return;
    lines.push(line);
    basedOn.push(evidence);
  };

  if (summary.premature_status > 0) {
    push(
      "No afirmes estados del pedido ('ya está', 'ya salió', 'sale en X') sin una tool que los devuelva en ese turno.",
      `${summary.premature_status} mensaje(s) con estado no respaldado`,
    );
  }
  if (summary.ungrounded_promise > 0) {
    push(
      "No prometas envío, Uber, comprobante ni total antes de que el cliente confirme la entrega y el pago.",
      `${summary.ungrounded_promise} promesa(s) sin confirmación previa`,
    );
  }
  if (summary.presumed_confirmation > 0) {
    push(
      "No asumas la venta ('dale, te la mando', 'listo, te lo mando') hasta que el cliente dé una confirmación explícita.",
      `${summary.presumed_confirmation} confirmación(es) asumida(s)`,
    );
  }
  if (summary.pressured_familiarity > 0) {
    push(
      "Evitá la familiaridad forzada y repetida ('amigo'): calidez por palabra, no por muletilla.",
      `${summary.pressured_familiarity} uso(s) de familiaridad`,
    );
  }
  for (const pattern of operatorPatterns) {
    const clean = pattern.trim();
    if (clean) push(`Patrón de operador a preservar: ${clean}`, "ejemplo real de operador");
  }
  if (lines.length === 0) {
    push(
      "Mantener el flujo actual: no se detectaron fallos de tono en la evidencia revisada.",
      "sin hallazgos verificados",
    );
  }

  return {
    lines,
    text: lines.map((l) => `- ${l}`).join("\n"),
    basedOn,
  };
}

// ─── Claves de guía aprobada ─────────────────────────────────────────────────

export function normalizeGuidanceKey(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${GUIDANCE_KEY_PREFIX}${slug || "regla"}`;
}

export function isGuidanceMemory(key: string | null | undefined): boolean {
  return typeof key === "string" && key.startsWith(GUIDANCE_KEY_PREFIX);
}
