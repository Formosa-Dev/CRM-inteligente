# Channel/Provider Port Delta — AH Sports → SocialCRM

**SDD EXPLORE deliverable.** Read-only analysis. Maps the delta in the
channel/provider layer between the improved AH Sports tree
(`C:\Users\Asus\Documents\estabilizacion\ah sports\App de gestion`) and this
SocialCRM worktree. Every claim below was verified by direct file reads/diffs,
not by trusting the AH review docs (several review findings were later fixed —
current-source state is what this report describes).

## Executive summary

The provider **contract** is already at parity (messenger, registry, types,
kapso/zernio adapters, signature chain, channel-events dedup are verbatim or
near-verbatim ports in AH). The real value AH added is in **operational
correctness** on top of that contract:

1. **Durability** — a Postgres `agent_inbound_jobs` queue that survives
   restarts, versus SocialCRM's Redis + process-local timer buffer.
2. **Provider-agnostic pipeline** — AH's inbound pipeline reads normalized
   event fields; SocialCRM's still unwraps `payload.whatsappInboundMessage`
   and hard-codes `"whatsapp"`, so it can only ever serve the YCloud path.
3. **Outbound correctness** — 24h window gate, `senderKind` honesty (automated
   sends never mute the agent), deterministic notification idempotency,
   persist-before-send operator replies.
4. **Scoped credentials** — per-field scope-chain merge + per-provider
   `*_enc` columns in `agent_config`, versus SocialCRM's whole-row resolution
   that only supports `ycloud_api_key`.
5. **Coexistence UX** — Zernio `onboarding: business_app` connect mode +
   Meta-envelope echo/status/media handling, required for "operator keeps the
   WhatsApp phone app" installs.

SocialCRM also has real advantages AH lost (media-rich telegram + echo
handling, outbound media sends, actor/seller gating, Meta CAPI OAuth, reddit).
These are flagged so the port doesn't regress them.

---

## Adaptation notes (apply to every phase)

| Concern | AH Sports | SocialCRM (this worktree) | Port rule |
|---|---|---|---|
| IDs | `channel_accounts.id`, `conversations.id`, `chat_messages.id`, `lead_identities.id` are **varchar/UUID strings** | Same entities are **`integer` serials** | Keep `Number.isInteger` guards; never copy string-id logic verbatim. SC's `accountIdOf` (`Number.isInteger(id) && id > 0`) already rejects AH's symbolic ids (`env:*`, `*:agent-config`) — equivalent, keep it. |
| Lead model | `contacts` + `leadIdentities.contactId` + `conversations.customerId` | `leads` (nullable phone, `channelAccountId`, `externalUserId`, unique `(channel, external_user_id)`) + `leadIdentities.leadId` + `conversations.leadId` | **Never** port `contacts`/`customerId`/`organizationId`. SC's leads model is a superset (tenant column on `lead_identities`, UTM/attribution). Map `contactId` → `leadId` semantics. |
| Admin auth | `requireAgentAdmin` / `authorizeAgentApi` (custom scrypt cookie RBAC) | `requireAdmin()` from `src/lib/auth/require-admin.ts` + `auth()` from `@/auth` (NextAuth v5) | Swap guard calls 1:1; read paths use `auth()`, mutations use `requireAdmin()`. |
| Routing/UI naming | `/admin/canales/*` (Spanish), `conectar/zernio` page-route callback | `/admin/channels/*` (English), `/api/channels/zernio/callback` API callback | Keep SC's English routes and its existing API-route callback location. |
| Conversation thread model | `external_thread_id` = **canonical external user id**; provider thread dug out of last inbound `rawPayload.providerConversationId` | `external_thread_id` = **provider thread id** (stamped by `stampConversationThreadId`); identity lives in `external_user_id_normalized` | SC's model is cleaner — keep it. When porting AH code that calls `loadProviderThreadId`, use `conv.externalThreadId` directly (SC already does this in `sendOutboundMessage`). |
| Message model | `chat_messages`: `direction`, `sender_kind` (`customer`/`agent`/`operator`), `sender_ref`, `delivery_state` (`queued`/`sent`/`failed`), `provider_conversation_id`, `content_type` | `chat_messages`: `role` (`user`/`assistant`/`human`/`system`), `content_attributes`, `platform_message_id`, `channel_account_id`. **No sender/delivery/thread columns.** | Schema delta — see Area 9. Recommendation: add AH's columns as nullable + keep `role` during transition rather than remapping semantics. |
| Stack | Next 15, custom auth, `@neondatabase/serverless`, `server-only` guards | Next 16.2.4, NextAuth v5, drizzle+Neon | Follow `node_modules/next/dist/docs/` for any route changes; `import "server-only"` convention ports fine. |
| Domain | Textile orders, organizations, cash, promos | Pizza/food orders, leads, cash, promotions | Only the transport/queue/seam layers port. Domain bodies (agent prompts, order wording, seller tools) never port. |

---

## Area 1 — `zernio-connect.ts` (embedded connect)

