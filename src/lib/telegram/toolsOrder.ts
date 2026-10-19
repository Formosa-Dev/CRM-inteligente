import { tool } from "ai";
import { z } from "zod";
import { db } from "@/db";
import { orders, leads } from "@/db/schema";
import { eq, ilike, sql } from "drizzle-orm";
import { resolveItems, validateResolvedOrderItems, decrementStockBestEffort } from "@/lib/order-utils";
import { normalizePhone, isValidPhone } from "@/lib/phone-utils";
import { resolveClientName } from "@/lib/lead-utils";
import { isSafeCustomerNameMatch } from "./customer-match";
import { argentinaWallTime } from "./ar-time";


// ─── manageOrder: Herramientas de gestión de pedidos

// createOrder - Crear nuevo pedido
export const createOrder = tool({
  description:
    "CREAR un nuevo pedido. Busca el lead por teléfono primero, después por nombre. SI NO ENCUENTRA, CREA EL LEAD AUTOMÁTICAMENTE. NO necesita que el lead exista primero. El teléfono es OPCIONAL — si no se pasa, se crea un lead sin teléfono (para casos de Instagram, Facebook, clientes del local sin número). PREGUNTAS: 'creá un pedido para Juan, 2 Genesis', 'nuevo pedido para María, 1 Deli Deli', 'cargá pedido para floricienta, 1 Toro Asado'. SIEMPRE intentá con esta tool primero cuando te pidan crear un pedido.",
  inputSchema: z.object({
    customerName: z.string().trim().min(1).describe("Nombre del cliente. Si no se pasa el teléfono, se busca al lead por este nombre."),
    phone: z.string().optional().describe("Teléfono del cliente (OPCIONAL si ya existe un lead con ese nombre). Si no se pasa, se busca por nombre."),
    orderType: z
      .enum(["hamburguesas", "pan_mayorista"])
      .describe("Tipo de pedido"),
    items: z
      .array(
        z.object({
          name: z.string(),
          quantity: z.number().int().positive(),
    }))
    .describe("Items del pedido"),
    deliveryFee: z.number().min(0).optional().describe("Costo de delivery solo si el admin indicó el monto (0 si no aplica)"),
    address: z.string().optional().describe("Dirección de entrega si el cliente indicó delivery"),
    paymentStatus: z.enum(["pending", "paid"]).optional().describe("Estado de pago: pending (pendiente), paid (pagado). Default: pending"),
    paymentMethod: z.string().optional().describe("Método de pago: efectivo, alias, etc."),
    notes: z.string().optional().describe("Notas especiales"),
  }),
  execute: async ({ customerName, phone, orderType, items, deliveryFee, address, paymentStatus, paymentMethod, notes }) => {
    // Normalizar items contra productos reales de la DB
    const resolvedItems = await resolveItems(items);
    const itemError = validateResolvedOrderItems(resolvedItems);
    if (itemError) return { success: false, message: itemError };

    let cleanedPhone = phone ? normalizePhone(phone) : "";
    if (cleanedPhone && !isValidPhone(cleanedPhone)) {
      return { success: false, message: `El teléfono "${phone}" no es válido. Corregilo o creá el pedido sin teléfono.` };
    }
    let existingLead: { id: number; status: string | null; name: string | null } | undefined;

    if (cleanedPhone && customerName) {
      // Buscar por teléfono, pero VERIFICAR que el nombre coincida
      const [leadByPhone] = await db
        .select({ id: leads.id, status: leads.status, name: leads.name })
        .from(leads)
        .where(eq(leads.phone, cleanedPhone))
        .limit(1);

      if (leadByPhone) {
        // Si encontramos un lead por teléfono, verificar que el nombre sea similar
        const nameMatch = !leadByPhone.name || isSafeCustomerNameMatch(customerName, leadByPhone.name);
        if (nameMatch) {
          existingLead = leadByPhone;
        } else {
          return { success: false, message: `El teléfono ${cleanedPhone} corresponde a otro cliente. Verificá el número antes de crear el pedido.` };
        }
      }
    }

    // Si no se encontró por teléfono o el nombre no coincide, buscar por nombre
    // Usa búsqueda semántica con pg_trgm (trigramas) para encontrar aunque el
    // dueño escriba mal el nombre o tenga emojis/caracteres raros en DB
    if (!existingLead && customerName) {
      // Intentar primero con pg_trgm (búsqueda semántica)
      let nameMatches: { id: number; status: string | null; name: string | null; phone: string | null }[] = [];
      
      try {
        nameMatches = await db
          .select({ id: leads.id, status: leads.status, name: leads.name, phone: leads.phone })
          .from(leads)
          .where(sql`similarity(${leads.name}, ${customerName}) > 0.2`)
          .orderBy(sql`similarity(${leads.name}, ${customerName}) DESC`)
          .limit(5);
      } catch {
        // Fallback a ilike si pg_trgm no está disponible
        nameMatches = await db
          .select({ id: leads.id, status: leads.status, name: leads.name, phone: leads.phone })
          .from(leads)
          .where(ilike(leads.name, `%${customerName}%`))
          .limit(5);
      }

      if (nameMatches.length === 0) {
        // Nuevo cliente: la inserción posterior crea el lead con o sin teléfono.
      } else if (nameMatches.length === 1) {
        if (!isSafeCustomerNameMatch(customerName, nameMatches[0].name)) {
          return { success: false, message: `Encontré a ${nameMatches[0].name} como coincidencia aproximada (ID ${nameMatches[0].id}). Confirmá la identidad antes de vincular el pedido, o indicá un nombre nuevo más preciso.` };
        }
        if (cleanedPhone && nameMatches[0].phone && !nameMatches[0].phone.startsWith("sin-telefono-") && nameMatches[0].phone !== cleanedPhone) {
          return { success: false, message: `Ya existe ${nameMatches[0].name} con otro teléfono. Confirmá cuál cliente corresponde antes de crear el pedido.` };
        }
        // Un solo match → usarlo
        existingLead = nameMatches[0];
        cleanedPhone = nameMatches[0].phone ?? cleanedPhone;
      } else if (nameMatches.length > 1) {
        // Múltiples matches → devolver opciones
        const options = nameMatches
          .map((l) => `• ${l.name || "Sin nombre"} — ${l.phone}`)
          .join("\n");
        return {
          success: false,
          message: `Encontré VARIOS clientes con nombre similar:\n${options}\n\n¿Cuál es? Pasá el número exacto.`,
        };
      }
    }

    // Si después de todo no hay lead, crear uno nuevo
    if (!existingLead) {
      if (!cleanedPhone) {
        // Sin teléfono: crear lead con placeholder (Instagram, Facebook, local)
        cleanedPhone = `sin-telefono-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const [newLead] = await db
          .insert(leads)
          .values({
            name: customerName,
            phone: cleanedPhone,
            status: "new",
            notes: "⚠️ Cliente sin teléfono — cargar número pendiente",
          })
          .returning({ id: leads.id, status: leads.status, name: leads.name });
        existingLead = newLead;
      } else {
        // Crear lead automáticamente si hay teléfono válido y no existe
        const [newLead] = await db
          .insert(leads)
          .values({
            name: customerName,
            phone: cleanedPhone,
            status: "converted",
          })
          .returning({ id: leads.id, status: leads.status, name: leads.name });
        existingLead = newLead;
      }
    }

    // Vincular con lead existente
    const leadId = existingLead.id;
    const leadName = existingLead.name ?? customerName;
    // Si era lead sin pedidos, pasar a converted
    if (existingLead.status === "new" || existingLead.status === "contacted") {
      await db.update(leads).set({ status: "converted" }).where(eq(leads.id, existingLead.id));
    }
    // A shorthand in an order must not overwrite an existing customer's full name.

    // Calcular total
    let subtotal = 0;
    for (const item of resolvedItems) {
      subtotal += (item.price ?? 0) * item.quantity;
    }
    const delivery = deliveryFee || 0;
    const total = subtotal + delivery;

    const [created] = await db
      .insert(orders)
      .values({
        leadId: leadId ?? undefined,
        phoneNumber: cleanedPhone,
        customerName: leadName,
        orderType,
        items: resolvedItems,
        address: address || null,
        deliveryFee: delivery ? String(delivery) : "0",
        paymentStatus: paymentStatus || "pending",
        paymentMethod: paymentMethod || null,
        notes,
        status: "pending",
      })
      .returning({ id: orders.id });

    await decrementStockBestEffort(resolvedItems);

    // Notificar
    try {
      const { notifyNewOrder } = await import("@/lib/telegram/notifier");
      notifyNewOrder({
        id: created.id,
        customerName: leadName || cleanedPhone,
        orderType,
        items: resolvedItems,
        total,
        status: "pending",
        phoneNumber: cleanedPhone,
        notes: notes || null,
      });
    } catch {}

    const itemSummary = resolvedItems.map(i => `${i.quantity}x ${i.name}`).join(", ");

    return {
      success: true,
      id: created.id,
      total,
      message: `✅ Pedido #${created.id} creado para ${leadName || phone}. Total: $${total} (${itemSummary})`,
    };
  },
});

// addItemToOrder - Agregar producto al pedido
export const addItemToOrder = tool({
  description:
    "AGREGAR un producto a un pedido existente. Solo funciona si el pedido no está entregado o cancelado. PREGUNTAS: 'agregale una Génesis al pedido 5', 'poné otra Deli al pedido 3'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
    item: z.object({
      name: z.string().describe("Nombre del producto"),
      quantity: z.number().int().positive().describe("Cantidad"),
    }),
  }),
  execute: async ({ orderId, item }) => {
    // Normalizar item contra productos reales de la DB
    const resolvedItems = await resolveItems([item]);
    const resolved = resolvedItems[0];
    if (!resolved) return { success: false, message: "Item inválido" };
    const itemError = validateResolvedOrderItems(resolvedItems);
    if (itemError) return { success: false, message: itemError };

    // Verificar que el pedido exista y no esté terminado
    const [existing] = await db
      .select({ id: orders.id, status: orders.status, items: orders.items })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Pedido no encontrado" };
    }

    if (existing.status === "delivered" || existing.status === "cancelled") {
      return {
        success: false,
        message: "No se puede modificar un pedido entregado o cancelado",
      };
    }

    // Agregar item
    const currentItems = (existing.items as { name: string; quantity: number }[]) ?? [];
    const newItems = [...currentItems, resolved];

    await db
      .update(orders)
      .set({ items: newItems, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return {
      success: true,
      message: `Agregado ${resolved.quantity}x ${resolved.name} al pedido #${orderId}`,
    };
  },
});

