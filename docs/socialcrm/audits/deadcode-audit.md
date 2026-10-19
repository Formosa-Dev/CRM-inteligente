# SocialCRM — Dead Code & Vestigial Artifact Audit

Status: read-only audit. Date: 2026-10-19.
Scope: `src/`, `scripts/`, root assets, `docs/`, `prompts/`, `package.json`.
Source files were not modified. The only artifact produced by this audit is this report.

## Method

1. Built a full import graph of `src/` + `scripts/` (static `import`, `from`, `import()`, `require()`),
   then ran BFS from real Next.js entry points (`page.*`, `layout.*`, `route.*`,
   `template.tsx`, `loading.tsx`, `instrumentation.ts`, `proxy.ts`) and from `scripts/`.
   Anything unreachable is listed as ORPHAN. Tests were run as a separate BFS root set to
   distinguish ORPHAN from TEST-REACHABLE.
2. For every exported symbol, counted references in every other file (including tests and
   scripts), then manually inspected each zero-reference candidate for internal use, dynamic
   imports, or framework entry-point semantics. A symbol is called DEAD only when it has no
   importer/caller outside its own file and is not used inside its own file.
3. Compared `src/db/schema.ts` against every query call site and against word-level references
   for each column.
4. Cross-checked routes against in-repo callers, webhook/provider configuration, `render.yaml`,
   and docs. Documented operator/manual endpoints are reported as PUBLIC-SEAM, not dead.
5. Cross-checked `package.json` dependencies against actual imports plus CSS/config usage.
6. Compared extracted helper/function names across files for duplicated implementations.

Confidence labels used below: **high** (zero importers, verified by graph + grep),
**medium** (no caller but externally reachable/documented), **low** (looks dead, manual verify).

---

## DEAD (safe to delete)

### D1. Legacy agent stack — `src/lib/agent/` (whole directory, 561 LOC)

| Path | Symbol |
|---|---|
| `src/lib/agent/index.ts:50` | `processMessage()` (only file with the legacy loop) |
| `src/lib/agent/conversation.ts:10` | `loadConversation()` |
| `src/lib/agent/conversation.ts:38` | `saveConversation()` |
| `src/lib/agent/buffer.ts:19` | `addToBuffer()` |
| `src/lib/agent/smart-split.ts:54` | `smartSplit()` |
| `src/lib/agent/system-prompt.ts:32` | `buildSystemPrompt()` |
| `src/lib/agent/tools.ts:10,46,102,121` | `checkHours`, `getMenu`, `checkDelivery`, `makeCaptureOrder` |

**Evidence:** `grep -rn "from \"@/lib/agent\"" src scripts` returns nothing; no relative importer
outside the directory; no dynamic `import("@/lib/agent...")`. The directory is only
self-referential (`index.ts` imports the other five files). The production paths are
`src/lib/whatsapp/agent.ts` + `src/lib/whatsapp/prompt-builder.ts` +
`src/lib/buffer/manager.ts`, which superseded this stack.
**Action:** delete the directory. Expect no build impact (nothing imports it).

### D2. Dead Telegram handler — `src/lib/telegram/handler.ts:25` (241 LOC)

`handleTelegramUpdate()` has zero importers. The live implementation is inline in
`src/app/api/telegram/webhook/[token]/route.ts` (auth + rate-limit + media + buffering +
`generateText`), which duplicates this file's logic. `src/lib/telegram/tools.ts` and
`prompt-builder.ts` are imported directly by the route, not through `handler.ts`.
**Evidence:** `grep -rn "telegram/handler\|from \"./handler\"\|handleTelegramUpdate" src` only
finds the declaration; graph BFS marks the file ORPHAN.
**Action:** delete; keep the route as the single implementation.

### D3. Dead WhatsApp splitter — `src/lib/whatsapp/smart-split.ts:6,43,48` (59 LOC)

