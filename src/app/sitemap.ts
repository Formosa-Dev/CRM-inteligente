import type { MetadataRoute } from "next";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";
import { CAMPAIGNS } from "@/lib/constants";
import { getSiteUrl } from "@/lib/site-url";

// Only categories with a dedicated detail route get product URLs — the
// rest live inside /carta-digital.
const DETAIL_ROUTE: Record<string, string> = {
  hamburguesa: "/hamburguesas",
  pan_mayorista: "/pan-mayorista",
};

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = getSiteUrl();

  const staticRoutes: MetadataRoute.Sitemap = [
    { path: "", priority: 1 },
    { path: "/carta-digital", priority: 0.9 },
    { path: "/pan-mayorista", priority: 0.8 },
  ].map(({ path, priority }) => ({
    url: `${base}${path}`,
    changeFrequency: "weekly" as const,
    priority,
  }));

  const promoRoutes: MetadataRoute.Sitemap = CAMPAIGNS.filter(
    (c) => c.active,
  ).map((c) => ({
    url: `${base}/promo/${c.slug}`,
    changeFrequency: "weekly" as const,
    priority: 0.6,
  }));

  let productRoutes: MetadataRoute.Sitemap = [];
  try {
    const rows = await db
      .select({
        id: products.id,
        category: products.category,
        updatedAt: products.updatedAt,
      })
      .from(products)
      .where(
        and(
          eq(products.available, true),
          inArray(products.category, ["hamburguesa", "pan_mayorista"]),
        ),
      );
    productRoutes = rows.map((row) => ({
      url: `${base}${DETAIL_ROUTE[row.category]}/${row.id}`,
      lastModified: row.updatedAt,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    }));
  } catch {
    // DB unavailable — the static and promo routes still ship.
  }

  return [...staticRoutes, ...promoRoutes, ...productRoutes];
}
