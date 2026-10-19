import { NextRequest, NextResponse } from "next/server";
import { getBusinessInfo } from "@/lib/business";
import { checkRateLimit, clientIpFromRequest } from "@/lib/infra/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Public business identity for the storefront. Exposes only non-secret
 * fields — never API keys, tokens, or internal config.
 */
export async function GET(req: NextRequest) {
  const rate = await checkRateLimit(`pub:business:${clientIpFromRequest(req)}`);
  if (!rate.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  const info = await getBusinessInfo();
  return NextResponse.json(info, {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