`splitIntoBubbles`, `needsSmartSplit`, `formatAsWhatsAppBubbles` have zero importers (graph
ORPHAN). A second, live implementation already exists at
`src/lib/buffer/response-sender.ts:27` (`splitIntoBubbles`), which is what the Telegram route
uses. The legacy agent copy is `src/lib/agent/smart-split.ts` (D1).
**Action:** delete.

### D4. Dead circuit breaker — `src/lib/infra/circuit-breaker.ts:1,36` (36 LOC)

`CircuitBreaker` and `openaiCircuitBreaker` have zero importers; `@/lib/infra` is never
imported as a module. Retry/rate-limit behavior in production comes from
`src/lib/infra/rate-limit.ts` and provider-level retries.
**Action:** delete.

### D5. Dead queue producer/worker — `src/lib/queue/producer.ts:3,20`, `src/lib/queue/worker.ts:181,240` (302 LOC)

`enqueueMessage()` has zero callers (graph ORPHAN). `processNextMessage()` and
`startWorker()` are only imported by `src/lib/queue/worker.test.ts`;
`src/instrumentation.ts:8-9` starts the reconcile scheduler only, and `render.yaml` declares
web + cron services only (no worker process). Nothing ever pushes to `queue:messages`, so the
queue and DLQ are inert at runtime.
**Action:** delete `producer.ts` + `worker.ts` + `worker.test.ts`, or wire a real worker if the
queue is still intended. `dlq.ts` is kept only by the admin route (see P3).

### D6. Dead validation schema — `src/lib/validations/agent-config.ts:3,15` (15 LOC)

`agentConfigSchema` / `AgentConfigFormData` have zero importers. The admin form validates with
the inline Zod schema in `src/app/(admin)/admin/agent/actions.ts`.
**Action:** delete.

### D7. Dead attribution barrel — `src/lib/attribution/index.ts:1` (22 LOC)

The barrel has zero importers. Consumers import the file `src/lib/attribution.ts` directly
(`@/lib/attribution`) or the submodules (`ref-code`, `ref-code-sign`, `utm-capture`,
`constants`). Because `src/lib/attribution.ts` exists, `@/lib/attribution` resolves to the file,
never to this index.
**Action:** delete the barrel or delete the legacy file and update the three importers; do not
keep both.

### D8. Dead UI components (1,530 LOC)

All have zero importers in the reachability graph and no dynamic imports.

| Path | Export | Note |
|---|---|---|
| `src/components/attachments/attachment-gallery.tsx:118` | `AttachmentGallery` | Superseded by `components/messages/media-renderer.tsx` |
| `src/components/clients/clients-table.tsx:69` | `ClientsTable` | Superseded by `admin/clients/clients-view.tsx` |
| `src/components/hero/hero-section.tsx:12` | `HeroSection` | Storefront uses `home/landing-hero.tsx` |
| `src/components/home/empanadas-showcase.tsx:14` | `EmpanadasShowcase` | Storefront uses `carta-digital` / landing menu |
| `src/components/products/featured-products-section.tsx:22` | `FeaturedProductsSection` | Root of the dead product-card chain |
| `src/components/products/product-card.tsx:11` | `ProductCard` | Only imported by the dead section above |
| `src/components/products/product-grid.tsx:28` | `ProductGrid` | Only imported by the dead section above |
| `src/components/products/product-toggle.tsx:14` | `ProductToggle` | No importer |
| `src/components/products/quantity-stepper.tsx:12` | `QuantityStepper` | No importer |
| `src/components/products/upsell-modal.tsx:43` | `UpsellModal` | No importer |
| `src/app/(admin)/admin/conversations/conversations-table.tsx:75` | `ConversationsTable` | Page imports `conversations-inbox.tsx`, not this file |
| `src/components/ui/dialog.tsx:1` | Dialog primitives | No importer |
| `src/components/ui/dropdown-menu.tsx:1` | Dropdown primitives | No importer |
| `src/components/ui/tag-input.tsx:14` | `TagInput` | No importer |
| `src/hooks/use-tilt.ts:21` | `useTilt` | No importer |

