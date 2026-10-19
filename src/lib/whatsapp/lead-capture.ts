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
 * contact. An existing lead is only stamped when it has NO account yet
 * (first attribution): arbitrary inbound traffic on another account must
 * never migrate the ownership, or account-scoped order lookups silently
 * follow the wrong account. Order-bearing transitions re-stamp explicitly
 * in the order path (create-order), not here. NULL leaves the column
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
    if (channelAccountId != null && lead.channelAccountId == null) {
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
