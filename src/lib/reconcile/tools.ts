// ─── Toolset restringido del Reconciler ──────────────────────────────────────
// Solo lectura + carga de pedidos entregados + alta de producto faltante +
// candidatas + memoria. SIN mensajería a clientes, SIN cambios de config,
// SIN borrados. El reconciler ordena la casa, no habla con nadie.

import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { reconcileCandidates } from "@/db/schema";

import { getConversationMessagesTool, queryDataTool, searchClientTool } from "@/lib/telegram/toolsManagement";
import { getPendingOrders, getTodaysOrders, searchOrdersByDate } from "@/lib/telegram/toolsQuery";
import { getAllProducts, searchProducts, createProduct } from "@/lib/telegram/toolsProduct";
import { createDeliveredOrder } from "@/lib/telegram/toolsOrder";
import { rememberThis } from "@/lib/telegram/toolsMemory";

// ─── reportReconcileCandidate ────────────────────────────────────────────────
// Deja constancia durable de algo que necesita al humano (falta un dato,
// producto fuera de catálogo, venta ambigua). El bot de Telegram la ve con
// getReconcileCandidates y el dueño la resuelve después.
export const reportReconcileCandidate = tool({
  description:
    "Registra una candidata de reconciliación cuando NO se puede cargar la venta sola: falta un dato crítico, producto sin precio en catálogo, o venta ambigua. NO usar para ventas claras — esas se cargan directo con createDeliveredOrder.",
  inputSchema: z.object({
    conversationId: z.number().int().describe("ID de la conversación de WhatsApp donde se detectó"),
    kind: z.enum(["order", "product", "info"]).describe("order = venta incompleta, product = producto vendido fuera de catálogo, info = otro dato faltante"),
    summary: z.string().describe("Qué se detectó y qué falta concretamente. Ej: 'Nico pidió 2 deli + papas pero no dice si pagó'"),
    payload: z.record(z.string(), z.unknown()).optional().describe("Datos estructurados: items tentativos, teléfono, total mencionado, etc."),
  }),
  execute: async ({ conversationId, kind, summary, payload }) => {
    const [created] = await db
      .insert(reconcileCandidates)
      .values({
        conversationId,
        kind,
        summary,
        payload: payload ?? {},
        status: "needs_info",
      })
      .returning({ id: reconcileCandidates.id });
    return { success: true, candidateId: created.id };
  },
});

export const reconcileTools = {
  // lectura de chats y datos
  getConversationMessages: getConversationMessagesTool,
  queryData: queryDataTool,
  searchClient: searchClientTool,
  searchProducts,
  getAllProducts,
  // lectura de pedidos (anti-duplicado)
  getPendingOrders,
  getTodaysOrders,
  searchOrdersByDate,
  // carga real
  createDeliveredOrder,
  createProduct,
  // memoria: aprende mapeos nuevos ("napo" = Pizza Napolitana)
  rememberThis,
  // reporte de lo que no puede resolver
  reportReconcileCandidate,
};