**Action:** delete. If the UI primitives are deliberately kept as a design-system surface, move
them out of the app tree and document that decision (they are not used today).

### D9. Dead exports inside live modules

Each symbol below is exported but has zero references outside its own file, and is not called
inside its file.

| Path:line | Symbol | Evidence / note |
|---|---|---|
| `src/app/(admin)/admin/conversations/actions.ts:142` | `updateConversationStatus` | No UI/action consumer; status is not editable anywhere |
| `src/app/(admin)/admin/conversations/actions.ts:189` | `getConversation` | Unused server action |
| `src/app/(admin)/admin/conversations/actions.ts:204` | `getLeadByConversation` | Unused server action |
| `src/app/(admin)/admin/conversations/actions.ts:217` | `getOrdersByLead` | Unused server action |
| `src/app/(admin)/admin/telegram/actions.ts:205` | `saveTelegramConfigAction` | Only the four other actions are referenced from `telegram-config.tsx` |
| `src/lib/messaging/accounts.ts:509` | `listActiveAccounts` | No caller; admin loads accounts directly |
| `src/lib/meta/oauth.ts:81` | `decryptToken` | `encryptToken` is used by the callback; decrypt is never called (tokens are used only while minting) |
| `src/lib/media/downloader.ts:131` | `downloadTelegramMedia` | Duplicate of `downloadTelegramFile` in `telegram/bot.ts:40`, which is the one used |
| `src/lib/whatsapp/tools/prompt-security.ts:97` | `createPromptSecurityServer` | Only `detectInjection`/`sanitizeInput` are used |
| `src/lib/whatsapp/session-store.ts:262` | `initialSessionState` | No internal or external caller |
| `src/lib/whatsapp/anti-loop.ts:148` | `buildAntiLoopDirective` | No caller; `analyzeConversationState` builds the directive inline |
| `src/lib/attribution/ref-code.ts:16` | `encodeRefCode` | Legacy unsigned encoder; new links use `ref-code-sign.ts`. `decodeRefCode` is active |
| `src/lib/whatsapp/temporal-context.ts:81` | `isTodayArgentina` | No caller |
| `src/lib/whatsapp/temporal-context.ts:89` | `isWithinActiveWindow` | No caller |
| `src/lib/telegram/toolsSalesCoach.ts:183` | `classifyOrdersForWindows` | No caller, not even a test |
| `src/lib/logger.ts:33` | `logProcessing` | No caller |
| `src/lib/logger.ts:39` | `logError` | No caller |
| `src/lib/order-utils.ts:38` | `cleanPhone` | Deprecated wrapper; no caller |
| `src/lib/order-utils.ts:45` | `isValidPhone` | Deprecated wrapper; all callers import `phone-utils` |
| `src/lib/client-utils.ts:76` | `parseTags` | No caller |
| `src/lib/client-utils.ts:86` | `stringifyTags` | No caller |
| `src/lib/whatsapp.ts:21` | `buildProductWhatsAppURL` | No caller; `buildWhatsAppURL` is the live helper |
| `src/lib/constants.ts:37` | `WHATSAPP_MESSAGES` | No caller |
| `src/lib/constants.ts:109` | `BREAD_PRODUCTS` | No caller; bread data comes from the DB |
| `src/lib/animation-variants.ts:28` | `scaleIn` | No caller |
| `src/lib/animation-variants.ts:99` | `wordRevealContainer` | No caller |
| `src/lib/animation-variants.ts:106` | `wordReveal` | No caller |
| `src/lib/queue/dlq.ts:62` | `replayDLQMessage` | No caller and nothing enqueues (D5) |
| `src/types/client.ts:1,22,32` | `Client`, `ClientOrder`, `ClientTab` | Only `ClientStats` is imported (`client-utils.ts:1`) |
| `src/types/chat.ts:77,82` | `TagVariant`, `ContextPanelSection` | No references |