| AH file | SocialCRM counterpart | Delta (AH has, SC lacks) | Strategy | Adaptation notes |
|---|---|---|---|---|
| `src/lib/messaging/providers/zernio-connect.ts` | `src/lib/messaging/providers/zernio-connect.ts` | `ZERNIO_WHATSAPP_ONBOARDING = ["api","business_app"]` const + optional `onboarding` param on `getZernioConnectUrl` (defaults `api`) → enables WhatsApp Business app **coexistence** connect. `ZERNIO_CONNECT_PLATFORMS` drops `reddit` (AH channel contract). Webhook name `ah-ingress` vs `socialcrm-ingress`. | **adapt** | Port only the `onboarding` param + const + its pass-through into the connect request body. **Keep** `reddit` in `ZERNIO_CONNECT_PLATFORMS`. Keep `socialcrm-ingress` webhook name (install-specific). Everything else is identical. |
| `src/app/actions/channel-connect.ts` | `src/app/(admin)/admin/channels/actions.ts` (`startZernioConnect`) | `onboarding` accepted through a strict zod enum (`z.enum(ZERNIO_WHATSAPP_ONBOARDING).optional()`); input object `{platform, onboarding?}` instead of bare `platform` arg. Dead-cookie cleanup when `getZernioConnectUrl` fails. | **adapt** | Extend SC's `startZernioConnect` signature to `{platform, onboarding?}` with the same zod enum + cookie-delete-on-failure. Auth guard: `requireAdmin()` already correct. |
| `src/app/(admin)/admin/canales/ChannelsView.tsx` | `src/app/(admin)/admin/channels/channels-view.tsx` | Two WhatsApp connect buttons: `"WhatsApp — coexistencia (tu app actual)"` → `business_app`, `"WhatsApp — número nuevo / Cloud API"` → `api`. `connectZernio(platform, onboarding)` passes the mode through. | **adapt** | Add the second WhatsApp entry to SC's `ZERNIO_CONNECT` list with labels matching SC's tone; keep `reddit` entry. |
| `src/app/(admin)/admin/canales/conectar/zernio/route.ts` | `src/app/api/channels/zernio/callback/route.ts` | Platform allowlist is `isZernioConnectPlatform` (connect-reachable platforms only). | **adapt** | SC's callback gates on `isChannelKind` — accepts `sms`/`reddit` which Zernio connect never produces. Tighten to `isZernioConnectPlatform` (already exported by zernio-connect). Body otherwise identical (same upsert, same state check). Keep SC's API-route location + `requireAdmin`. |

---

## Area 2 — Provider adapters (`providers/*.ts`)

