import { generateText, stepCountIs, type ModelMessage } from "ai";
import { extractWebOrderReference, checkoutPhone } from "@/lib/checkout/contract";
import { findReferencedWebOrder } from "@/lib/checkout/service";
import type { OpenAILanguageModelChatOptions } from "@ai-sdk/openai";
import {
  getMenuTool,
  checkAvailabilityTool,
  getBusinessHoursTool,
  createTransferToHumanTool,
  getProductDetailsTool,
  getProductPriceTool,
  searchProductsTool,
  checkProductAvailabilityTool,
  suggestProductsTool,
  getClientHistoryTool,
  checkDeliveryTool,
  getDeliveryTimeTool,
  listAvailableProductsTool,
  getWaitTimeTool,
  getOrderStatusTool,
  addToOrderTool,
  updateOrderTool,
  cancelOrderTool,
  createSendProductImageTool,
  checkKitchenStatusTool,
  checkPanStockTool,
  checkHamburguesasStockTool,
  saveAddressTool,
  getPaymentAliasTool,
  createSendStickerTool,
  createSendMenuImageTool,
  createSendPromoImageTool,
  createSendImageTool,
  createSendDocumentTool,
  createAddOrderItemTool,
  createCreateOrderTool,
  createGetOrderSummaryTool,
  createGetAddressesTool,
  getActivePromosTool,
} from "./tools";
import { detectInjection } from "./tools/prompt-security";
import { buildSystemPrompt, DEFAULT_SYSTEM_PROMPT, type CustomerContext } from "./prompt-builder";
import { assertSessionContext, type SessionContext } from "./session-policy";
import { getAIConfig, getMainChatModel, isOpenAIBaseUrl } from "@/lib/ai/config";
import {
  resolveScopeForConversation,
  runWithAgentConfigScope,
} from "@/lib/agent-config-scope";
import { getStatusSemantic } from "./status-utils";
import { classifyTurnIntent, evaluateOrderLifecycle, filterSameDayActiveCartRows } from "./temporal-context";

// ─── Session routing guard (SDD memoria-persistente-sesion-whatsapp, PR 4) ───
// Only an AI-enabled, permitted commercial flow may reach the LLM/tools.
// Fixed, handoff, blocked, and duplicate paths resolve to a fixed reply (or
// silence) WITHOUT invoking GPT or any tool.
export type AgentRoutingKind =
  | "allow_agent"
  | "fixed_ack"
  | "fixed_clarification"
  | "handoff"
  | "blocked"
  | "duplicate";

// Nombre del humano del negocio (identidad del despliegue, no del repo).
const OWNER_NAME = process.env.BUSINESS_OWNER_NAME?.trim() || "una persona del equipo";

export const FIXED_ACK_REPLY = "Holaa ¿todo bien?";
export const FIXED_CLARIFICATION_REPLY =
  "¿Me contás qué necesitás del negocio? Si querés pedir o consultar precios, decime.";
export const HANDOFF_REPLY = `Ahí te paso con ${OWNER_NAME}, yo estoy para cosas del negocio.`;

export function resolveAgentRouting(kind: AgentRoutingKind): {
  invokeLLM: boolean;
  useTools: boolean;
  fixedReply: string | null;
} {
  switch (kind) {
    case "allow_agent":
      return { invokeLLM: true, useTools: true, fixedReply: null };
    case "fixed_ack":
      return { invokeLLM: false, useTools: false, fixedReply: FIXED_ACK_REPLY };
    case "fixed_clarification":
      return { invokeLLM: false, useTools: false, fixedReply: FIXED_CLARIFICATION_REPLY };
    case "handoff":
      return { invokeLLM: false, useTools: false, fixedReply: HANDOFF_REPLY };
    case "blocked":
    case "duplicate":
      return { invokeLLM: false, useTools: false, fixedReply: null };
  }
}

interface RunAgentParams {
  conversationId: number;
  customerPhone: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  /** Compact permitted session facts only (validated, never text/PII). */
  sessionContext?: SessionContext;
  /** Boundary routing kind — non-commercial kinds never reach the LLM/tools. */
  routingKind?: AgentRoutingKind;
  /** Provider message IDs of the current turn, forwarded to the order audit. */
  turnMessageIds?: string[];
}

export interface PendingMedia {
  type: "image" | "document" | "sticker";
  url: string;
  caption: string;
  dbContent: string;
}

// S13: every agent_config read inside a run (prompt layers, tool executes,
// AI creds, delivery notify) resolves the conversation's account/channel row.
// Outside this wrapper nothing changes — ambient scope is empty → global row.
export async function runWhatsAppAgent(
  params: RunAgentParams
): Promise<{ text: string; pendingMedia: PendingMedia[] }> {
  const scope = await resolveScopeForConversation(params.conversationId);
  return runWithAgentConfigScope(scope, () => runWhatsAppAgentImpl(params));
}