**Action:** delete the symbol (or wire it if the feature is intended, e.g.
`updateConversationStatus`). Low risk: all are additive exports.

### D10. Dead UI branch / broken redirect

- `src/proxy.ts:7-14` and `src/auth/index.ts:36` point unauthenticated admins to
  `/admin/login`, but no `src/app/admin/login` (or `src/app/(admin)/login`) route exists. The real
  page is `src/app/login/page.tsx`, and `src/app/(admin)/layout.tsx:14` redirects to `/login`.
  The proxy branch is unreachable/broken and the auth `signIn` page is a 404.
  **Action:** point both to `/login`.
- `src/app/(admin)/admin/conversations/[id]/page.tsx:99` reads
  `conversations.messages` (legacy JSONB). That column is written only by the dead
  `saveConversation` (D1); the live pipeline writes `chat_messages`. The page is reachable from
  `dashboard-actions.tsx:96` and therefore renders an empty/legacy thread. Its own inventory
  already labels it "legacy server-rendered reader" (`docs/agent-ux-inventory.md:44,219`).
  **Action:** delete the page (or reimplement it on `chat_messages`); then drop the column
  (V1).

### D11. Dead API routes (no in-repo caller, no webhook/config reference)

| Path:line | Route | Evidence |
|---|---|---|
| `src/app/api/leads/update/route.ts:9` | `POST /api/leads/update` | No `fetch`/client/action caller. Referenced only in historical SDD docs (`sdd/resolucion-consistencia/fase-d-whatsapp-api/*`) and not in any install/webhook guide. It is a broader duplicate of the `[id]` PATCH below |
| `src/app/api/leads/stats/route.ts:8` | `GET /api/leads/stats` | No caller anywhere; analytics pages use `src/lib/analytics/queries.ts` directly. Not in docs |
| `src/app/api/leads/[id]/route.ts:17` | `PATCH /api/leads/[id]` | No in-repo caller and no docs reference. Superseded in practice by the admin server actions (`admin/clients/actions.ts`) |

**Action:** delete. If an external CRM/webhook is known to call `POST /api/leads/update` or
`PATCH /api/leads/[id]`, keep only that one and document it as a public seam.

### D12. Orphan files and assets

**Exact duplicates (safe delete):**

| Path | Evidence |
|---|---|
| `assets/` (11 files, 5.7 MB) | Every file is byte-identical to `public/assets/<same path>` (SHA-1 verified). Next.js serves only `public/`; code references `/assets/...` URLs, which map to `public/assets/`. Root `assets/` is never read. |
| `public/images/products/*.png` (5 files) | Byte-identical to `public/assets/images/products/*.png`; no code references `/images/...` |
| `public/images/products/carne.html`, `carne.svg` | No reference anywhere |
| `public/next.svg`, `vercel.svg`, `globe.svg`, `window.svg`, `file.svg` | Default create-next-app assets, no reference in `src/` or CSS |
| `scripts/db-push-safe.sh` | Same fallback logic as `package.json` `db:push` (`drizzle-kit push --force ... \|\| echo skipped`); not wired |

**One-off / superseded scripts:**

| Path | Why |
|---|---|
| `scripts/apply-business-cols.ts` | One-off DDL; columns now in migration `0004_business_ai_config`; hardcodes another checkout's `.env` |
| `scripts/apply-integration-cols.ts` | One-off DDL; migration `0005_integration_secrets`; hardcodes old `.env` |
| `scripts/backfill-business.ts` | One-off data backfill; hardcodes old `.env` |
| `scripts/migrate-promos.mjs` | One-off promo columns/backfill; superseded by migrations |
| `scripts/add-prepizza-docena.mjs` | One-off product insert for an old catalog |
| `scripts/fix-catalog.ts` | One-off catalog repair; hardcodes old `.env` |
| `scripts/audit-images.ts` | One-off image audit; hardcodes old `.env` |
| `scripts/encrypt-secrets.ts` | One-off migration of plaintext secrets; runtime now encrypts on write |
| `scripts/verify-decrypt.ts` | Companion to the one-off above; hardcodes old `.env` |
| `scripts/dedupe-agent-config.ts` | One-off dedupe; unique indexes now enforce it; hardcodes old `.env` |
| `scripts/debug-hours.ts` | Ad-hoc debug script |
| `scripts/inspect-config.mjs` | Ad-hoc config dump; reads legacy `agent_config.id = 1` |
| `scripts/cash-backfill.ts` | One-off historical caja backfill; keep only if a historical install still needs it |

