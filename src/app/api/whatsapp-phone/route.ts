import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { checkRateLimit, clientIpFromRequest } from "@/lib/infra/rate-limit";

export async function GET(req: NextRequest) {
  const rate = await checkRateLimit(`pub:whatsapp-phone:${clientIpFromRequest(req)}`);
  if (!rate.success) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }
  let phone = process.env.WHATSAPP_PHONE_NUMBER?.replace(/[+\s]/g, "") || "";
  try {
    const [cfg] = await db
      .select({ phone: agentConfig.phoneNumber })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);
    if (cfg?.phone) phone = cfg.phone.replace(/[+\s]/g, "");
  } catch {}

  return NextResponse.json({ phone });
}