| AH file | SocialCRM counterpart | Delta | Strategy | Adaptation notes |
|---|---|---|---|---|
| `providers/ycloud.ts` | `providers/ycloud.ts` | (a) **`sendTemplate` implemented** — `buildTemplateBody` builds the YCloud `sendDirectly` template shape; SC's ycloud has **no `sendTemplate`**, so `messenger.sendTemplate` silently falls back to `sendMessage` and template sends to YCloud can never succeed. (b) **429 classified retryable** — `status === 429 \|\| status >= 500`; SC has `status >= 500` only → rate-limited sends are dropped instead of retried. (c) Absorbed `lib/ycloud.ts` legacy client (signature verify, timestamp window, `ECHO_EVENT_TYPES`, env-resolved `legacySend`) into the adapter. | **adapt** | Port (a) + (b) only — both are small, surgical, and needed by the Area-7 template fallback. **Skip (c)**: keep SC's `src/lib/ycloud.ts` seam (the legacy client is still used by non-account paths); the file-merge is organizational, not behavioral. |
| `providers/kapso.ts` | `providers/kapso.ts` | Near-verbatim port (import/type adaptations). 429+5xx retryable, `sendTemplate` — identical both sides. | **skip** | Nothing behavioral to port. |
| `providers/zernio.ts` | `providers/zernio.ts` | Near-verbatim port. 429/409/5xx retryable, `sendTemplate` — identical. | **skip** | Nothing behavioral to port. |
| (telegram outside provider model — `lib/channels/telegram.ts` `sendTelegramMessage`) | `src/lib/telegram/bot.ts` (`sendTelegramMessage`) | AH normalizes telegram updates to a canonical `NormalizedTelegramInbound` (contentType text/image/document **caption-only**) and derives webhook path tokens (`deriveWebhookPathToken`, `timingSafeEqualString`, `TELEGRAM_SECRET_HEADER`). | **adapt (partial)** | Port only `deriveWebhookPathToken`/`timingSafeEqualString`-equivalent helpers IF S6 lands (they're pure). **Do not** adopt AH's caption-only media handling — SC's `bot.ts` downloads photo/audio/document and enriches (vision, transcription) — strictly richer. |
| media domains | per-provider `PROVIDER_MEDIA_DOMAINS` (kapso Graph CDN hosts, zernio Meta CDN hosts) + exact/`.*.domain` anchored allowlist matching | **adapt** | Wire SC's downloader to accept per-provider `extraAllowedDomains` and use suffix-anchored host checks (blocks `evilcdn.<domain>` bypasses). Needed once non-YCloud providers carry media. |

---

## Area 3 — `messaging/ingress.ts` + unified ingress route

| AH file | SocialCRM counterpart | Delta | Strategy | Adaptation notes |
|---|---|---|---|---|
| `src/lib/messaging/ingress.ts` | `src/lib/messaging/ingress.ts` | `verifyAndResolveEvents` **identical** (per-account `credentials.webhookSecret` → provider-secret chain, verified-secret set). Passive persistence ≈ identical except AH **calls `ensureLeadIdentity`** on the passive path — every persisted social inbound links a lead; SC's passive path creates the conversation/message but **never links a lead** → ig/fb/sms inbound is lead-less. | **adapt (one call site)** | Add `ensureLeadIdentity` to SC's `handlePassiveChannelEvent` (post `findOrCreateConversation`, post `insertMessage`, best-effort). SC's own `messaging/lead-identity.ts` is already a complete leads-based implementation — just unwired here. |
| `src/app/api/webhooks/ingress/[provider]/route.ts` | same path | AH routes `ctx.channel === "whatsapp" \|\| "telegram"` through `handleNormalizedEvent` (any provider that maps to whatsapp — zernio/kapso included — gets the agent). SC routes **only `provider.id === "ycloud" && channel === "whatsapp"`** through the pipeline; a zernio/kapso whatsapp inbound is passively persisted and **never answered**. AH imports `@/lib/whatsapp/register` to install the sales dispatcher — moot in SC because SC has no dispatcher seam (hard `runWhatsAppAgent`), but the equivalent consequence is identical: non-ycloud whatsapp = no agent reply. | **adapt** | Change the gate to route all `whatsapp`-channel events through `handleNormalizedEvent` — but only AFTER the pipeline is provider-agnostic (S3), otherwise non-YCloud payloads hit the `whatsappInboundMessage` guard and get acked without persistence, which is *worse* than today's passive persistence. Order matters: this is the last step of the ingress track. Do not add telegram to the gate unless S6 is done — SC's telegram lives on its own route. |

---

## Area 4 — `inbound-pipeline.ts` + durable queue

| AH file | SocialCRM counterpart | Delta | Strategy | Adaptation notes |
|---|---|---|---|---|
| `src/lib/messaging/inbound-queue.ts` (607) | — (no equivalent; `agent_inbound_jobs` table absent from schema) | Postgres durable turn queue: `turn:<conv>` dedup key w/ partial-unique live statuses; lifecycle queued→running→done/dead (DLQ); 10min lease re-claims crashed `running`; exponential backoff (10s·2ⁿ≤5min, 5 attempts → DLQ); **batch rebuilt from `chat_messages`** (at-least-once, not payload-trusting); self-healing drain at top of `handleNormalizedEvent` + startup/periodic drain in `instrumentation.ts`; 42P01 → degrade to in-memory buffer with one warn. | **adapt** | Port the module + the table migration, adapting: string ids→int; AH's `db` client import → `@/db`; `contacts` refs → leads. **Decision point**: keep SC's Redis `BufferManager` as the debounce/coalesce layer *in front of* the queue (queue = durability, Redis = debounce), or drop Redis entirely like AH did (in-memory buffer + PG queue). AH's model is simpler infra (no Redis dep on Render); SC's Redis already exists. Recommend AH's model: one durable store, no second infra dep, and the queue preserves coalescing via the partial-unique `turn:` key. |
| `src/lib/messaging/inbound-pipeline.ts` | `src/lib/messaging/inbound-pipeline.ts` | Provider-agnostic inbound: reads `event.type`/`event.text`/`event.mediaRefs`; SC unwraps `payload.whatsappInboundMessage` and hard-codes `"whatsapp"` at `findOrCreateConversation` (line ~736) → any non-YCloud payload is acked without persistence. `setInboundTurnDispatcher` seam (module-level `turnDispatcher`, default = generic router dispatch) vs SC's hard `runWhatsAppAgent` import. Queue-backed turn flush vs `scheduleBufferProcessing` timer. `persistCanonicalMessage`-style claims for auto-reply. | **adapt** | Replace the `whatsappInboundMessage` guard with normalized-field reads; thread `effectiveCtx.channel` into `findOrCreateConversation` (it accepts a channel arg already). Introduce the `InboundTurnDispatcher` seam but **keep SC's whatsapp agent wiring** (`runWhatsAppAgent`, `resolveWhatsAppActor`, seller/allowedPhoneIds gating) as the registered dispatcher — do not port AH's `whatsappSalesDispatcher` internals. Keep SC's `checkRateLimit` wa-inbound gate, `allowedPhoneIds`/`sellerPhoneIds` gates, `captureLeadIfNew`, and `humanOverrideUntil` semantics. |
| `src/lib/messaging/buffer.ts` (383) | `src/lib/buffer/{manager,processor,redis}.ts` | AH's in-memory debounce buffer (per-key lock, content dedup, dead-letter) shadows the PG queue. SC's Redis+memory buffer is functionally equivalent for debounce but its flush **timer is process-local** — restart = orphaned Redis lists until the next same-key inbound (no sweep exists). | **adapt** | Covered by the S0 decision above: either keep `BufferManager` as debounce-only front-end to the queue, or replace with AH's buffer+queue pair. Either way add the startup drain to `src/instrumentation.ts` (SC's currently only runs the reconcile scheduler behind `INTERNAL_CRON`). |
| `src/lib/media/inbound.ts` | inline media block in `inbound-pipeline.ts` (~lines 290-360, 1000-1090) | `provider.resolveMedia → downloadMedia → saveMediaLocally → transcribe/vision/video/document` seam, `MAX_MEDIA_REFS`, non-fatal contract, provider-keyed allowlists. SC inlines `downloadYCloudMedia(mediaObj.id, apiKey)` — ycloud-only, but richer enrichment (audio→transcription, image→vision, video→analysis, doc→text all present). | **adapt** | Port the seam + `resolveMedia` provider calls + `PROVIDER_MEDIA_DOMAINS`; keep SC's enrichment functions (`transcribeAudio`, `processImageWithVision`, `analyzeVideo`, `extractDocumentText`) and async-transcription-after-store pattern. |
| `src/lib/messaging/auto-reply.ts` | inline `shouldSendAutoReply`/`autoReplyClaimKey` in SC's pipeline (lines 95-118) | Identical logic, AH extracted to a module. | **skip** | Pure refactor; no behavioral delta. |
| `src/lib/messaging/bubbles.ts` | `src/lib/buffer/response-sender.ts` (`splitIntoBubbles`, `sendTelegramBubbles`, `sendWhatsAppBubbles`) | Identical split algorithm; AH keeps only split + own-echo match, SC's file also owns the bubble senders. | **skip** | Equivalent. |