**Bundled portability defect:** the eight scripts above that call
`readFileSync("C:/Users/Asus/Documents/estabilizacion/Mrs Muzzarella/muzapp/.env")` are not
portable and silently depend on a developer machine path. Even the ones kept should switch to
`dotenv/config` + `DATABASE_URL`.

**Documented operators — keep (verified intentionally manual):**
`scripts/audit-sales-today.mjs`, `scripts/learn-style.ts`, `scripts/telegram-configure.mjs`,
`scripts/telegram-diagnose.mjs`, `scripts/lib/telegram-ops.mjs`.
`src/db/seed.ts` is the `npm run db:seed` entry point — keep.

**Orphan docs:**

| Path | Why |
|---|---|
| `prompts/infrastructure-upgrade-prompt.md`, `prompts/infrastructure-upgrade-corrected.md` | Plan a Redis queue + worker that was never wired (D5). Stale design artifact |
| `system-prompt-analysis.md`, `SYSTEM-PROMPT-V2.md` (root) | Working copies of the prompt; the live sources are `src/lib/whatsapp/seller-prompt.ts` and `prompt-builder.ts`. Not referenced by code/docs |
| `docs/JEV_TYPESAFE_MUZAPP_IMPLEMENTATION.md` | Historical implementation log; contains stale references to now-dead files (e.g. `telegram/handler`) |

**Action:** delete duplicates/assets and one-off scripts; archive the stale prompt docs under
`docs/archive/` if provenance matters. Verify `cash-backfill.ts` against the supported install
matrix before deleting.

---

## TEST-ONLY

| Path:line | Symbol / file | Why it is test-only |
|---|---|---|
| `src/lib/queue/worker.ts:181,240` | `processNextMessage`, `startWorker` | Only `src/lib/queue/worker.test.ts` imports the module; no production boot/wiring (see D5). The test keeps a dead production path alive |
| `src/lib/messaging/test-support/fake-db.ts:273,356` | `FakeDb`, `installFakeDb` | Intentional test support, used by lead-identity/security suites. Keep; document as test-only |
| `src/lib/ai/config.ts:133` | `getMainModel` | Only `src/lib/telegram/webhook-model.test.ts` uses it; the live route uses `getMainChatModel` |
| `src/lib/messaging/errors.ts:109` | `shouldRetryError` | Only `errors.test.ts`; no production caller |
| `src/lib/telegram/sales-coach.ts:335` | `isGuidanceMemory` | Only `sales-coach.test.ts`; no production caller |
| `src/lib/whatsapp/webhook-pipeline.ts:120` | `isEligibleInboundMessage` | Only `agent-consistency.test.ts`; the live pipeline checks eligibility elsewhere |

**Verdict:** `fake-db.ts` is legitimate test infrastructure. The other five are behavior that is
tested but not wired in production — either wire them or delete the export and its test.

---

## PUBLIC-SEAM (intentional?)

These have no in-repo caller but are reachable from outside the repo (webhooks, operators,
docs, deployment config). Do not delete without a product decision.