// removeItemFromOrder - Quitar producto del pedido
export const removeItemFromOrder = tool({
  description:
    "QUITAR un producto de un pedido existente. PREGUNTAS: 'sacale la Génesis al pedido 5', 'quitá una Deli del pedido 3'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
    itemName: z.string().describe("Nombre del producto a quitar"),
  }),
  execute: async ({ orderId, itemName }) => {
    const [existing] = await db
      .select({ id: orders.id, status: orders.status, items: orders.items })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Pedido no encontrado" };
    }

    if (existing.status === "delivered" || existing.status === "cancelled") {
      return {
        success: false,
        message: "No se puede modificar un pedido entregado o cancelado",
      };
    }

    const currentItems = (existing.items as { name: string; quantity: number }[]) ?? [];
    const newItems = currentItems.filter((i) => i.name !== itemName);

    if (newItems.length === currentItems.length) {
      return {
        success: false,
        message: `No se encontró ${itemName} en el pedido`,
      };
    }

    await db
      .update(orders)
      .set({ items: newItems, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return {
      success: true,
      message: `Eliminado ${itemName} del pedido #${orderId}`,
    };
  },
});

// updateOrderStatus - Actualizar estado del pedido
export const updateOrderStatus = tool({
  description:
    "CAMBIAR el estado de un pedido: pending → preparing → ready → delivered. PREGUNTAS: 'el pedido 5 está listo', 'marcá el pedido 3 como entregado', 'el pedido 7 ya está'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
    status: z
      .enum(["pending", "preparing", "ready", "delivered", "cancelled"])
      .describe("Nuevo estado"),
  }),
  execute: async ({ orderId, status }) => {
    const [existing] = await db
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Pedido no encontrado" };
    }

    await db
      .update(orders)
      .set({ status, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    const statusLabels: Record<string, string> = {
      pending: "pendiente",
      preparing: "en preparación",
      ready: "listo para retirar",
      delivered: "entregado",
      cancelled: "cancelado",
    };

    return {
      success: true,
      message: `Pedido #${orderId} marcado como ${statusLabels[status]}`,
    };
  },
});

