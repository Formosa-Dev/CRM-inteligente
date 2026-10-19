# SocialCRM — Multichannel Provider Architecture Roadmap

**Decision up front:** evolve the current YCloud-hardcoded WhatsApp pipeline into a
provider-adapter messaging layer (`src/lib/messaging/`), keeping the installed
single-business product fully working at every step. YCloud stays the default
WhatsApp provider; Zernio (social channels) and Kapso (WhatsApp BSP) plug in
behind the same interface. Multitenancy is **not** built now, but every new
artifact carries a `tenantId` (constant `"default"`) so a future SaaS migration
is additive, not a rewrite.

Product context: SocialCRM is self-hosted, single-install software (Render +
Neon Postgres, one business per deployment, singleton `agent_config` row
`id=1`). It may be tailored/sold as a dedicated client installation. All
phases below preserve that model.

Source material: product requirements in `docs/socialcrm/multiprovider-source-spec.md`
(Spanish; treated as requirements input, not API authority). Verified current-state
facts below were read from code; provider claims that are only in the spec are
flagged **[RESEARCH]**.

---

## 1. Current state (verified from code)

| Area | Fact | Where |
|---|---|---|
| Inbound WhatsApp | Canonical route `POST/GET /api/whatsapp/webhook`; legacy alias `/api/webhook/whatsapp` re-exports it | `src/app/api/whatsapp/webhook/route.ts`, `src/app/api/webhook/whatsapp/route.ts` |
| Signature | `ycloud-signature` header `t=<ts>,s=<hmac>`, HMAC-SHA256 over `t.rawBody`, 300s anti-replay, timing-safe compare; missing secret → reject (fail closed) | `src/lib/whatsapp/signature.ts` |
| Outbound | **Two** YCloud clients: `sendWhatsAppMessage` (throws) and `sendText`/`sendImage`/`sendDocument` (retry + `{ok,wamid}`), all `POST /v2/whatsapp/messages/sendDirectly` with `X-API-Key` | `src/lib/whatsapp/ycloud-client.ts`, `src/lib/ycloud.ts` |
| Media in | `GET /v2/whatsapp/media/{id}` → `{url,mime_type,file_name}` → download → `public/uploads/`; domain allowlist `api.ycloud.com`, `cdn.ycloud.com`, `api.telegram.org` | `src/lib/media/downloader.ts` |
| Event filter | `whatsapp.inbound_message.received`; echo types `whatsapp.message.echo`, `whatsapp.smb.message.echoes` drive human-override detection | webhook route §2–3 |
| Pipeline | signature → protocol gate → echo → type whitelist → durable dedup (`platformMessageId`) → rate limit → config → actor (delivery/seller/customer) → conversation → lead capture → persist → session boundary machine → buffer (3s debounce) → agent → `sendWhatsAppBubbles` | webhook route; `docs/agent-runtime-inventory.md` §3 |
| Channel seam | `conversations.channel` enum `["whatsapp","telegram"]` + `externalUserId`; `sendOutboundMessage` already dispatches per channel | `src/lib/channels/router.ts`, `src/db/schema.ts` |
| Direct send call sites | broadcast, queue worker, followup cron, Telegram internal tools (`sendMessageAsOperator`, `sendWhatsAppMessage`), order creation, delivery notification, admin test | `broadcast.ts`, `queue/worker.ts`, `cron/followup`, `telegram/tools{WhatsApp,Management}.ts`, `whatsapp/tools/create-order.ts`, `channels/router.ts` |
| Credentials | `agent_config` singleton, AES-256-GCM at rest, DB→env fallback (`getYCloudApiKey`, `getIntegrationSecrets`) | `src/lib/integrations.ts`, `src/lib/encryption.ts` |
| Meta direct | `/api/meta/webhook` exists: GET verify token + POST `x-hub-signature-256` HMAC — **stub: persists messages, no agent** | `src/app/api/meta/webhook/route.ts` |
| Telegram | `/api/telegram/webhook/[token]` — ops/internal bot, **not** a customer channel provider | `src/app/api/telegram/webhook/[token]/route.ts` |
| DB driver | `neon-http` — **no interactive transactions**; concurrency via unique constraints + CAS | `src/lib/db/index.ts` |
| Tests | `node --test` via tsx; `agent-consistency.test.ts` pins webhook ordering **by reading route source** — brittle under refactor | `package.json`, `src/lib/agent-consistency.test.ts` |