async function runWhatsAppAgentImpl({
  conversationId,
  customerPhone,
  messages,
  sessionContext,
  routingKind,
  turnMessageIds,
}: RunAgentParams): Promise<{ text: string; pendingMedia: PendingMedia[] }> {
  // 🧠 SESIÓN PERSISTENTE (SDD memoria-persistente-sesion-whatsapp, PR 4):
  // fixed/handoff/blocked/duplicate NEVER reach the LLM or tools — return
  // the fixed reply (or silence) before any GPT/tool code runs.
  if (routingKind !== undefined) {
    const routing = resolveAgentRouting(routingKind);
    if (!routing.invokeLLM) {
      return { text: routing.fixedReply ?? "", pendingMedia: [] };
    }
  }
  // Only permitted compact non-text commercial facts are accepted. Any
  // message text, PII, payment value, prompt, or media payload fails closed.
  if (sessionContext !== undefined) {
    assertSessionContext(sessionContext);
  }

  console.log("[agent] === AGENT v2.2 (gpt-5.4-mini + business-intent toolChoice:required + Type C) ===");
  // 🛡️ PROMPT INJECTION DETECTION
  const lastUserMessage = messages[messages.length - 1]?.content || "";
  const injectionCheck = detectInjection(lastUserMessage);
  
  if (injectionCheck.detected) {
    console.warn("[agent] Prompt injection detected:", injectionCheck.pattern);
    return { text: "No puedo procesar esa solicitud. ¿Querés hacer un pedido o ver el menú?", pendingMedia: [] };
  }

  // A reference alone never grants ownership: verify against the transport sender.
  const webReference = extractWebOrderReference(lastUserMessage);
  let referencedWebOrder: { id: number; status: string } | undefined;
  if (webReference) {
    try {
      referencedWebOrder = await findReferencedWebOrder(webReference, checkoutPhone(customerPhone));
      if (!referencedWebOrder) return {
        text: "No pude asociar esa referencia con este WhatsApp. Escribinos desde el número que ingresaste en la carta o pedí ayuda para corregirlo. No creé otro pedido.", pendingMedia: [],
      };
    } catch {
      return { text: "No pude verificar el pedido ahora. Reenviá el mismo mensaje en unos momentos; así evitamos duplicarlo.", pendingMedia: [] };
    }
  }

  // 🔄 ANTI-LOOP: detectar si estamos en un ciclo de repetición
  let antiLoopDirective = "";
  try {
    const { analyzeConversationState } = await import("./anti-loop");
    const state = await analyzeConversationState(conversationId, lastUserMessage, []);
    antiLoopDirective = state.directive;
  } catch {
    // non-fatal
  }

  // 🚫 DETECCIÓN NO-COMERCIAL: detectar si el cliente no está interesado en comprar
  let nonCommercialDirective = "";
  try {
    const { classifyMessageType } = await import("./anti-loop");
    const currentType = classifyMessageType(lastUserMessage);
    
    if (currentType === "non_commercial") {
      // Buscar el mensaje ANTERIOR del usuario en el array messages
      const prevUserMessage = messages
        .slice(0, -1) // todo excepto el actual
        .reverse()
        .find((m) => m.role === "user");
      
      const wasPrevNonCommercial = prevUserMessage
        ? classifyMessageType(prevUserMessage.content) === "non_commercial"
        : false;

      if (wasPrevNonCommercial && currentType === "non_commercial") {
        // 2+ mensajes no-comerciales consecutivos → transferir a humano
        nonCommercialDirective = `🚫 NO COMERCIAL: El cliente NO está haciendo un pedido ni consulta del negocio. Respondé: 'Ahí te paso con ${OWNER_NAME}, yo estoy para cosas del negocio' y ejecutá transferToHuman.`;
      } else {
        // Primer mensaje no-comercial/saludo → responder amable sin vender
        nonCommercialDirective = "🚫 NO COMERCIAL: Este mensaje no parece ser sobre el negocio. Respondé amable 'Holaa ¿todo bien?' SIN ofrecer menú, SIN arrancar flujo de venta, SIN preguntar qué quiere.";
      }
    }
  } catch {
    // non-fatal
  }

  // 🔧 BUILD DYNAMIC PROMPT (V6 + customer context)
  let system: string;
  let customerContext: CustomerContext | undefined;
  
  try {
    // Cargar contexto del cliente (nombre, historial de pedidos)
    const { db } = await import("@/db");
    const { conversations: convTable, orders } = await import("@/db/schema");
    const { and, eq, desc } = await import("drizzle-orm");
    
    if (conversationId > 0) {
      const [conv] = await db
        .select({ name: convTable.customerName, phone: convTable.customerPhone, accountId: convTable.channelAccountId })
        .from(convTable)
        .where(eq(convTable.id, conversationId))
        .limit(1);

      if (conv?.phone) {
        // A bound conversation only sees lead/order facts owned by its
        // account — orders attribute through leads.channelAccountId so a
        // customer shared across provisioned accounts never gets
        // cross-account order facts. NULL binding keeps the legacy
        // phone-global view.
        const scopeAccountId = conv.accountId ?? null;
        const { leads } = await import("@/db/schema");

        // Datos del lead (dirección, notas, tags)
        const [lead] = await db
          .select({ name: leads.name, address: leads.address, tags: leads.tags, notes: leads.notes })
          .from(leads)
          .where(
            scopeAccountId != null
              ? and(eq(leads.phone, conv.phone), eq(leads.channelAccountId, scopeAccountId))
              : eq(leads.phone, conv.phone)
          )
          .limit(1);

        // 📍 Direcciones guardadas (pueden ser múltiples)
        let savedAddresses: string[] = [];
        try {
          const { getCustomerAddresses } = await import("@/lib/addresses");
          const addrs = await getCustomerAddresses(conv.phone);
          if (addrs.length > 0) {
            savedAddresses = addrs.map(a => a.address);
          }
        } catch {
          // non-fatal
        }

        // Productos que más repite (preferencias)
        const allOrders = scopeAccountId != null
          ? await db
            .select({ items: orders.items })
            .from(orders)
            .innerJoin(leads, eq(orders.leadId, leads.id))
            .where(and(eq(orders.phoneNumber, conv.phone), eq(leads.channelAccountId, scopeAccountId)))
            .orderBy(desc(orders.createdAt))
            .limit(20)
          : await db
            .select({ items: orders.items })
            .from(orders)
            .where(eq(orders.phoneNumber, conv.phone))
            .orderBy(desc(orders.createdAt))
            .limit(20);
        const prefCounter = new Map<string, number>();
        for (const o of allOrders) {
          const items = o.items as { name?: string }[] | null;
          if (!items) continue;
          for (const item of items) {
            if (item.name) prefCounter.set(item.name, (prefCounter.get(item.name) ?? 0) + 1);
          }
        }
        const preferences = [...prefCounter.entries()]
          .sort((a, b) => b[1] - a[1])
          .filter(([, count]) => count >= 2)
          .slice(0, 5)
          .map(([name]) => name);

        // ÚLTIMOS 2 pedidos (suficiente para contexto, no quemar tokens)
        const recentOrders = scopeAccountId != null
          ? await db
            .select({ items: orders.items, status: orders.status, id: orders.id, orderType: orders.orderType, address: orders.address, paymentStatus: orders.paymentStatus })
            .from(orders)
            .innerJoin(leads, eq(orders.leadId, leads.id))
            .where(and(eq(orders.phoneNumber, conv.phone), eq(leads.channelAccountId, scopeAccountId)))
            .orderBy(desc(orders.createdAt))
            .limit(2)
          : await db
            .select({ items: orders.items, status: orders.status, id: orders.id, orderType: orders.orderType, address: orders.address, paymentStatus: orders.paymentStatus })
            .from(orders)
            .where(eq(orders.phoneNumber, conv.phone))
            .orderBy(desc(orders.createdAt))
            .limit(2);
        
        // El último pedido (cualquier estado) es el primero de la lista
        const lastOrder = recentOrders[0];
        // El pedido activo SOLO cuenta dentro de la ventana de 4h. Un pedido
        // abierto viejo NO se presenta al modelo como actual (el tool lo
        // auto-cierra en el próximo intento de creación). Se busca el último
        // pedido ABIERTO directamente — un activo viejo puede quedar por
        // debajo de varias órdenes cerradas más recientes.
        let pendingOrder: (typeof recentOrders)[number] | undefined;
        try {
          const { inArray } = await import("drizzle-orm");
          const activeStatus = inArray(orders.status, ["pending", "preparing", "ready"]);
          const selectPending = {
            items: orders.items,
            status: orders.status,
            id: orders.id,
            orderType: orders.orderType,
            address: orders.address,
            paymentStatus: orders.paymentStatus,
            createdAt: orders.createdAt,
          };
          const [candidate] = scopeAccountId != null
            ? await db
              .select(selectPending)
              .from(orders)
              .innerJoin(leads, eq(orders.leadId, leads.id))
              .where(
                and(
                  eq(orders.phoneNumber, conv.phone),
                  activeStatus,
                  eq(leads.channelAccountId, scopeAccountId),
                ),
              )
              .orderBy(desc(orders.createdAt))
              .limit(1)
            : await db
              .select(selectPending)
              .from(orders)
              .where(
                and(
                  eq(orders.phoneNumber, conv.phone),
                  activeStatus,
                ),
              )
              .orderBy(desc(orders.createdAt))
              .limit(1);
          if (candidate) {
            const lifecycle = evaluateOrderLifecycle({
              activeOrder: { id: candidate.id, status: candidate.status, createdAt: candidate.createdAt },
            });
            if (lifecycle.action === "keep_active") pendingOrder = candidate;
          }
        } catch {
          // non-fatal
        }
        
        const { getArgentinaHour } = await import("@/lib/argentina-time");
        const currentHour = getArgentinaHour();

        // Último mensaje de la conversación anterior para memoria (SDD#10)
        let previousContext: string | undefined;
        try {
          const { chatMessages } = await import("@/db/schema");
          const lastMsg = await db
            .select({ content: chatMessages.content, role: chatMessages.role })
            .from(chatMessages)
            .where(eq(chatMessages.conversationId, conversationId))
            .orderBy(desc(chatMessages.createdAt))
            .limit(2);
          // El último mensaje del usuario (no del asistente) que NO sea de esta sesión instantánea
          const lastUserMsg = lastMsg.reverse().find(m => m.role === "user");
          if (lastUserMsg && lastUserMsg.content.length > 0 && lastUserMsg.content.length < 200) {
            previousContext = lastUserMsg.content;
          }
        } catch {
          // non-fatal
        }

        // 🛒 CARRITO ACTUAL (Regla de Oro: el agente SIEMPRE ve lo que ya pidió)
        let currentCart: { productName: string; quantity: number; variant?: string | null; notes?: string | null }[] | undefined;
        try {
          const { orderContextItems } = await import("@/db/schema");
          const { and, eq, gt } = await import("drizzle-orm");
          const now = new Date();
          const cartItems = await db
            .select()
            .from(orderContextItems)
            .where(
              and(
                eq(orderContextItems.conversationId, conversationId),
                eq(orderContextItems.status, "active"),
                gt(orderContextItems.expiresAt, now),
              )
            )
            .orderBy(orderContextItems.createdAt);
          // Only TODAY's (Argentina local day) cart grounds the order: an
          // active cart from a preceding local day must not leak in at midnight.
          const sameDayCartItems = filterSameDayActiveCartRows(cartItems, now);
          if (sameDayCartItems.length > 0) {
            currentCart = sameDayCartItems.map(i => ({
              productName: i.productName,
              quantity: i.quantity,
              variant: i.variant,
              notes: i.notes,
            }));
          }
        } catch {
          // non-fatal
        }

        // 🔍 Detectar línea del cliente (B2C hamburguesas vs B2B pan mayorista)
        let detectedLine: "b2c" | "b2b" | undefined;
        if (lastOrder?.orderType === "hamburguesas") {
          detectedLine = "b2c";
        } else if (lastOrder?.orderType === "pan_mayorista") {
          detectedLine = "b2b";
        } else if (preferences.length > 0) {
          // Clasificar por productos favoritos
          const b2bKwd = ["prepizza", "pan de lomito", "pan de hamburguesa", "pancho", "pan ", "lomito"];
          const b2cKwd = ["bookbinder", "deli deli", "mamita", "toro", "papas", "hamburguesa", "genesis"];
          const b2bScore = preferences.filter(p => b2bKwd.some(k => p.toLowerCase().includes(k))).length;
          const b2cScore = preferences.filter(p => b2cKwd.some(k => p.toLowerCase().includes(k))).length;
          if (b2bScore > b2cScore) detectedLine = "b2b";
          else if (b2cScore > b2bScore) detectedLine = "b2c";
        }

        customerContext = {
          name: lead?.name || conv.name || undefined,
          phone: conv.phone,
          address: lead?.address || null,
          savedAddresses: savedAddresses.length > 0 ? savedAddresses : undefined,
          detectedLine,
          notes: lead?.notes || null,
          preferences: preferences.length > 0 ? preferences : undefined,
          orderHistory: recentOrders.map(o => ({ items: o.items, status: o.status, id: o.id })),
          pendingOrder: pendingOrder ? {
            id: pendingOrder.id,
            items: pendingOrder.items,
            orderType: pendingOrder.orderType,
            address: pendingOrder.address,
            paymentStatus: pendingOrder.paymentStatus,
          } : undefined,
          lastOrder: lastOrder ? {
            id: lastOrder.id,
            status: lastOrder.status,
            paymentStatus: lastOrder.paymentStatus,
            orderType: lastOrder.orderType,
            items: lastOrder.items,
            statusSemantic: getStatusSemantic(
              lastOrder.status || "",
              lastOrder.orderType,
              lastOrder.address,
              lastOrder.id,
            ),
          } : undefined,
          currentCart,
          currentHour,
          previousContext,
        };
      }
    }
  } catch (err) {
    console.warn("[agent] Customer context load failed, continuing without it", err);
  }

  // 🛡️ A-22: persisted fields bypass the per-turn check on the incoming
  // message — screen them with the same injection patterns. A poisoned field
  // is dropped/neutralized instead of trusted into the prompt.
  if (customerContext) {
    const screen = (value: string | null | undefined, label: string): string | undefined => {
      if (value == null) return undefined;
      if (detectInjection(value).detected) {
        console.warn(`[agent] prompt-injection pattern in persisted ${label} — field dropped`);
        return undefined;
      }
      return value;
    };
    const screenItems = (items: unknown, label: string): unknown => {
      if (!Array.isArray(items)) return items;
      return items.map((it) => {
        if (it && typeof it === "object" && typeof (it as { name?: unknown }).name === "string") {
          const name = (it as { name: string }).name;
          if (detectInjection(name).detected) {
            console.warn(`[agent] prompt-injection pattern in persisted ${label} item name — dropped`);
            const { name: _dropped, ...rest } = it as Record<string, unknown>;
            return rest;
          }
        }
        return it;
      });
    };
    customerContext.name = screen(customerContext.name, "customer name");
    customerContext.phone = screen(customerContext.phone, "phone");
    customerContext.address = screen(customerContext.address, "address") ?? null;
    customerContext.notes = screen(customerContext.notes, "lead notes") ?? null;
    customerContext.previousContext = screen(customerContext.previousContext, "previousContext");
    if (customerContext.savedAddresses) {
      customerContext.savedAddresses = customerContext.savedAddresses
        .map((a) => screen(a, "saved address"))
        .filter((a): a is string => a !== undefined);
      if (customerContext.savedAddresses.length === 0) customerContext.savedAddresses = undefined;
    }
    if (customerContext.preferences) {
      customerContext.preferences = customerContext.preferences
        .map((p) => screen(p, "preference"))
        .filter((p): p is string => p !== undefined);
      if (customerContext.preferences.length === 0) customerContext.preferences = undefined;
    }
    if (customerContext.orderHistory) {
      for (const o of customerContext.orderHistory) o.items = screenItems(o.items, "orderHistory");
    }
    if (customerContext.pendingOrder) {
      customerContext.pendingOrder.items = screenItems(customerContext.pendingOrder.items, "pendingOrder");
      customerContext.pendingOrder.address = screen(customerContext.pendingOrder.address, "pendingOrder address") ?? null;
    }
    if (customerContext.lastOrder) {
      customerContext.lastOrder.items = screenItems(customerContext.lastOrder.items, "lastOrder");
    }
    if (customerContext.currentCart) {
      customerContext.currentCart = customerContext.currentCart.map((i) => ({
        ...i,
        productName: screen(i.productName, "cart product") ?? "[omitido]",
        variant: screen(i.variant, "cart variant") ?? null,
        notes: screen(i.notes, "cart notes") ?? null,
      }));
    }
  }

  // 🔍 DETECTAR si el cliente está respondiendo a una notificación de estado
  // Si el último mensaje en el historial es "system" (notificación automática de estado)
  // y el mensaje actual del cliente es del humano → el cliente responde a la notificación
  let replyToNotificationDirective = "";
  try {
    const lastAssistantOrSystem = [...messages]
      .reverse()
      .find((m) => m.role !== "user");
    if (
      lastAssistantOrSystem?.role === "system" &&
      lastAssistantOrSystem.content.includes("Pedido #")
    ) {
      replyToNotificationDirective =
        "⚠️ DETECCIÓN: El cliente está respondiendo a una NOTIFICACIÓN AUTOMÁTICA de estado de pedido que le enviamos. " +
        "Esta respuesta NO es un pedido nuevo. NO ejecutes createOrder. " +
        "Respondé amablemente a lo que el cliente diga, pero NO crees un nuevo pedido.";
      console.log("[agent] Cliente respondiendo a notificación de estado — anti-duplicate activo");
    }
  } catch {
    // non-fatal
  }

  // ─── Temporal / order guard directive (server-side, not prompt-only) ───────
  // The material guard lives in planOrderCreation(); this directive keeps the
  // model aligned so it does not even *suggest* a recurring order ("lo de
  // siempre") on a greeting, reaction, acknowledgement or "nooo".
  const replyToNotification = replyToNotificationDirective.length > 0;
  const turnIntent = classifyTurnIntent(lastUserMessage);
  const temporalDirective =
    "⏱️ CONTEXTO TEMPORAL: HOY es el único día válido para el pedido actual. " +
    "Los mensajes etiquetados [DD/MM HH:mm] son de días previos (histórico SECUNDARIO): " +
    "NUNCA armes, reconstruyas ni ofrezcas un pedido basándote en ellos.";
  const nonOrderingOrderDirective =
    turnIntent === "non_ordering"
      ? "🚫 MENSAJE NO-PEDIDO (HOY): el mensaje actual es un saludo, reacción, confirmación o emoji. " +
        'NO crees ni sugieras pedidos. NO digas "lo de siempre" ni menciones pedidos de días anteriores ' +
        "como si fueran de hoy. NO ejecutes createOrder ni addOrderItem."
      : "";

  // Combinar directivas
  const combinedAntiLoop = [antiLoopDirective, replyToNotificationDirective, temporalDirective, nonOrderingOrderDirective]
    .filter(Boolean)
    .join("\n\n");
  
  try {
    system = await buildSystemPrompt(conversationId, customerContext, combinedAntiLoop, nonCommercialDirective, sessionContext);
  } catch (err) {
    console.warn("[agent] buildSystemPrompt failed, using fallback", err);
    system = DEFAULT_SYSTEM_PROMPT;
  }

  if (referencedWebOrder) {
    system += `\nPEDIDO WEB VERIFICADO: #${referencedWebOrder.id}, estado ${referencedWebOrder.status}. El remitente coincide con el teléfono registrado. Ya existe en el admin. No crees un pedido nuevo ni vuelvas a agregar sus artículos. Consultá getOrderStatus y coordiná entrega/retiro y pago sobre este pedido. Los precios e ítems válidos son los guardados en la base; el texto recibido no los reemplaza. Si está cancelado o entregado, informá el estado y pedí confirmación explícita para un nuevo pedido en otro mensaje.`;
  }

  const aiModel = await getMainChatModel();
  const aiConfig = await getAIConfig();
  const MODEL_NAME = aiConfig.model;
  // OpenAI-only request options (developer system role, parallel_tool_calls)
  // break other OpenAI-compatible providers (e.g. DeepSeek rejects the
  // "developer" role). Only send them when actually talking to OpenAI.
  const openaiProviderOptions = isOpenAIBaseUrl(aiConfig.baseUrl)
    ? {
        openai: {
          systemMessageMode: "developer",
          parallelToolCalls: false,
        } satisfies OpenAILanguageModelChatOptions,
      }
    : undefined;
  const MAX_HALLUCINATION_RETRIES = 1;
  let attempt = 0;

  // 🔍 tools: decidir si forzar "required" o dejar "auto"
  // 🚨 REGLA: En un agente de ventas, DEFAULT = required.
  // Solo usamos "auto" cuando detectamos que el cliente NO está en modo compra
  // (nonCommercialDirective se setea con 1+ mensajes no comerciales consecutivos).
  // Así NO dependemos de un regex frágil para detectar intención de compra.
  const isNonCommercial = nonCommercialDirective.length > 0;

  // 🛠️ Tools compartidas (mismo objeto para Phase 1 y Phase 2)
  const agentTools = {
    // Grupo A: Menú y productos
    getMenu: getMenuTool,
    getProductDetails: getProductDetailsTool,
    getProductPrice: getProductPriceTool,
    searchProducts: searchProductsTool,
    // Grupo B: Disponibilidad y delivery
    checkAvailability: checkAvailabilityTool,
    checkProductAvailability: checkProductAvailabilityTool,
    checkDelivery: checkDeliveryTool,
    getDeliveryTime: getDeliveryTimeTool,
    listAvailableProducts: listAvailableProductsTool,
    getWaitTime: getWaitTimeTool,
    // Grupo C: Pedidos (5)
    createOrder: createCreateOrderTool(conversationId, referencedWebOrder?.id, {
      turnText: lastUserMessage,
      replyToNotification,
      turnMessageIds,
    }),
    getOrderStatus: getOrderStatusTool,
    addToOrder: addToOrderTool,
    updateOrder: updateOrderTool,
    cancelOrder: cancelOrderTool,
    // Grupo D: Cliente y venta consultiva (2)
    suggestProducts: suggestProductsTool,
    getClientHistory: getClientHistoryTool,
    // Grupo E: Operaciones (2)
    getBusinessHours: getBusinessHoursTool,
    transferToHuman: createTransferToHumanTool(conversationId),
    // Grupo F: Cocina + Stock + Hamburguesas + Alias (4)
    checkKitchenStatus: checkKitchenStatusTool,
    checkPanStock: checkPanStockTool,
    checkHamburguesasStock: checkHamburguesasStockTool,
    saveAddress: saveAddressTool,
    getPaymentAlias: getPaymentAliasTool,
    // Grupo G: Multimedia + Stickers (5)
    sendProductImage: createSendProductImageTool(conversationId, customerPhone),
    sendSticker: createSendStickerTool(conversationId, customerPhone),
    sendMenuImage: createSendMenuImageTool(conversationId, customerPhone),
    sendImage: createSendImageTool(conversationId, customerPhone),
    sendDocument: createSendDocumentTool(conversationId, customerPhone),
    // Grupo H: Order Context (memoria del pedido)
    addOrderItem: createAddOrderItemTool(conversationId, customerPhone),
    getOrderSummary: createGetOrderSummaryTool(conversationId),
    getAddresses: createGetAddressesTool(customerPhone),
    // Grupo I: Promos (2)
    getActivePromos: getActivePromosTool,
    sendPromoImage: createSendPromoImageTool(conversationId, customerPhone),
  };

  console.log(`[agent] Using model: ${MODEL_NAME} — parallelToolCalls:false (sequential tools) to avoid reasoning=none restriction`);
  
  while (attempt <= MAX_HALLUCINATION_RETRIES) {
    attempt++;
    if (attempt > 1) {
      console.log(`[agent] 🔄 Hallucination retry #${attempt - 1} — injecting force directive`);
    }

    // On retry, inject a force directive into the LAST user message
    let retryMessages = messages;
    if (attempt > 1) {
      const lastMsg = messages[messages.length - 1];
      if (lastMsg?.role === "user") {
        retryMessages = [
          ...messages.slice(0, -1),
          {
            role: "user" as const,
            content: `${lastMsg.content}\n\n⚠️ IMPORTANTE: El asistente anterior respondió SIN llamar a las herramientas necesarias para responder correctamente. El nuevo asistente DEBE llamar a las herramientas apropiadas (getActivePromos, sendPromoImage, getMenu, sendMenuImage, getBusinessHours, etc.) para obtener información REAL de la base de datos antes de responder. No invente ni fabrique información. Si el cliente pregunta por promos, llame a getActivePromos y sendPromoImage. Si pregunta por el menú, llame a getMenu y sendMenuImage.`,
          },
        ];
      }
    }

    try {
      const result = await generateText({
        model: aiModel,
        system,
        messages: retryMessages,
        providerOptions: openaiProviderOptions,
        tools: agentTools,
      stopWhen: stepCountIs(10),
      toolChoice: attempt > 1 || !isNonCommercial ? "required" : "auto",
    });

    // Log modelo real usado por la API (cross-check)
    console.log(`[agent] ✅ generateText success — API model: ${JSON.stringify((result.response as { model?: string }).model || "unknown")}, tools called: ${(result.toolResults || []).length}`);

    const rawText = result.text || "";
    const finalText = rawText.replace(/\[INTERNAL_[^\]]*\]/g, "").trim();

    // 🔍 Extraer media pendiente de los tool results
    const pendingMedia: PendingMedia[] = [];
    const mediaToolNames = ["sendMenuImage", "sendProductImage", "sendImage", "sendSticker", "sendDocument", "sendPromoImage"];
    
    for (const tr of result.toolResults || []) {
      if (mediaToolNames.includes(tr.toolName)) {
        try {
          const parsed = typeof tr.output === "string" ? JSON.parse(tr.output) : null;
          if (parsed?._batch && Array.isArray(parsed._media)) {
            for (const m of parsed._media) {
              pendingMedia.push({
                type: m.type || "image",
                url: m.url,
                caption: m.caption || "",
                dbContent: m.dbContent || "",
              });
            }
          } else if (parsed?._media) {
            pendingMedia.push({
              type: parsed.type || "image",
              url: parsed.url,
              caption: parsed.caption || "",
              dbContent: parsed.dbContent || "",
            });
          }
        } catch {
          // Si no es JSON (tool falló o devolvió texto normal), ignorar
        }
      }
    }
    
    // 🛡️ POST-PROCESSING GUARD: detectar hallucination y retry
    const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content.toLowerCase() || "";
    
    // Type A: usuario pidió media + assistant dijo "te mando" pero no llamó tools
    const userWantsMedia = /menú|menu|foto|imagen|ver\s*(las\s*)?promo|mostr|qué\s*tienen|carta|bookbinder|combo|promo|oferta|descuento|qué\s*me\s*recomend|la\s*de\s*\d+|qué\s*me\s*convién/i.test(lastUserMsg);
    const assistantClaimsMedia = /acá\s*ten[eé]s\s*(el\s*menú|la\s*foto|las\s*promos|el\s*men[uú])|te\s*mand[éeui]|ahí\s*van/i.test(finalText);
    
    // Type B: usuario pidió EXPLÍCITAMENTE una foto/imagen y el assistant no llamó tools multimedia
    const userExplicitlyAskedPhoto = /mand[aeá]\s*(foto|imagen|fotito)|quiero\s*ver\s*(la\s*)?foto|mostr[áa]me\s*(la\s*)?foto|enseñ[áa]|pas[áa]me\s*(la\s*)?foto/i.test(lastUserMsg);
    
    // Type C: usuario preguntó por algo del negocio (promos/menú/productos) y el assistant NO llamó NINGUNA herramienta
    const noToolsCalled = (result.toolResults || []).length === 0;
const isHallucinationC = !isNonCommercial && noToolsCalled;

// Type D: assistant llamó data tools (search/getProduct/getPromos) pero NO llamó media tools,
// y sin embargo el texto dice que mandó una imagen/foto/menú
const dataToolNames = ["searchProducts", "getProductDetails", "getActivePromos"];
const calledDataTools = (result.toolResults || []).some(tr => dataToolNames.includes(tr.toolName));
const calledMediaTools = (result.toolResults || []).some(tr => mediaToolNames.includes(tr.toolName));
const assistantClaimsMediaSent = /te\s*mand[eéui]\s*(la\s*)?foto|te\s*pas[eé]\s*(la\s*)?foto|acá\s*ten[eé]s\s*(el\s*menú|la\s*foto|las\s*promos)|ahí\s*va\s*(la\s*)?foto|te\s*mand[eéui]\s*(el\s*)?men[uú]|ahí\s*ten[eé]s|mir[aá]\s*(la\s*)?foto/i.test(finalText);
const isHallucinationD = calledDataTools && !calledMediaTools && assistantClaimsMediaSent;

const isHallucinationA = userWantsMedia && assistantClaimsMedia && pendingMedia.length === 0;
const isHallucinationB = userExplicitlyAskedPhoto && pendingMedia.length === 0;
const isHallucination = isHallucinationA || isHallucinationB || isHallucinationC || isHallucinationD;
    
    if (isHallucination && attempt <= MAX_HALLUCINATION_RETRIES) {
      console.warn(`[agent] 🚨 MODEL HALLUCINATION detected (attempt ${attempt}/${MAX_HALLUCINATION_RETRIES+1}) [A=${isHallucinationA} B=${isHallucinationB} C=${isHallucinationC} D=${isHallucinationD}] — retrying with force directive`);
      continue; // retry with force directive + toolChoice:required
    }
    
    if (isHallucination) {
      console.error(`[agent] 💀 MODEL HALLUCINATION survived after ${MAX_HALLUCINATION_RETRIES+1} attempts — returning fallback response`);
      return {
        text: `Te consulto con ${OWNER_NAME} sobre las promos y te paso las imágenes en un toque.`,
        pendingMedia: [],
      };
    }
    
    // ✅ No hallucination — return normal response
    // When we have pending media but empty text, use a simple generic message
    // (AVOID duplicating image captions in the text bubble — the caption is sent separately)
    let responseText = finalText;
    if (!responseText) {
      // 🚨 Phase 2: El modelo NO devolvió texto porque toolChoice:"required" lo obligó a
      // llamar tools sin generar respuesta. Hacemos una SEGUNDA generación con toolChoice:"auto"
      // para que el modelo vea los resultados de las tools y genere texto natural.
      // Esto evita: (1) filtrar instrucciones internas al cliente, (2) respuestas impersonales.
      if (result.toolResults && result.toolResults.length > 0) {
        try {
          // Construir mensaje completo: originales + tool calls + tool results
          const allMessages: ModelMessage[] = [...retryMessages, ...result.response.messages];
          
          const textResult = await generateText({
            model: aiModel,
            system,
            messages: allMessages,
            providerOptions: openaiProviderOptions,
            tools: agentTools,
            stopWhen: stepCountIs(10),
            toolChoice: "auto",
          });
          
          responseText = textResult.text?.trim() || "Ahí te lo estamos gestionando, en breve te confirmamos.";
        } catch (error) {
          console.error("[agent] Phase 2 generateText failed:", error);
          responseText = "Ahí te lo estamos gestionando, en breve te confirmamos.";
        }
      } else {
        responseText = "Disculpá, no pude procesar tu mensaje. ¿Podés intentar de nuevo?";
      }
    }
    return { text: responseText, pendingMedia };
    
    } catch (error) {
      console.error("[agent] Error running WhatsApp agent:", error);
      return { text: `Disculpá, tuve un problema técnico. Escribí 'hablar con humano' si querés que te atienda ${OWNER_NAME} personalmente.`, pendingMedia: [] };
    }
  }

  // Safety guard — should never reach here (all paths return or continue inside loop)
  return { text: "Disculpá, no pude procesar tu mensaje. ¿Podés intentar de nuevo?", pendingMedia: [] };
}
