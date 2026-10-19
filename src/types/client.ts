export interface ClientStats {
  totalOrders: number;
  totalSpent: number;
  avgOrderValue: number;
  ordersThisMonth: number;
  lastOrderAt: Date | null;
}
