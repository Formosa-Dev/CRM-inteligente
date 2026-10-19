import { db } from "@/db";
import { conversations } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { ModelMessage } from "ai";
import { normalizePhone } from "@/lib/phone-utils";

const MAX_MESSAGES = 50;
const TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function loadConversation(phone: string): Promise<ModelMessage[]> {
  try {
    const normalizedPhone = normalizePhone(phone);
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.whatsappId, normalizedPhone))
      .limit(1);

    if (rows.length === 0) return [];

    const conv = rows[0];
    const lastUpdate = conv.updatedAt?.getTime() ?? 0;

    // Reset conversation if older than 24 hours
    if (Date.now() - lastUpdate > TIMEOUT_MS) {
      return [];
    }

    const messages = (conv.messages ?? []) as ModelMessage[];
    // Keep only the last MAX_MESSAGES messages
    return messages.slice(-MAX_MESSAGES);
  } catch (error) {
    console.error("[conversation] Error loading conversation:", error);
    return [];
  }
}

export async function saveConversation(
  phone: string,
  messages: ModelMessage[]
): Promise<void> {
  try {
    const trimmed = messages.slice(-MAX_MESSAGES);

    const existing = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.whatsappId, phone))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(conversations)
        .set({
          messages: trimmed as unknown as Record<string, unknown>[],
          updatedAt: new Date(),
        })
        .where(eq(conversations.whatsappId, phone));
    } else {
      await db.insert(conversations).values({
        whatsappId: phone,
        customerPhone: phone,
        channel: "whatsapp",
        externalUserId: phone,
        externalUserIdNormalized: normalizePhone(phone),
        messages: trimmed as unknown as Record<string, unknown>[],
        status: "active",
      });
    }
  } catch (error) {
    console.error("[conversation] Error saving conversation:", error);
  }
}