---

## Area 5 — Accounts + config scope

| AH file | SocialCRM counterpart | Delta | Strategy | Adaptation notes |
|---|---|---|---|---|
| `src/lib/channels/agent-config-scope.ts` (732) | `src/lib/agent-config-scope.ts` (560) | **`resolveAgentConfigChain` + `firstScopedValue`**: returns all rows in the scope chain (account→channel→global) so each field inherits independently — a scope row created to toggle one flag can no longer hide a parent's credentials (AH R4-MED-2). SC's `resolveAgentConfigStrict` resolves ONE row (whole-row granularity): an account row with a blank `ycloudApiKey` fails instead of inheriting. | **adapt** | Port `resolveScopedRowIds` + `resolveAgentConfigChain` + `firstScopedValue` into `lib/agent-config-scope.ts` (integer ids, `tenantId` column exists in SC's `agent_config`? — verify at implementation; scope columns exist). **Semantics change to flag**: blank-on-scoped-row becomes "inherit" not "fail" for *inherited* fields — fail-closed still applies when NO scope supplies a field. Keep `resolveAgentConfigStrict` for single-row consumers (admin editor exact-scope reads, `resolveScopeForConversation`). |
| `src/lib/messaging/accounts.ts` (794) | `src/lib/messaging/accounts.ts` (514) | (a) `credentialsFromAgentConfigScope`: `agent_config` refs work for **all providers** via `SCOPED_PROVIDER_FIELDS` (`ycloudApiKeyEnc`, `kapsoApiKeyEnc`, `zernioApiKeyEnc` + matching `*WebhookSecretEnc`, telegram→`botTokenEnc`, fallback `webhookSecretEnc`); SC's `credentialsFromAgentConfig` hard-fails non-ycloud providers → today zernio/kapso/telegram accounts can only use `env:` refs. (b) `ChannelAccountStore` injectable store + `createEnvAccountStore`/`createDbBackedAccountStore` + `isSymbolicAccountId`/`channelAccountRowId`. | **adapt** | Port (a) once S2 config-chain + S0 `*Enc` columns land — per-field `firstScopedValue` over the chain, `agent_config` ref enabled per provider, blank-everywhere = explicit failure (never silent global). **Skip the store indirection (b)** — SC's direct-DB + `Number.isInteger` id guard is equivalent for its id space; the store exists in AH mainly for test seams and env-materialized string ids. |
| `src/lib/channels/accounts.ts` | — (SC keeps account resolution inside `messaging/accounts.ts` + `channels/router.ts`) | AH split a channels-side re-export/facade (`resolveChannelAccountStrict`, `decideSendAccount`, sender matching) from the messaging store. | **skip** | Organizational split; SC's two files already cover the same exports. |
| `src/lib/channels/send-account.ts` | `src/lib/messaging/send-account.ts` + `BoundAccountResolution`/`DefaultAccountResolution` in `router.ts` | AH re-declares the resolution types locally (string ids) + `accountIdOf` filters symbolic ids. SC's versions are equivalent for integer ids. | **skip** | Functionally identical. |

---

## Area 6 — Lead identity

| AH file | SocialCRM counterpart | Delta | Strategy | Adaptation notes |
|---|---|---|---|---|
| `src/lib/channels/lead-identity.ts` (`ensureLeadIdentity`) | `src/lib/messaging/lead-identity.ts` (`ensureLeadIdentity`) | SC's implementation is **already real and leads-based**: existing identity lookup → `leads.phone` fallback → phone-less lead + identity create → 23505 race re-read → `linkConversationToLead`. AH's does the same on `contacts` with string ids and adds the `conversations.customerId` link on create. | **skip (impl) / adapt (call sites)** | Keep SC's implementation verbatim. Delta is **wiring**, not the module: wire `ensureLeadIdentity` into the passive ingress path (Area 3) — it's already called inside `findOrCreateConversation` for the active path. AH's historical "two implementations, stub imported" review finding is **fixed in current AH source** — ignore it. |

---

## Area 7 — Outbound (operator reply, order-status, broadcast)

| AH file | SocialCRM counterpart | Delta | Strategy | Adaptation notes |
|---|---|---|---|---|
| `src/lib/whatsapp/outbound-window.ts` (121, **new module**) | — (no equivalent; `isCustomerWindowOpen` logic doesn't exist) | Single 24h-window decision seam: `lastCustomerInboundAt` → `isCustomerWindowOpen` → `decideCustomerWindowSend` returns text / template-from-`wa_template_fallback`-settings-key / text-with-honest-`no_template`. | **adapt** | New file `src/lib/whatsapp/outbound-window.ts`. `lastCustomerInboundAt` must read SC's role model (`role = 'user'` inbound) unless the sender-column migration lands — write it against `direction`/`sender_kind` if S0 adds them, else `role`+`platform_message_id`. `wa_template_fallback` settings key → SC has a `settings` table? (verify; else agent_config column or env — pick the existing SC settings surface). Language default `es_AR` fits SC. |
| `src/lib/channels/operator-send.ts` (330) | `sendOutboundMessage` in `src/lib/channels/router.ts` (745-885) + `sendReply` in `admin/conversations/actions.ts` | AH: **persist BEFORE send** (`queued`→`sent`/`failed` — a crash never leaves an invisible reply); `senderKind:"operator"`+`senderRef` (session user id — transcript distinguishes human from AI; SC persists `human`→`assistant`, losing the distinction); F-02 window gate→template fallback; `loadProviderThreadId` for zernio; `stampDeliveryResult` folds the pending row into a winning provider echo (23505 race); `account_provider_mismatch` drop; `channel_unsupported` graceful; telegram replies via bound-account bot token→scoped/global. SC already has: `providerConversationId` via `conv.externalThreadId` (**cleaner than AH's rawPayload dig — keep**), `resolveUnboundWhatsAppSend` fail-closed chain, media sends (image/document — **AH lacks outbound media, do not regress**), `humanOverrideUntil` 2h flag (SC's mute mechanism — keep, it's equivalent to AH's operator-gate). | **adapt** | Rework `sendOutboundMessage`: persist-first with a delivery marker (either new `delivery_state` column or `contentAttributes.delivery`), stamp operator identity (`sender_kind`/`sender_ref` if migrated; else keep `human` role + add `contentAttributes.operatorRef`), thread `providerConversationId` (already done via `externalThreadId`), add the window gate for whatsapp text sends, keep media sends + `humanOverrideUntil` + legacy-credential path. The 23505 echo-fold ports if sender columns land — SC's own-echo detection (role lookup) already covers most of it. |
| `src/lib/whatsapp/order-status-notify.ts` (304) | `src/lib/whatsapp/order-status-notify.ts` (65) + callers `admin/orders/actions.ts`, `lib/telegram/order-lifecycle.ts` | AH: deterministic send idempotency `order-status:<orderId>:<status>` (re-fired transition retries the SAME send); persists outbound fact sent **and** failed; `senderKind:"agent"` + `senderRef:"order-status-notify"` — fixes the AH-R1 bug where automated notifies stamped "operator" and muted the agent ≤2h (SC's `human`→`assistant` mapping means SC notifications would... — verify: SC's caller currently persists the notify as what role? If `assistant`, the mute path isn't hit but the transcript still can't distinguish); 24h window gate; `providerConversationId` for zernio; `ORDER BY created_at DESC` identity lookup + BSUID phone-shape guard; `account_provider_mismatch`. | **adapt** | Port the transport layer: `notifyOrderStatusChange` equivalent must resolve SC's model — `orders.leadId → leads.phone` / `lead_identities` (NOT `orders.contactId → contacts`). Keep `decideSendAccount` + SC's `SendAccountDeps` seam (already equivalent). Keep SC's caller contract (returns `{ok, error, retryable, channelAccountId}`); add `persisted` + window decision to the result shape. `buildOrderStatusMessage` (textile stages) is **domain — do not port**; SC's own status wording stays. |
| `src/lib/telegram/tools-broadcast.ts` (389) | `src/lib/whatsapp/broadcast.ts` (523) | Different scopes: AH's is a telegram-operator tool that broadcasts via `senderKind:"agent"`; SC's is the whatsapp broadcast engine with its own tests. AH-R1 flagged the "operator" mis-stamp; current AH source stamps `agent`. | **skip** | SC's broadcast is domain-specific and tested — do not replace. Port only the *rule*: any automated/broadcast send must not stamp the operator sender kind (verify SC's broadcast role on insert — if it writes `human`, fix to `assistant`/agent-equivalent). |

---

## Area 8 — Admin/UI connect flows

| AH file | SocialCRM counterpart | Delta | Strategy | Adaptation notes |
|---|---|---|---|---|
| `src/app/(admin)/admin/canales/page.tsx` | `src/app/(admin)/admin/channels/page.tsx` | Same listing shell; Spanish routes/copy. | **skip** | Keep SC's `/admin/channels` + English UI. |
| `src/app/(admin)/admin/canales/webhook-endpoints.ts` | `src/app/(admin)/admin/channels/webhook-endpoints.ts` | `publicBaseUrl` differs only in env precedence: AH reads `NEXT_PUBLIC_APP_URL \|\| RENDER_EXTERNAL_URL`; SC reads `AUTH_URL \|\| NEXT_PUBLIC_APP_URL`. | **skip** | Keep SC's env chain (`AUTH_URL` first — NextAuth needs it anyway); optionally append `RENDER_EXTERNAL_URL` as a last resort. |
| `src/app/actions/channel-accounts.ts` (225) | inline in `admin/channels/actions.ts` (`fetchChannelAccounts`, `createChannelAccount`, `setChannelAccountStatus`) | AH split account CRUD into its own actions file + `channel-accounts.ts`; same operations. | **skip** | Organizational. |
| `src/app/(admin)/admin/canales/ChannelsView.tsx` dual buttons + scoped-credentials hint | `channels-view.tsx` | Covered in Area 1 — dual `onboarding` buttons + hint text pointing to `/admin/agent` scoped config. | **adapt** | Port buttons + hint only. |
| Meta Business OAuth (none in AH) | `src/app/(admin)/admin/meta/meta-connection-section.tsx`, `actions.ts`, `/api/meta/callback` | SC-only: OAuth for Meta **Conversions API/Pixel** (ads), `META_APP_ID`/`META_APP_SECRET`, Pixel config. | **skip — SC-only, preserve** | Not a channel-connect surface — different purpose (marketing CAPI). AH has nothing to port here; do not confuse it with whatsapp connect. |
| `src/app/api/whatsapp/webhook/[token]/route.ts` + `src/lib/channels/whatsapp/import.ts` (Meta-envelope schema/normalizers) | `src/app/api/whatsapp/webhook/route.ts` (YCloud global) + `src/app/api/meta/webhook/{route,helpers}.ts` (Meta-native, **text-only**) | AH's Meta-native route handles `messages` + **`smb_message_echoes`** + **`statuses`** + media refs + deterministic `meta:` deliveryIds + path-token (`deriveWebhookPathToken(verifyToken)`) + per-IP limit/bounded body/event cap + `verifyWhatsAppSignature` (HMAC-256) + `aggregateWebhookStatuses`. SC's `/api/meta/webhook` already: verifies HMAC-256, rate-limits, bounds body, caps events, resolves accounts **fail-closed by routing key** (good), feeds `handleNormalizedEvent` — but **drops everything without `text`** (media silently ignored), **ignores `smb_message_echoes`** (operator phone-app replies never reach the inbox — breaks coexistence), **ignores `statuses`** (no delivery-state updates). | **adapt** | Enrich SC's existing `/api/meta/webhook` + `helpers.ts`: parse `smb_message_echoes` → `kind:"message.echo"` events (existing `handleEcho` handles them), `statuses` → `kind:"message.status"` (persisted via `persistChannelEvent`), media msgs → `mediaRefs` + `[image]`/`[document]` text placeholders, deterministic `meta:<kind>:<id>` deliveryIds. Optionally add the `[token]` path segment (defense-in-depth) — SC's signature+verify-token already gates. Keep SC's fail-closed account resolution — it's equal-or-better than AH's. |

---

## Area 9 — Schema delta

| AH structure | SocialCRM counterpart | Delta | Strategy | Adaptation notes |
|---|---|---|---|---|
| `agent_inbound_jobs` (durable queue table + partial-unique live-status index) | **absent** | Whole table missing — required by Area 4. | **adapt** | New migration + `agentInboundJobs` in `src/db/schema.ts` with integer `conversation_id`/`channel_account_id` FKs, `dedup_key` text, `payload` jsonb, `status`, `attempts`, `run_after`, `last_error`, timestamps. |
| `chat_messages.sender_kind/sender_ref/direction/delivery_state/provider_conversation_id/content_type` | `chat_messages.role` + `content_attributes` + `platform_message_id` | SC has **none** of the sender/delivery/thread columns — the whole honest-attribution model is a schema delta. | **adapt (decision point)** | Recommended: additive migration — nullable `direction`, `sender_kind`, `sender_ref`, `delivery_state`, `provider_conversation_id`; keep `role` populated during transition (dual-write), readers migrate gradually. Alternative: encode in `content_attributes` — cheaper but loses index-ability for `operator`-kind queries (the 2h-mute gate + window gate read these). Take option A. |
| `agent_config.{zernio_api_key_enc, zernio_webhook_secret_enc, kapso_api_key_enc, kapso_webhook_secret_enc, ycloud_api_key_enc, ycloud_webhook_secret_enc, bot_token_enc, webhook_secret_enc, provider_key_enc}` | `agent_config.ycloud_api_key` (text), `telegram_bot_token` (encrypted), `telegram_webhook_token` | SC's `agent_config` only carries ycloud (+legacy telegram) credential fields; all other providers are env-only. | **adapt** | Additive columns for the per-provider `*Enc` pairs SC actually needs (`zernio_*`, `kapso_*`, `ycloud_webhook_secret_enc`; map telegram's existing `telegram_bot_token`/`telegram_webhook_token` as the `botTokenEnc`/`webhookSecretEnc` equivalents rather than duplicating). `provider_key_enc` (AI credential) is out of channel scope — skip unless wanted for other reasons. |
| `channel_accounts` | `channel_accounts` | Equivalent shape (provider, channel, providerAccountId, senderAddress, credentialsRef, status) — modulo int/string ids. | **skip** | Already present. |
| `lead_identities` | `lead_identities` | Equivalent (SC adds `tenant_id`). | **skip** | Already present — SC's is ahead (tenant column). |
| `channel_events` | `channel_events` | Equivalent (account-partitioned unique indexes both sides). | **skip** | Already present. |
| `conversations.external_thread_id` semantics | `external_thread_id` = provider thread (stamped) + `external_user_id_normalized` = identity | Divergent semantics — AH's `external_thread_id` is the *identity* key. | **skip — keep SC's** | Document in every ported file: never assign an identity value to `external_thread_id`. |