| Path | What | Evidence |
|---|---|---|
| `src/app/api/webhook/whatsapp/route.ts:1` | Legacy YCloud webhook alias re-exporting the canonical `GET/POST` | Documented in `docs/agent-ux-inventory.md:273`, `architecture-roadmap.md:37`, install guides |
| `src/app/api/whatsapp-phone/route.ts:5` | Public `GET { phone }` | Documented in `docs/agent-ux-inventory.md:277`; no in-repo caller |
| `src/app/api/agent/test/route.ts:5` | Operator config check | Documented in `docs/agent-ux-inventory.md:275`, `s13-agent-config-scope.md:56`; no UI caller |
| `src/app/api/admin/test-agent/route.ts:8` | Operator config + YCloud probe | Documented in `docs/agent-ux-inventory.md:276`; overlaps `/api/agent/test` (see U4) |
| `src/app/api/admin/dlq/route.ts:7,22` | Operator DLQ list/clear | Documented in `docs/agent-runtime-inventory.md:151`; **vestigial while D5 stands** (queue never produces) |
| `src/lib/attribution/index.ts:1` | Backward-compat barrel | Comment says "backward compat", but it is currently unused (D7). Keep only if external consumers import the package path |
| `src/lib/media/downloader.ts:35` | `downloadMedia` per-provider allowlist seam | Active through inbound pipeline; the seam itself is intentional |
| `src/proxy.ts:1` | Next 16 request proxy | Framework entry point (not dead), but its `/admin/login` target is broken (D10) |

---

## DUPLICATES (consolidation candidates — report only)

| # | Duplicate | Locations | Recommendation |
|---|---|---|---|
| U1 | Smart-split implementations (3) | `src/lib/buffer/response-sender.ts:27` (live), `src/lib/whatsapp/smart-split.ts:6` (dead), `src/lib/agent/smart-split.ts:54` (dead) | Delete the two dead copies; keep the buffer one |
| U2 | Buffering implementations (2) | `src/lib/buffer/manager.ts` (live, Redis+memory) vs `src/lib/agent/buffer.ts:19` (dead in-memory `setInterval`) | Delete the agent copy with D1 |
| U3 | Prompt builders (3) | `src/lib/whatsapp/prompt-builder.ts:520` (live), `src/lib/whatsapp/seller-prompt.ts` (live seller subset), `src/lib/agent/system-prompt.ts:32` (dead) | Delete the dead legacy builder |
| U4 | Config-test endpoints | `src/app/api/agent/test/route.ts` vs `src/app/api/admin/test-agent/route.ts` | One endpoint; unify or clearly document the difference |
| U5 | Telegram update processing | `src/lib/telegram/handler.ts:25` (dead) vs `src/app/api/telegram/webhook/[token]/route.ts:38` (live) | Delete the dead handler |
| U6 | Provider helpers (3 copies) | `asString`, `getHeader`, `isRecord`, `syntheticDeliveryId`, `toIsoTimestamp`, `extractMediaRefs`, `mapStatus`, `normalizeType` in `providers/kapso.ts:96-210`, `providers/ycloud.ts:71-216`, `providers/zernio.ts:110-141` | Extract a shared `providers/shared.ts`; keep each provider's genuine normalization differences |
| U7 | Phone helpers | `src/lib/order-utils.ts:38,45` (deprecated wrappers) vs `src/lib/phone-utils.ts:12,24` | Delete the wrappers; all callers already use `phone-utils` |
| U8 | Telegram file download (2) | `src/lib/telegram/bot.ts:40` (live) vs `src/lib/media/downloader.ts:131` (dead) | Delete `downloadTelegramMedia` |
| U9 | File-size/URL formatting (2) | `src/components/attachments/attachment-gallery.tsx:11,18` (dead) vs `src/components/messages/media-renderer.tsx:10,15` (live) | Delete with D8 |
| U10 | `getMenuData` (2) | `src/lib/whatsapp/prompt-builder.ts:153` vs `src/lib/whatsapp/seller-prompt.ts:62` | Same DB query; extract to one helper |
| U11 | `orderTotal` (2) | `src/lib/cash/session.ts:69` vs `src/lib/telegram/toolsAnalytics.ts:22` | Consolidate on one implementation |
| U12 | Ref-code codecs | `src/lib/attribution.ts` (legacy build/parse/extract) vs `src/lib/attribution/ref-code.ts` + `ref-code-sign.ts` | Retire the legacy codec once live links are migrated; keep signed verification |
| U13 | `sleep` (6 copies) | `buffer/processor.ts:5`, `buffer/response-sender.ts:14`, `media/transcription.ts:3`, `queue/worker.ts:24` (dead), `whatsapp/broadcast.ts:30`, `ycloud.ts:19` | Low priority; one shared `lib/utils/sleep.ts` |
| U14 | Date/time formatters (6+) | `caja-view.tsx:30,41`, `orders-view.tsx:40`, `leads-table.tsx:86`, `conversations/[id]/page.tsx:44`, `customer-context-panel.tsx:27`, `message-bubble.tsx:13`, `leads-chart.tsx:59` | Low priority; consolidate into `lib/client-utils.ts` (AR locale) |
| U15 | Login schema (2) | `src/lib/validations/auth.ts:3` (used by `login/actions.ts`) vs `src/auth/index.ts:10` (own copy) | Import the shared schema in `auth/index.ts` |

