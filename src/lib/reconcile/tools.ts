// ─── Toolset restringido del Reconciler ──────────────────────────────────────
// SOLO LECTURA + candidatas para revisión humana. El reconciler corre
// desatendido por cron sobre texto que escriben los clientes (superficie de
// prompt-injection): NUNCA puede escribir pedidos, productos ni memoria
// permanente. Toda venta detectada se reporta como candidata y un humano la
// revisa y carga después desde el bot de Telegram.
// SIN mensajería a clientes, SIN cambios de config, SIN borrados.

import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { reconcileCandidates } from "@/db/schema";

import { getConversationMessagesTool, queryDataTool, searchClientTool } from "@/lib/telegram/toolsManagement";
import { getPendingOrders, getTodaysOrders, searchOrdersByDate } from "@/lib/telegram/toolsQuery";
import { getAllProducts, searchProducts } from "@/lib/telegram/toolsProduct";

// ─── reportReconcileCandidate ────────────────────────────────────────────────
// ÚNICA vía de salida del reconciler: deja constancia durable de una venta
// detectada o de un dato faltante para que un HUMANO la revise y cargue desde
// Telegram (getReconcileCandidates → carga → resolve). Así el texto de los
// clientes jamás se convierte en un pedido/producto real sin aprobación.
export const reportReconcileCandidate = tool({
  description:
    "Registra una candidata de reconciliación para revisión humana. Es la ÚNICA forma de salida: usala para TODA venta detectada (kind='order'), producto vendido fuera de catálogo (kind='product') o dato/mapeo faltante (kind='info'). El humano la resuelve después desde Telegram.",
  inputSchema: z.object({
    conversationId: z.number().int().describe("ID de la conversación de WhatsApp donde se detectó"),
    kind: z.enum(["order", "product", "info"]).describe("order = venta detectada (clara o incompleta), product = producto vendido fuera de catálogo, info = otro dato/mapeo a revisar"),
    summary: z.string().describe("Qué se detectó y, si falta algo, qué falta concretamente. Ej: 'Nico pidió 2 deli + papas, pagó por alias, no quedó cargada'"),
    payload: z.record(z.string(), z.unknown()).optional().describe("Datos estructurados para cargarla: items [{name,quantity}], customerName, customerPhone, deliveredAt (YYYY-MM-DD HH:MM), paymentStatus, paymentMethod, totalMentioned, orderType"),
    status: z.enum(["detected", "needs_info"]).optional().default("detected").describe("detected = venta clara lista para cargar; needs_info = falta un dato crítico que el humano tiene que completar"),
  }),
  execute: async ({ conversationId, kind, summary, payload, status }) => {
    const [created] = await db
      .insert(reconcileCandidates)
      .values({
        conversationId,
        kind,
        summary,
        payload: payload ?? {},
        status: status ?? "detected",
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
  // única salida: candidata para aprobación humana
  reportReconcileCandidate,
};