---

## 2. Target architecture

```
                 ┌────────────────────────── unified ingress ──────────────────────────┐
 YCloud ───────► │ POST /api/webhooks/ingress/ycloud   (existing routes keep working    │
 Zernio ───────► │ POST /api/webhooks/ingress/zernio    and delegate here)              │
 Kapso ───────►  │ POST /api/webhooks/ingress/kapso                                    │
 Meta ─────────► │ (meta/webhook migrates later, unchanged contract)                    │
                 └───────┬─────────────────────────────────────────────────────────────┘
                         │ registry.get(provider).verifySignature → parseInbound → NormalizedInboundEvent[]
                         ▼
              channel ingress pipeline (provider-agnostic)
              dedup → rate-limit → actor → conversation → persist → session policy → buffer → agent
                         │
                         ▼ replies / proactive sends
              messenger.send(conversation|account, OutboundMessage)
                         │ resolves ChannelAccount → provider adapter
                 ┌───────┴────────┬──────────────┬─────────────┐
                 ▼                ▼              ▼             ▼
           YCloudAdapter   ZernioAdapter   KapsoAdapter   TelegramBotSender
           (whatsapp,sms)  (ig,fb,… wa?)   (whatsapp)     (internal ops — stays direct)
```

### 2.1 New module: `src/lib/messaging/`

| File | Responsibility |
|---|---|
| `types.ts` | `ProviderId`, `ChannelId`, `ChannelAccount`, `NormalizedInboundEvent`, `OutboundMessage`, `SendResult`, `MessagingProvider` interface |
| `registry.ts` | `getProvider(id)`, `listProviders()`; explicit map, no magic discovery |
| `accounts.ts` | `resolveChannelAccount({channel, provider?})` → default active account; credential resolution `channel_accounts → agent_config → env` |
| `messenger.ts` | `send()` facade — the only outbound entry point for app code |
| `providers/ycloud.ts` | wraps existing `signature.ts`, `ycloud-client.ts`, `ycloud.ts`, `downloader.ts` |
| `providers/zernio.ts`, `providers/kapso.ts` | added in Phase 4/5 |
| `provider-contract.test.ts` | shared contract suite every adapter must pass |

### 2.2 Core types (contract — freeze in Phase 0/1)

```ts
type ProviderId = "ycloud" | "zernio" | "kapso" | "meta" | "telegram";
type ChannelId  = "whatsapp" | "instagram" | "facebook" | "telegram" | "sms";

interface ChannelAccount {
  id: string;
  tenantId: string;                 // "default" — single install now; real tenancy later
  provider: ProviderId;
  channel: ChannelId;
  externalAccountId: string;        // WABA id / phone_number_id / provider account id
  displayAddress: string | null;    // E.164 phone or social handle
  credentials: EncryptedJson;       // { apiKey?, accessToken?, webhookSecret?, extra? }
  status: "active" | "disconnected" | "error";
  isDefault: boolean;
}

interface NormalizedInboundEvent {
  provider: ProviderId;
  channel: ChannelId;
  channelAccountId: string | null;
  kind: "message" | "echo" | "status" | "comment" | "unknown";
  providerEventId: string | null;
  senderId: string;                 // E.164 phone or provider-scoped social id
  senderName: string | null;
  messageId: string | null;         // provider-namespaced (see §3-C6)
  type: "text" | "image" | "audio" | "document" | "video" | "location" | "comment" | "other";
  text: string | null;
  media: { providerMediaId?: string; url?: string; mimeType?: string; fileName?: string; caption?: string } | null;
  location: { latitude: number; longitude: number; name?: string; address?: string } | null;
  raw: unknown;
}

interface MessagingProvider {
  id: ProviderId;
  channels: ChannelId[];
  verifySignature(a: { rawBody: string; headers: Headers; account: ChannelAccount | null }): boolean | Promise<boolean>;
  parseInbound(a: { rawBody: string; headers: Headers }): NormalizedInboundEvent[];   // array: providers may batch events
  send(account: ChannelAccount, msg: OutboundMessage): Promise<{ providerMessageId?: string; status: string }>;
  downloadMedia?(account: ChannelAccount, providerMediaId: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }>;
}
```

