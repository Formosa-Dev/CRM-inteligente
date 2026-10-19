import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { orders, leads, agentConfig, addresses, orderContextItems, conversations } from "@/db/schema";
import { eq, desc, and, gt, asc } from "drizzle-orm";
import { notifyNewOrder } from "@/lib/telegram/notifier";
import { resolveItems, validateResolvedOrderItems, decrementStockBestEffort } from "@/lib/order-utils";
import { normalizePhone } from "@/lib/phone-utils";
import {
  argentinaDayKey,
  filterSameDayActiveCartRows,
  planOrderCreation,
  type ActiveOrderSnapshot,
} from "@/lib/whatsapp/temporal-context";
import {
  auditOrderEvent,
  autoCloseStaleOrder,
  clearKeepActiveConfirmation,
  DrizzleOrderLifecycleRepository,
  readKeepActiveConfirmation,
  setKeepActiveConfirmation,
  type OrderLifecycleRepository,
} from "@/lib/whatsapp/order-lifecycle";

export interface OrderCreationContext {
  /** Current-day buffered user text (server truth, not the model's view). */
  turnText?: string;
  /** True when this turn replies to a closure/status notification. */
  replyToNotification?: boolean;
  /** Provider message IDs of the current turn, for the audit trail. */
  turnMessageIds?: string[];
  /** Test seam; defaults to the shared Drizzle repository. */
  lifecycleRepository?: OrderLifecycleRepository;
}

async function notifyDeliveryOrder(
  customerName: string,
  customerPhone: string,
  address: string | null,
  items: { name: string; quantity: number; unitPrice: number }[],
  total: number,
  orderId: number
): Promise<void> {
  try {
    const [cfg] = await db.select().from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);
    const deliveryPhone = cfg?.deliveryPhoneNumber?.trim();
    if (!deliveryPhone) return;

    const { messenger } = await import("@/lib/messaging");
    const { decryptIfEncrypted } = await import("@/lib/encryption");
    const apiKey = decryptIfEncrypted(cfg?.ycloudApiKey) || process.env.YCLOUD_API_KEY || "";
    const from = process.env.WHATSAPP_PHONE_NUMBER || cfg?.phoneNumber || "";
    if (!apiKey || !from) return;

    // Buscar el maps link más reciente del cliente
    const [lastAddr] = await db
      .select({ mapsLink: addresses.mapsLink })
      .from(addresses)
      .where(eq(addresses.phone, customerPhone))
      .orderBy(desc(addresses.lastUsedAt))
      .limit(1);

    const itemLines = items.map(i => `• ${i.quantity}x ${i.name} — $${(i.quantity * i.unitPrice).toLocaleString("es-AR")}`).join("\n");

    const message = [
      `🚚 NUEVO PEDIDO #${orderId} PARA DELIVERY`,
      ``,
      `👤 ${customerName}`,
      `📱 ${customerPhone}`,
      address ? `📍 ${address}` : "",
      lastAddr?.mapsLink ? `🗺️ ${lastAddr.mapsLink}` : "",
      ``,
      `${itemLines}`,
      ``,
      `💰 Total: $${total.toLocaleString("es-AR")}`,
    ].filter(Boolean).join("\n");

    const res = await messenger.send(
      { to: deliveryPhone, type: "text", text: message },
      { credentials: { apiKey, senderAddress: from } },
    );
    if (!res.ok) throw new Error(res.error);
    console.log(`[delivery] Order #${orderId} notified to ${deliveryPhone}`);
  } catch (err) {
    console.warn("[delivery] Failed to notify delivery:", err);
  }
}

