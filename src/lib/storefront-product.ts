import "server-only";

import { cache } from "react";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";

/**
 * Server-side product lookup for the public detail routes. Cached per
 * request so a segment layout and its generateMetadata share one query.
 * Returns null for malformed ids, unavailable products, or DB failures —
 * callers turn that into a 404.
 */
export const getStorefrontProduct = cache(async (id: string) => {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  try {
    const [row] = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        category: products.category,
        imageUrl: products.imageUrl,
      })
      .from(products)
      .where(and(eq(products.id, numericId), eq(products.available, true)))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
});