### 2.3 Routing rule (Phase ≥2)

`resolveChannelAccount` picks the `is_default` active account for a channel.
One field — `whatsappProvider: "ycloud" | "kapso" | "zernio"` — decides which
provider owns WhatsApp for the install (spec routing options A/B/C collapse to
a config choice, not code paths). Social channels have exactly one candidate
provider each, so no rule table is needed.

---

## 3. Compatibility constraints (installed single-business model)

These are hard requirements; a phase that breaks one is not done.

- **C1 — Webhook URLs never break.** `/api/whatsapp/webhook` **and** legacy
  `/api/webhook/whatsapp` keep serving identical behavior. The unified ingress
  is additive; old routes delegate into it. Existing YCloud dashboard configs
  and the Meta webhook keep working untouched.
- **C2 — `agent_config` remains writable from `/admin/agent`.** The admin UI is
  the credential editor for the installed product. New `channel_accounts`
  credentials are *resolved with priority* but `agent_config`/`env` stay valid
  fallbacks forever. No admin re-configuration may be required after upgrade.
- **C3 — DB migrations are additive only.** New table `channel_accounts`; new
  enum values appended to `channel` (`instagram`, `facebook`, `sms`, …). No
  renames, no drops, no rewrites of `conversations.whatsappId` (still populated
  for whatsapp rows; `externalUserId` is the forward-compatible key).
- **C4 — Fail-closed semantics preserved.** Missing webhook secret → 401;
  dedup/CAS/DB failure → silent 200 with no output; empty allowlist → deny.
  Adapters must not weaken this.
- **C5 — Secrets stay encrypted at rest.** `channel_accounts.credentials` uses
  the same AES-256-GCM `lib/encryption.ts` scheme; values never reach the
  client; `CLEAR` semantics unchanged.
- **C6 — Provider-namespaced message ids.** `chat_messages.platformMessageId`
  is globally unique and today holds bare YCloud ids — and the echo/own-send
  matching depends on that exact form. Rule: **YCloud keeps bare native ids**
  (compat); every *new* provider stores `${provider}:${nativeId}`. Each adapter
  owns id normalization both inbound and on the send-path id write-back.
- **C7 — Echo/human-override is WhatsApp-specific.** `handleEcho` semantics
  (human reply from Business App → `humanOverrideUntil`) stay bound to the
  YCloud adapter's `kind:"echo"` events; other providers may or may not
  produce echoes — per-provider research.
- **C8 — 24h-window / auto-reply policies are per-channel.** WhatsApp rules
  (`autoReply24h`, session policy) must not leak onto channels where they don't
  apply (Instagram has different reply windows — [RESEARCH]).
- **C9 — Telegram ops bot is out of scope of the provider model.** It is an
  internal tool channel (allowlisted chat ids), not a customer provider. A
  future Zernio-delivered *customer* Telegram channel would be a different
  account/channel row.
- **C10 — Source-reading tests updated in the same commit.** Any refactor that
  moves code pinned by `agent-consistency.test.ts` (ordering assertions read
  the route source) must update the test in the same work unit.
- **C11 — neon-http: no interactive transactions.** Backfills and dual-write
  use idempotent upserts / CAS like the rest of the codebase.
- **C12 — Media domain allowlist is per-provider.** `downloader.ts` adds
  provider CDN domains only when the corresponding adapter lands, never
  speculatively.

---

## 4. Provider capability & ownership matrix

Status: **V** = verified in repo code · **S** = spec claim only · **?** = unknown → Phase 0 research.