---

## Area 10 — Kill-switch (`agent_config.enabled`) coverage

| Enforcement point | AH | SocialCRM | Delta | Strategy |
|---|---|---|---|---|
| Pipeline dispatch (whatsapp) | `isAgentDisabled`/row `enabled === false` gates the turn | `config.enabled === true` required at dispatch (`inbound-pipeline.ts:776`), scope-resolved | **Equal** | — |
| Telegram route | canonical pipeline gate covers it | `config.enabled` checked in route (`[token]/route.ts:73`) + `telegramEnabled` flag | **Equal** (SC has an extra per-channel flag — keep it) | — |
| Unified ingress (non-ycloud whatsapp) | gate applies (all whatsapp through pipeline) | **gap** — events go passive, no agent ever runs (consequence, not a kill-switch bug) | resolves via Area 3/4 | — |
| Passive channels (ig/fb/sms) | persistence only, no agent — `enabled` not consulted | same | **Equal** — persistence is not agent output | — |
| Auto-reply | `enabled === false` gates before send | `isAiEnabled` gates before send | **Equal** | — |
| Operator reply / order-status / broadcast | not gated by `enabled` (transactional — deliberate) | not gated | **Equal** — keep the distinction: `enabled` silences *agent turns*, never operator/transactional sends. Document the decision in the port PR. | — |

