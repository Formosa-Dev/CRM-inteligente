import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { promotions } from "@/db/schema";
import { checkRateLimit, clientIpFromRequest } from "@/lib/infra/rate-limit";

// ─── GET /api/promotions ────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const rate = await checkRateLimit(`pub:promotions:${clientIpFromRequest(req)}`);
  if (!rate.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  try {
    const { searchParams } = req.nextUrl;
    const activeOnly = searchParams.get("active") === "true";

    // Listing inactive promotions is admin-only — the public surface must not
    // enumerate promos that were intentionally hidden.
    if (!activeOnly) {
      const session = await auth();
      if (!session) {
        return NextResponse.json({ error: "No autorizado" }, { status: 401 });
      }
    }

    const rows = await db
      .select({
        id: promotions.id,
        name: promotions.name,
        description: promotions.description,
        imageUrl: promotions.imageUrl,
        customPrice: promotions.customPrice,
        items: promotions.items,
        active: promotions.active,
      })
      .from(promotions)
      .where(activeOnly ? eq(promotions.active, true) : undefined)
      .orderBy(desc(promotions.createdAt));

    return NextResponse.json(rows);
  } catch (err) {
    console.error("[GET /api/promotions]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