| Capability | YCloud | Zernio | Kapso | Meta direct |
|---|---|---|---|---|
| Channels | whatsapp, sms (V) | instagram, facebook, telegram, + more (S — exact list ?) | whatsapp (S) | whatsapp (stub, V) |
| Send text | V `sendDirectly` | ? | ? | not implemented |
| Send image/doc | V | ? | ? | — |
| Send template | not used in code (V) | ? | ? | — |
| Inbound webhook | V `whatsapp.inbound_message.received` | S `message.received`, `comment.received` | S `message.received` per phone number | V (`messages` persisted) |
| Signature | V HMAC-SHA256 `t,s` header | S HMAC-SHA256 (header name ?) | ? (spec adapter implies Meta-shaped payload) | V `x-hub-signature-256` |
| Echo/own-message events | V (`*.echo` types) | ? | ? | n/a |
| Media download API | V `/v2/whatsapp/media/{id}` | ? | ? | — |
| Onboarding | manual WABA + API key (V) | S OAuth dashboard/API | S embedded signup links, number pools | OAuth flow exists (V) |
| Agentic extras | — | S MCP server, `@zernio/node` SDK (? exists?) | S MCP server, human handoff, managed billing | — |
| **Owns (target)** | `providers/ycloud.ts` | `providers/zernio.ts` | `providers/kapso.ts` | `providers/meta.ts` (later) |

### Research items (Phase 0 deliverable — none of these may be coded as fact)

1. Zernio: API base URL & auth scheme; webhook signature header/payload format;
   exact event names & payload shapes; whether `@zernio/node` exists and is
   maintained; per-channel capability list (IG DMs vs comments vs story
   replies); outbound send API shape; rate limits; pricing/tenancy model.
2. Kapso: webhook endpoint format & signature scheme; payload shape (spec's
   Meta-`entry[]`-shaped guess is unverified); send message API; embedded
   signup link generation API; multi-number account model; billing model
   implications for a single self-hosted install.
3. Both: do inbound ids collide with YCloud id space (drives C6 namespacing);
   delivery-status event shapes (needed to keep `sent/delivered` semantics).
4. Verify whether Zernio can also carry WhatsApp (spec option C) — if yes, the
   `whatsappProvider` config gains a third value; if no, document the limit.

---

## 5. Phases (dependency-aware)

```
P0 research ──┐
              ├─► P1 messaging-core + YCloudAdapter ─► P2 channel_accounts ─► P4 Zernio ─┐
              │            └─────────────────────────► P3 unified ingress ──► P5 Kapso ──┴─► P6 per-channel inbox/policy
              └─► (P1 contract freeze informed by P0, but P1 may start with YCloud-only facts)
```

### Phase 0 — Provider API research (no product code)

- Deliverable: `docs/socialcrm/provider-research.md` answering §4 items with
  links to official docs; freeze `NormalizedInboundEvent`/`OutboundMessage`.
- Commit: `docs(socialcrm): add provider api research notes`
- Verify: doc review; contract types compile-checked in P1.

### Phase 1 — Messaging core + YCloudAdapter (pure refactor, zero behavior change)

- Create `lib/messaging/{types,registry,accounts,messenger}.ts`.
- `providers/ycloud.ts` wraps existing send/signature/parse/media functions
  **without moving them yet** (delegation first, extraction later if useful).
- Switch all direct send call sites to `messenger.send`: `broadcast.ts`,
  `queue/worker.ts`, `cron/followup`, `toolsWhatsApp.ts`, `toolsManagement.ts`,
  `create-order.ts`, `channels/router.ts`, webhook route reply paths,
  `response-sender.ts` (bubble sender takes a `send` fn, stays channel-aware).
- Refactor webhook route: extract YCloud payload→`NormalizedInboundEvent`
  parsing into the adapter; route keeps identical gate order.
- Work units:
  1. `feat(messaging): add provider abstraction core and ycloud adapter` (types + adapter + contract test; nothing references it — safe additive)
  2. `refactor(whatsapp): route outbound sends through messaging facade` (call sites; tests updated same commit per C10)
  3. `refactor(whatsapp): extract inbound parsing into ycloud adapter` (webhook route slimmed; ordering tests updated same commit)
