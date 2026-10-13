# Muzapp AI Runtime Inventory

Exploration-only inventory of the Muzapp AI execution/runtime stack, written to guide its replication in **AH Sports**.
Repo: `muzapp` (branch `ai-runtime-inventory`, tip `b5755f0`). Stack: Next.js 16 App Router, React 19, TypeScript, Drizzle ORM (`neon-http`), PostgreSQL, NextAuth v5, Vercel AI SDK v6 (`ai`), Zod v4, Upstash Redis, YCloud (WhatsApp), Telegram Bot API, Cloudinary.
Method: codebase-memory MCP index (7318 nodes / 11734 edges) + direct reads. No product code changed.

Legend: **[P]** = reusable platform feature (channel/agent/infra-agnostic), **[M]** = Muzzarella/rotisería-specific business logic or copy.

---

## 1. Architecture at a glance

```
YCloud WhatsApp ─┐
Telegram Bot    ─┼─► inbound webhook routes ─► gates ─► BufferManager (Redis|memory, debounce)
Meta (stub)     ─┘                                   └─► session boundary state machine (Postgres)
                                                          └─► runWhatsAppAgent / Telegram generateText
Meta Ads / web ─► /api/checkout ─► orders ────────────────┘  (Vercel AI SDK + tools)
Admin/server actions ─► orders, config, cash, reconcile
Cron (/api/cron/*) + instrumentation scheduler ─► followup + reconcile deep-pass (LLM)
```

Layers: `app` (routes/UI) → `lib` (core) → `db` (schema). `lib` fan-in 292, `app` fan-out 312. Hot symbols: `where` (`lib/whatsapp/prompt-builder.ts`, fan-in 113), `log` (`lib/logger.ts`, 97), `requireAdmin` (`lib/auth/require-admin.ts`, 37), `normalizePhone` (20).

---

## 2. Inbound channels

### 2.1 WhatsApp — YCloud
- **Canonical route:** `src/app/api/whatsapp/webhook/route.ts` (`GET` verification, `POST` messages/events).
- **Legacy alias:** `src/app/api/webhook/whatsapp/route.ts` re-exports `{ GET, POST }` from the canonical route (same pipeline).
- Signature: `ycloud-signature` header `t=<ts>,s=<hmac>`; HMAC-SHA256 over `` `${t}.${rawBody}` `` with `YCLOUD_WEBHOOK_SECRET`, constant-time compare, 300s anti-replay — `lib/whatsapp/signature.ts:verifyYCloudSignature`.
- Outbound send: `POST https://api.ycloud.com/v2/whatsapp/messages/sendDirectly` with `X-API-Key` — `lib/whatsapp/ycloud-client.ts:sendWhatsAppMessage`. Images/docs: `lib/ycloud.ts` (`sendImage`, `sendDocument`, `sendText`).
- **Inbound payload (incoming):** `{ type: "whatsapp.inbound_message.received", whatsappInboundMessage: { type: "text|image|audio|document|video|location", id, from, customerProfile?.name, text.body?, image/audio/document/video?: { id, caption?, filename?, voice? }, location?: { latitude, longitude, name, address } } }`.
- **Echo events (outgoing from Business App):** `whatsapp.message.echo`, `whatsapp.smb.message.echoes` — `handleEcho()` at `route.ts:73`. Human echo sets `conversations.humanOverrideUntil = now+2h`; own-AI echo is deduped only.
- **Delivery number:** messages from `agent_config.deliveryPhoneNumber` route to `handleDeliveryNotification()` → `notifyCustomerDeliveryArrived()`.

### 2.2 Telegram
- **Route:** `src/app/api/telegram/webhook/[token]/route.ts`. Token compared with `timingSafeEqual` against `agent_config.telegramWebhookToken` (DB) or `TELEGRAM_WEBHOOK_TOKEN`. Disabled → 503; rate limited by IP.
- Config resolution: `lib/telegram/bot.ts:getTelegramConfigFromDB` (DB first, env fallback) → `{ botToken, webhookToken, allowedChatIds[], enabled }`. Token stored encrypted.
- **Payload:** Telegram `Update` (`lib/telegram/bot.ts:TelegramUpdate`) with `message.{text,voice,audio,photo[],document,video,caption,chat,from,message_id,date}`.
- Allowlist gate: `isChatAuthorized(chatId, allowedChatIds)` **fails closed** on empty allowlist — runs **before** any media/Whisper/vision work.
- Server-side (non-webhook) handler: `lib/telegram/handler.ts:handleTelegramUpdate` (used by non-route callers).

