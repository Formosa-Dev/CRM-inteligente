import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GUIDANCE_KEY_PREFIX,
  analyzeTone,
  argentinaDayWindow,
  buildGuidanceProposal,
  classifyOrder,
  isGuidanceMemory,
  normalizeGuidanceKey,
  redactPII,
  summarizeOutcomes,
  toneSummary,
  type ConversationEvidence,
  type OrderEvidence,
} from "./sales-coach";
import { INTERNAL_AGENT_SYSTEM_PROMPT } from "./system-prompt";

// ─── Clasificación de ventas (autoridad = fila en orders) ────────────────────

function order(over: Partial<OrderEvidence> = {}): OrderEvidence {
  return { id: 1, createdAt: new Date("2026-10-13T03:00:00Z"), phoneNumber: "5493704000000", ...over };
}

test("un pedido web se clasifica como web por tag o nota, sin importar la conversación", () => {
  const web = classifyOrder(order({ tags: ["Carta digital"] }), { id: 5 });
  assert.equal(web.kind, "web");
  const webNote = classifyOrder(order({ notes: "Pedido web (x; y; z; delivery)" }), { id: 5 });
  assert.equal(webNote.kind, "web");
});

test("override humano activo al crear el pedido ⇒ operador", () => {
  const conv: ConversationEvidence = {
    id: 7,
    phone: "5493704000000",
    humanOverrideUntil: new Date("2026-10-13T05:00:00Z"),
  };
  assert.equal(classifyOrder(order(), conv).kind, "operator");
});

test("respuestas de operador en la conversación ⇒ operador", () => {
  const conv: ConversationEvidence = { id: 7, phone: "5493704000000", humanMessages: 3 };
  assert.equal(classifyOrder(order(), conv).kind, "operator");
});

test("conversación sin intervención de operador ⇒ bot", () => {
  const conv: ConversationEvidence = { id: 7, phone: "5493704000000", humanMessages: 0 };
  assert.equal(classifyOrder(order(), conv).kind, "bot");
});

test("pedido sin conversación asociada ⇒ unresolved (nunca se infiere una venta por intención)", () => {
  assert.equal(classifyOrder(order(), undefined).kind, "unresolved");
});

test("summarizeOutcomes cuenta por origen y conversaciones sin venta", () => {
  const convs: ConversationEvidence[] = [
    { id: 1, phone: "5493704000001", humanMessages: 0 },
    { id: 2, phone: "5493704000002", humanMessages: 2 },
    { id: 3, phone: "5493704000003", humanMessages: 0 }, // sin pedido
  ];
  const orders: OrderEvidence[] = [
    order({ id: 10, phoneNumber: "5493704000001" }),
    order({ id: 11, phoneNumber: "5493704000002" }),
    order({ id: 12, phoneNumber: "5493704000009" }), // sin conversación
  ];
  const s = summarizeOutcomes(orders, convs);
  assert.equal(s.total, 3);
  assert.equal(s.byKind.bot, 1);
  assert.equal(s.byKind.operator, 1);
  assert.equal(s.byKind.unresolved, 1);
  assert.equal(s.conversationsWithoutOrder, 1);
});

// ─── De-identificación ───────────────────────────────────────────────────────

test("redactPII quita nombres conocidos, teléfonos largos y emails", () => {
  const out = redactPII("Juan quiere 5493704868421, mail juan@test.com", ["Juan", "María"]);
  assert.doesNotMatch(out, /Juan/);
  assert.doesNotMatch(out, /5493704868421/);
  assert.doesNotMatch(out, /juan@test.com/);
  assert.match(out, /\[CLIENTE\]/);
  assert.match(out, /\[NUM\]/);
  assert.match(out, /\[EMAIL\]/);
});

// ─── Análisis de tono: verificado vs hipótesis ───────────────────────────────

test("analyzeTone detecta estado prematuro y promesa sin respaldo en mensajes del bot", () => {
  const findings = analyzeTone(
    [
      { role: "user", content: "quiero una toro" },
      { role: "assistant", content: "Ya esta todo, dentro de 20 sale. Podes venir" },
      { role: "assistant", content: "Dale, te la mandamos. Despues me pasas el comprobante del uber" },
    ],
    [],
  );
  const t = toneSummary(findings);
  assert.ok(t.premature_status >= 1);
  assert.ok(t.ungrounded_promise >= 1);
});

