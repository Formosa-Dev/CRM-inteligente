export type BoundarySignal = "commercial" | "personal" | "ambiguous";
export type SessionMode = "commercial" | "personal_acknowledged" | "handed_off";
export type SessionEventType =
  | "commercial_detected"
  | "personal_acknowledged"
  | "ambiguous_clarified"
  | "handoff_requested";

export type CommercialIntent = "catalog" | "order" | "delivery" | "support" | "other";
export type PendingQuestion = "unit_or_dozen" | "delivery_time" | "address" | "payment" | "other";
export type AssetKind = "image" | "audio" | "document" | "video";

export type CommercialFacts = {
  intent?: CommercialIntent;
  pendingQuestion?: PendingQuestion;
  hasActiveOrder?: boolean;
  activeOrderId?: number;
  hasActiveCart?: boolean;
  hasAddressReference?: boolean;
  recentAssetKinds?: AssetKind[];
};

export type ConversationSessionState = {
  conversationId: number;
  version: number;
  policyVersion: number;
  episode: number;
  mode: SessionMode;
  ackSent: boolean;
  clarificationSent: boolean;
  commercialIntent: CommercialIntent | null;
  pendingQuestion: PendingQuestion | null;
  hasActiveOrder: boolean;
  activeOrderId: number | null;
  hasActiveCart: boolean;
  hasAddressReference: boolean;
  recentAssetKinds: AssetKind[];
};

export type SessionContext = Omit<ConversationSessionState, "conversationId" | "version" | "policyVersion" | "episode" | "mode" | "ackSent" | "clarificationSent">;

export type RoutingDecision =
  | { kind: "allow_agent"; state: ConversationSessionState; eventType: SessionEventType }
  | { kind: "fixed_ack" | "fixed_clarification"; delivery: "allowed" | "suppressed"; state: ConversationSessionState; eventType: SessionEventType }
  | { kind: "blocked"; reason: "override" | "handed_off"; state: ConversationSessionState; eventType: SessionEventType }
  | { kind: "duplicate"; state: ConversationSessionState; eventType: SessionEventType };

export type SessionPolicyInput = {
  signal: BoundarySignal;
  messageId: string;
  hasHumanOverride?: boolean;
  commercialFacts?: CommercialFacts;
  delivery?: "allowed" | "suppressed";
};

const COMMERCIAL_PATTERN = /\b(pedido|orden|comprar|compra|precio|precios|menu|menú|catalogo|catálogo|delivery|envio|envío|presupuesto|stock|disponible|promoci[oó]n)\b/i;
const PERSONAL_PATTERN = /\b(c[oó]mo est[aá]s|todo bien|te extra[nñ]o|feliz cumple|buen d[ií]a|buenas noches|amor)\b/i;
const PERMITTED_CONTEXT_KEYS = new Set([
  "commercialIntent", "pendingQuestion", "hasActiveOrder", "activeOrderId", "hasActiveCart", "hasAddressReference", "recentAssetKinds",
]);

export function classifyBoundary(input: { text: string; messageType: string; hasActiveOrder: boolean }): BoundarySignal {
  if (input.hasActiveOrder || COMMERCIAL_PATTERN.test(input.text)) return "commercial";
  if (input.messageType === "text" && PERSONAL_PATTERN.test(input.text)) return "personal";
  return "ambiguous";
}

export function createInitialSessionState(conversationId: number): ConversationSessionState {
  return {
    conversationId, version: 0, policyVersion: 1, episode: 0, mode: "commercial", ackSent: false, clarificationSent: false,
    commercialIntent: null, pendingQuestion: null, hasActiveOrder: false, activeOrderId: null, hasActiveCart: false,
    hasAddressReference: false, recentAssetKinds: [],
  };
}

/** Only compact commercial references and flags may cross the repository/LLM boundary. */
export function assertSessionContext(value: unknown): SessionContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Session context is not permitted");
  const context = value as Record<string, unknown>;
  for (const key of Object.keys(context)) {
    if (!PERMITTED_CONTEXT_KEYS.has(key)) throw new Error(`Session context field ${key} is not permitted`);
  }
  if (context.commercialIntent !== undefined && typeof context.commercialIntent !== "string") throw new Error("Session context is not permitted");
  if (context.pendingQuestion !== undefined && typeof context.pendingQuestion !== "string") throw new Error("Session context is not permitted");
  if (context.hasActiveOrder !== undefined && typeof context.hasActiveOrder !== "boolean") throw new Error("Session context is not permitted");
  if (context.activeOrderId !== undefined && (!Number.isInteger(context.activeOrderId) || (context.activeOrderId as number) < 1)) throw new Error("Session context is not permitted");
  if (context.hasActiveCart !== undefined && typeof context.hasActiveCart !== "boolean") throw new Error("Session context is not permitted");
  if (context.hasAddressReference !== undefined && typeof context.hasAddressReference !== "boolean") throw new Error("Session context is not permitted");
  if (context.recentAssetKinds !== undefined && (!Array.isArray(context.recentAssetKinds) || context.recentAssetKinds.some((kind) => typeof kind !== "string"))) throw new Error("Session context is not permitted");
  return Object.fromEntries(Object.entries(context).filter(([, entry]) => entry !== undefined)) as SessionContext;
}