### 2.3 Meta (WhatsApp Cloud API) — stub
`src/app/api/meta/webhook/route.ts`: GET verify (`hub.verify_token` == `META_WEBHOOK_VERIFY_TOKEN`, fails closed), POST HMAC-SHA256 `x-hub-signature-256`. Only persists `messages` into a conversation; `// TODO: Process with agent` — **no agent wiring yet**.
OAuth callback: `src/app/api/meta/callback/route.ts`, `lib/meta/oauth.ts`, `lib/meta/config.ts`.

### 2.4 Actor resolution **[P]**
`lib/whatsapp/actor.ts:resolveWhatsAppActor(phone, { deliveryPhoneNumber, sellerPhoneIds })` → `"delivery" | "seller" | "customer"`. Priority: delivery → seller → customer. `shouldCaptureLead(actor)` = only customers. Comparison canonicalizes digits (`lib/phone-utils.ts:phoneMatches/phoneInList`).

---

## 3. Webhook processing pipeline (WhatsApp POST) — exact gate order

`src/app/api/whatsapp/webhook/route.ts:POST`:

1. Read raw body → verify YCloud signature (401 if missing/bad secret).
2. **`isProtocolArtifact(payload)`** (`lib/whatsapp/webhook-pipeline.ts`) → 200 no-op for empty Business echoes and delivery/status events (no lookup/mutation/routing/reply). Non-empty echoes fall through.
3. Echo event types → `handleEcho`.
4. Non-`whatsapp.inbound_message.received` → 200.
5. Type whitelist `["text","image","audio","document","video","location"]`.
6. **Durable dedup:** `isMessageDuplicate(messageId)` *before* any conversation lookup; dedup failure → fail closed (200, no output).
7. `normalizePhone(customerPhone)`; per-phone rate limit `wa-inbound:<digits>` (`lib/infra/rate-limit.ts`, 200 always so YCloud won't retry-storm).
8. Load `agent_config` id=1 (always, even if AI off), decrypt `ycloudApiKey`.
9. Actor detection → delivery branch / allowlist gate (`allowedPhoneIds`) / seller flag.
10. `findOrCreateConversation("whatsapp", customerPhone, name, customerPhone)` (`lib/channels/router.ts`).
11. `captureLeadIfNew` (best-effort; failure never kills pipeline) — only if actor=customer.
12. Auto-reply 24h (first contact, AI on, `autoReply24h`, not web-redirect).
13. Persist inbound + build `agentText`/`contentAttributes`/`policyText` per type:
    - location → `addresses` insert + `leads.address` update (fire-and-forget).
    - text → `insertMessage`.
    - media → `downloadYCloudMedia` → `saveMediaLocally` → per-type: audio→Whisper, image/image-doc→vision race, video→`analyzeVideo`, doc→`extractDocumentText`.
    - `policyText` is only non-empty for text or caption — contentless media never drives the session machine.
14. **Web-order redirect** (first msg, config on) → deterministic reply + return.
15. **`persistSessionTransition`** (`lib/whatsapp/session-store.ts`) for classifiable customer input even when AI off. Duplicate → return; `fixed_ack`/`fixed_clarification` → fixed reply (only if `delivery === "allowed"`) then return; `blocked`/`handoff` → `deliverWebhookHandoff` then return. **Fixed/handoff/blocked never reach buffer/GPT/tools.**
16. `resolveSessionPersistence({eligible:true, aiEnabled, dedup:"new", cas:"saved"})`; `!allowAgent` → return (message saved, session persisted, AI skipped).
17. Human override check (`checkHumanOverride`, **fails closed** on DB error → `return true`).
18. Content-level dedup (5s) → `BufferManager.enqueue("whatsapp", phone, msg)`.
19. `scheduleBufferProcessing(...)` fire-and-forget async callback (see §6): seller branch uses Telegram system prompt + `internalSellerTools`; customer branch re-validates override/handed_off/fresh-human-activity, builds history via `mergeBufferedTurn`, calls `runWhatsAppAgent`, persists reply, `sendWhatsAppBubbles`, then media (2s spacing).

Contract pinned by tests (`agent-consistency.test.ts`): protocol gate < lookup; dedup < session; session < buffer; session < agent; fixed guard < buffer/agent.

---

## 4. Session boundary state machine **[P]**

Three durable Postgres tables (`drizzle/0003_session_memory.sql`, re-shipped idempotently in `0004`). Durable reference state only — never message text/PII/prompts/media.

State (`conversation_session_states`, unique per conversation, CAS on `version`):
`{ conversationId, version, policyVersion, episode, mode: commercial|personal_acknowledged|handed_off, ackSent, clarificationSent, commercialIntent?, pendingQuestion?, recentAssetKinds[], activeOrderId?, hasActiveCart, hasAddressReference }`.

Events (`conversation_session_events`): unique `(conversation_id, inbound_message_id)` → at-most-once. `{episode, stateVersion, policyVersion, eventType, signal, inboundMessageId}`.
Effect claims (`conversation_session_effect_claims`): unique `(conversation, episode, effect_kind)` and `(conversation, inbound, effect_kind)` for `human_override | owner_notification | customer_reply`.

**`lib/whatsapp/session-policy.ts`:**
- `classifyBoundary({text,messageType,hasActiveOrder})` → `commercial` (hasActiveOrder or `COMMERCIAL_PATTERN`), `personal` (text matching `PERSONAL_PATTERN`), else `ambiguous`.
- `transitionSession(state,input)` routing:
  - `hasHumanOverride` → `blocked(override)`.
  - `commercial` → `allow_agent` (mode commercial, resets ack/clarification, increments `episode` if prior ack/clarification). Revives handed_off.
  - `personal` & first → `fixed_ack` (mode `personal_acknowledged`, ackSent).
  - `ambiguous` & first → `fixed_clarification` (clarificationSent).
  - otherwise → `allow_agent`.
- `assertSessionContext` / `formatPermittedSessionFacts` reject any non-permitted key (text/phone/name/address/payment/prompt/media) — fail closed. Only `commercialIntent, pendingQuestion, hasActiveOrder, activeOrderId, hasActiveCart, hasAddressReference, recentAssetKinds` may cross into the LLM.
- `SessionPolicyService.decide()` runs `findEvent`(dedup) → load → transition → `saveTransition` (CAS); returns `duplicate` (no-op), throws on `conflict`; on `handoff` calls `HandoffEffectService.claimHandoffEffects`.

**`lib/whatsapp/session-store.ts`:** `DrizzleSessionPolicyRepository` (note `withConversationLock` is a **documented pass-through** — neon-http has no interactive tx; concurrency rests on unique-event + CAS version). `persistSessionTransition`, `loadSessionState`, `initialSessionState`.

**`lib/whatsapp/human-handoff.ts`:** `HandoffEffectService` claims the 3 effects at-most-once; `resolveHandoffDelivery` / `resolveHandoffTransport` (owner side deliverable even with AI off; customer reply only when `delivery==="allowed"`). Used by both `transferToHuman` tool and webhook handoff.

---

## 5. Agent orchestration

### 5.1 WhatsApp sales agent **[P core + M prompt/tools]**
`src/lib/whatsapp/agent.ts:runWhatsAppAgent({conversationId, customerPhone, messages, sessionContext?, routingKind?})`:
1. If `routingKind` set and not `allow_agent` → `resolveAgentRouting(kind)` returns fixed reply/silence **before any GPT/tool** (`FIXED_ACK_REPLY`, `FIXED_CLARIFICATION_REPLY`, `HANDOFF_REPLY`; owner name from `BUSINESS_OWNER_NAME`).
2. `assertSessionContext` if provided.
3. Prompt-injection detection (`lib/whatsapp/tools/prompt-security.ts:detectInjection`).
4. Web-order reference verification: `extractWebOrderReference` → `findReferencedWebOrder(ref, checkoutPhone(phone))`; mismatch/uncertainty → fixed safe replies (no duplicate order).
5. Anti-loop directive (`lib/whatsapp/anti-loop.ts:analyzeConversationState`) + non-commercial directive (2 consecutive non-commercial → handoff).
6. Loads customer context (name, phone, lead address/tags/notes, saved addresses, product preferences from last 20 orders, last 2 orders, active `orderContextItems` cart, current Argentina hour, previous context) → `buildSystemPrompt`.
7. Model/options: `getMainChatModel()` + `getAIConfig()`. OpenAI-only `providerOptions` (`systemMessageMode:"developer"`, `parallelToolCalls:false`) sent only when `isOpenAIBaseUrl`.
8. Tool registry (30+ tools, see §8) built per-conversation via factories.
9. `generateText({ model, system, messages, tools, stopWhen: stepCountIs(10), toolChoice: attempt>1 || !isNonCommercial ? "required" : "auto" })`.
10. Hallucination guards A–D (media claims without media tools, explicit photo, no tools called, data-but-no-media) → 1 retry with force directive, then fallback reply.
11. **Phase 2:** if empty text but tool results exist → second `generateText` with `toolChoice:"auto"` (avoids leaking internal instructions).
12. Extract `pendingMedia` from media tool outputs `{_media|_batch}`.

Return `{ text, pendingMedia[] }`.

### 5.2 Telegram internal agent **[P]**
`src/app/api/telegram/webhook/[token]/route.ts` buffer callback → `generateText({ model: getMainChatModel(), system: buildTelegramPrompt(), tools: internalAgentTools, stopWhen: stepCountIs(15) })`. Regression-locked (`webhook-model.test.ts`): must use `getMainChatModel` (`.chat()`), NOT `getMainModel` (Responses API breaks DeepSeek/OpenAI-compatible).

### 5.3 Seller agent on WhatsApp **[P model, M copy]**
Inside the WhatsApp buffer callback when `actor==="seller"`: `generateText({ model: openai.chat("gpt-5.4-mini"), system: buildSellerPrompt(), tools: internalSellerTools, ... })` — replies over WhatsApp. Sellers bypass the customer boundary machine and human override.

### 5.4 Reconcile agent **[M]**
`lib/reconcile/runner.ts:runReconcile` — cron/internal scheduler deep pass over `findConversationsNeedingReconcile` (`scan.ts`, pure SQL) with `RECONCILE_SYSTEM_PROMPT` + restricted `reconcileTools`; loads delivered orders, reports candidates, notifies admins via Telegram.

---

## 6. Buffer / queue / retry / background

**Buffer [P]** — `lib/buffer/`:
- `config.ts`: `BUFFER_CONFIG` whatsapp `debounceMs:3000, lockTtlMs:300000, maxBufferSize:20`; telegram `debounceMs:8000`.
- `manager.ts`: `BufferManager` (Upstash Redis keys `buffer:`, `timer:`, `lock:`, `dedup:`) with permanent **in-memory fallback** on `redisDown`; `isContentDuplicate` (5s content dedup).
- `processor.ts`: `scheduleBufferProcessing` acquires a per-user lock, polls timer expiry (1s), `fetchAndClear`, runs callback, then graceful-interruption re-process (max depth 3, content-hash guard).
- `response-sender.ts`: `splitIntoBubbles` (≤250 chars, strips markdown/internal markers), `sendWhatsAppBubbles` / `sendTelegramBubbles` (3s inter-bubble delay + Telegram typing action).

**Queue + DLQ [P]** — `lib/queue/{producer,worker,dlq}.ts`: Redis list `queue:messages`; worker `processNextMessage` (rpop), exponential backoff `2^retry * 1000ms`, max 3 retries → `queue:dlq`; `replayDLQMessage`, `clearDLQ`. Admin route `src/app/api/admin/dlq/route.ts`. Telegram-type processing is a documented no-op.

**Circuit breaker** — `lib/infra/circuit-breaker.ts` (`threshold 5`, `cooldown 60s`); exported `openaiCircuitBreaker` (not wired into the agent call path).

**Idempotency (Telegram)** — `lib/idempotency.ts` in-memory `telegram-<chatId>-<date>`, 5-min TTL (plus DB-level `platformMessageId` dedup).

**Cron** — `src/app/api/cron/followup/route.ts` (delivered ≥30min & `followupSent=false`, atomic claim, 9–22h ART only) and `src/app/api/cron/reconcile/route.ts` (scan/sweep, overlap guard). Both auth via `CRON_SECRET` (`timingSafeEqual`, fails closed). Internal scheduler `lib/reconcile/scheduler.ts` started by `src/instrumentation.ts` only when `INTERNAL_CRON=1`.

---

## 7. Provider / model adapters **[P]**

- `src/lib/ai/models.ts`: `AI_MODEL` (default `gpt-5.4-mini`), `AI_MODEL_FAST` (`gpt-5-mini`), `AI_MODEL_VISION` (`gpt-4o`), `AI_BASE_URL` (`OPENAI_BASE_URL` default `https://api.openai.com/v1`).
- `src/lib/ai/config.ts`: DB-first (`agent_config.ai_*`, 30s cache) with env fallback; `invalidateAIConfigCache()` on admin save. `getAIProvider()` builds an OpenAI-compatible provider; `isDeepSeekBaseUrl` injects `deepseekNonThinkingFetch` (disables thinking on `/responses` and `/chat/completions` — DeepSeek rejects `tool_choice:"required"` otherwise). `getMainModel` (Responses) vs `getMainChatModel`/`getFastModel` (`.chat()`).
- Direct non-SDK calls: Whisper (`{baseUrl}/audio/transcriptions`, `whisper-1`, es) — `lib/media/transcription.ts`; vision (`{baseUrl}/chat/completions`, `ai.modelVision`, data URI) — `lib/media/vision.ts`. These are OpenAI-API-shaped only.
- Secrets decrypted via `lib/encryption.ts:decryptIfEncrypted` (AES-256-GCM, `salt:iv:authTag:cipher`, key `scrypt(AUTH_SECRET)`, tolerant of legacy plaintext).

---

## 8. Prompts and tool execution

### Prompt construction
- `lib/whatsapp/prompt-builder.ts:buildSystemPrompt` layers: `getCorePrompt` (custom `whatsappSystemPrompt` or `DEFAULT_SYSTEM_PROMPT` + admin/`whatsappInstructions`/promos/train context), `getStyleProfile` (`whatsappStyleProfile`), `getMenuData`, `getBusinessHours` (Argentina-time, midnight-crossing + B2C/B2B mode), `getProductionHours`, `getOperationalData` (kitchen/stock/alias/delivery/zones), per-conversation customer context, permitted session facts, anti-loop + non-commercial directives. Placeholders `{{TIEMPO_ESPERA}} {{BUSINESS_NAME}} {{BUSINESS_ADDRESS}} {{BUSINESS_LOCATION}}`. `DEFAULT_SYSTEM_PROMPT` = "Karen" persona **[M]**.
- `lib/telegram/prompt-builder.ts:buildTelegramPrompt` + `lib/telegram/system-prompt.ts:INTERNAL_AGENT_SYSTEM_PROMPT` **[P+M]**: business info, promos, `agentMemories`, reconcile candidates, ops radar (pending/unpaid), open cash session, menu.
- `lib/whatsapp/seller-prompt.ts:buildSellerPrompt` + `BASE_SELLER_PROMPT` **[M]** (product synonym dictionary, seller tool list).
- `lib/reconcile/prompt.ts:RECONCILE_SYSTEM_PROMPT` **[M]** with strict closure line `RESULTADO: ... | PEDIDOS: ... | NOTA: ...`.

### WhatsApp customer toolset (from `lib/whatsapp/tools/index.ts`, registry in `agent.ts`) **[M business tools on P harness]**
- Menu/products: `getMenu`, `getProductDetails`, `getProductPrice`, `searchProducts`, `getActivePromos`.
- Availability/delivery: `checkAvailability`, `checkProductAvailability`, `checkDelivery`, `getDeliveryTime`, `listAvailableProducts`, `getWaitTime`.
- Orders: `createOrder` (factory `createCreateOrderTool(conversationId, referencedWebOrderId)`), `getOrderStatus`, `addToOrder`, `updateOrder`, `cancelOrder`.
- Consulting: `suggestProducts`, `getClientHistory`.
- Ops: `getBusinessHours`, `transferToHuman` (factory `createTransferToHumanTool`), `checkKitchenStatus`, `checkPanStock`, `checkHamburguesasStock`, `saveAddress`, `getPaymentAlias`.
- Media: `sendProductImage`, `sendSticker`, `sendMenuImage`, `sendImage`, `sendDocument`, `sendPromoImage` (factories bound to conversation/phone; media pending extraction).
- Order-context: `addOrderItem`, `getOrderSummary`, `getAddresses` (factory `order-context-tools.ts`; 30-min TTL cart).
All Zod-schema'd `tool({description,inputSchema,execute})`. `prompt-security.ts:detectInjection`.

### Telegram internal toolset — `lib/telegram/tools.ts:internalAgentTools` (~60 tools) **[P+M]**
Grouped modules: `toolsQuery` (orders), `toolsClient`, `toolsProduct` (incl. create/update/delete), `toolsOrder`, `toolsManagement` (clients, analytics, hours, `updateAgentConfig`, `queryData`, `getConversationMessages`, `setHumanOverride`, `sendMessageAsOperator`, `injectCustomerNote`), `toolsAnalytics`, `toolsWhatsApp` (`sendWhatsAppMessage`, `broadcastWhatsApp`), `toolsMemory` (`rememberThis`, `forgetThis`, `recallMemories`, reconcile candidates), `toolsCash`.
`internalSellerTools` (`seller-prompt.ts`) = read/create-order subset, no `broadcastWhatsApp`/`deleteLead` (test-enforced).
`reconcileTools` (`reconcile/tools.ts`) = read-only + `createDeliveredOrder` + `createProduct` + `rememberThis` + `reportReconcileCandidate` (no messaging/config/delete).

---

## 9. Handoff / escalation **[P service, M copy]**

- Agent tool: `createTransferToHumanTool` → claims handoff effects, writes `humanOverrideUntil = now+24h` on override claim, fetches last 8 msgs, `sendEscalationEmail`.
- Webhook deterministic handoff: `deliverWebhookHandoff` → `resolveHandoffTransport` (override write + owner notification; **never** customer WhatsApp while AI off).
- Escalation transport `lib/whatsapp/tools/escalation-email.ts:sendEscalationEmail` — despite the name, primary channel is **Telegram broadcast** to every allowlisted admin chat (plain text, no markdown → injection-safe) plus the dedicated notify chat; email is only configured, not sent via SMTP here.
- Owner notify: `lib/telegram/notifier.ts:notifyAdmins`, `notifyNewOrder` (order card + direct `wa.me` link; extra pan-mayorista card to `telegramNotifyChatId`).

---

## 10. API routes & server actions

Routes (`src/app/api/**`):
- Webhooks: `whatsapp/webhook`, `webhook/whatsapp` (alias), `telegram/webhook/[token]`, `meta/webhook`, `meta/callback`.
- Cron: `cron/followup`, `cron/reconcile` (GET `?key=`).
- Agent admin: `admin/test-agent` (GET, `requireAdmin`), `admin/dlq`, `admin/ref-code`, `agent/test` (POST, `requireAdmin`).
- Commerce/public: `checkout` (POST, origin+rate-limit+Zod), `products`, `promotions`, `business`, `leads` (+`[id]`, `stats`, `update`), `link-preview`, `media/upload`, `media/[...path]`, `auth/[...nextauth]`, `health`, `whatsapp-phone`.
Server actions: `src/app/(admin)/admin/agent/actions.ts` (`saveAgentConfig`, `testAgentConnection`), `src/app/login/actions.ts`, `src/app/setup/actions.ts`, plus admin order/cash actions.

---

## 11. Zod validation inventory

- `lib/validations/agent-config.ts:agentConfigSchema` (legacy minimal) and the **authoritative** `agentConfigSchema` in `app/(admin)/admin/agent/actions.ts` (business hours, phone-id lists, delivery zones, business identity, AI provider, integration secrets; `escalationEmail` email-or-empty; secret fields optional with `"CLEAR"` sentinel).
- `lib/checkout/contract.ts:checkoutSchema` (uuid requestId, AR phone transform `549XXXXXXXXXX`, fulfillment mode, address refine, items 1–40).
- `lib/validations/{auth,product}.ts`.
- Per-tool `inputSchema` (Zod) on every agent tool.

---

## 12. Auth & tenant isolation

- NextAuth v5 (`src/auth/index.ts`, `src/auth/types.d.ts`), route `api/auth/[...nextauth]`; `src/proxy.ts` middleware guards `/admin/:path*`.
- `src/lib/auth/require-admin.ts:requireAdmin()` (fan-in 37) gates every admin mutation/server action and admin API route.
- Single-tenant by design: config is a singleton `agent_config` row `id=1`; tenant isolation is **deployment-level** (one DB per deployment), not row-level. `agent_config` holds all credentials, encrypted at rest.
- Fail-closed convention everywhere: empty secret/token/allowlist → deny.

---

## 13. JSONB shapes (from `src/db/schema.ts`)

- `agent_config.businessHours` → `{day,open,openTime,closeTime}[]`; `allowedPhoneIds`/`sellerPhoneIds` → `{name,phone}[]`; `whatsappZonasDelivery` → `{zona,disponible,tiempo,costo}[]`; `menuImageUrlsHamburguesas`/`...Pan` → `string[]`.
- `products.variants` → `{name,priceDelta,default?}[]`.
- `conversations.conversationMetadata` → `{repromptCount,lastUserMessageType,lastSuggestedProducts[],lastTools[]}`; `messages` → `Record<string,unknown>[]` (legacy).
- `chat_messages.contentAttributes` → `{type,url,fileName?,fileSize?,mimeType?,caption?,transcription?,description?}[]`.
- `orders.items` (notNull), `orders.tags` → `string[]`.
- `order_context_items`, `addresses`, `attachments` typed columns.
- `promotions.items` → `{productId,productName,quantity}[]`.
- `reconcile_candidates.payload` → `Record<string,unknown>`; `cash_sessions.report`, `leads.tags`, `agentMemories`.

---

## 14. Database tables & migrations

Tables (`src/db/schema.ts`): `users`, `products`, `agent_config` (singleton, ~60 columns), `conversations`, `conversation_session_states`, `conversation_session_events`, `conversation_session_effect_claims`, `chat_messages`, `leads`, `attachments`, `orders`, `order_context_items`, `addresses`, `agent_memories`, `reconcile_candidates`, `reconcile_runs`, `cash_sessions`, `cash_movements`, `promotions`.
Enums: `user_role`, `product_category`, `product_line`, `conversation_status`, `lead_status`, `client_type`, `channel` (whatsapp|telegram), `message_role` (user|assistant|system|human), session enums (mode/intent/question/asset_kind/event_type/signal/effect_kind), `order_type`, `order_status`, `reconcile_status`, `cash_session_status`.

Migrations (Drizzle `drizzle/`): `0000_peaceful_chamber` (core schema), `0002_unique_phone`, `0002_woozy_valkyrie`, `0003_session_memory` (session tables), `0004_business_ai_config` (idempotent session re-ship + business/AI columns), `0005_integration_secrets`, `0006_catalog_alcohol_empanadas`, `0007_web_order_redirect`, `0008_lame_lord_tyger` (agent_memories/reconcile + `conversations.last_reconciled_at`), `0009_needy_pestilence` (cash), `0010_peaceful_rocket_racer` (`agent_config.whatsapp_style_profile`). `_journal.json` version 7, dialect postgresql. Driver: `lib/db/index.ts` lazy `drizzle(neon(url), {schema})` proxy — **no interactive transactions** (checkout & session use conditional INSERT/UPDATE + CAS instead).

---

## 15. Secrets / environment variables

Env vars referenced (from code; `.env.example` is read-protected by policy, values not inspected):

DB/auth: `DATABASE_URL`, `AUTH_SECRET`, `NEXTAUTH_SECRET`, `AUTH_URL`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SEED_DEMO`.
AI: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AI_MODEL`, `AI_MODEL_FAST`, `AI_MODEL_VISION`.
WhatsApp/YCloud: `YCLOUD_API_KEY`, `YCLOUD_WEBHOOK_SECRET`, `WHATSAPP_PHONE_NUMBER`.
Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_LICHAS_CHAT_ID`.
Meta: `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `NEXT_PUBLIC_META_PIXEL_ID`, `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`.
Cloudinary: `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`.
Infra: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `CRON_SECRET`, `INTERNAL_CRON`, `ESCALATION_EMAIL`, `BUSINESS_NAME`, `BUSINESS_OWNER_NAME`, `DUPLICATE_ORDER_WINDOW_MINUTES`, `RENDER_EXTERNAL_URL`, `VERCEL_URL`, `NEXT_RUNTIME`, `NODE_ENV`.

DB-first DB→env resolution for: AI provider (`lib/ai/config.ts`), integration secrets (`lib/integrations.ts`), Telegram config (`lib/telegram/bot.ts`), business identity (`lib/business.ts`). Allowed non-DB: `NEXT_PUBLIC_*` (build-time), Redis (infra), `AUTH_SECRET`, `DATABASE_URL`.

---

## 16. Logs / observability

- `lib/logger.ts` pino (JSON prod / debug dev); `createCorrelationId`, `createLogger`, `logRequestReceived`, `logProcessing`, `logError`. Used by the Telegram route.
- WhatsApp route uses `console.log/warn/error` with `[webhook:wa]`, `[webhook:echo]`, `[buffer:*]`, `[agent]`, `[delivery]`, `[telegram]`, `[reconcile]` tags.
- `src/app/api/health/route.ts` health check. Escalations logged with `[escalation]`.
- No external APM/tracing; observability is structured logs + Telegram admin alerts + `reconcile_runs.report`.

---

## 17. Tests (no runner framework — `node --test` via tsx)

`npm run test:agents` runs: `src/lib/agent-consistency.test.ts` (large: session machine, handoff claims, protocol filter, routing matrix, `mergeBufferedTurn`, phone identity, status semantics, webhook ordering assertions via source reads), `checkout/{contract,origin,service}.test.ts`, `components/cart/checkout-ux.test.ts`, `whatsapp/web-order-guard.test.ts`, `checkout/notify.test.ts`, `telegram/notifier.test.ts`, `telegram/webhook-model.test.ts`, `cash/session.test.ts`. Verification convention: `npm run build` + `npx tsc --noEmit` + `npx eslint src scripts`.

---

## 18. Reusable platform features vs Muzzarella-specific

**Reusable (port to AH Sports mostly as-is) [P]**
- Channel abstraction: `lib/channels/router.ts` (find-or-create conversation, insertMessage w/ dedup, contentAttributes, media auto-attach), `lib/whatsapp/actor.ts`, `lib/phone-utils.ts`.
- Webhook gates: `lib/whatsapp/webhook-pipeline.ts` (`isProtocolArtifact`, `isEligibleInboundMessage`, `resolveSessionPersistence`).
- Session boundary machine: `lib/whatsapp/session-policy.ts`, `session-store.ts`, `human-handoff.ts` (+ 3 tables).
- Buffer + response-sender, queue + DLQ, idempotency, rate-limit, circuit-breaker, logger.
- Provider adapter: `lib/ai/config.ts`, `lib/ai/models.ts` (OpenAI-compatible, DB→env, DeepSeek handling).
- Media pipeline: `lib/media/{downloader,transcription,vision,document,video}.ts` (YCloud/Telegram-specific download only).
- Crypto: `lib/encryption.ts`; integrations resolver `lib/integrations.ts`; business identity `lib/business.ts`; Argentina time `lib/argentina-time.ts`.
- Telegram bot plumbing `lib/telegram/bot.ts` (send/download/webhook mgmt/config), notifier/`notifyAdmins`.
- Checkout contract/service/origin/store, cron+reconcile scaffolding, admin/agent config actions (adapt the Zod schema and fields).

**Muzzarella-specific (must be rewritten for AH Sports domain) [M]**
- Sales prompt `DEFAULT_SYSTEM_PROMPT` (Karen), B2C/B2B pan/burger flow, hours logic.
- All `lib/whatsapp/tools/*` business tools (menu, burgers/pan stock, delivery zones, payment aliases, promos, order-context cart).
- `seller-prompt.ts` synonym dictionary; `reconcile/prompt.ts`; `telegram/system-prompt.ts`; `status-utils.ts` copy.
- Product/category enums (`hamburguesa`, `pan_mayorista`, `tragos_vip`…), `order_type` (hamburguesas|pan_mayorista).
- Escalation/handoff user-facing copy, follow-up copy, delivery notification copy.

---

## 19. Notable gaps / risks for the AH Sports port

- Meta WhatsApp Cloud webhook is a **persist-only stub** (no agent).
- `lib/queue/worker.ts` Telegram processing is a no-op; the live Telegram path is the webhook + buffer, not the queue.
- `SessionPolicyRepository.withConversationLock` is a pass-through (neon-http); concurrency relies on unique-event idempotency + CAS — an AH Sports port on a transactional driver could add real `SELECT ... FOR UPDATE`.
- Single-tenant `agent_config id=1`; multi-tenant/multi-business would require a business-id column + scoping.
- `conversations.messages` JSONB is legacy/unused in the live path (live history is `chat_messages`).
- `openaiCircuitBreaker` is defined but not wired into `generateText`.
- Cron auth is a query-string shared secret (`?key=`), constant-time compared; fine for infra cron, weaker than signed requests.

---

## 20. Key file → responsibility index

| Path | Responsibility |
|---|---|
| `src/app/api/whatsapp/webhook/route.ts` | YCloud inbound pipeline, echo, delivery, handoff, buffer enqueue |
| `src/lib/whatsapp/webhook-pipeline.ts` | Protocol/eligibility/persistence gates (pure) |
| `src/lib/whatsapp/agent.ts` | Sales agent orchestration, routing, hallucination guards |
| `src/lib/whatsapp/session-{policy,store}.ts` | Durable boundary state machine + repository |
| `src/lib/whatsapp/human-handoff.ts` | Idempotent handoff effect claims + transport gates |
| `src/lib/whatsapp/prompt-builder.ts` | Layered system prompt + permitted session facts |
| `src/lib/whatsapp/tools/**` | Customer sales tools [M] |
| `src/app/api/telegram/webhook/[token]/route.ts` | Telegram inbound + internal agent |
| `src/lib/telegram/{bot,handler,tools,prompt-builder,notifier}.ts` | Telegram plumbing + ~60 internal tools |
| `src/lib/buffer/**` | Debounce buffer, bubble sender, in-memory fallback |
| `src/lib/queue/**` | Redis queue + retry + DLQ |
| `src/lib/ai/config.ts` + `models.ts` | Provider/model adapter (DB→env, OpenAI-compatible) |
| `src/lib/media/**` | Download + Whisper + vision + doc/video |
| `src/lib/reconcile/**` | Background sale reconciliation (scan + LLM deep pass) |
| `src/lib/checkout/**` | Web order contract/service/origin/store |
| `src/db/schema.ts` + `drizzle/**` | Schema + migrations |
| `src/lib/{encryption,integrations,business,phone-utils,logger,infra}` | Cross-cutting infra |