test("analyzeTone ignora mensajes del cliente y del operador", () => {
  const findings = analyzeTone(
    [
      { role: "user", content: "ya esta?" },
      { role: "human", content: "amigo dale" },
    ],
    [],
  );
  assert.equal(findings.length, 0);
});

test("analyzeTone no duplica el mismo hallazgo y redacta la cita", () => {
  const findings = analyzeTone(
    [{ role: "assistant", content: "Hola Juan, ya esta todo" }],
    ["Juan"],
  );
  assert.equal(findings.length, 1);
  assert.doesNotMatch(findings[0].quote, /Juan/);
});

// ─── Propuesta compacta y revisable ──────────────────────────────────────────

test("buildGuidanceProposal es compacta (≤8 líneas), marcada como propuesta y con base", () => {
  const findings = analyzeTone(
    [{ role: "assistant", content: "Ya esta todo. Dale, te la mandamos" }],
    [],
  );
  const proposal = buildGuidanceProposal(findings, ["Dalee", "Con envio o buscas?"]);
  assert.ok(proposal.lines.length <= 8);
  assert.ok(proposal.lines.length >= 1);
  assert.ok(proposal.basedOn.length >= 1);
  assert.match(proposal.text, /^- /m);
});

test("buildGuidanceProposal sin hallazgos no inventa reglas", () => {
  const proposal = buildGuidanceProposal([], []);
  assert.match(proposal.text, /no se detectaron fallos/i);
});

// ─── Claves de guía aprobada ─────────────────────────────────────────────────

test("normalizeGuidanceKey prefija y sanea; isGuidanceMemory distingue el namespace", () => {
  const key = normalizeGuidanceKey("Tono Directo!");
  assert.equal(key, `${GUIDANCE_KEY_PREFIX}tono-directo`);
  assert.equal(isGuidanceMemory(key), true);
  assert.equal(isGuidanceMemory("catalog-items-only"), false);
  assert.equal(isGuidanceMemory(undefined), false);
});

// ─── Ventana Argentina ───────────────────────────────────────────────────────

test("argentinaDayWindow (1 día) arranca a las 03:00 UTC del día AR y termina 24h después", () => {
  const now = new Date("2026-10-13T05:56:00Z"); // 02:56 AR del 13/10
  const { start, end } = argentinaDayWindow(1, now);
  assert.equal(start.toISOString(), "2026-10-13T03:00:00.000Z");
  assert.equal(end.toISOString(), "2026-10-14T03:00:00.000Z");
});

test("argentinaDayWindow (3 días) incluye dos días previos AR", () => {
  const now = new Date("2026-10-13T05:56:00Z");
  const { start } = argentinaDayWindow(3, now);
  assert.equal(start.toISOString(), "2026-10-11T03:00:00.000Z");
});

// ─── Regresiones de prompt / comportamiento ──────────────────────────────────

test("el prompt de WhatsApp endurece el tono: directo, no presumido, sin estados inventados", () => {
  const src = readFileSync("src/lib/whatsapp/prompt-builder.ts", "utf8");
  assert.match(src, /\[TONO — DIRECTO PERO NO PREsumIDO\]/);
  assert.match(src, /no digas "ya está"/i);
  assert.match(src, /no prometas Uber, envío/i);
});

test("el agente de Telegram tiene el loop de aprendizaje y prohíbe afirmar que entrenó solo", () => {
  assert.match(INTERNAL_AGENT_SYSTEM_PROMPT, /analyzeSalesChats/);
  assert.match(INTERNAL_AGENT_SYSTEM_PROMPT, /proposeSalesGuidance/);
  assert.match(INTERNAL_AGENT_SYSTEM_PROMPT, /applySalesGuidance/);
  assert.match(INTERNAL_AGENT_SYSTEM_PROMPT, /NUNCA digas "entrené"/);
  assert.match(INTERNAL_AGENT_SYSTEM_PROMPT, /solo con aprobación explícita/i);
});

test("la capa de guía aprobada se inyecta solo con el prefijo sales-guidance:", () => {
  const src = readFileSync("src/lib/whatsapp/prompt-builder.ts", "utf8");
  assert.match(src, /getApprovedSalesGuidance/);
  assert.match(src, /sales-guidance:/);
});
