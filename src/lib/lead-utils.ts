import { db } from "@/db";
import { leads, orders } from "@/db/schema";
import { eq, sql, inArray, asc } from "drizzle-orm";

/**
 * Returns the managed client name if the person has orders,
 * otherwise returns fallbackName (WhatsApp name).
 * Business rule:
 *   - Has orders → use leads.name (managed name)
 *   - No orders → use fallbackName (WhatsApp/conversation name)
 */
export async function resolveClientName(
  phone: string,
  fallbackName: string
): Promise<string> {
  // 1. Find lead by phone
  const [lead] = await db
    .select({ id: leads.id, name: leads.name })
    .from(leads)
    .where(eq(leads.phone, phone))
    .orderBy(asc(leads.id))
    .limit(1);

  if (!lead || !lead.name) return fallbackName;

  // 2. Check if they have orders (are a client)
  const [orderCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(orders)
    .where(eq(orders.phoneNumber, phone));

  if (orderCount && orderCount.count > 0) {
    return lead.name; // managed name
  }

  return fallbackName; // WhatsApp name for leads without orders
}

/**
 * Batch variant for list queries.
 * Returns a Map<phone, resolvedName>
 */
export async function resolveClientNamesBatch(
  phones: string[]
): Promise<Map<string, string>> {
  if (phones.length === 0) return new Map();

  // Dedupe
  const uniquePhones = [...new Set(phones)];

  // Get all leads with their phones and names
  const leadRows = await db
    .select({ phone: leads.phone, name: leads.name })
    .from(leads)
    .where(inArray(leads.phone, uniquePhones))
    .orderBy(asc(leads.id));

  if (leadRows.length === 0) return new Map();

  // Get order counts for these phones
  const orderCounts = await db
    .select({
      phone: orders.phoneNumber,
      count: sql<number>`count(*)`,
    })
    .from(orders)
    .where(inArray(orders.phoneNumber, uniquePhones))
    .groupBy(orders.phoneNumber);

  const orderCountMap = new Map(
    orderCounts.map((o) => [o.phone, o.count])
  );
  // First row per phone wins — matches resolveClientName's ORDER BY id ASC LIMIT 1
  const leadNameMap = new Map<string, string | null>();
  for (const l of leadRows) {
    // leads.phone is nullable (S11); nulls can't match uniquePhones anyway.
    if (!l.phone) continue;
    if (!leadNameMap.has(l.phone)) leadNameMap.set(l.phone, l.name);
  }
  const result = new Map<string, string>();

  for (const phone of uniquePhones) {
    const name = leadNameMap.get(phone);
    const count = orderCountMap.get(phone) ?? 0;
    if (name && count > 0) {
      result.set(phone, name);
    }
  }

  return result;
}