**Net:** kill-switch parity is already close; the only real fix is structural (whatsapp-from-other-providers never reaching any agent — Area 3/4, not a kill-switch issue per se).

---

## "SocialCRM does better — do NOT regress"

- **Outbound media**: `sendOutboundMessage` sends image/document outbound. AH's `operator-send` is text-only.
- **Echo media enrichment**: SC's `handleEcho` downloads+transcribes operator audio echoes. AH persists echo text only.
- **Telegram inbound media**: photo/audio/document download → vision/transcription. AH is caption-only.
- **Actor/seller gating**: `resolveWhatsAppActor`, `allowedPhoneIds`, `sellerPhoneIds`, `internalSellerTools`/`buildSellerPrompt` — the dispatcher seam must keep these; AH has no actor concept.
- **`humanOverrideUntil` + role-model mute**: works; keep rather than switching wholesale to `handoffResolvedAt` semantics.
- **`conv.externalThreadId` as provider thread**: cleaner than AH's rawPayload dig — keep stamping at inbound, read at send.
- **Meta CAPI OAuth** (`/admin/meta`, pixel): different-purpose surface AH lacks — keep.
- **Legacy env-credential path** (`resolveLegacyWhatsAppCredentials`, `resolveUnboundWhatsAppSend`): needed for un-migrated installs — AH dropped it entirely.
- **Reddit channel**: SC-only — never remove because AH's contract omits it.
- **Redis buffer infra** (if kept): dead-letter + content-dedup already exist.
- **`getTelegramConfigFromDB` opportunistic token encryption migration** — keep.

