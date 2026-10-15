import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { eq, and } from "drizzle-orm";
import { db } from "@/db";
import { products } from "@/db/schema";

// ─── GET /api/products ───────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const category = searchParams.get("category") as string | null;
    const available = searchParams.get("available");

    // Requesting hidden products requires an admin session — the public
    // storefront must not be able to enumerate inactive items.
    if (available === "false") {
      const session = await auth();
      if (!session) {
        return NextResponse.json({ error: "No autorizado" }, { status: 401 });
      }
    }

    const conditions = [];

    // Filter by available (default: true)
    if (available !== "false") {
      conditions.push(eq(products.available, true));
    }

    // Filter by category (any valid category)
    if (category) {
      conditions.push(eq(products.category, category as (typeof products.$inferSelect)["category"]));
    }

    const items = await db
      .select({
        id: products.id,
        name: products.name,
        description: products.description,
        price: products.price,
        isPromo: products.isPromo,
        promoPrice: products.promoPrice,
        stock: products.stock,
        category: products.category,
        imageUrl: products.imageUrl,
        available: products.available,
        comingSoon: products.comingSoon,
        sortOrder: products.sortOrder,
        variants: products.variants,
      })
      .from(products)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(products.sortOrder);

    return NextResponse.json(items, {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  } catch (err) {
    console.error("[GET /api/products]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}