// cancelOrder - Cancelar pedido
export const cancelOrder = tool({
  description:
    "Cancela un pedido. Preguntas: 'cancela el pedido 5', 'cancela mi pedido'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido a cancelar"),
    reason: z.string().optional().describe("Razón de cancelación"),
  }),
  execute: async ({ orderId, reason }) => {
    const [existing] = await db
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Pedido no encontrado" };
    }

    if (existing.status === "delivered") {
      return {
        success: false,
        message: "No se puede cancelar un pedido ya entregado",
      };
    }

    await db
      .update(orders)
      .set({
        status: "cancelled",
        notes: reason ? `Cancelado: ${reason}` : "Cancelado por el cliente",
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));

    return {
      success: true,
      message: `Pedido #${orderId} cancelado`,
    };
  },
});

// calculateTotal - Calcular total del pedido
export const calculateTotal = tool({
  description:
    "Calcula el total de un pedido. Preguntas: 'cuánto sale el pedido 5', 'total del pedido'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
  }),
  execute: async ({ orderId }) => {
    const [existing] = await db
      .select({ id: orders.id, items: orders.items, status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { error: "Pedido no encontrado" };
    }

    const items = existing.items as { name: string; quantity: number; price?: number }[];
    let total = 0;
    const breakdown: { item: string; qty: number; price: number; subtotal: number }[] = [];

    for (const item of items ?? []) {
      const price = item.price ?? 0;
      const subtotal = price * item.quantity;
      total += subtotal;
      breakdown.push({
        item: item.name,
        qty: item.quantity,
        price,
        subtotal,
      });
    }

    return {
      orderId,
      status: existing.status,
      items: breakdown,
      total,
    };
  },
});

