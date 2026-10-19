/**
 * Optimistic compare-and-swap writer for `conversations.conversation_metadata`
 * (A-48).
 *
 * Several subsystems share this jsonb column — the anti-loop reprompt
 * counter, the order-lifecycle same/new marker, plus opaque keys preserved
 * verbatim. All of them used unconditional read-modify-write, so two
 * concurrent writers silently lost each other's fields.
 *
 * Schema changes are out of scope and neon-http has no transactions or row
 * locks (see session-store.ts for the same constraint), so the CAS guards on
 * the value itself: `conversation_metadata IS NOT DISTINCT FROM <old>::jsonb`.
 * jsonb equality is semantic — key order and whitespace don't matter. A lost
 * race yields rowCount 0 → re-read, re-merge, retry (bounded). Returns false
 * when the row is missing or retries are exhausted; callers treat metadata
 * persistence as best-effort.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";

export const METADATA_CAS_MAX_RETRIES = 4;

type MetadataShape = (typeof conversations.$inferSelect)["conversationMetadata"];

export async function updateConversationMetadataCAS(
  conversationId: number,
  mutate: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<boolean> {
  for (let attempt = 0; attempt <= METADATA_CAS_MAX_RETRIES; attempt++) {
    const [row] = await db
      .select({ metadata: conversations.conversationMetadata })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!row) return false;

    const current = (row.metadata ?? null) as Record<string, unknown> | null;
    const next = mutate({ ...(current ?? {}) });

    const updated = await db
      .update(conversations)
      .set({ conversationMetadata: next as MetadataShape })
      .where(
        and(
          eq(conversations.id, conversationId),
          sql`${conversations.conversationMetadata} IS NOT DISTINCT FROM ${current === null ? null : JSON.stringify(current)}::jsonb`,
        ),
      );
    // neon-http returns {rowCount}; test fakes return the updated rows array.
    const rowCount = Array.isArray(updated)
      ? updated.length
      : ((updated as unknown as { rowCount?: number }).rowCount ?? 0);
    if (rowCount > 0) return true;
    // Conflict — another writer landed between our read and write. Retry with
    // a fresh read so the merge re-applies on top of their change.
  }
  console.warn(`[conversation-metadata] CAS retries exhausted for conversation ${conversationId}`);
  return false;
}