- Verify: `npm run test:agents` green (incl. updated consistency test),
  `typecheck`, `lint`, `build`; new `provider-contract.test.ts` +
  `ycloud-adapter.test.ts` with recorded real-payload fixtures (inbound text/
  image/audio/location/echo/status; signature ok/bad/expired).
- Rollback: each commit is independently revertable; commit 1 alone is inert.

### Phase 2 — `channel_accounts` schema + credential resolution

- Drizzle additive migration: `channel_accounts` table (+ `tenant_id text
  not null default 'default'`, unique `(tenant_id, provider, channel,
  external_account_id)`, `is_default` partial unique per `(tenant_id,channel)`);
  extend `channel` enum values needed by Phase 4 (`instagram`, `facebook`,
  `sms` can wait for the phase that needs them — additive each time).
- Idempotent backfill: derive the `ycloud/whatsapp` account row from
  `agent_config` id=1 at boot or first resolve (lazy, C11-safe upsert).
- `accounts.ts` resolver: `channel_accounts → agent_config → env`; messenger
  resolves account per send. `whatsappProvider` config field added to
  `agent_config` (default `ycloud`).
- Work units:
  1. `feat(db): add channel_accounts table and channel enum extensions` (schema + migration only)
  2. `feat(messaging): resolve credentials via channel_accounts with legacy fallback` (resolver + backfill + tests)
  3. `feat(admin): read-only channel status in agent page` (optional slice — shows resolved accounts)
- Verify: migration idempotent on fresh + existing DBs; gates green; resolver
  tests cover fallback order and encrypted round-trip (C5).

### Phase 3 — Unified ingress route

- `POST /api/webhooks/ingress/[provider]`: provider lookup → `verifySignature`
  → `parseInbound` → shared pipeline → per-kind dispatch (message/echo/
  status/comment). `/api/whatsapp/webhook` + legacy alias delegate to
  `ingress("ycloud")` internally — same gates, same 200/401 semantics.
- Keep the route thin: pipeline lives in `lib/messaging/inbound-pipeline.ts`
  so route files stay provider-free.
- Work units:
  1. `feat(messaging): add unified webhook ingress route with ycloud dispatch`
  2. `refactor(whatsapp): delegate existing webhook routes to ingress` (+C10 test updates)
- Verify: signature negative tests per provider hook; e2e-style fixture POST
  against both old and new paths asserting identical DB effects; gates green.

### Phase 4 — Zernio adapter (social channels)

- Blocked by P0 findings. Implements `verifySignature`/`parseInbound`/`send`/
  `downloadMedia` for instagram/facebook first; `comment` events land as
  `kind:"comment"` and route to inbox without the WhatsApp session machine.
- Admin: Zernio credential fields + account row creation from `/admin/agent`
  (or a new `/admin/channels` section); `channel` enum extension migration.
- Work units (each gated on the previous):
  1. `feat(messaging): add zernio adapter (signature + inbound parse)` + fixtures
  2. `feat(db): extend channel enum for social channels` + `feat(admin): zernio account config`
  3. `feat(messaging): zernio outbound send + media download`
  4. `feat(inbox): render instagram/facebook conversations` (admin UI slice)
- Verify: contract suite vs Zernio adapter; fixture replays per event kind;
  signature negatives; dedup namespacing test (C6); gates green.

### Phase 5 — Kapso adapter (WhatsApp alternate provider)

- Blocked by P0. `whatsappProvider: "kapso"` switches WhatsApp to Kapso while
  preserving every pipeline guarantee; embedded-signup onboarding is a
  separate, later slice (research first — may not fit single-install).
- Work units:
  1. `feat(messaging): add kapso adapter (signature + parse + send)` + fixtures
  2. `feat(messaging): whatsapp provider switch via whatsappProvider config`
  3. (optional, later) `feat(admin): kapso embedded signup onboarding`
- Verify: contract suite; parity test — same normalized event from ycloud and
  kapso fixtures produces identical conversation/message effects; gates green.

### Phase 6 — Per-channel policy & inbox maturity