---

## UNUSED-DEPS

| Dependency | Type | Evidence | Action |
|---|---|---|---|
| `@types/bcryptjs@^2.4.6` | dev | No file imports it; `bcryptjs@3.0.3` ships its own TypeScript declarations. It is a leftover stub for bcryptjs 2.x | Remove after confirming `tsc --noEmit` still resolves `bcryptjs` types on a clean install |

**Everything else is used — explicitly verified:**

- `shadcn` is **not** unused: `src/app/globals.css:3` does `@import "shadcn/tailwind.css"`.
  (It is a CLI package in dependencies, but the CSS import makes it runtime-relevant; if the
  project prefers `shadcn` as a dev-only CLI, the Tailwind import must move first.)
- `tw-animate-css` — `src/app/globals.css:2`.
- `@tanstack/react-query` — `conversations-inbox.tsx` + `lib/conversations/queries.ts`.
- `pino` — `lib/logger.ts`; `pdf-parse` — `lib/media/document.ts` (dynamic import);
  `cloudinary` — media upload; `@upstash/ratelimit` — `lib/infra/rate-limit.ts`;
  `@upstash/redis` — `lib/buffer/redis.ts` + `lib/queue/dlq.ts`; `@base-ui/react` — UI
  primitives; `class-variance-authority`, `clsx`, `tailwind-merge` — UI/utils;
  `@ai-sdk/openai` + `ai` + `zod` — agent; `next-auth`, `bcryptjs`, `sonner`,
  `framer-motion`, `lucide-react`, `drizzle-orm`, `@neondatabase/serverless` — core.
- All devDependencies are used by config/scripts (`drizzle-kit`, `dotenv`, `tsx`, `eslint`,
  `eslint-config-next`, `@tailwindcss/postcss`, `tailwindcss`, `typescript`, `@types/*`).

---

## VESTIGIAL-SCHEMA

| Path:line | Column / object | Evidence | Suggested action |
|---|---|---|---|
| `src/db/schema.ts:296` | `conversations.messages` (jsonb) | Only writer is `saveConversation` (`src/lib/agent/conversation.ts:55,66`), which is dead (D1). Only reader is the legacy detail page (`conversations/[id]/page.tsx:99`), which shows an empty thread because the live pipeline writes `chat_messages`. | Delete the legacy page, then drop the column in a separate migration with the data-retention decision |
| `src/db/schema.ts:153` | `agent_config.menuImageUrlsPan` | Zero references anywhere outside `schema.ts` (not in admin form, not in tools, not in prompts) | Drop in a migration, or wire it into `sticker-tools` if the plural-pan gallery was intended |
| `src/db/schema.ts:365` | `conversation_session_events.inbound_hash` | Zero references anywhere outside `schema.ts`; the event insert at `session-store.ts` never sets it | Drop, or populate it if dedup-by-hash is still planned |