// confirmOrder - Confirmar pedido
export const confirmOrder = tool({
  description:
    "Confirma un pedido con el cliente. Preguntas: 'confirmar pedido 5', 'confirma el pedido'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido a confirmar"),
  }),
  execute: async ({ orderId }) => {
    const [existing] = await db
      .select({
        id: orders.id,
        customerName: orders.customerName,
        phoneNumber: orders.phoneNumber,
        items: orders.items,
        status: orders.status,
      })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Pedido no encontrado" };
    }

    // Resolver nombre desde leads
    const resolvedName = await resolveClientName(
      existing.phoneNumber,
      existing.customerName ?? ""
    );

    // Calcular total
    const items = existing.items as { name: string; quantity: number; price?: number }[];
    let total = 0;
    for (const item of items ?? []) {
      total += (item.price ?? 0) * item.quantity;
    }

    // Cambiar a preparando
    await db
      .update(orders)
      .set({ status: "preparing", updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return {
      success: true,
      message: `Pedido #${orderId} confirmado para ${resolvedName}. Total: $${total}. Ahora está en preparación.`,
      customer: resolvedName,
      items: items?.map((i) => `${i.quantity}x ${i.name}`),
      total,
    };
  },
});

// markAsPaid - Marcar pedido como pagado
export const markAsPaid = tool({
  description:
    "Marca un pedido como pagado. Preguntas: 'marcá el pedido 5 como pagado', 'ya pagó el pedido 3', 'pasá a pagado el 7'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
  }),
  execute: async ({ orderId }) => {
    const [existing] = await db
      .select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Pedido no encontrado" };
    }

    await db
      .update(orders)
      .set({ paymentStatus: "paid", updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return {
      success: true,
      message: `✅ Pedido #${orderId} marcado como pagado`,
    };
  },
});

