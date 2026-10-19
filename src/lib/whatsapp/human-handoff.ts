/**
 * Idempotent handoff effect claims (SDD memoria-persistente-sesion-whatsapp, PR 3).
 *
 * One transaction coordinates the handoff side effects: the human override,
 * the owner notification, and the customer reply. Every effect is claimed
 * through `conversation_session_effect_claims`, which is unique per
 * (conversation, episode, effect) and per (conversation, inbound, effect),
 * so retries and concurrent deliveries are harmless: at most one override,
 * one owner notification, and one customer reply per episode/message.
 *
 * Claims are durable even when AI is disabled; customer delivery is then
 * suppressed while the claim itself persists. Only boundary references
 * (conversation id, episode, effect kind, inbound id) are stored — never
 * message text, PII, prompts, or media payloads.
 */
import { db } from "@/db";
import { conversationSessionEffectClaims } from "@/db/schema";
import { providerForChannel } from "@/lib/messaging/registry";
import type { ChannelKind } from "@/lib/messaging/types";

export type HandoffEffectKind = "human_override" | "owner_notification" | "customer_reply";

export type HandoffClaimInput = {
  conversationId: number;
  episode: number;
  inboundMessageId: string;
  aiEnabled: boolean;
};

export type HandoffClaimResult = {
  overrideClaimed: boolean;
  ownerNotificationClaimed: boolean;
  customerReplyClaimed: boolean;
  /** The owner is always notified on a fresh handoff, even with AI disabled. */
  ownerNotificationDeliverable: boolean;
  /** Customer replies are only delivered when AI is enabled. */
  customerReplyDeliverable: boolean;
};

export type ClaimOutcome = "claimed" | "duplicate";

export interface HandoffEffectRepository {
  claimEffect(input: {
    conversationId: number;
    episode: number;
    effectKind: HandoffEffectKind;
    inboundMessageId: string;
  }): Promise<ClaimOutcome>;
}

export interface HandoffEffectClaimant {
  claimHandoffEffects(input: HandoffClaimInput): Promise<HandoffClaimResult>;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  if (record.code === "23505") return true;
  const message = record.message;
  if (typeof message === "string" && /duplicate key|unique constraint|already exists/i.test(message)) return true;
  const cause = (record.cause ?? record.error) as unknown;
  if (cause && typeof cause === "object") {
    const nested = cause as Record<string, unknown>;
    if (nested.code === "23505") return true;
    if (typeof nested.message === "string" && /duplicate key|unique constraint/i.test(nested.message)) return true;
  }
  return false;
}

const HANDOFF_EFFECTS: readonly HandoffEffectKind[] = [
  "human_override",
  "owner_notification",
  "customer_reply",
];

/** Pure delivery gate: a claimed customer reply may only go out when AI is enabled. */
export function resolveHandoffDelivery(input: { aiEnabled: boolean; replyClaimed: boolean }): boolean {
  return input.aiEnabled && input.replyClaimed;
}

export type HandoffTransportInput = {
  notifyClaim: boolean;
  replyClaim: boolean;
  delivery: "allowed" | "suppressed";
  /**
   * Conversation channel the decision is computed for. Defaults to
   * "whatsapp" so legacy callers keep identical semantics.
   */
  channel?: ChannelKind;
};

export type HandoffTransportKind =
  /** Channel is delivered through a registered messaging provider. */
  | "messenger"
  /** Channel is delivered by an internal bot (telegram) — not a provider. */
  | "internal-bot"
  /** Channel has no registered provider — customer delivery fails closed. */
  | "unavailable";

export type HandoffTransportDecision = {
  /** Persist humanOverrideUntil (24h) — only on a fresh override claim. */
  writeOverride: boolean;
  /** Notify the owner (escalation email/Telegram) — only on a fresh claim. */
  sendOwnerNotification: boolean;
  /** Reply to the customer — only on a fresh claim while AI is enabled. */
  sendCustomerReply: boolean;
  /** Channel the decision was computed for (input or "whatsapp" default). */
  channel: ChannelKind;
  /** Which delivery surface the customer-side effects use. */
  transport: HandoffTransportKind;
};

/**
 * Pure webhook handoff-transport gate (SDD memoria-persistente-sesion-whatsapp,
 * W2; generalized channel-agnostic in S15). Claims are at-most-once per
 * episode/message; the transport follows the same rule: a duplicate claim
 * transports nothing. The owner side stays deliverable even with AI disabled;
 * the customer reply is suppressed until the AI routing flag is enabled, so
 * closing this gap never sends to the customer while the IA stays off.
 *
 * The channel only affects the customer-reply surface: the override write and
 * the owner notification are channel-independent. WhatsApp resolves to
 * "messenger" (bubbles/format unchanged); telegram to "internal-bot"; a
 * channel with no registered provider resolves to "unavailable" and the
 * customer reply stays suppressed — fail closed, never a silent misroute.
 */
export function resolveHandoffTransport(input: HandoffTransportInput): HandoffTransportDecision {
  const channel = input.channel ?? "whatsapp";
  const transport: HandoffTransportKind =
    channel === "telegram"
      ? "internal-bot"
      : providerForChannel(channel)
        ? "messenger"
        : "unavailable";
  return {
    writeOverride: input.notifyClaim,
    sendOwnerNotification: input.notifyClaim,
    sendCustomerReply:
      input.replyClaim &&
      input.delivery === "allowed" &&
      transport !== "unavailable",
    channel,
    transport,
  };
}

export class HandoffEffectService implements HandoffEffectClaimant {
  constructor(private readonly repository: HandoffEffectRepository) {}

  async claimHandoffEffects(input: HandoffClaimInput): Promise<HandoffClaimResult> {
    const claimed = new Map<HandoffEffectKind, boolean>();
    for (const effectKind of HANDOFF_EFFECTS) {
      claimed.set(
        effectKind,
        (await this.repository.claimEffect({
          conversationId: input.conversationId,
          episode: input.episode,
          effectKind,
          inboundMessageId: input.inboundMessageId,
        })) === "claimed"
      );
    }
    const customerReplyClaimed = claimed.get("customer_reply") ?? false;
    const ownerNotificationClaimed = claimed.get("owner_notification") ?? false;
    return {
      overrideClaimed: claimed.get("human_override") ?? false,
      ownerNotificationClaimed,
      customerReplyClaimed,
      ownerNotificationDeliverable: ownerNotificationClaimed,
      customerReplyDeliverable: resolveHandoffDelivery({
        aiEnabled: input.aiEnabled,
        replyClaimed: customerReplyClaimed,
      }),
    };
  }
}

export class DrizzleHandoffEffectRepository implements HandoffEffectRepository {
  async claimEffect(input: {
    conversationId: number;
    episode: number;
    effectKind: HandoffEffectKind;
    inboundMessageId: string;
  }): Promise<ClaimOutcome> {
    try {
      await db.insert(conversationSessionEffectClaims).values({
        conversationId: input.conversationId,
        episode: input.episode,
        effectKind: input.effectKind,
        inboundMessageId: input.inboundMessageId,
      });
      return "claimed";
    } catch (error) {
      if (isUniqueViolation(error)) return "duplicate";
      throw error;
    }
  }
}
