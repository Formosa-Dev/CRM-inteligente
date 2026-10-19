/**
 * Lead identity resolution for multi-channel installs (roadmap §2.4).
 *
 * Phone channels key leads on `leads.phone` (existing behavior, unchanged).
 * Phone-less channels (instagram/facebook/reddit) key leads through
 * `lead_identities(channel, externalId)` where `externalId` is the canonical
 * identity — the same value stored on `conversations.external_user_id_normalized`.
 *
 * Resolution order per spec §2.4.1:
 *   1. `lead_identities(channel, externalId)` → link the existing lead.
 *   2. `leads.phone` fallback → attach the new social identity to that lead.
 *   3. Neither → create a phone-less lead + its identity row.
 *
 * Never throws: lead linking is best-effort bookkeeping — a failure must not
 * fail webhook processing (same contract as `autoLinkLeadToConversation`).
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { leadIdentities, leads } from "@/db/schema";
import { normalizePhone } from "@/lib/phone-utils";
import type { ChannelKind } from "./types";

export interface LeadIdentityInput {
  channel: ChannelKind;
  /** Raw provider identity (as stored on conversations.external_user_id). */
  externalUserId: string;
  /** Canonical key — canonicalExternalUserId() output; the identity dedup key. */
  externalUserIdNormalized: string;
  customerName?: string | null;
  customerPhone?: string | null;
  channelAccountId: number | null;
  conversationId: number;
}

/** Links `conversationId` (+ account stamp) onto a lead that lacks one. */
async function linkConversationToLead(
  leadId: number,
  input: LeadIdentityInput
): Promise<void> {
  const [lead] = await db
    .select({ id: leads.id, conversationId: leads.conversationId })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead || lead.conversationId != null) return;
  await db
    .update(leads)
    .set(
      input.channelAccountId != null
        ? { conversationId: input.conversationId, channelAccountId: input.channelAccountId }
        : { conversationId: input.conversationId }
    )
    .where(eq(leads.id, leadId));
  console.log(
    `[leads] Linked lead #${leadId} → conversation #${input.conversationId} (${input.channel})`
  );
}

export async function ensureLeadIdentity(
  input: LeadIdentityInput
): Promise<void> {
  const { channel, externalUserIdNormalized: externalId } = input;
  try {
    // 1. Known identity → link its lead to this conversation if needed.
    const [identity] = await db
      .select({ leadId: leadIdentities.leadId })
      .from(leadIdentities)
      .where(
        and(
          eq(leadIdentities.channel, channel),
          eq(leadIdentities.externalId, externalId)
        )
      )
      .limit(1);
    if (identity) {
      await linkConversationToLead(identity.leadId, input);
      return;
    }

    // 2. Phone fallback → attach the social identity to that existing lead.
    const phone = input.customerPhone
      ? normalizePhone(input.customerPhone)
      : "";
    let leadId: number | undefined;
    if (phone) {
      const [lead] = await db
        .select({ id: leads.id })
        .from(leads)
        .where(eq(leads.phone, phone))
        .limit(1);
      leadId = lead?.id;
    }

    // 3. No match anywhere → create the phone-less social lead.
    let createdLeadId: number | undefined;
    if (leadId == null) {
      const [created] = await db
        .insert(leads)
        .values({
          name: input.customerName ?? null,
          phone: phone || null,
          channel,
          externalUserId: input.externalUserId,
          channelAccountId: input.channelAccountId,
          conversationId: input.conversationId,
        })
        .returning({ id: leads.id });
      leadId = created.id;
      createdLeadId = created.id;
      console.log(
        `[leads] Created lead #${leadId} for ${channel}:${externalId}`
      );
    } else {
      await linkConversationToLead(leadId, input);
    }

    try {
      await db
        .insert(leadIdentities)
        .values({ leadId, channel, externalId });
    } catch (err) {
      if ((err as { code?: string } | null)?.code !== "23505") throw err;
      // (channel, externalId) race: a concurrent inbound won the identity
      // row. Re-link to the winning lead so the conversation never orphans.
      const [winner] = await db
        .select({ leadId: leadIdentities.leadId })
        .from(leadIdentities)
        .where(
          and(
            eq(leadIdentities.channel, channel),
            eq(leadIdentities.externalId, externalId)
          )
        )
        .limit(1);
      if (winner && winner.leadId !== leadId) {
        await linkConversationToLead(winner.leadId, input);
        if (createdLeadId != null) {
          if (phone) {
            // The losing shell carries a phone identifier: deleting it would
            // discard a matchable lead. Keep it and clear the duplicate
            // conversation stamp so only the identity winner points here.
            await db
              .update(leads)
              .set({ conversationId: null })
              .where(eq(leads.id, createdLeadId));
          } else {
            // Phone-less shell created milliseconds ago: it can hold no
            // identities/orders/attachments yet, so drop it instead of
            // leaving a second lead stamped on one conversation. A
            // pre-existing lead (phone fallback) is never deleted.
            await db.delete(leads).where(eq(leads.id, createdLeadId));
          }
        }
      }
    }
  } catch (err) {
    console.warn(
      `[leads] ensureLeadIdentity failed for ${channel}:${externalId}:`,
      err
    );
  }
}
