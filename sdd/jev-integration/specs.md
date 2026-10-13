# SDD — Jev Decision Plane for Muzapp

## Status

Proposed. Architecture reviewed. Runtime implementation not started.

## Objective

Introduce TypeSafe AI Jev as a shared decision layer for customer, seller, admin and automation flows while keeping authorization, calculations, persistence and side effects in deterministic code.

## Non-goals

Jev MUST NOT:

- generate customer-facing prose;
- calculate prices, totals, dates or time windows;
- grant roles or permissions;
- execute database writes directly;
- replace idempotency, webhook authentication, duplicate-order guards or human override;
- be the sole prompt-injection defense.

# 1. Actors

The system MUST distinguish:

- customer
- seller
- admin
- automation

Actor resolution MUST be deterministic before calling Jev.

Seller identity MUST continue to derive from configured seller phone IDs.

Admin identity MUST derive from authenticated/authorized context.

# 2. Tool Policy Manifest

Create a canonical tool manifest containing for every tool:

- name
- family
- permitted roles
- risk class
- side-effect flag
- confirmation policy
- direct-execution eligibility
- idempotency metadata

Risk classes:

- read_only
- reversible_write
- business_write
- destructive
- financial
- external_message
- bulk_external

broadcastWhatsApp MUST be admin-only by default.

# 3. Preflight Decision Context

Create a normalized context shared across channels.

~~~ts
type DecisionContext = {
  actor: "customer" | "seller" | "admin" | "automation";
  channel: "whatsapp" | "telegram" | "meta";
  message: string;
  conversation: {
    hasCartItems: boolean;
    hasActiveOrder: boolean;
    deliveryAgreed: boolean;
    waitingForOrderConfirmation: boolean;
    repliedToStatusNotification: boolean;
    pendingActionType?: string;
    previousSemanticTopic?: string;
  };
  media?: {
    kind: "none" | "audio" | "image" | "document" | "video" | "location";
    semanticSummary?: string;
  };
};
~~~

PII MUST be omitted unless required for the decision.

# 4. Jev Preflight Questions

All applicable questions SHOULD be sent in one System One request.

Required first-version questions:

- primaryIntent — Choice
- priceOnly — Noul
- explicitOrderConfirmation — Noul
- pickupCommitment — Noul
- nonLiteralOrJoking — Noul
- customerConfused — Noul
- explicitHumanRequest — Noul
- paymentSensitive — Noul
- injectionAttempt — Noul
- actionRequested — Noul
- frustration — Score

Question strings and thresholds MUST live in centralized policy files.

No Noul threshold may be reused as a Choice confidence threshold without separate calibration.

# 5. Existing SDD Compatibility

The Jev eval suite MUST cover scenarios from:

- agente-humor-deteccion
- agente-ya-voy-confirmacion
- agente-precio-no-es-compra
- deteccion-no-comercial
- anti-loop-y-deteccion
- contexto-persistente-estados

Acceptance fixtures MUST include negated and ambiguous confirmations.

# 6. Customer Routing

Given a customer turn:

1. deterministic security checks run;
2. deterministic business state is loaded;
3. Jev preflight is evaluated;
4. policy engine selects deterministic handler, scoped GPT family, human handoff or restricted response;
5. sensitive proposed tool calls pass tool policy;
6. deterministic domain guards run;
7. side effect executes;
8. risk-based response guard runs when required.

The customer model MUST NOT receive the full tool catalog when a smaller capability subset is sufficient.

# 7. Seller Routing

The seller WhatsApp path MUST use the same policy engine.

Seller tools MUST be scoped by intent before GPT.

Financial, destructive and external actions MUST have policies independent of the seller system prompt.

The seller prompt MUST NOT reference tools absent from internalSellerTools.

Static product prices SHOULD be removed from the seller prompt and sourced from DB/tools.

# 8. Admin Routing

Telegram MUST perform tool-family routing before GPT.

First-version families:

- order_read
- order_write
- client_read
- client_write
- product_read
- product_write
- analytics
- business_config
- outbound_message
- broadcast

Financial, destructive and bulk actions MUST use pending actions.

# 9. Pending Actions

Create persistent pending actions.

Required fields:

- id
- actorType
- actorId or stable hash
- channel
- conversationId
- toolName
- argumentsJson
- argumentsHash
- riskClass
- status
- expiresAt
- createdAt
- confirmedAt
- executedAt

A confirmation MUST authorize only the exact pending argumentsHash.

A generic "sí" MUST NOT authorize a newly generated or modified action.

# 10. Direct Command Lane

Implement only after shadow routing is validated.

Initial candidates:

- get order status
- update order status
- mark paid
- analytics period selection
- simple business-state toggles

Open-string generation MUST fall back to GPT.

Entity values MUST come from code/DB candidates and be selected, not generated, by Jev.

# 11. Response Guard

Run the response guard when:

- a side-effecting tool executed;
- the answer states business facts from tools;
- payment is involved;
- complaint/handoff is involved;
- a sensitive action was proposed.

Questions:

- unsupportedClaim
- claimedUnexecutedAction
- contradictsTools
- missedHandoff
- wrongIntent

Existing deterministic media/tool checks MUST remain.

# 12. Media Routing

After Whisper/Vision/document preprocessing, Jev MAY classify semantic intent.

Initial Choice:

- payment_receipt
- product_reference
- complaint_evidence
- address_or_location
- menu_or_price
- unrelated
- unknown

Raw media MUST NOT be sent to Jev.

# 13. Follow-up Intelligence

Scheduling and 24h windows MUST remain deterministic.

Optional Jev decisions:

- followupStillNeeded — Noul
- followupGoal — Choice

