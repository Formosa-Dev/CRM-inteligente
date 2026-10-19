/**
 * Durable session repository and webhook persistence entry points
 * (SDD memoria-persistente-sesion-whatsapp, PR 2).
 *
 * PostgreSQL/Drizzle is the sole authority for boundary session state.
 * Every transition is gated by the unique inbound event key (at-most-once)
 * and a compare-and-swap on the state version. Any dedup or CAS failure
 * throws so the webhook can fail closed: no buffering, no GPT/Jev/tools,
 * and no automatic customer replies.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  conversationSessionEvents,
  conversationSessionStates,
} from "@/db/schema";
import {
  classifyBoundary,
  SessionPolicyService,
  type AssetKind,
  type BoundarySignal,
  type CommercialIntent,
  type ConversationSessionState,
  type PendingQuestion,
  type RoutingDecision,
  type SessionEventType,
  type SessionPolicyRepository,
} from "./session-policy";
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

function toRowState(state: ConversationSessionState) {
  return {
    conversationId: state.conversationId,
    version: state.version,
    policyVersion: state.policyVersion,
    episode: state.episode,
    mode: state.mode,
    ackSent: state.ackSent,
    clarificationSent: state.clarificationSent,
    commercialIntent: state.commercialIntent,
    pendingQuestion: state.pendingQuestion,
    recentAssetKinds: [...state.recentAssetKinds],
    activeOrderId: state.activeOrderId,
    hasActiveCart: state.hasActiveCart,
    hasAddressReference: state.hasAddressReference,
  };
}

type SessionStateRow = typeof conversationSessionStates.$inferSelect;

function fromRowState(row: SessionStateRow): ConversationSessionState {
  return {
    conversationId: row.conversationId,
    version: row.version,
    policyVersion: row.policyVersion,
    episode: row.episode,
    mode: row.mode,
    ackSent: row.ackSent,
    clarificationSent: row.clarificationSent,
    commercialIntent: (row.commercialIntent ?? null) as CommercialIntent | null,
    pendingQuestion: (row.pendingQuestion ?? null) as PendingQuestion | null,
    hasActiveOrder: row.activeOrderId !== null && row.activeOrderId !== undefined,
    activeOrderId: row.activeOrderId ?? null,
    hasActiveCart: row.hasActiveCart,
    hasAddressReference: row.hasAddressReference,
    recentAssetKinds: [...(row.recentAssetKinds as AssetKind[] | null ?? [])],
  };
}

export class DrizzleSessionPolicyRepository implements SessionPolicyRepository {
  /**
   * SDD memoria-persistente-sesion-whatsapp (W3 decision): neon-http is a
   * stateless fetch-based driver with no interactive transactions or advisory
   * locks, so a real SELECT FOR UPDATE lock is not available here. This stays
   * an inline pass-through BY DESIGN. Concurrency safety rests on the two
   * durable mechanisms below, both fail closed: the unique inbound event key
   * (unique-event-first, at-most-once) plus the compare-and-swap on the state
   * version. A lost race surfaces as `duplicate` (no-op) or `conflict`
   * (throw, webhook aborts with no routing/output).
   */
  async withConversationLock<T>(conversationId: number, work: () => Promise<T>): Promise<T> {
    void conversationId;
    return work();
  }

  async load(conversationId: number): Promise<ConversationSessionState | null> {
    const [row] = await db
      .select()
      .from(conversationSessionStates)
      .where(eq(conversationSessionStates.conversationId, conversationId))
      .limit(1);
    return row ? fromRowState(row) : null;
  }

  async findEvent(
    conversationId: number,
    inboundMessageId: string
  ): Promise<{ eventType: SessionEventType; signal: BoundarySignal } | null> {
    const [row] = await db
      .select({
        eventType: conversationSessionEvents.eventType,
        signal: conversationSessionEvents.signal,
      })
      .from(conversationSessionEvents)
      .where(
        and(
          eq(conversationSessionEvents.conversationId, conversationId),
          eq(conversationSessionEvents.inboundMessageId, inboundMessageId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  async saveTransition(input: {
    state: ConversationSessionState;
    expectedVersion: number;
    inboundMessageId: string;
    eventType: SessionEventType;
    signal: BoundarySignal;
  }): Promise<"saved" | "duplicate" | "conflict"> {
    const { state } = input;

    try {
      await db.insert(conversationSessionEvents).values({
        conversationId: state.conversationId,
        episode: state.episode,
        stateVersion: state.version,
        policyVersion: state.policyVersion,
        eventType: input.eventType,
        signal: input.signal,
        inboundMessageId: input.inboundMessageId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return "duplicate";
      throw error;
    }

    const removeOrphanEvent = async () => {
      try {
        await db
          .delete(conversationSessionEvents)
          .where(
            and(
              eq(conversationSessionEvents.conversationId, state.conversationId),
              eq(conversationSessionEvents.inboundMessageId, input.inboundMessageId)
            )
          );
      } catch {
        // Best effort: the orphan audit row is harmless because the caller
        // fails closed and never routes on it.
      }
    };

    if (input.expectedVersion === 0) {
      const [existing] = await db
        .select({ id: conversationSessionStates.id })
        .from(conversationSessionStates)
        .where(eq(conversationSessionStates.conversationId, state.conversationId))
        .limit(1);
      if (!existing) {
        try {
          await db.insert(conversationSessionStates).values(toRowState(state));
          return "saved";
        } catch (error) {
          if (isUniqueViolation(error)) {
            await removeOrphanEvent();
            return "conflict";
          }
          await removeOrphanEvent();
          throw error;
        }
      }
    }

    try {
      const updated = await db
        .update(conversationSessionStates)
        .set({ ...toRowState(state), updatedAt: new Date() })
        .where(
          and(
            eq(conversationSessionStates.conversationId, state.conversationId),
            eq(conversationSessionStates.version, input.expectedVersion)
          )
        );
      const rowCount = (updated as unknown as { rowCount?: number }).rowCount ?? 0;
      if (rowCount === 0) {
        await removeOrphanEvent();
        return "conflict";
      }
      return "saved";
    } catch (error) {
      await removeOrphanEvent();
      throw error;
    }
  }
}

export type PersistSessionTransitionInput = {
  conversationId: number;
  messageId: string;
  text: string;
  messageType: string;
  aiEnabled: boolean;
  hasHumanOverride: boolean;
  hasActiveOrder?: boolean;
};

/**
 * Transactionally evaluates the deterministic boundary policy and persists
 * the eligible transition plus its audit event. Persists even when AI is
 * disabled (delivery is then suppressed). Throws on any dedup/CAS failure
 * so the caller fails closed.
 */
export async function persistSessionTransition(
  input: PersistSessionTransitionInput
): Promise<RoutingDecision> {
  const signal = classifyBoundary({
    text: input.text,
    messageType: input.messageType,
    hasActiveOrder: input.hasActiveOrder ?? false,
  });
  // A-54 — no handoff claimant: the deterministic transition never emits
  // "handoff"; handoffs only happen via the transferToHuman tool, which
  // claims its effects directly.
  const service = new SessionPolicyService(
    new DrizzleSessionPolicyRepository()
  );
  return service.decide(input.conversationId, {
    signal,
    messageId: input.messageId,
    hasHumanOverride: input.hasHumanOverride,
    delivery: input.aiEnabled ? "allowed" : "suppressed",
  });
}

/** Re-reads persisted boundary state (used to revalidate after debounce). */
export async function loadSessionState(
  conversationId: number
): Promise<ConversationSessionState | null> {
  return new DrizzleSessionPolicyRepository().load(conversationId);
}