- Channel-aware inbound policies (reply windows per channel rules, comment→DM
  flows), per-account status surfacing in admin, multi-account support only if
  a real install needs >1 WhatsApp number.
- Scope set after P4/P5 experience. Verify per slice.

---

## 6. First implementation slice (safe to start now)

**Slice = Phase 1, work unit 1.** Exactly:

- New files only: `src/lib/messaging/types.ts`, `registry.ts`,
  `providers/ycloud.ts` (delegates to existing `lib/ycloud.ts`,
  `whatsapp/ycloud-client.ts`, `whatsapp/signature.ts`, `media/downloader.ts`),
  `provider-contract.test.ts`, `providers/ycloud.test.ts` with recorded
  fixtures, and a barrel `src/lib/messaging/index.ts`.
- **Zero edits to existing files** → no behavior change; commit is fully
  revertable; nothing references the module until work unit 2.
- Commit: `feat(messaging): add provider abstraction core and ycloud adapter`.
- Verify before commit: `npm run test:agents`, `npm run typecheck`,
  `npm run lint`, `npm run build` (all must pass; the new tests join
  `test:agents` in work unit 2 when the facade lands).

Why this slice: it freezes the contract every later phase depends on, proves
the adapter shape against the one provider whose behavior is fully known from
code, and cannot regress the installed product.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Source-reading consistency tests pin the 1184-line webhook route | Refactor silently breaks or needs big test churn | C10: update tests in same commit; migrate pinning to behavioral assertions over time |
| Provider API facts in spec are unverified (all of Zernio/Kapso) | Building to the spec could produce dead code | Phase 0 gates P4/P5; adapters land only after research confirms shapes |
| Echo/override semantics are YCloud-specific | New providers may not emit echoes → human replies via native apps go undetected | Per-provider `kind:"echo"` mapping; document unsupported case; admin shows "override detection: unsupported" |
| `platformMessageId` collisions across providers | Dedup/eof matching corruption | C6 namespacing for new providers; parity tests |
| Credential migration bugs | Installed installs lose sending ability | C2 fallback order never removed; lazy backfill (C11); encrypted round-trip tests |
| `channel` enum extension locks enum values | Postgres enum values can't be dropped | Add values only when the consuming phase lands |
| Unified ingress changes 200/401 semantics | Provider retry storms or silent drops | Fixture e2e asserting identical responses on old+new paths; keep fail-closed |
| `tenantId` theater | Fake multitenancy now → wrong assumptions later | Column exists but stays `"default"`; no tenant-scoped queries beyond it; document that real tenancy is a future additive migration |
| Media allowlist sprawl | SSRF surface grows | C12: add provider domains only with the adapter |
| Single process + Upstash-optional buffer under multi-channel load | Debounce keys collide across channels | Buffer keys already include channel (`enqueue(channel, userId)`); verify per-channel isolation in P4 tests |

## 8. Non-goals

- **No multitenancy** — no tenant provisioning, row-level isolation, billing,
  or per-tenant admin. `tenantId` exists only as a forward-compatible column.
- No Kapso managed-billing / credit-line features.
- No MCP server integrations in this roadmap (spec mentions them; revisit after
  the messaging layer is stable).
- No migration of the internal Telegram ops bot into the provider model (C9).
- No changes to the session boundary machine, agent prompts/tools, checkout,
  cash, reconcile, or storefront.
- No template-message management UI (YCloud templates aren't used today).
- No removal of `agent_config` credential fields or env fallbacks.
- No Meta-direct WhatsApp completion beyond keeping the existing stub working.

## 9. Open decisions (resolve in P0/P1)

1. Whether `parseInbound` batches (spec implies Kapso/Meta may send `entry[]`)
   — the interface already returns an array; confirm per provider.
2. Whether WhatsApp via Zernio is real (spec option C) — decides the third
   `whatsappProvider` value.
3. Where per-channel policy config lives (`agent_config` jsonb vs a future
   `channel_policies` table) — decide at P6 with real requirements.
4. Whether Kapso embedded signup makes sense for a self-hosted single-install
   product, or only matters in a future hosted offering.
