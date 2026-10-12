// ─── Memory & Reconcile Tools ────────────────────────────────────────────────
// Memoria persistente del agente interno (estilo Hermes/Engram pero en la DB
// propia): reglas que el dueño dicta ("cargá siempre con items del catálogo")
// y candidatas que deja el reconciler para resolver después.

import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { agentMemories, reconcileCandidates } from "@/db/schema";
import { eq, and, desc, sql } from "drizzle-orm";

// ─── rememberThis ────────────────────────────────────────────────────────────
// Guarda una regla/hecho/preferencia de forma PERMANENTE. Upsert por key.
export const rememberThis = tool({
  description:
    "GUARDAR una regla, hecho o preferencia del dueño de forma PERMANENTE (sobrevive entre conversaciones). Usar cuando el admin diga 'dejalo como regla', 'acordate que', 'siempre hacé X', 'recordá que'. La key es un slug corto en inglés (ej: 'catalog-items-only', 'alias-mp-actual').",
  inputSchema: z.object({
    key: z.string().trim().min(3).max(120).describe("Slug corto identificador, ej: 'regla-items-catalogo'"),
    content: z.string().trim().min(1).describe("La regla/hecho a recordar, en español claro"),
    type: z.enum(["rule", "fact", "preference"]).optional().default("rule").describe("rule = regla de trabajo, fact = dato del negocio, preference = preferencia del dueño"),
  }),
  execute: async ({ key, content, type }) => {
    const normalizedKey = key.toLowerCase().replace(/\s+/g, "-").slice(0, 120);
    const [existing] = await db
      .select({ id: agentMemories.id })
      .from(agentMemories)
      .where(eq(agentMemories.key, normalizedKey))
      .limit(1);

    if (existing) {
      await db
        .update(agentMemories)
        .set({ content, type: type ?? "rule", active: true, updatedAt: new Date() })
        .where(eq(agentMemories.id, existing.id));
      return `✅ Memoria actualizada: "${normalizedKey}"`;
    }

    await db.insert(agentMemories).values({
      key: normalizedKey,
      content,
      type: type ?? "rule",
      source: "admin",
    });
    return `✅ Guardado permanente: "${normalizedKey}" — ${content.slice(0, 80)}`;
  },
});

// ─── forgetThis ──────────────────────────────────────────────────────────────
export const forgetThis = tool({
  description:
    "DESACTIVAR una regla/hecho guardado. Usar cuando el admin diga 'olvidate de X', 'esa regla ya no va', 'sacá esa regla'.",
  inputSchema: z.object({
    key: z.string().trim().min(1).describe("La key de la memoria a desactivar"),
  }),
  execute: async ({ key }) => {
    const normalizedKey = key.toLowerCase().replace(/\s+/g, "-").slice(0, 120);
    const result = await db
      .update(agentMemories)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(agentMemories.key, normalizedKey))
      .returning({ id: agentMemories.id });
    if (!result.length) return `No encontré ninguna memoria con key "${normalizedKey}".`;
    return `✅ Memoria desactivada: "${normalizedKey}"`;
  },
});

// ─── recallMemories ──────────────────────────────────────────────────────────
export const recallMemories = tool({
  description:
    "LISTAR las reglas/hechos guardados en memoria permanente. Usar cuando el admin pregunte 'qué reglas tenés?', 'qué te acordás?'.",
  inputSchema: z.object({
    query: z.string().optional().describe("Texto para filtrar (opcional)"),
  }),
  execute: async ({ query }) => {
    const rows = await db
      .select({ key: agentMemories.key, type: agentMemories.type, content: agentMemories.content })
      .from(agentMemories)
      .where(eq(agentMemories.active, true))
      .orderBy(desc(agentMemories.updatedAt))
      .limit(30);

    const filtered = query
      ? rows.filter((r) => `${r.key} ${r.content}`.toLowerCase().includes(query.toLowerCase()))
      : rows;

    if (!filtered.length) return "No tengo reglas guardadas en memoria.";
    return filtered.map((r) => `• [${r.type}] ${r.key}: ${r.content}`).join("\n");
  },
});

// ─── getReconcileCandidates ──────────────────────────────────────────────────
// Lista las ventas/datos detectados por el reconciler que quedaron pendientes.
export const getReconcileCandidates = tool({
  description:
    "Ver las ventas detectadas automáticamente en chats de WhatsApp que quedaron pendientes (necesitan un dato o confirmación del dueño). PREGUNTAS: 'qué quedó pendiente?', 'hay ventas sin cargar?', 'mostrame las candidatas'.",
  inputSchema: z.object({
    status: z.enum(["detected", "needs_info", "loaded", "dismissed"]).optional()
      .describe("Filtrar por estado. Default: detected + needs_info (las abiertas)"),
  }),
  execute: async ({ status }) => {
    const conditions = status
      ? eq(reconcileCandidates.status, status)
      : sql`${reconcileCandidates.status} IN ('detected', 'needs_info')`;

    const rows = await db
      .select()
      .from(reconcileCandidates)
      .where(conditions)
      .orderBy(desc(reconcileCandidates.createdAt))
      .limit(20);

    if (!rows.length) return "No hay candidatas pendientes de reconciliación.";

    return rows.map((r) =>
      `#${r.id} [${r.kind}/${r.status}] conv #${r.conversationId ?? "—"} — ${r.summary}${r.orderId ? ` → pedido #${r.orderId}` : ""}`
    ).join("\n");
  },
});

// ─── resolveReconcileCandidate ───────────────────────────────────────────────
export const resolveReconcileCandidate = tool({
  description:
    "Resolver una candidata de reconciliación: marcarla 'loaded' (después de cargar el pedido con createDeliveredOrder) o 'dismissed' (si no era venta). PREGUNTAS: 'cargá la candidata 3', 'la 2 no era venta, descartala'.",
  inputSchema: z.object({
    id: z.number().int().positive().describe("ID de la candidata"),
    action: z.enum(["loaded", "dismissed"]).describe("loaded = ya se cargó el pedido, dismissed = descartar (no era venta)"),
    orderId: z.number().int().optional().describe("ID del pedido creado (si action=loaded)"),
    adminNote: z.string().optional().describe("Nota del admin"),
  }),
  execute: async ({ id, action, orderId, adminNote }) => {
    const result = await db
      .update(reconcileCandidates)
      .set({
        status: action,
        orderId: orderId ?? undefined,
        adminNote: adminNote ?? undefined,
        resolvedAt: new Date(),
      })
      .where(and(
        eq(reconcileCandidates.id, id),
        sql`${reconcileCandidates.status} IN ('detected', 'needs_info')`,
      ))
      .returning({ id: reconcileCandidates.id });

    if (!result.length) return `La candidata #${id} no existe o ya fue resuelta.`;
    return `✅ Candidata #${id} marcada como ${action === "loaded" ? "cargada" : "descartada"}.`;
  },
});

export const memoryTools = {
  rememberThis,
  forgetThis,
  recallMemories,
  getReconcileCandidates,
  resolveReconcileCandidate,
};