// markPaymentMethod - Registrar método de pago de un pedido
export const markPaymentMethod = tool({
  description:
    "Registra el método de pago de un pedido. Preguntas: 'pagó con alias', 'registrá que pagó en efectivo', 'método de pago del pedido 5'",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido"),
    method: z.string().describe("Método de pago: efectivo, alias, transferencia, etc."),
  }),
  execute: async ({ orderId, method }) => {
    const [existing] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Pedido no encontrado" };
    }

    await db
      .update(orders)
      .set({ paymentMethod: method, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return {
      success: true,
      message: `✅ Pedido #${orderId} — método de pago registrado: ${method}`,
    };
  },
});

// createDeliveredOrder - Cargar pedido ya entregado (backfill)
export const createDeliveredOrder = tool({
  description:
    "CARGAR un pedido que YA FUE ENTREGADO (backfill). Para cuando el admin olvidó registrar un pedido. El método de pago NO es necesario para crear el pedido, se puede registrar después. Crea el lead si no existe. El teléfono es OPCIONAL — si no se pasa, se crea un lead sin teléfono. NO envía notificaciones. IMPORTANTE: Ejecutá esta tool apenas tengas nombre y productos. PREGUNTAS: 'cargá un pedido de ayer', 'subí un pedido viejo de Juan', 'registrá un pedido que ya entregamos el lunes'",
  inputSchema: z.object({
    customerName: z.string().trim().min(1).describe("Nombre del cliente"),
    customerPhone: z.string().optional().describe("Teléfono del cliente (opcional, con código de país)"),
    orderType: z.enum(["hamburguesas", "pan_mayorista"]).describe("Tipo de pedido"),
    items: z.array(z.object({
      name: z.string(),
      quantity: z.number().int().positive(),
    })).describe("Items del pedido"),
    deliveryFee: z.number().min(0).optional().describe("Costo de delivery (0 si no aplica)"),
    paymentStatus: z.enum(["pending", "paid"]).optional().describe("Default: paid (ya está pagado porque fue entregado)"),
    paymentMethod: z.string().optional().describe("Método de pago"),
    notes: z.string().optional().describe("Notas del pedido"),
    deliveredAt: z.string().optional().describe("Fecha/hora de entrega. Si no se especifica, se usa la fecha actual. Formato: DD/MM o YYYY-MM-DD HH:MM"),
  }),
  execute: async ({ customerName, customerPhone, orderType, items, deliveryFee, paymentStatus, paymentMethod, notes, deliveredAt }) => {
    // Normalizar items contra productos reales de la DB
    const resolvedItems = await resolveItems(items);
    const itemError = validateResolvedOrderItems(resolvedItems);
    if (itemError) return { success: false, message: itemError };

    // Validar y limpiar teléfono
    const cleanedPhone = customerPhone ? normalizePhone(customerPhone) : "";
    if (cleanedPhone && !isValidPhone(cleanedPhone)) {
      return { success: false, message: `El teléfono "${customerPhone}" no parece válido. Usá el formato internacional con código de país (ej: 549XXXXXXXXXX), 10-15 dígitos. Si no tenés el número, crealo sin teléfono.` };
    }

    // 1. Crear o actualizar lead
    let leadId: number | null = null;
    let leadName = customerName;

    const [existingLead] = cleanedPhone ? await db
      .select({ id: leads.id, status: leads.status, name: leads.name })
      .from(leads)
      .where(eq(leads.phone, cleanedPhone))
      .limit(1) : [];

    if (existingLead) {
      leadId = existingLead.id;
      leadName = existingLead.name || customerName;
      // Actualizar a converted si era lead nuevo
      if (existingLead.status === "new" || existingLead.status === "contacted") {
        await db.update(leads).set({ status: "converted", name: customerName }).where(eq(leads.id, existingLead.id));
      } else if (customerName) {
        await db.update(leads).set({ name: customerName }).where(eq(leads.id, existingLead.id));
      }
    } else {
      // Crear lead nuevo (con placeholder si no hay teléfono)
      const finalPhone = cleanedPhone || `sin-telefono-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const [newLead] = await db.insert(leads).values({
        name: customerName,
        phone: finalPhone,
        status: cleanedPhone ? "converted" : "new",
        notes: cleanedPhone ? null : "⚠️ Cliente sin teléfono — cargar número pendiente",
      }).returning({ id: leads.id });
      leadId = newLead.id;
    }

    // 2. Parsear fecha de entrega — siempre como hora de pared Argentina
    //    (el servidor corre en UTC; `new Date(y,m,d,h)` la armaría en UTC y
    //    el pedido caería fuera de la ventana de caja del turno real).
    let deliveredTimestamp: Date;
    if (deliveredAt) {
      const clean = deliveredAt.trim();
      const now = new Date();
      if (/^\d{1,2}\/\d{1,2}$/.test(clean)) {
        // Solo día/mes → mediodía AR del año corriente
        const [d, m] = clean.split("/").map(Number);
        deliveredTimestamp = argentinaWallTime(d, m, 12, 0, now);
      } else if (/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}$/.test(clean)) {
        const [dm, h] = clean.split(/\s+/);
        const [d, m] = dm.split("/").map(Number);
        const [hh, mi] = h.split(":").map(Number);
        deliveredTimestamp = argentinaWallTime(d, m, hh, mi, now);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
        // Solo fecha ISO → mediodía AR de ese día
        const [y, m, d] = clean.split("-").map(Number);
        deliveredTimestamp = argentinaWallTime(d, m, 12, 0, now, y);
      } else if (/^\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}/.test(clean) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(clean)) {
        // ISO sin zona → hora de pared AR (con zona explícita se respeta tal cual)
        const [ymd, hm] = clean.split(/[T ]/);
        const [y, m, d] = ymd.split("-").map(Number);
        const [hh, mi] = hm.split(":").map(Number);
        deliveredTimestamp = argentinaWallTime(d, m, hh, mi ?? 0, now, y);
      } else {
        const parsed = new Date(clean);
        deliveredTimestamp = Number.isNaN(parsed.getTime()) ? now : parsed;
      }
    } else {
      deliveredTimestamp = new Date();
    }

    // 3. Calcular total
    let subtotal = 0;
    for (const item of resolvedItems) {
      subtotal += (item.price ?? 0) * item.quantity;
    }
    const delivery = deliveryFee || 0;
    const total = subtotal + delivery;

    // 4. Crear pedido como delivered SIN notificaciones
    const [created] = await db.insert(orders).values({
      leadId,
      phoneNumber: cleanedPhone,
      customerName: leadName,
      orderType,
      items: resolvedItems,
      deliveryFee: delivery ? String(delivery) : "0",
      paymentStatus: paymentStatus || "paid",
      paymentMethod: paymentMethod || null,
      notes: notes || null,
      status: "delivered",
      deliveredAt: deliveredTimestamp,
      followupSent: true, // ya se entregó, no mandar followup
    }).returning({ id: orders.id });

    await decrementStockBestEffort(resolvedItems);

    const dateStr = deliveredTimestamp.toLocaleDateString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit",
    });

    const itemSummary = resolvedItems.map(i => `${i.quantity}x ${i.name}`).join(", ");

    return {
      success: true,
      id: created.id,
      message: `📦 Pedido #${created.id} cargado como ENTREGADO (${dateStr}) para ${leadName}. Total: $${total}. Items: ${itemSummary}. Sin notificaciones.`,
    };
  },
});

