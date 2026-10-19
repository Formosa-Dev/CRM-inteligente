import { db } from "@/db";
import { leads } from "@/db/schema";
import { eq } from "drizzle-orm";
import { normalizePhone } from "@/lib/phone-utils";

/**
 * Extract ref code from message text (format: ref:CODE123)
 */
export function extractRefCode(text: string): string | null {
  const match = text.match(/ref:([A-Za-z0-9_-]+)/i);
  return match ? match[1] : null;
}

/**
 * Auto-capture lead on first contact — no duplicates by phone.
 * `channelAccountId` attributes the lead to the account that received the
 * contact (a re-contact through a different account moves the ownership so
 * scoped order lookups follow the latest account); NULL leaves the column
 * untouched, preserving the legacy shared-lead behavior.
 */
export async function captureLeadIfNew(
  phone: string,
  name: string | null,
  firstMessage: string,
  channelAccountId?: number | null
): Promise<{ isNew: boolean; leadId?: number }> {
  // Normalizar teléfono antes de cualquier operación
  phone = normalizePhone(phone);
  // Check if lead already exists
  const existing = await db
    .select({ id: leads.id, channelAccountId: leads.channelAccountId })
    .from(leads)
    .where(eq(leads.phone, phone))
    .limit(1);

  if (existing.length > 0) {
    const lead = existing[0];
    if (channelAccountId != null && lead.channelAccountId !== channelAccountId) {
      await db
        .update(leads)
        .set({ channelAccountId })
        .where(eq(leads.id, lead.id));
    }
    return { isNew: false, leadId: lead.id };
  }

  const refCode = extractRefCode(firstMessage);

  const [created] = await db
    .insert(leads)
    .values({
      phone,
      name,
      firstMessage,
      refCode,
      status: "new",
      platform: "whatsapp",
      tags: ["nuevo", "whatsapp"],
      channelAccountId: channelAccountId ?? null,
    })
    .returning({ id: leads.id });

  return { isNew: true, leadId: created.id };
}