export function toSessionContext(state: ConversationSessionState): SessionContext {
  return assertSessionContext({
    commercialIntent: state.commercialIntent ?? undefined,
    pendingQuestion: state.pendingQuestion ?? undefined,
    hasActiveOrder: state.hasActiveOrder,
    activeOrderId: state.activeOrderId ?? undefined,
    hasActiveCart: state.hasActiveCart,
    hasAddressReference: state.hasAddressReference,
    recentAssetKinds: [...state.recentAssetKinds],
  });
}

function applyCommercialFacts(state: ConversationSessionState, facts: CommercialFacts | undefined): ConversationSessionState {
  if (!facts) return state;
  const permitted = assertSessionContext({
    commercialIntent: facts.intent,
    pendingQuestion: facts.pendingQuestion,
    hasActiveOrder: facts.hasActiveOrder,
    activeOrderId: facts.activeOrderId,
    hasActiveCart: facts.hasActiveCart,
    hasAddressReference: facts.hasAddressReference,
    recentAssetKinds: facts.recentAssetKinds,
  });
  return {
    ...state,
    commercialIntent: permitted.commercialIntent ?? state.commercialIntent,
    pendingQuestion: permitted.pendingQuestion ?? state.pendingQuestion,
    hasActiveOrder: permitted.hasActiveOrder ?? state.hasActiveOrder,
    activeOrderId: permitted.activeOrderId ?? state.activeOrderId,
    hasActiveCart: permitted.hasActiveCart ?? state.hasActiveCart,
    hasAddressReference: permitted.hasAddressReference ?? state.hasAddressReference,
    recentAssetKinds: permitted.recentAssetKinds ? [...permitted.recentAssetKinds] : state.recentAssetKinds,
  };
}

function nextState(state: ConversationSessionState, changes: Partial<ConversationSessionState>): ConversationSessionState {
  return { ...state, ...changes, version: state.version + 1 };
}

export function transitionSession(state: ConversationSessionState, input: SessionPolicyInput): RoutingDecision {
  if (input.hasHumanOverride) return { kind: "blocked", reason: "override", state, eventType: "handoff_requested" };

  // Commercial intent always reaches the agent — even in legacy handed_off
  // conversations, which revive on their next message instead of staying dead.
  if (input.signal === "commercial") {
    const updated = nextState(applyCommercialFacts(state, input.commercialFacts), {
      mode: "commercial", ackSent: false, clarificationSent: false, episode: state.episode + (state.ackSent || state.clarificationSent ? 1 : 0),
    });
    return { kind: "allow_agent", state: updated, eventType: "commercial_detected" };
  }

  const delivery = input.delivery ?? "allowed";
  if (input.signal === "personal" && !state.ackSent && !state.clarificationSent) {
    return { kind: "fixed_ack", delivery, state: nextState(state, { mode: "personal_acknowledged", ackSent: true }), eventType: "personal_acknowledged" };
  }
  if (input.signal === "ambiguous" && !state.ackSent && !state.clarificationSent) {
    return { kind: "fixed_clarification", delivery, state: nextState(state, { clarificationSent: true }), eventType: "ambiguous_clarified" };
  }

  // Non-commercial follow-ups go to the agent — it should always answer rather
  // than permanently handing the conversation off to a human.
  return { kind: "allow_agent", state: nextState(state, { mode: "commercial" }), eventType: "commercial_detected" };
}

export type SessionPolicyRepository = {
  withConversationLock<T>(conversationId: number, work: () => Promise<T>): Promise<T>;
  load(conversationId: number): Promise<ConversationSessionState | null>;
  findEvent(conversationId: number, inboundMessageId: string): Promise<{ eventType: SessionEventType; signal: BoundarySignal } | null>;
  saveTransition(input: { state: ConversationSessionState; expectedVersion: number; inboundMessageId: string; eventType: SessionEventType; signal: BoundarySignal }): Promise<"saved" | "duplicate" | "conflict">;
};

/** Database adapters must atomically lock, compare-and-swap, and insert the unique inbound event. */
export class SessionPolicyService {
  constructor(private readonly repository: SessionPolicyRepository) {}

  async decide(conversationId: number, input: SessionPolicyInput): Promise<RoutingDecision> {
    return this.repository.withConversationLock(conversationId, async () => {
      const seen = await this.repository.findEvent(conversationId, input.messageId);
      if (seen) {
        const state = await this.repository.load(conversationId) ?? createInitialSessionState(conversationId);
        return { kind: "duplicate", state, eventType: seen.eventType };
      }
      const state = await this.repository.load(conversationId) ?? createInitialSessionState(conversationId);
      const decision = transitionSession(state, input);
      const result = await this.repository.saveTransition({ state: decision.state, expectedVersion: state.version, inboundMessageId: input.messageId, eventType: decision.eventType, signal: input.signal });
      if (result === "duplicate") {
        const raced = await this.repository.findEvent(conversationId, input.messageId);
        const current = await this.repository.load(conversationId) ?? decision.state;
        return { kind: "duplicate", state: current, eventType: raced?.eventType ?? decision.eventType };
      }
      if (result === "conflict") throw new Error("Conversation session compare-and-swap conflict");
      return decision;
    });
  }
}