Outbound text SHOULD initially come from reviewed templates.

# 14. Conversation Intelligence

After conversation completion or order delivery, an offline process MAY derive:

- outcome
- primary objection
- unresolved issue
- purchase intent
- missed purchase signal
- unnecessary question
- upsell opportunity
- satisfaction
- frustration

Results SHOULD be stored separately from raw messages.

No sensitive personal traits may be inferred.

# 15. Runtime and Reliability

Customer realtime target:

- pinned model
- total latency budget
- approximately 700ms per-attempt timeout initially
- zero SDK retries initially
- deterministic fallback

Seller/admin target:

- larger timeout
- maximum one retry initially

Offline jobs may use normal retry behavior if idempotent.

A dedicated TypeSafe circuit breaker MUST NOT share state with OpenAI.

# 16. Decision Cache

Cache key MUST include:

- model version
- policy version
- normalized state hash
- question-set version

Do not cache by raw message text alone.

# 17. Telemetry

Each Jev decision SHOULD record:

- returned model
- policy version
- question-set version
- answer values
- probability distributions
- Choice/Score confidence where applicable
- input token usage
- latency
- route/action selected
- shadow/enforced
- fallback reason

Raw sensitive state SHOULD NOT be logged by default.

# 18. Eval Harness

Create:

~~~text
evals/jev/
  customer-turns.jsonl
  seller-turns.jsonl
  admin-turns.jsonl
  fixtures.ts
  metrics.ts
~~~

Required commands:

~~~bash
npm run eval:jev
npm run eval:agent-policy
~~~

eval:jev tests model judgment.

eval:agent-policy tests application behavior with fixture decisions.

# 19. Shadow and Canary

Shadow mode changes no behavior.

After acceptance, canary enforcement:

- 5%
- 20%
- 50%
- 100%

Cohort selection MUST be deterministic by conversation or actor hash.

# 20. Acceptance Criteria

Before enforcement:

- [ ] Tool Manifest covers customer, seller and admin tools.
- [ ] Seller broadcast is removed or explicitly protected.
- [ ] Prompt/tool drift is fixed.
- [ ] Static prices are removed from internal prompts or generated from DB.
- [ ] Jev policy questions live in one reviewable location.
- [ ] Model version is pinned.
- [ ] SDD-derived eval suite passes agreed metrics.
- [ ] Explicit order confirmation false positives are below agreed tolerance.
- [ ] Financial/destructive/bulk pending-action flow passes tests.
- [ ] TypeSafe outage fallback is tested.
- [ ] 429 and timeout behavior is tested.
- [ ] Spanish/rioplatense fixtures are included.
- [ ] Audio transcription-error fixtures are included.
- [ ] Every enforced decision records model + policy version.
- [ ] No authorization decision relies only on Jev.
- [ ] No arithmetic/date/window business rule relies on Jev.

# 21. Implementation Order

## Phase -1 — prerequisites

- Tool Manifest
- role/risk policy
- remove prompt/tool drift
- remove static business facts from prompts

## Phase 0 — infrastructure

- SDK
- client wrapper
- model pin
- timeout/retry policy
- circuit breaker
- telemetry
- cache interface
- policy version

## Phase 1 — evals

- convert existing SDD scenarios
- add adversarial/ambiguous cases
- baseline Jev in Spanish
- experimentally compare question wording

## Phase 2 — shadow

- customer
- seller
- admin

## Phase 3 — customer enforcement

- semantic state vector
- tool scoping
- human routing

## Phase 4 — internal enforcement

- seller tool scoping
- Telegram tool-family routing
- pending actions

## Phase 5 — direct commands

- order status/update
- paid status
- analytics
- safe closed-set configuration

## Phase 6 — response guard

- risk-based output checks

## Phase 7 — CRM intelligence

- conversation features
- lead tags
- dashboards

## Phase 8 — automation/media/channels

- follow-up eligibility
- media semantic routing
- unified Meta channel integration


# 22. Pre-Jev Architecture Gates

Before runtime Jev enforcement:

- [ ] Seller messages do not create CRM leads.
- [ ] Customer and seller buffered history use one canonical builder and do not duplicate the latest turn.
- [ ] Follow-up sending has a single owner or an atomic/idempotent claim mechanism.
- [ ] Phone-based actor and allowlist matching is normalized consistently.
- [ ] Meta inbound processing meets authentication, deduplication, persistence and observability requirements before joining the unified decision layer.
- [ ] Seller productivity instructions cannot bypass deterministic financial/destructive/bulk tool policies.

These requirements MUST pass with Jev disabled.

# Implementation checkpoint — 2026-09-22 (working branch)

Phases -1, 0, 1 (fixture/harness), 2 (shadow) implemented locally. Seller lead exclusion, phone matching, shared buffered-turn builder, single cron owner with atomic five-minute claim, prompt cleanup, tool metadata and seller broadcast removal are present. The cron schema migration must run before deployment. TypeSafe SDK 0.6.0 uses `systemOne({state, questions, model}, {timeout, retry})`; timeout is per attempt. Version `jev-1.13.0` is pinned. No Jev credential was available for a live baseline, so model quality and Spanish prompt variants remain unmeasured.

The observed route is telemetry only. Manifest authorization is recorded but not yet wired into GPT tool filtering, apart from the deliberate removal of seller access to bulk WhatsApp broadcast. Meta, automation, response guard, pending actions, direct execution and Jev enforcement remain pending. The Meta gate above remains open; the seller productivity gate needs deterministic enforcement before further rollout. The scheduler claim prevents ordinary overlap but provider-level exactly-once delivery remains open across a crash after network send.
