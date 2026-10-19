import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { checkRateLimit, clientIpFromRequest } from "@/lib/infra/rate-limit";

export async function GET(req: NextRequest) {
  // The check below is a live DB query — unbounded polling doubles as a DB
  // DoS, so it sits behind the same limiter as the other public endpoints.
  const rate = await checkRateLimit(`pub:health:${clientIpFromRequest(req)}`);
  if (!rate.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  try {
    // Simple DB test - just try to select
    await db.select().from(users).limit(1);
    
    return NextResponse.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || "1.0.0",
      db: "connected",
    });
  } catch (error) {
    console.error("[api/health] DB check failed:", error);
    return NextResponse.json(
      {
        status: "error",
        timestamp: new Date().toISOString(),
        db: "unreachable",
      },
      { status: 500 }
    );
  }
}