**Checked and not vestigial (may look suspicious):**
`conversations.whatsappId` is still used by `src/lib/channels/router.ts:109,140,488` for legacy
dedup; `externalThreadId`, `lastReconciledAt`, `lastMessagePreview` are read by live paths;
`leads.{refCode,utm*,ad*,campaignId,adsetId,platform,channel}` are written/read by
`/api/leads` and the admin tables; `attachments`, `addresses`, `orderContextItems`,
`agentMemories`, `channelEvents`, `cash*`, `reconcile*`, and the session-state tables all have
live readers and writers.

---

## Verified in-use (looked dead but aren't)

- `useCustomerOrders` and `OrderHistory` — active via
  `customer-context-panel.tsx:8` → `conversations-inbox.tsx:8`.
- `src/lib/whatsapp/tools/index.ts` — active through `src/lib/whatsapp/agent.ts:40`
  (`from "./tools"`); the individual tool files are reachable from that barrel.
- `formatPermittedSessionFacts`, `getCorePrompt`, `getProductionHours`, `getOperationalData`
  — internal to `prompt-builder.ts` (`:521-527`, `:627`); no external caller, but not dead.
- `matchCatalog` — internal to `order-utils.resolveItems` (`:71,85`); the test is extra.
- `looksLikePhone` — internal to `phoneMatches` in `phone-utils.ts`.
- `passiveMessageRole` — internal to `ingress.ts:397`.
- `getTelegramConfigFromEnv` — internal to `bot.ts:265`.
- `getAIProvider`, `isDeepSeekBaseUrl` — internal to `ai/config.ts:128-146`.
- `lastCashBoundary`, `nextCashBoundaryAfter`, `propagateOpening` — internal to
  `cash/session.ts:197-586`.
- `analyzeImage`, `raceVision` — internal to `media/vision.ts:119,155`.
- `sanitizeInput` — internal to `prompt-security.ts:55`.
- `getDLQMessages`, `clearDLQ` — used by `api/admin/dlq/route.ts` (but see D5).
- `src/db/seed.ts` — `npm run db:seed` entry point.
- `src/proxy.ts` — Next 16 framework entry point (the route it redirects to is the broken part).
- `src/lib/validation` date helpers (`normalize*`, `buildConversationConditions`) — internal to
  `conversations/filters.ts` and exercised through `conversationListWhere`.
- `src/lib/messaging/index.ts` barrel — imported by webhook/ingress/dashboard paths.
- `shadcn`, `tw-animate-css` — consumed by `src/app/globals.css`.

---

## Summary

| Category | Count | Notes |
|---|---|---|
| Dead modules/files | 8 + 15 components | ~2,766 LOC including the legacy agent dir, queue worker, handler, and unused UI |
| Dead exports in live modules | 33 | Mostly additive, no behavior change if removed |
| Dead/orphan routes | 3 (`/api/leads/update`, `/api/leads/stats`, `PATCH /api/leads/[id]`) | No in-repo caller, no webhook/config reference |
| Public seams kept | 8 | Documented operator/webhook/compat surfaces |
| Test-only | 6 | 1 intentional fixture, 5 unwired behaviors |
| Duplicates | 15 | Highest value: U1–U9 |
| Unused deps | 1 (`@types/bcryptjs`) | `shadcn` and `tw-animate-css` are used by CSS |
| Vestigial columns | 3 | `conversations.messages`, `agent_config.menu_image_urls_pan`, `conversation_session_events.inbound_hash` |
| Orphan assets | ~7.1 MB | Root `assets/` duplicate (5.7 MB) + `public/images` duplicate (~1.4 MB) + Next scaffold SVGs |

Highest-leverage cleanup order: (1) delete `src/lib/agent/`, `telegram/handler.ts`, and the
dead UI components; (2) delete the orphan asset duplicates and one-off scripts; (3) fix the
`/admin/login` redirect; (4) remove the three dead routes; (5) schedule the schema migration
for `conversations.messages` only after the legacy detail page is removed.
