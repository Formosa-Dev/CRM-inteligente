import type { ClientStats } from "@/types/client";

export function calculateClientStats(orders: {
  id: number;
  items: unknown;
  status: string;
  createdAt: Date;
}[]): ClientStats {
  const completedOrders = orders.filter(
    (o) => o.status === "delivered" || o.status === "ready"
  );

  const totalOrders = completedOrders.length;
  
  // Items is already the calculated total from the DB
  const totalSpent = completedOrders.reduce((sum, order) => {
    const items = order.items as { total?: number; price?: number; quantity?: number }[] | null;
    if (!items) return sum;
    return sum + (items[0]?.total || 0);
  }, 0);

  const now = new Date();
  const thisMonth = now.getMonth();
  const thisYear = now.getFullYear();
  const ordersThisMonth = completedOrders.filter((o) => {
    const d = new Date(o.createdAt);
    return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
  }).length;

  const lastOrder = orders.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  )[0];

  return {
    totalOrders,
    totalSpent,
    avgOrderValue: totalOrders > 0 ? Math.round(totalSpent / totalOrders) : 0,
    ordersThisMonth,
    lastOrderAt: lastOrder ? new Date(lastOrder.createdAt) : null,
  };
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
  }).format(amount);
}

/**
 * Total de un pedido para display: Σ(precio||unitPrice)×cantidad + envío.
 * Los items del admin guardan `price` y/o `unitPrice`; cantidad faltante
 * cuenta como 1 (mismo default que el render "1x"). Devuelve 0 cuando no hay
 * nada cobrado — el caller decide no renderizar el total en ese caso.
 */
export function computeOrderTotal(
  items: Array<{
    name?: string;
    productName?: string;
    quantity?: number | null;
    price?: number | string | null;
    unitPrice?: number | string | null;
  }> | null | undefined,
  deliveryFee?: number | string | null,
): number {
  const lines = Array.isArray(items) ? items : [];
  const subtotal = lines.reduce((sum, item) => {
    const unit = Number(item?.price) || Number(item?.unitPrice) || 0;
    const qty = Number(item?.quantity ?? 1);
    return sum + (unit > 0 && qty > 0 ? unit * qty : 0);
  }, 0);
  const fee = Number(deliveryFee) || 0;
  return subtotal + (fee > 0 ? fee : 0);
}