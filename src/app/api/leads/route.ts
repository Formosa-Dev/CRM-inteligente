import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { checkRateLimit } from "@/lib/infra/rate-limit";
import { eq, and, gte, lte, desc, or, ilike } from "drizzle-orm";
import { db } from "@/db";
import { leads } from "@/db/schema";
import { extractRefCode } from "@/lib/attribution";
import { decodeRefCode } from "@/lib/attribution/ref-code";
import { verifyRefCodeSignature } from "@/lib/attribution/ref-code-sign";
import { z } from "zod";
import { normalizePhone } from "@/lib/phone-utils";

// ─── POST /api/leads ──────────────────────────────────────────────────────────

const CreateLeadSchema = z.object({
  phone: z.string().min(1, "phone is required").max(30),
  name: z.string().max(120).optional(),
  email: z.string().email().max(200).optional().or(z.literal("")),
  firstMessage: z.string().max(2000).optional(),
  utmSource: z.string().max(120).optional(),
  utmMedium: z.string().max(120).optional(),
  utmCampaign: z.string().max(120).optional(),
  utmContent: z.string().max(120).optional(),
  platform: z.string().max(40).optional(),
  adId: z.string().max(120).optional(),
  campaignId: z.string().max(120).optional(),
  adsetId: z.string().max(120).optional(),
});

export async function POST(req: NextRequest) {
  try {
    // Public lead-capture endpoint — rate limited to prevent spam floods
    const ip =
      req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      req.headers.get("x-real-ip") ??
      "unknown";
    const rate = await checkRateLimit(`leads:${ip}`);
    if (!rate.success) {
      return NextResponse.json({ error: "Too many requests" }, { status: 429 });
    }

    // Reject oversized bodies before parsing — the endpoint is public.
    if (Number(req.headers.get("content-length")) > 8000) {
      return NextResponse.json({ error: "Payload demasiado grande" }, { status: 413 });
    }
    const body = await req.json();
    const parsed = CreateLeadSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Validation error", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const data = parsed.data;
    data.phone = normalizePhone(data.phone);
    const refCode = data.firstMessage ? extractRefCode(data.firstMessage) : null;

    // Attribution resolution — fail-open: errors must never block lead creation
    let resolvedCampaignId: string | null = data.campaignId ?? null;
    let resolvedAdsetId: string | null = data.adsetId ?? null;
    let resolvedAdId: string | null = data.adId ?? null;
    let resolvedPlatform: string | null = data.platform ?? null;
    let resolvedUtmSource: string | null = data.utmSource ?? null;

    if (refCode) {
      try {
        const decoded = decodeRefCode(refCode);
        // Signed codes: reject attribution when the HMAC doesn't check out.
        // Legacy unsigned codes (already published in live ads) still decode.
        if (decoded && decoded.signed && !verifyRefCodeSignature(refCode)) {
          console.warn("[POST /api/leads] refCode signature invalid — dropping attribution");
        } else if (decoded) {
          resolvedCampaignId = decoded.campaignId;
          resolvedAdsetId = decoded.adsetId;
          resolvedAdId = decoded.adId;
          resolvedPlatform = "meta";
          if (!resolvedUtmSource) resolvedUtmSource = "meta";
        } else {
          console.warn("[POST /api/leads] refCode present but decodeRefCode returned null", { refCode });
          resolvedPlatform = resolvedPlatform ?? "unknown";
        }
      } catch (attributionErr) {
        console.warn("[POST /api/leads] decodeRefCode threw — skipping attribution", attributionErr);
        resolvedPlatform = resolvedPlatform ?? "unknown";
      }
    } else {
      resolvedPlatform = resolvedPlatform ?? "organic";
    }

    const [lead] = await db
      .insert(leads)
      .values({
        phone: data.phone,
        name: data.name ?? null,
        email: data.email || null,
        firstMessage: data.firstMessage ?? null,
        refCode: refCode ?? null,
        utmSource: resolvedUtmSource,
        utmMedium: data.utmMedium ?? null,
        utmCampaign: data.utmCampaign ?? null,
        utmContent: data.utmContent ?? null,
        platform: resolvedPlatform,
        campaignId: resolvedCampaignId,
        adsetId: resolvedAdsetId,
        adId: resolvedAdId,
      })
      .returning();

    return NextResponse.json(lead, { status: 201 });
  } catch (err) {
    console.error("[POST /api/leads]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

// ─── GET /api/leads ───────────────────────────────────────────────────────────

/**
 * Parses a ?from=/?to= filter. Invalid dates return null so the param is
 * simply ignored — `new Date("garbage")` inside a Drizzle comparison throws
 * a RangeError that used to surface as a 500.
 */
export function parseDateParam(value: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  try {
    const { searchParams } = req.nextUrl;

    const campaign = searchParams.get("campaign");
    const status = searchParams.get("status") as
      | "new"
      | "contacted"
      | "converted"
      | "lost"
      | null;
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const search = searchParams.get("search");

    const conditions = [];

    if (campaign) {
      conditions.push(eq(leads.utmCampaign, campaign));
    }
    if (status) {
      conditions.push(eq(leads.status, status));
    }
    const fromDate = parseDateParam(from);
    if (fromDate) {
      conditions.push(gte(leads.createdAt, fromDate));
    }
    const toDate = parseDateParam(to);
    if (toDate) {
      conditions.push(lte(leads.createdAt, toDate));
    }
    if (search) {
      const cleaned = search.trim();
      conditions.push(
        or(
          ilike(leads.phone, `%${cleaned}%`),
          ilike(leads.name, `%${cleaned}%`),
        )
      );
    }

    const rows = await db
      .select()
      .from(leads)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(leads.createdAt))
      .limit(200);

    return NextResponse.json(rows);
  } catch (err) {
    console.error("[GET /api/leads]", err);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