## "Do NOT port — AH-specific"

- `contacts`/`customerId`/`organizationId`/`tenant` wiring — SC's `leads` model stays.
- String/UUID account & message ids and every `isSymbolicAccountId`-style guard that exists *because* ids are strings.
- `requireAgentAdmin`/`authorizeAgentApi` (AH cookie auth) → SC uses `requireAdmin()`/`auth()`.
- `whatsappSalesDispatcher`/`sales-agent.ts` internals (textile presupuesto domain) — only the `setInboundTurnDispatcher` **seam** ports.
- `buildOrderStatusMessage` textile stage wording.
- AH's `routeInboundMessage` legacy channels router — SC must not gain a second router; the dispatcher seam replaces the need.
- `/admin/canales` Spanish route names + Spanish-only UI copy (SC's `/admin/channels` English).
- `ah-ingress` webhook name.
- AH's removal of `reddit` from connect platforms.
- `routeInboundMessage`'s flat channel routing (AH's "whatsapp → AI, telegram → operator bot, else persist" — SC's actor model is richer).

---

## Implementation phases (parallel-worktree safe)

Ownership rules: no file appears in two phases; schema lands first because later phases `import` the new columns/tables but **worktree file ownership stays disjoint** regardless — dependencies are import-level, not edit-level.

### S0 — Schema foundation (lands first, solo)
- **Owns**: `src/db/schema.ts`, `drizzle/*` migration files only.
- **Work**: `agent_inbound_jobs` table + partial-unique live-status index; `agent_config` `*Enc` columns (`zernio_api_key_enc`, `zernio_webhook_secret_enc`, `kapso_api_key_enc`, `kapso_webhook_secret_enc`, `ycloud_webhook_secret_enc`); nullable `chat_messages` sender columns (`direction`, `sender_kind`, `sender_ref`, `delivery_state`, `provider_conversation_id`); `wa_template_fallback` home (settings row or agent_config column — pick existing surface).

### S1 — Provider + connect fixes *(parallel with S2/S5)*
- **Owns**: `src/lib/messaging/providers/ycloud.ts`, `src/lib/messaging/providers/zernio-connect.ts`, `src/app/(admin)/admin/channels/{actions.ts,channels-view.tsx,webhook-endpoints.ts}`, `src/app/api/channels/zernio/callback/route.ts` + provider/connect tests.
- **Work**: ycloud `sendTemplate` + 429-retryable; `onboarding` param through connect-url→action→view (dual WhatsApp buttons); tighten callback platform gate to `isZernioConnectPlatform`; cookie-delete-on-failure. Keep `reddit`, keep `socialcrm-ingress` name.

### S2 — Scoped credential chain *(parallel with S1/S5; needs S0 columns for full effect but code can land first — chain reads degrade gracefully while columns are absent via `isSchemaNotReady`)*
- **Owns**: `src/lib/agent-config-scope.ts`, `src/lib/messaging/accounts.ts` + tests.
- **Work**: `resolveScopedRowIds` + `resolveAgentConfigChain` + `firstScopedValue`; `credentialsFromAgentConfigScope` (all-provider `agent_config` refs, `SCOPED_PROVIDER_FIELDS`, telegram→`telegram_bot_token` mapping, per-field env fallback rules unchanged).

### S3 — Durable queue + pipeline generalization *(needs S0; parallel with S1/S2/S5)*
- **Owns**: `src/lib/messaging/inbound-queue.ts` (new), `src/lib/messaging/inbound-pipeline.ts`, `src/lib/messaging/buffer.ts` (new, if adopting AH's) **or** `src/lib/buffer/*` (if keeping Redis), `src/lib/media/inbound.ts` (new), `src/instrumentation.ts`, `src/lib/channels/router.ts` **only** `findOrCreateConversation` channel-param call-site contract (see boundary note) + tests.
- **Work**: port the queue + drain triggers; `setInboundTurnDispatcher` seam; replace `whatsappInboundMessage` unwrap with normalized-field reads; provider-agnostic channel threading; `provider.resolveMedia` media seam + `PROVIDER_MEDIA_DOMAINS`. **Boundary**: `insertMessage`/`findOrCreateConversation` signatures stay untouched here — sender-column stamping is S5's job via a shared helper; S3 keeps writing `role` (additive columns stay null).
- **Decision recorded**: Redis keep-or-drop per Area 4 row 1.

### S4 — Ingress + webhook routing *(needs S3's provider-agnostic pipeline)*
- **Owns**: `src/app/api/webhooks/ingress/[provider]/route.ts`, `src/lib/messaging/ingress.ts`, `src/app/api/meta/webhook/route.ts`, `src/app/api/meta/webhook/helpers.ts` + tests.
- **Work**: route all whatsapp-channel events (any provider) through `handleNormalizedEvent`; `ensureLeadIdentity` in passive persistence; enrich Meta webhook (echoes/statuses/media/deliveryIds); keep SC's fail-closed account resolution everywhere.

### S5 — Outbound correctness *(parallel with S1/S2/S3/S4; needs S0 columns)*
- **Owns**: `src/lib/whatsapp/outbound-window.ts` (new), `src/lib/whatsapp/order-status-notify.ts`, `src/lib/channels/router.ts` (`sendOutboundMessage`, `insertMessage` sender-column stamping, `stampConversationThreadId`), `src/app/(admin)/admin/conversations/actions.ts`, `src/app/(admin)/admin/orders/actions.ts`, `src/lib/telegram/order-lifecycle.ts` + tests.
- **Work**: window gate; persist-before-send; `sender_kind`/`sender_ref` honest attribution (operator vs agent); deterministic `order-status:<orderId>:<status>` idempotency; `providerConversationId` via `externalThreadId`; ordered identity lookup + BSUID guard; `account_provider_mismatch`. Keep media sends, `humanOverrideUntil`, legacy-credential path, SC order-status wording.
- **Collision note**: S3 must not edit `router.ts` beyond the agreed call-site contract; all router.ts internals belong to S5.

### S6 — Telegram canonical intake *(deferred — evaluate separately)*
- SC's dedicated telegram route is richer than AH's canonical path (media enrichment). Recommendation: **defer indefinitely or skip** — only revisit if telegram needs multi-account bot tokens (then port `botTokenEnc`-scoped resolution to `getTelegramConfigFromDB`, not the pipeline swap).

### Worktree layout
- Worktree A (serial): S0 → S3 → S4 (the durability/ingress track — tightly coupled).
- Worktree B (parallel): S1 — providers + connect UI.
- Worktree C (parallel): S2 — config chain. 
- Worktree D (parallel): S5 — outbound correctness.
- No two tracks own the same file; merges are import-compatible by construction.

## Verification gates (per phase, before claiming done)

1. `npm run test:agents`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build` (`NODE_OPTIONS=--max-old-space-size=8192` if heap-limited)
