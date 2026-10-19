import { db } from "@/db";
import { agentConfig } from "@/db/schema";
import { eq } from "drizzle-orm";
import { formatBusinessHours } from "@/lib/business-hours";

export interface BusinessInfo {
  name: string;
  tagline: string;
  address: string;
  phoneDisplay: string;
  /** Digits-only number for wa.me links (no +, no spaces). */
  whatsappPhone: string;
  instagram: string;
  website: string;
  description: string;
  /** Display-ready opening hours, only when the business configured them. */
  hours?: string;
}

const FALLBACK: BusinessInfo = {
  name: process.env.BUSINESS_NAME ?? "Mi Negocio",
  tagline: "",
  address: "",
  phoneDisplay: "",
  whatsappPhone: (process.env.WHATSAPP_PHONE_NUMBER ?? "").replace(/\D/g, ""),
  instagram: "",
  website: "",
  description: "",
  hours: process.env.BUSINESS_HOURS || undefined,
};

/**
 * Reads the business identity from agent_config (row 1). Every field falls
 * back to env/empty so deployments without the newer columns still boot.
 * Server-only — client components should call GET /api/business instead.
 */
export async function getBusinessInfo(): Promise<BusinessInfo> {
  try {
    const [cfg] = await db
      .select({
        businessName: agentConfig.businessName,
        businessTagline: agentConfig.businessTagline,
        businessAddress: agentConfig.businessAddress,
        businessPhoneDisplay: agentConfig.businessPhoneDisplay,
        instagramHandle: agentConfig.instagramHandle,
        businessWebsite: agentConfig.businessWebsite,
        businessDescription: agentConfig.businessDescription,
        businessHours: agentConfig.businessHours,
        phoneNumber: agentConfig.phoneNumber,
        whatsappBotNumber: agentConfig.whatsappBotNumber,
      })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    if (!cfg) return FALLBACK;

    const whatsappPhone = (
      cfg.phoneNumber || cfg.whatsappBotNumber || process.env.WHATSAPP_PHONE_NUMBER || ""
    ).replace(/\D/g, "");

    return {
      name: cfg.businessName || FALLBACK.name,
      tagline: cfg.businessTagline || FALLBACK.tagline,
      address: cfg.businessAddress || FALLBACK.address,
      phoneDisplay: cfg.businessPhoneDisplay || FALLBACK.phoneDisplay,
      whatsappPhone,
      instagram: (cfg.instagramHandle || "").replace(/^@/, ""),
      website: cfg.businessWebsite || "",
      description: cfg.businessDescription || "",
      hours:
        formatBusinessHours(cfg.businessHours) ??
        (process.env.BUSINESS_HOURS || undefined),
    };
  } catch {
    return FALLBACK;
  }
}