// updateOrder - Editar campos de un pedido existente (cliente, teléfono, lead, entrega, pago)
export const updateOrder = tool({
  description:
    "EDITA campos de un pedido ya creado: nombre del cliente, teléfono, lead asociado, dirección, costo de envío, notas, método/estado de pago. USAR cuando: 'poné el teléfono X al pedido N', 'corregí el nombre', 'ese pagó por MP', 'agregale dirección'. Evita cancelar y recrear el pedido.",
  inputSchema: z.object({
    orderId: z.number().describe("ID del pedido a editar"),
    customerName: z.string().trim().min(1).optional().describe("Nuevo nombre del cliente"),
    phone: z.string().optional().describe("Nuevo teléfono (se normaliza y vincula al lead si existe)"),
    leadId: z.number().optional().describe("ID del lead a asociar"),
    address: z.string().optional().describe("Dirección de entrega"),
    deliveryFee: z.number().min(0).optional().describe("Costo de envío"),
    notes: z.string().optional().describe("Notas del pedido"),
    paymentMethod: z.string().optional().describe("Método de pago: 'efectivo', 'mp', 'transferencia', etc."),
    paymentStatus: z.enum(["pending", "paid"]).optional().describe("Estado de cobro"),
    deliveredAt: z.string().optional().describe("Fecha/hora de entrega en ISO, ej: '2026-10-14T23:30:00-03:00'. Corrige a qué turno/caja pertenece el pedido."),
    createdAt: z.string().optional().describe("Fecha/hora de creación en ISO — solo para re-ubicar pedidos mal fechados"),
  }),
  execute: async ({ orderId, customerName, phone, leadId, address, deliveryFee, notes, paymentMethod, paymentStatus, deliveredAt, createdAt }) => {
    const [existing] = await db
      .select({ id: orders.id, customerName: orders.customerName, phoneNumber: orders.phoneNumber, leadId: orders.leadId })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (!existing) {
      return { success: false, message: "Pedido no encontrado" };
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (customerName !== undefined) updates.customerName = customerName;
    if (leadId !== undefined) {
      const [lead] = await db.select({ id: leads.id, name: leads.name }).from(leads).where(eq(leads.id, leadId)).limit(1);
      if (!lead) return { success: false, message: `Lead #${leadId} no existe` };
      updates.leadId = lead.id;
      if (customerName === undefined && lead.name) updates.customerName = lead.name;
    }
    if (phone !== undefined) {
      const cleaned = normalizePhone(phone);
      if (cleaned && !isValidPhone(cleaned)) {
        return { success: false, message: `El teléfono "${phone}" no es válido.` };
      }
      updates.phoneNumber = cleaned || null;
      // Si hay lead con ese teléfono y el pedido no tiene lead, vincularlo.
      if (cleaned && updates.leadId === undefined && !existing.leadId) {
        const [byPhone] = await db.select({ id: leads.id }).from(leads).where(eq(leads.phone, cleaned)).limit(1);
        if (byPhone) updates.leadId = byPhone.id;
      }
    }
    if (address !== undefined) updates.address = address;
    if (deliveryFee !== undefined) updates.deliveryFee = String(deliveryFee);
    if (notes !== undefined) updates.notes = notes;
    if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
    if (paymentStatus !== undefined) updates.paymentStatus = paymentStatus;
    for (const [key, value] of [["deliveredAt", deliveredAt], ["createdAt", createdAt]] as const) {
      if (value === undefined) continue;
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return { success: false, message: `Fecha inválida en ${key}: "${value}"` };
      updates[key] = d;
    }

    await db.update(orders).set(updates).where(eq(orders.id, orderId));

    const changed = Object.keys(updates).filter(k => k !== "updatedAt").join(", ");
    return {
      success: true,
      message: `Pedido #${orderId} actualizado (${changed})`,
    };
  },
});

// Export all manageOrder tools
export const manageOrderTools = {
  createOrder,
  addItemToOrder,
  removeItemFromOrder,
  updateOrderStatus,
  updateOrder,
  cancelOrder,
  calculateTotal,
  confirmOrder,
  markAsPaid,
  markPaymentMethod,
  createDeliveredOrder,
};