export function createCreateOrderTool(
  conversationId: number,
  referencedWebOrderId?: number,
  context: OrderCreationContext = {},
) {
  return tool({
  description: "Crea un pedido una vez que el cliente confirmó los items. AUTO-LEE el carrito de la conversación. SIEMPRE confirmar con el cliente antes de usar esta herramienta. Preguntá el nombre al cliente si no lo sabés.",
  inputSchema: z.object({
    customerName: z.string().describe("Nombre del cliente (preguntalo si no lo sabés)"),
    orderType: z.enum(["hamburguesas", "pan_mayorista"]).describe("Tipo: hamburguesas (rotisería nocturna) o pan_mayorista (al por mayor)"),
    items: z.array(z.object({
      name: z.string(),
      quantity: z.number().int().positive(),
    })).optional().describe("Items del pedido (opcional; el precio se resuelve desde la DB, nunca lo inventes)"),
    customerPhone: z.string().describe("Teléfono del cliente"),
    address: z.string().optional().describe("Dirección de entrega (si es delivery)"),
    deliveryFee: z.number().min(0).optional().describe("Costo de delivery (0 si no aplica)"),
    paymentStatus: z.enum(["pending", "paid"]).optional().describe("Estado de pago: pending (pendiente), paid (pagado)"),
    paymentMethod: z.string().optional().describe("Método de pago: efectivo, alias, etc."),
    notes: z.string().optional().describe("Notas adicionales del pedido"),
  }),
  execute: async ({ customerName, orderType, items: explicitItems, customerPhone, address, deliveryFee, paymentStatus, paymentMethod, notes }) => {
    if (referencedWebOrderId) return `El pedido web #${referencedWebOrderId} ya está registrado. Continuá sobre ese mismo pedido; no lo dupliques.`;
    // Bind creation to the actual conversation, never an LLM-supplied identity.
    const [conversation] = await db.select({ phone: conversations.customerPhone }).from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!conversation?.phone) return "No pude verificar el remitente. No creé el pedido.";
    customerPhone = normalizePhone(conversation.phone);

    const now = new Date();
    const repository = context.lifecycleRepository ?? new DrizzleOrderLifecycleRepository();

    // ─── Same-day cart (server truth): only non-expired items of THIS day ──
    let sameDayCartItems: { name: string; quantity: number }[] = [];
    try {
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
        .orderBy(asc(orderContextItems.createdAt));
      sameDayCartItems = filterSameDayActiveCartRows(cartItems, now).map((ci) => ({ name: ci.productName, quantity: ci.quantity }));
    } catch (err) {
      console.warn("[createOrder] Failed to read cart:", err);
    }

    // ─── Material temporal + lifecycle guard (server-side, prompt-proof) ──
    let activeOrder: ActiveOrderSnapshot | null = null;
    try {
      activeOrder = await repository.findActiveOrder(customerPhone);
    } catch {
      return "No pude verificar si ya existe un pedido. Reintentá en un momento para evitar duplicados.";
    }

    // ─── Server-side two-turn confirmation state ─────────────────────────
    // When keep_active asks "same order or a new one?", we persist a marker
    // scoped to that active order. The customer's next explicit order turn
    // then proceeds instead of looping on the same question. The marker is
    // durable (conversationMetadata), independent of the LLM's wording.
    let newOrderIntentPending = false;
    try {
      const pending = await readKeepActiveConfirmation(conversationId);
      newOrderIntentPending = pending !== null && activeOrder !== null && pending.activeOrderId === activeOrder.id;
    } catch {
      newOrderIntentPending = false;
    }

    const plan = planOrderCreation({
      referencedWebOrderId,
      turnText: context.turnText ?? "",
      replyToNotification: context.replyToNotification ?? false,
      sameDayCartItems,
      explicitItems,
      activeOrder,
      newOrderIntentPending,
      now,
    });

    auditOrderEvent("order_creation_decision", {
      conversationId,
      localDay: argentinaDayKey(now),
      consideredCurrentMessages: context.turnText ? 1 : 0,
      messageIds: context.turnMessageIds,
      activeOrderId: activeOrder?.id ?? null,
      autoClosed: plan.kind === "auto_close_then_create",
      decision:
        plan.kind === "create" || plan.kind === "auto_close_then_create"
          ? "create"
          : plan.kind === "keep_active"
            ? "keep_active"
            : "no_create",
      reason: plan.kind === "blocked" ? plan.reason : plan.kind,
    });

    if (plan.kind === "blocked") {
      return plan.message;
    }
    if (plan.kind === "keep_active") {
      // Persist the same/new clarification so the next explicit turn can exit
      // keep_active instead of looping. Failure is non-fatal (we just re-ask).
      try {
        await setKeepActiveConfirmation(conversationId, plan.orderId);
      } catch (error) {
        console.warn("[createOrder] Failed to persist keep-active confirmation:", error);
      }
      return plan.message;
    }
    // plan is now auto_close_then_create | create: both carry grounded items.
    const items = plan.items;
    if (plan.kind === "auto_close_then_create") {
      // Idempotent: a lost race or an already-closed row is a no-op.
      await autoCloseStaleOrder(activeOrder ?? { id: plan.closeOrderId, status: "pending", createdAt: now }, now, repository, {
        conversationId,
        localDay: argentinaDayKey(now),
      });
    }
    // A fresh order is proceeding — the same/new question is resolved.
    try {
      await clearKeepActiveConfirmation(conversationId);
    } catch {
      // non-fatal
    }

    // ─── Verificar si hay stock de hamburguesas ──────────────────────────
    if (orderType === "hamburguesas") {
      try {
        const [cfg] = await db
          .select({ sinStock: agentConfig.hamburguesasSinStock })
          .from(agentConfig)
          .where(eq(agentConfig.id, 1))
          .limit(1);
        if (cfg?.sinStock) {
          return "Hoy no estamos vendiendo hamburguesas. Solo tenemos pan mayorista disponible. Disculpá las molestias.";
        }
      } catch {
        // non-fatal — si falla la consulta, permitir el pedido
      }
    }

    // Resolver items contra productos reales de la DB
    const resolvedItems = await resolveItems(items);
    const itemError = validateResolvedOrderItems(resolvedItems);
    if (itemError) return itemError;
    const subtotal = resolvedItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
    const delivery = deliveryFee || 0;
    const total = subtotal + delivery;

    // Find lead to link order + save address
    let leadId: number | null = null;
    try {
      const [lead] = await db
        .select({ id: leads.id, status: leads.status })
        .from(leads)
        .where(eq(leads.phone, customerPhone))
        .limit(1);

      if (lead) {
        leadId = lead.id;
        // Save/update address on the lead if provided
        if (address) {
          await db.update(leads)
            .set({ address })
            .where(eq(leads.id, lead.id));
        }
        // Set client type based on order type
        const clientType = orderType === "pan_mayorista" ? "b2b" : "b2c";
        await db.update(leads)
          .set({ type: clientType })
          .where(eq(leads.id, lead.id));
        // Si era un lead sin pedidos, actualizar a "converted" (cliente)
        if (lead.status === "new" || lead.status === "contacted") {
          await db.update(leads)
            .set({ status: "converted" })
            .where(eq(leads.id, lead.id));
        }

      }
    } catch {
      // non-fatal
    }

    const [order] = await db.insert(orders).values({
      leadId,
      phoneNumber: customerPhone,
      customerName,
      address: address || null,
      orderType,
      items: resolvedItems,
      deliveryFee: delivery ? String(delivery) : "0",
      paymentStatus: paymentStatus || "pending",
      paymentMethod: paymentMethod || null,
      notes: notes || null,
      status: "pending",
    }).returning({ id: orders.id });

    // Limpiar orderContextItems de esta conversación (el carrito ya pasó a pedido)
    try {
      await db.delete(orderContextItems)
        .where(eq(orderContextItems.conversationId, conversationId));
    } catch {
      // non-fatal
    }

    // Best-effort stock decrement — the agent already validates availability via
    // checkStock before creating the order. Never fails the order.
    await decrementStockBestEffort(resolvedItems);

    notifyNewOrder({ id: order.id, customerName, orderType, items: resolvedItems, total, status: "pending", phoneNumber: customerPhone, notes });

    // Notificar al delivery con pedido + dirección
    if (address) {
      notifyDeliveryOrder(customerName, customerPhone, address, resolvedItems, total, order.id);
    }

    const typeLabel = orderType === "hamburguesas" ? "🍔 Hamburguesas" : "🍞 Pan Mayorista";

    return `✅ Pedido #${order.id} registrado (${typeLabel}).\n👤 Cliente: ${customerName}\n💰 Total: $${total.toFixed(2)}.`;
  },
});
}
