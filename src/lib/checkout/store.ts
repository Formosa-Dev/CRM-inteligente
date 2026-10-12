import { and, eq, like, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentConfig, orders, products, promotions } from "@/db/schema";
import { type Product, type Promo, webReference } from "./contract";

export type OrderRow = {
  id: number;
  phoneNumber: string | null;
  customerName: string | null;
  items: unknown;
  notes: string | null;
  address: string | null;
};

export type InsertOrderValues = {
  phone: string;
  customerName: string;
  orderType: "hamburguesas" | "pan_mayorista";
  items: unknown;
  notes: string;
  address: string | null;
  reference: string;
};

export type CheckoutDeps = {
  getDestinationPhone(): Promise<string | null>;
  getBurgersUnavailable(): Promise<boolean>;
  findOrderByReference(phone: string, reference: string): Promise<OrderRow | null>;
  listProducts(): Promise<Product[]>;
  listPromos(): Promise<Promo[]>;
  reserveStock(productId: number, quantity: number): Promise<number>;
  getProductStock(productId: number): Promise<{ name: string; stock: number | null } | null>;
  releaseStock(productId: number, quantity: number): Promise<void>;
  insertOrderIfAbsent(values: InsertOrderValues): Promise<OrderRow | null>;
};

// Raw SQL via the neon-http driver returns the database's snake_case column
// names; Drizzle's query builder returns camelCase. Normalizing here keeps a
// single OrderRow shape — reading `row.phoneNumber` off a raw row silently
// produced `undefined`, which rejected every first-time checkout with a false
// "already used" conflict even though the order had been stored.
type RawOrderRow = {
  id: number;
  phone_number: string | null;
  customer_name: string | null;
  items: unknown;
  notes: string | null;
  address: string | null;
};

export function mapOrderRow(row: RawOrderRow): OrderRow {
  return {
    id: row.id,
    phoneNumber: row.phone_number,
    customerName: row.customer_name,
    items: row.items,
    notes: row.notes,
    address: row.address ?? null,
  };
}

export function createDbCheckoutDeps(): CheckoutDeps {
  return {
    async getDestinationPhone() {
      // agent_config was introduced by the WhatsApp agent, which some
      // deployments never provisioned. Its absence must not block checkout.
      try {
        const [cfg] = await db.select({ phone: agentConfig.phoneNumber }).from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);
        return cfg?.phone ?? null;
      } catch {
        return null;
      }
    },
    async getBurgersUnavailable() {
      try {
        const [cfg] = await db.select({ noBurgers: agentConfig.hamburguesasSinStock }).from(agentConfig).where(eq(agentConfig.id, 1)).limit(1);
        return cfg?.noBurgers ?? false;
      } catch {
        return false;
      }
    },
    async findOrderByReference(phone, reference) {
      const [order] = await db.select({
        id: orders.id,
        phoneNumber: orders.phoneNumber,
        customerName: orders.customerName,
        items: orders.items,
        notes: orders.notes,
        address: orders.address,
      }).from(orders).where(and(eq(orders.phoneNumber, phone), like(orders.notes, `%${reference}%`))).limit(1);
      return order ?? null;
    },
    async listProducts() {
      return db.select().from(products);
    },
    async listPromos() {
      return db.select().from(promotions);
    },
    async reserveStock(productId, quantity) {
      const result = await db.execute(sql`
        UPDATE products SET stock = stock - ${quantity}
        WHERE id = ${productId} AND stock IS NOT NULL AND stock >= ${quantity}
      `);
      return result.rowCount ?? 0;
    },
    async getProductStock(productId) {
      const [p] = await db.select({ name: products.name, stock: products.stock }).from(products).where(eq(products.id, productId)).limit(1);
      return p ?? null;
    },
    async releaseStock(productId, quantity) {
      await db.execute(sql`UPDATE products SET stock = stock + ${quantity} WHERE id = ${productId}`);
    },
    async insertOrderIfAbsent(values) {
      // Conditional INSERT keyed on the request reference: a concurrent request
      // that already stored it wins and this statement becomes a no-op.
      const inserted = await db.execute(sql`
        INSERT INTO orders (phone_number, customer_name, order_type, items, notes, address, status)
        SELECT ${values.phone}, ${values.customerName}, ${values.orderType}::order_type, ${JSON.stringify(values.items)}::jsonb, ${values.notes}, ${values.address}, 'pending'
        WHERE NOT EXISTS (
          SELECT 1 FROM orders WHERE phone_number = ${values.phone} AND notes LIKE ${`%${values.reference}%`}
        )
        RETURNING id, phone_number, customer_name, items, notes, address
      `);
      const raw = inserted.rows?.[0] as RawOrderRow | undefined;
      return raw ? mapOrderRow(raw) : null;
    },
  };
}

export async function findReferencedWebOrder(reference: string, phone: string) {
  const [order] = await db.select({ id: orders.id, status: orders.status }).from(orders)
    .where(and(eq(orders.phoneNumber, phone), like(orders.notes, `%${webReference(reference)}%`))).limit(1);
  return order ?? null;
}
