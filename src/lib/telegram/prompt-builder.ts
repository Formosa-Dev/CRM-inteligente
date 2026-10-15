import { db } from "@/db";
import { products, promotions, agentMemories, reconcileCandidates, orders } from "@/db/schema";
import { eq, and, desc, sql, count, ne } from "drizzle-orm";

/**
 * Construye el system prompt del bot de Telegram con datos vivos de la DB:
 * - Promociones activas
 * - Menú de productos actualizado
 * - Estado de la cocina, stock, alias MP
 */
export async function buildTelegramPrompt(): Promise<string> {
  const { INTERNAL_AGENT_SYSTEM_PROMPT } = await import("./system-prompt");
  const { getBusinessInfo } = await import("@/lib/business");
  const biz = await getBusinessInfo();
  const basePrompt = INTERNAL_AGENT_SYSTEM_PROMPT.replace(/\{\{BUSINESS_NAME\}\}/g, biz.name);

  const sections: string[] = [];

  // ── Info del negocio (cocina, stock, alias) ──
  try {
    const config = await db.query.agentConfig.findFirst({
      where: (c) => eq(c.id, 1),
    });

    if (config) {
      const infoLines: string[] = [];
      infoLines.push(`ESTADO COCINA: ${config.isCooking ? "Abierta" : "Cerrada"}`);
      if (config.hamburguesasSinStock === true) {
        infoLines.push("HAMBURGUESAS SIN STOCK: No se están vendiendo hamburguesas. Solo pan mayorista.");
      } else {
        infoLines.push("HAMBURGUESAS: Con stock — se pueden vender");
      }
      if (typeof config.stockPanDocenas === "number") {
        infoLines.push(`STOCK PAN: ${config.stockPanDocenas} docenas`);
      }
      const alias: string[] = [];
      if (config.aliasB2c) alias.push(`Hamburguesas: ${config.aliasB2c}`);
      if (config.aliasB2b) alias.push(`Pan: ${config.aliasB2b}`);
      if (alias.length > 0) infoLines.push(`ALIAS MP: ${alias.join(" | ")}`);
      if (config.tiempoEspera) infoLines.push(`TIEMPO ESTIMADO: ${config.tiempoEspera}`);

      sections.push(`═══ INFO DEL NEGOCIO ═══\n${infoLines.join("\n")}`);
    }
  } catch {
    // non-fatal
  }

  // ── Promociones activas ──
  try {
    const active = await db.select({ name: promotions.name, description: promotions.description, customPrice: promotions.customPrice })
      .from(promotions).where(eq(promotions.active, true)).orderBy(desc(promotions.createdAt));
    if (active.length) {
      sections.push(`═══ PROMOCIONES ACTIVAS ═══\n${active.map((promo) =>
        `${promo.name}${promo.customPrice ? ` — $${Number(promo.customPrice).toLocaleString("es-AR")}` : ""}${promo.description ? `: ${promo.description}` : ""}`
      ).join("\n")}`);
    }
  } catch {
    // non-fatal
  }

  // ── Memoria persistente (reglas/hechos guardados) ──
  try {
    const mems = await db
      .select({ type: agentMemories.type, content: agentMemories.content })
      .from(agentMemories)
      .where(eq(agentMemories.active, true))
      .orderBy(desc(agentMemories.updatedAt))
      .limit(20);

    if (mems.length > 0) {
      sections.push(
        `═══ MEMORIA / REGLAS APRENDIDAS (obligatorias, las dictó el dueño) ═══\n` +
        mems.map((m) => `• ${m.content}`).join("\n")
      );
    }
  } catch {
    // non-fatal — la tabla puede no existir en DBs viejas
  }

  // ── Candidatas de reconciliación pendientes ──
  try {
    const [pending] = await db
      .select({ count: count() })
      .from(reconcileCandidates)
      .where(sql`${reconcileCandidates.status} IN ('detected', 'needs_info')`);

    if (pending && pending.count > 0) {
      sections.push(
        `═══ RECONCILIACIÓN ═══\nHay ${pending.count} candidata(s) detectada(s) en chats pendientes de resolución. Usá getReconcileCandidates para verlas.`
      );
    }
  } catch {
    // non-fatal
  }

  // ── Estado operativo (radar): pendientes + sin cobrar ──
  try {
    const [stats] = await db
      .select({
        open: sql<number>`count(*) filter (where ${orders.status} in ('pending','preparing','ready'))::int`,
        unpaid: sql<number>`count(*) filter (where ${orders.paymentStatus} <> 'paid' and ${orders.status} <> 'cancelled')::int`,
      })
      .from(orders)
      .where(ne(orders.status, "cancelled"));

    if (stats && (stats.open > 0 || stats.unpaid > 0)) {
      const parts: string[] = [];
      if (stats.open > 0) parts.push(`${stats.open} pedido(s) pendiente(s)/en curso`);
      if (stats.unpaid > 0) parts.push(`${stats.unpaid} sin marcar pagado`);
      sections.push(`═══ RADAR ═══\n${parts.join(" · ")} — mencioná lo relevante sin esperar a que pregunten.`);
    }
  } catch {
    // non-fatal
  }

  // ── Sesión de caja abierta ──
  try {
    const { getOpenSession } = await import("@/lib/cash/session");
    const session = await getOpenSession();
    if (session) {
      sections.push(
        `═══ CAJA ═══\nSesión de caja #${session.id} abierta desde ${session.openedAt.toLocaleString("es-AR")}. Usá getCashStatus para el estado actual.`
      );
    }
  } catch {
    // non-fatal — el módulo/tabla de caja puede no existir todavía
  }

  // ── Menú de productos ──
  try {
    const items = await db
      .select({
        name: products.name,
        price: products.price,
        description: products.description,
        category: products.category,
      })
      .from(products)
      .where(and(eq(products.available, true), eq(products.comingSoon, false)))
      .orderBy(products.sortOrder);

    if (items.length > 0) {
      let menu = "═══ MENÚ ═══\n";
      const byCategory: Record<string, string[]> = {};
      for (const item of items) {
        const category = item.category || "otros";
        const price = item.price ? `$${Number(item.price).toLocaleString("es-AR")}` : "a consultar";
        if (!byCategory[category]) byCategory[category] = [];
        byCategory[category].push(`${item.name} (${price})`);
      }
      for (const [category, prods] of Object.entries(byCategory)) {
        menu += `${category}: ${prods.join(", ")}\n`;
      }
      sections.push(menu);
    }
  } catch {
    // non-fatal
  }

  return sections.length > 0
    ? `${basePrompt}\n\n${sections.join("\n\n")}`
    : basePrompt;
}
