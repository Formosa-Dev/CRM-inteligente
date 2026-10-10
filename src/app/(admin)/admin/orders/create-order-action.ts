"use server";

import { db } from "@/db";
import { orders, leads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { revalidatePath } from "next/cache";
import { notifyNewOrder } from "@/lib/telegram/notifier";
import { resolveItems, validateResolvedOrderItems, decrementStockBestEffort } from "@/lib/order-utils";
import { normalizePhone } from "@/lib/phone-utils";

export async function createManualOrder(
  data: {
    customerName: string;
    customerPhone: string;
    orderType: "hamburguesas" | "pan_mayorista";
    items: { name: string; quantity: number; unitPrice: number }[];
    address?: string | null;
    notes?: string | null;
    deliveryFee?: number;
    paymentStatus?: string;
    paymentMethod?: string;
  }
): Promise<{ success: boolean; orderId?: number; error?: string }> {
  if (!(await requireAdmin())) return { success: false, error: "No autorizado"  };

  try {
    // Si no hay teléfono, generar un placeholder único para poder crear el lead igual
    const hasPhone = data.customerPhone && data.customerPhone.trim().length > 0;
    const phone = hasPhone ? normalizePhone(data.customerPhone) : `sin-telefono-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const resolvedItems = await resolveItems(data.items);
    const itemError = validateResolvedOrderItems(resolvedItems);
    if (itemError) return { success: false, error: itemError };
    const subtotal = resolvedItems.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
    const delivery = data.deliveryFee || 0;
    const total = subtotal + delivery;

    // Vincular con lead si existe, o crear uno nuevo si no hay teléfono
    let leadId: number | null = null;
    try {
      if (hasPhone) {
        const [lead] = await db
          .select({ id: leads.id, status: leads.status })
          .from(leads)
          .where(eq(leads.phone, phone))
          .limit(1);
        if (lead) {
          leadId = lead.id;
          if (data.address) {
            await db.update(leads).set({ address: data.address }).where(eq(leads.id, lead.id));
          }
          if (lead.status === "new" || lead.status === "contacted") {
            await db.update(leads).set({ status: "converted" }).where(eq(leads.id, lead.id));
          }
          if (data.customerName) {
            await db.update(leads).set({ name: data.customerName }).where(eq(leads.id, lead.id));
          }
        }
      } else {
        // Sin teléfono: crear lead con el nombre solamente y marcarlo como "sin teléfono"
        const [newLead] = await db
          .insert(leads)
          .values({
            phone,
            name: data.customerName,
            status: "new",
            notes: "⚠️ Cliente sin teléfono — cargar número pendiente",
          })
          .returning({ id: leads.id });
        leadId = newLead.id;
      }
    } catch {}

    const [order] = await db
      .insert(orders)
      .values({
        leadId,
        phoneNumber: phone,
        customerName: data.customerName,
        address: data.address || null,
        orderType: data.orderType,
        items: resolvedItems,
        notes: data.notes || null,
        deliveryFee: data.deliveryFee ? String(data.deliveryFee) : "0",
        paymentStatus: data.paymentStatus || "pending",
        paymentMethod: data.paymentMethod || null,
        status: "pending",
      })
      .returning({ id: orders.id });

    await decrementStockBestEffort(resolvedItems);

    // Notificar a Telegram
    notifyNewOrder({
      id: order.id,
      customerName: data.customerName,
      orderType: data.orderType,
      items: resolvedItems,
      total,
      status: "pending",
      phoneNumber: phone,
      notes: data.notes || null,
    }).catch(() => {});

    revalidatePath("/admin/orders");
    return { success: true, orderId: order.id };
  } catch (e) {
    console.error("[createManualOrder]", e);
    return { success: false, error: "Error al crear pedido" };
  }
}
