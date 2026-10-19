# SocialCRM — Multichannel Provider Architecture Roadmap

**Decision up front:** evolve the current YCloud-hardcoded WhatsApp pipeline into a
provider-adapter messaging layer (`src/lib/messaging/`), keeping the installed
single-business product fully working at every step. YCloud stays the default —
and for v1 the only wired — WhatsApp provider; Zernio (social channels) and a
Kapso spike plug in behind the same interface.

**v1 scope (explicit decision, CR-6):** v1 = frozen canonical contract (§2.2) +
`YCloudAdapter` + outbound facade + inbound parse extraction, with zero
behavior change. `channel_accounts` and the unified ingress are **built only
when a second provider is approved** — until then the registry hard-codes
`whatsapp → ycloud` and credentials resolve from `agent_config`/`env`. Kapso is
**spike only** (no production wiring, no embedded signup). Every new artifact
carries `tenantId` (constant `"default"`) so a future SaaS migration is
additive, not a rewrite — but no tenant logic is built.

Product context: SocialCRM is self-hosted, single-install software (Render +
Neon Postgres, one business per deployment, singleton `agent_config` row
`id=1`). It may be tailored/sold as a dedicated client installation. All
phases below preserve that model.

Source material: product requirements in `docs/socialcrm/multiprovider-source-spec.md`
(Spanish; treated as requirements input, not API authority — tracked on `main`
≥ `fe04b2b`; untracked in this worktree). Provider API facts are sourced from
`docs/socialcrm/provider-integration-evidence.md` (official docs fetched
2026-10-18); items it could not verify are marked **[RESEARCH]**. Findings
from `docs/socialcrm/roadmaps-review.md` are folded in below.

---

## 1. Current state (verified from code)

| Area | Fact | Where |
|---|---|---|
| Inbound WhatsApp | Canonical route `POST/GET /api/whatsapp/webhook`; legacy alias `/api/webhook/whatsapp` re-exports it | `src/app/api/whatsapp/webhook/route.ts`, `src/app/api/webhook/whatsapp/route.ts` |
| Signature | `ycloud-signature` header `t=<ts>,s=<hmac>`, HMAC-SHA256 over `t.rawBody`, 300s anti-replay, timing-safe compare; missing secret → reject (fail closed) | `src/lib/whatsapp/signature.ts` |
| Outbound | **Two** YCloud clients: `sendWhatsAppMessage` (throws) and `sendText`/`sendImage`/`sendDocument` (retry + `{ok,wamid}`), all `POST /v2/whatsapp/messages/sendDirectly` with `X-API-Key` | `src/lib/whatsapp/ycloud-client.ts`, `src/lib/ycloud.ts` |
| Media in | `GET /v2/whatsapp/media/{id}` → `{url,mime_type,file_name}` → download → `public/uploads/` (ephemeral on Render — durable store needed before Zernio media) | `src/lib/media/downloader.ts` |
| Event filter | `whatsapp.inbound_message.received`; echo types `whatsapp.message.echo`, `whatsapp.smb.message.echoes` drive human-override detection | webhook route §2–3 |
| Pipeline | signature → protocol gate → echo → type whitelist → durable dedup (`platformMessageId`) → rate limit → config → actor (delivery/seller/customer) → conversation → lead capture → persist → session boundary machine → buffer (3s debounce) → agent → `sendWhatsAppBubbles` | webhook route; `docs/agent-runtime-inventory.md` §3 |
| Channel seam | `conversations.channel` enum `["whatsapp","telegram"]` + `externalUserId`; `sendOutboundMessage` already dispatches per channel; `Channel` union + `BUFFER_CONFIG` cover the same two channels | `src/lib/channels/router.ts`, `src/db/schema.ts`, `src/lib/buffer/config.ts` |
| **All direct-send call sites** | broadcast · queue worker · followup cron · Telegram internal tools (`sendMessageAsOperator`, `sendWhatsAppMessage`) · order creation + delivery notification · `sendOutboundMessage` router · webhook reply paths + `sendWhatsAppBubbles` · **admin dashboard reply + media** (`dashboard-actions-server.ts:72,89-92`) · **order status notifications** (`orders/actions.ts:189-190,239-240`) | `broadcast.ts`, `queue/worker.ts`, `cron/followup`, `telegram/tools{WhatsApp,Management}.ts`, `whatsapp/tools/create-order.ts`, `channels/router.ts`, `buffer/response-sender.ts`, the two admin action files |
| Not a sender | `src/app/api/agent/test/route.ts` only checks `ycloudApiKey` presence — it never sends | `src/app/api/agent/test/route.ts:29` |
| Credentials | `agent_config` singleton, AES-256-GCM at rest, DB→env fallback (`getYCloudApiKey`, `getIntegrationSecrets`); admin UI writes **only** `agent_config` | `src/lib/integrations.ts`, `src/lib/encryption.ts`, `admin/agent/actions.ts` |
| Meta direct | `/api/meta/webhook` exists: GET verify token + POST `x-hub-signature-256` HMAC — **stub: persists messages, no agent** | `src/app/api/meta/webhook/route.ts` |
| Telegram | `/api/telegram/webhook/[token]` — ops/internal bot, **not** a customer channel provider | `src/app/api/telegram/webhook/[token]/route.ts` |
| DB driver | `neon-http` — **no interactive transactions**; concurrency via unique constraints + CAS | `src/db/index.ts` |
| Tests | `node --test` via tsx; `test:agents` wires **13 of 14** test files on disk (`src/lib/whatsapp/web-order-redirect.test.ts` is missing); `agent-consistency.test.ts` pins webhook ordering **by reading route source** — brittle under refactor | `package.json`, `src/lib/agent-consistency.test.ts` |

---

## 2. Target architecture

```
                 ┌──────────────── unified ingress (Phase 3, gated on provider #2) ────────────────┐
 YCloud ───────► │ POST /api/webhooks/ingress/ycloud  (v1: existing /api/whatsapp/webhook stays    │
 Zernio ───────► │ POST /api/webhooks/ingress/zernio   the binding; ingress delegates when built)  │
 Kapso ───────►  │ POST /api/webhooks/ingress/kapso                                               │
 Meta ─────────► │ (meta/webhook migrates later, unchanged contract)                               │
                 └───────┬─────────────────────────────────────────────────────────────────────────┘
                         │ registry.get(provider).verifyWebhook → parseWebhook → NormalizedInboundEvent[]
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
           (whatsapp)      (ig,fb,… wa?)   (whatsapp —     (internal ops —
                                          spike only)     stays direct)
```

**Ingress path (W-1, decided):** the one canonical path is
`/api/webhooks/ingress/[provider]` — a Next.js dynamic segment (`[provider]`
directory, not `:provider` express syntax). The source brief's
`/api/v1/webhooks/ingress/:provider` is rejected: the app has no `/api/v1`
surface and no API versioning policy is adopted.

### 2.1 New module: `src/lib/messaging/`

| File | Responsibility |
|---|---|
| `types.ts` | Canonical contract types (§2.2) — the only definition site |
| `registry.ts` | `getProvider(id)`, `listProviders()`; explicit map, no magic discovery. v1: `whatsapp → ycloud` hard-coded |
| `accounts.ts` | `resolveChannelAccount({channel, provider?})` → default active account; credential resolution rules in C13 |
| `messenger.ts` | `send()` facade — the only outbound entry point for app code |
| `providers/ycloud.ts` | wraps existing `signature.ts`, `ycloud-client.ts`, `ycloud.ts`, `downloader.ts` |
| `providers/zernio.ts`, `providers/kapso.ts` | Phase 4 / Phase 5 |
| `provider-contract.test.ts` | shared contract suite every adapter must pass |

### 2.2 Canonical provider contract (single source of truth — CR-1)

This is the **one canonical contract**, adopted from
`provider-integration-evidence.md` §4 (verified against official provider docs
2026-10-18) with two deltas: `tenantId` added to `ChannelAccount`, and
`comment` removed from the channel union — it is an **event kind**, not a
channel (W-14). Where the source brief §4.1 (`IMessagingProvider`) or any
other document differs, **this contract wins**.

```ts
type ProviderId = "ycloud" | "zernio" | "kapso";
type ChannelId =
  | "whatsapp" | "instagram" | "facebook" | "messenger"
  | "telegram" | "sms";                       // no "comment" — that's an event kind
type EventKind =
  | "message.received" | "message.echo" | "message.status"
  | "comment.received" | "account.lifecycle" | "other";

interface ChannelAccount {
  id: string;
  tenantId: string;                  // constant "default" in v1 — multitenant migration path only
  provider: ProviderId;
  channel: ChannelId;
  /** ycloud: sender E.164 · zernio: accountId · kapso: phoneNumberId */
  providerAccountId: string;
  /** E.164 phone (WhatsApp/SMS) or page/handle id (social) */
  senderAddress: string;
  /** AES-256-GCM encrypted at rest (lib/encryption.ts) */
  credentials: { apiKey: string; webhookSecret: string; accessToken?: string };
  status: "active" | "disconnected" | "error";
}

interface OutboundMessage {
  to: string;                        // E.164 phone, BSUID, or social user id
  type: "text" | "image" | "document" | "template" | "interactive";
  text?: string;
  mediaUrl?: string;                 // public link; adapters may upload first
  template?: { name: string; language: string; components?: unknown[] };
  interactive?: unknown;             // provider-native passthrough
  replyToMessageId?: string;
  idempotencyKey?: string;           // → ycloud externalId / zernio Idempotency-Key
}

type SendResult =
  | { ok: true; providerMessageId: string; status: string }
  | { ok: false; error: string; retryable: boolean };

interface NormalizedInboundEvent {
  provider: ProviderId;
  /** delivery-level dedup key: evt_* | X-Zernio-Event-Id | X-Idempotency-Key */
  deliveryId: string;
  kind: EventKind;
  direction: "inbound" | "outbound" | "na";
  /** routing key: wabaId | zernio accountId | kapso phone_number_id */
  providerAccountId: string;
  providerConversationId?: string;   // zernio conversationId / kapso conv.id
  platformMessageId?: string;        // wamid / mid — durable message dedup (rule: C6)
  sender: {
    phone?: string; bsuid?: string; parentBsuid?: string;
    username?: string; socialId?: string; name?: string;
  };
  type?: "text" | "image" | "audio" | "video" | "document"
       | "location" | "sticker" | "interactive" | "reaction" | "unknown";
  text?: string;
  mediaRefs?: { id?: string; url?: string; refreshUrl?: string;
                mimeType?: string; filename?: string }[];
  replyToMessageId?: string;
  status?: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  raw: unknown;
}

interface MessagingProvider {
  readonly id: ProviderId;
  /** 'timestamped-hmac' (ycloud t.s) vs 'raw-body-hmac' (zernio, kapso) */
  readonly signatureScheme: "timestamped-hmac" | "raw-body-hmac";
  verifyWebhook(input: {
    headers: Record<string, string>;
    rawBody: string;
    secret: string;
  }): { ok: boolean; reason?: string };
  /** Returns an ARRAY — Kapso can deliver batched envelopes. */
  parseWebhook(input: {
    headers: Record<string, string>;
    rawBody: string;
  }): NormalizedInboundEvent[];
  sendMessage(account: ChannelAccount, msg: OutboundMessage): Promise<SendResult>;
  /** W-2: kept — Zernio WhatsApp first contact requires a template. */
  sendTemplate?(account: ChannelAccount, msg: OutboundMessage): Promise<SendResult>;
  resolveMedia?(account: ChannelAccount, ref: { id?: string; url?: string; refreshUrl?: string }):
    Promise<{ url: string; mimeType?: string; filename?: string }>;
}
```

Contract rules (from evidence §4 — binding on every adapter):

1. `request.text()` first, verify signature, then `JSON.parse` — all three
   providers sign the raw body.
2. Signature variants: YCloud `t=...,s=...` over `{t}.{body}` + ~300s
   tolerance + `timingSafeEqual`; Zernio/Kapso raw-body hex HMAC-SHA256 +
   `timingSafeEqual` (Zernio `X-Late-Signature` accepted as alias).
3. Two durable dedup keys: `deliveryId` (event/delivery level) and
   `platformMessageId` (message level; rule C6 for namespacing).
4. `parseWebhook` returns an array (Kapso batches; YCloud sends one event
   per POST).
5. Zernio sends are conversation-scoped (`POST /v1/inbox/conversations`,
   cached per `(accountId, to)`); YCloud/Kapso send direct to recipient.
   **[RESEARCH]** full Zernio conversation-create request shape.
6. Echo/status map to `kind: "message.echo"`/`"message.status"`,
   `direction` set; status events never trigger agent work.
7. `sender.bsuid` is first-class — never assume `sender.phone` exists
   (Meta's BSUID migration; drives §2.4).
8. Media: use `resolveMedia`/`refreshUrl`, never expiring signed URLs.

### 2.3 Routing rule

- **v1:** the registry hard-codes `whatsapp → ycloud`. A single
  `whatsappProvider` config field is the eventual switch — its only accepted
  value in v1 is `"ycloud"`; accepting `"kapso"`/`"zernio"` is the
  provider-approval gate, not a v1 build. **No routing matrix** is built.
- Social channels resolve to the one provider that offers them (Zernio) once
  approved — no rule table needed.

### 2.4 Social identity & schema migration plan (required before Phase 4 — CR-4)

Phone-less identities (Instagram/Facebook DMs, comments, BSUID-only senders)
cannot be modeled today: `conversations.whatsappId` is `notNull().unique()`,
`leads.phone` is `notNull().unique()`, `Channel`/`BUFFER_CONFIG`/the `channel`
pgEnum only know `whatsapp|telegram`. Design decisions:

1. **`lead_identities` table (chosen over bare `leads.phone` nullable alone):**
   `(id, leadId FK, channel ChannelId, externalId text, createdAt)` unique
   `(channel, externalId)`. Phone stays the primary key for WhatsApp leads;
   social leads get `leads.phone = NULL` + one `lead_identities` row.
   Migration: `ALTER leads.phone DROP NOT NULL` + replace the unique
   constraint with a **partial unique index** `WHERE phone IS NOT NULL`
   (non-destructive — corrects the "additive only" claim, see C3).
   `autoLinkLeadToConversation`/`autoAttachToLead` become channel-aware:
   lookup `lead_identities(channel, externalId)` first, `leads.phone` fallback.
2. **Synthetic conversation key:** `conversations.whatsappId` keeps its
   current values (back-compat) and receives `"${channel}:${externalUserId}"`
   for new channels (`ig:…`, `fb:…`, `msg:…`) — same convention as today's
   `tg_` synthesis. Column semantics = "channel conversation key"; renaming
   the column is a later optional migration, not required.
3. **Channel plumbing:** extend `channel` pgEnum (additive values:
   `instagram`, `facebook`, `messenger`, `sms`), `Channel` union in
   `channels/router.ts`, and `BUFFER_CONFIG` per channel (IG/FB debounce
   values TBD in Phase 4; comments may bypass the buffer entirely).
4. **Fixture gate:** a phone-less Instagram `message.received` fixture must
   create conversation + `lead_identities` row + dedup correctly before any
   Zernio send work lands.

---

## 3. Compatibility constraints (installed single-business model)

These are hard requirements; a phase that breaks one is not done.

- **C1 — Webhook URLs never break.** `/api/whatsapp/webhook` **and** legacy
  `/api/webhook/whatsapp` keep serving identical behavior. In v1 they remain
  the YCloud binding; when the unified ingress is built they delegate into it.
  Existing YCloud dashboard configs and the Meta webhook keep working untouched.
- **C2 — `agent_config` remains writable from `/admin/agent` — and wins.** The
  admin UI is the credential editor for the installed product. For the legacy
  `ycloud/whatsapp` account, resolution **prefers `agent_config`** over
  `channel_accounts` (C13) so admin edits are never shadowed.
- **C3 — Migrations are additive or non-destructive.** New tables
  (`channel_accounts`, `lead_identities`); new enum values appended to
  `channel`; new nullable columns (`conversations.channelAccountId`).
  **Exception:** `leads.phone` drops `NOT NULL` and its unique constraint
  becomes a partial unique index — a non-destructive widening required by
  §2.4. No renames, no drops, no rewrites of `conversations.whatsappId`
  (still populated; `externalUserId` is the forward key).
- **C4 — Fail-closed semantics preserved.** Missing webhook secret → 401;
  dedup/CAS/DB failure → silent 200 with no output; empty allowlist → deny.
  Adapters must not weaken this.
- **C5 — Secrets stay encrypted at rest.** `channel_accounts.credentials` and
  any new `agent_config` secret fields use the same AES-256-GCM
  `lib/encryption.ts` scheme; values never reach the client; `CLEAR`
  semantics unchanged.
- **C6 — Dedup ids are per-channel, not per-provider (W-4).**
  **WhatsApp wamids stay bare across every WhatsApp provider** (YCloud,
  Kapso, Meta direct) — the wamid is Meta-global and echo matching plus
  cross-provider parity depend on the exact stored form. **Social ids are
  namespaced** `${provider}:${nativeId}` (`zernio:…`). Each adapter owns id
  normalization inbound *and* on the send-path id write-back. Events with no
  message id (status/comment/lifecycle) dedup on `deliveryId` —
  `NormalizedInboundEvent.deliveryId` is the durable event-dedup key; a
  `webhook_deliveries(provider, deliveryId)` dedup table or equivalent lands
  with the first non-YCloud adapter.
- **C7 — Echo/human-override is WhatsApp-specific.** `handleEcho` semantics
  (human reply from Business App → `humanOverrideUntil`) stay bound to
  `kind:"message.echo"` + `direction:"outbound"` events; other providers may
  not produce echoes — the admin surface must show override detection as
  unsupported where it is.
- **C8 — 24h-window / auto-reply policies are per-channel.** WhatsApp rules
  (`autoReply24h`, session policy) must not leak onto channels where they
  don't apply; social reply-window rules are **[RESEARCH]** (evidence §3
  flags the gap).
- **C9 — Telegram ops bot is out of scope of the provider model.** It is an
  internal tool channel (allowlisted chat ids), not a customer provider. A
  future Zernio-delivered *customer* Telegram channel would be a different
  account/channel row.
- **C10 — Source-reading tests updated in the same commit.** Any refactor
  that moves code pinned by `agent-consistency.test.ts` (ordering assertions
  read the route source) must update the test in the same work unit.
- **C11 — neon-http: no interactive transactions.** Backfills and dual-write
  use idempotent upserts / CAS like the rest of the codebase.
- **C12 — Media domain allowlist is per-provider.** `downloader.ts` adds
  provider CDN domains only when the corresponding adapter lands, never
  speculatively.
- **C13 — Credential cutover is fail-safe (CR-5).** Until the admin UI writes
  `channel_accounts`, `resolveChannelAccount` for `provider="ycloud"` returns
  account metadata from `channel_accounts` but resolves **credentials from
  `agent_config` → env** — the backfilled row is a routing registry, never a
  credential shadow. New providers' credentials live only in
  `channel_accounts`. Required test: edit `agent_config.ycloudApiKey` after
  backfill → the new value wins on the next send.
- **C14 — Conversation↔account association is explicit (W-13).** Additive
  nullable `conversations.channelAccountId` ships **in the same migration as
  `channel_accounts`** — not in v1. Until then sends resolve the channel
  default (single-account-per-channel assumption, documented). Multi-account
  setups (e.g. Zernio multi-profile) are unsupported until the FK lands;
  inbound events populate it when they carry `providerAccountId`.

---

## 4. Provider capability & ownership matrix

Status: **V** = verified in repo code · **E** = verified against official
provider docs in `provider-integration-evidence.md` (2026-10-18) · **S** =
spec claim only · **?** = still unknown → research item.

| Capability | YCloud | Zernio | Kapso | Meta direct |
|---|---|---|---|---|
| Channels | whatsapp (V) · sms (S — no SMS code in repo) | whatsapp + social channels (E — exact platform list per evidence §1) | whatsapp (E) | whatsapp (stub, V) |
| API base / auth | `api.ycloud.com/v2`, `X-API-Key` (V) | `zernio.com/api/v1`, Bearer (E) | `api.kapso.ai` platform + Graph-proxy send (E; canonical proxy host ?) | graph.facebook.com (V partial) |
| Send text | V `sendDirectly` | E conversation-scoped send | E Graph-shaped send | not implemented |
| Send image/doc | V | E `mediaRefs`/`refreshUrl` flow | E Graph media flow | — |
| Send template | E (available; unused in repo) | E (required for WA first contact) | E | — |
| Inbound webhook | V `whatsapp.inbound_message.received` | E `message.received`, `comment.received`, `webhook.test` | E `whatsapp.message.received`, batched | V (`messages` persisted) |
| Signature | V/E `t,s` timestamped HMAC | E `X-Zernio-Signature` raw-body HMAC (+`X-Late-*` alias) | E `X-Webhook-Signature` raw-body HMAC | V `x-hub-signature-256` |
| Delivery dedup | E `evt_*` event id + wamid | E `X-Zernio-Event-Id` + `platformMessageId` | E `X-Idempotency-Key` + wamid | V |
| Ack / retries | E <6s, 7 retries | E ≤5s, 7 attempts | E ≤10s, retries 10s/40s | V |
| Send idempotency | E `externalId` field | E `Idempotency-Key` header | ? not documented | — |
| Echo/own-message events | V (`*.echo` types) | E `message.sent` + direction | E `whatsapp.message.sent` + direction | n/a |
| Media download API | V `/v2/whatsapp/media/{id}` | E `refreshUrl` | E Graph media via proxy | — |
| Onboarding | manual WABA + API key (V) | E `GET /connect/whatsapp` embedded signup | E setup links / `@kapso/sdk` (MPS) | OAuth flow exists (V) |
| **Owns (target)** | `providers/ycloud.ts` | `providers/zernio.ts` | `providers/kapso.ts` (spike) | `providers/meta.ts` (later) |

### Research items (Phase 0 deliverable — none of these may be coded as fact)

Resolved by evidence doc: Zernio base URL/auth/signature/events/SDK names;
Kapso signature scheme, batch envelopes, setup links, `@kapso/sdk`; YCloud
`externalId`, `fromUserId`/`parentBsuid` BSUID fields, media `link` approach
confirmed working. **Still open:**

1. Zernio `POST /v1/inbox/conversations` full request shape + per-recipient
   pacing (~10/min reported) + pricing/limits.
2. Kapso: canonical Graph-proxy host beyond the `v24.0` send path; send
   idempotency semantics; platform-webhook signature for the auto-generated
   secret; MPS availability/cost for a single-install operator.
3. Social reply-window rules (Instagram/Facebook) for C8.
4. Whether Zernio-carried WhatsApp is ever wanted for this product — if yes,
   `whatsappProvider` gains a third value; if no, document the limit.

---

## 5. Phases (dependency-aware)

```
v1 (unconditional):  P0 research ─► P1 messaging-core + YCloudAdapter (3 work units)
parallel lane:       repo-trust items (migration journal, /setup) — owned by
                     self-hosted-product-roadmap P0/P1, independent of this seam
gated (provider #2 approved):  P2 channel_accounts ─► P3 unified ingress ─► P4 Zernio (+§2.4 schema)
spike only:          P5 Kapso (no production wiring)
later:               P6 per-channel policy / durable media / rotation
```

### Phase 0 — Provider research closeout (no product code)

- Deliverable: update `provider-integration-evidence.md` (or
  `provider-research.md`) closing the open items in §4; freeze §2.2 verbatim.
- Commit: `docs(socialcrm): close out provider research items`
- Verify: doc review; contract types compile-checked in P1.

### Phase 1 — Messaging core + YCloudAdapter (pure refactor, zero behavior change)

- Create `lib/messaging/{types,registry,accounts,messenger}.ts` implementing
  §2.2 verbatim; v1 registry maps `whatsapp → ycloud`.
- `providers/ycloud.ts` wraps existing send/signature/parse/media functions
  **without moving them yet** (delegation first, extraction later if useful).
- Switch **every** direct send call site to `messenger.send` — complete list
  in §1: `broadcast.ts`, `queue/worker.ts`, `cron/followup`,
  `toolsWhatsApp.ts`, `toolsManagement.ts`, `create-order.ts`,
  `channels/router.ts`, webhook reply paths + `sendWhatsAppBubbles`,
  `dashboard-actions-server.ts` (reply bubbles + `sendImage` media),
  `orders/actions.ts` (both `sendText` status notifications).
- Refactor webhook route: extract YCloud payload→`NormalizedInboundEvent`
  parsing into the adapter; route keeps identical gate order.
- Work units:
  1. `feat(messaging): add provider abstraction core and ycloud adapter`
     (types + adapter + contract test; product code untouched — see test gate below)
  2. `refactor(whatsapp): route all outbound sends through messaging facade`
     (all call sites above; tests updated same commit per C10; `test:agents`
     gains the new messaging tests **and** the previously-unwired
     `web-order-redirect.test.ts` — `package.json` edit lands here)
  3. `refactor(whatsapp): extract inbound parsing into ycloud adapter`
     (webhook route slimmed; ordering tests updated same commit)
- Verify: `npm run test:agents` green (incl. updated consistency test + newly
  wired tests), `typecheck`, `lint`, `build`; `provider-contract.test.ts` +
  `providers/ycloud.test.ts` fixtures (inbound text/image/audio/location/
  echo/status; signature ok/bad/expired/malformed).
- Rollback: each commit is independently revertable; commit 1 alone is inert.

### Phase 2 — `channel_accounts` + credential resolution — **Gate: second provider approved**

- Drizzle migration (non-destructive, C3): `channel_accounts` table
  (`tenant_id text not null default 'default'`, unique `(tenant_id, provider,
  channel, provider_account_id)`, `is_default` partial unique per
  `(tenant_id, channel)`); **plus** nullable `conversations.channelAccountId`
  FK (C14) and the `channel` enum values the approved provider needs.
- Idempotent backfill: register the `ycloud/whatsapp` account row derived
  from `agent_config` id=1 (lazy upsert, C11). Per C13, the row holds
  routing metadata; ycloud **credentials still resolve `agent_config → env`**
  until the admin UI writes the table.
- `accounts.ts` resolver + `whatsappProvider` field gains its first
  non-`ycloud` accepted value only when the approved provider is
  WhatsApp-capable.
- Work units:
  1. `feat(db): add channel_accounts, conversations.channel_account_id, channel enum values`
  2. `feat(messaging): resolve accounts via channel_accounts with fail-safe credential precedence` (C13 shadowing test included)
  3. `feat(admin): read-only channel status in agent page` (optional slice)
- Verify: migration idempotent on fresh + existing DBs; shadowing test —
  post-backfill edit of `agent_config.ycloudApiKey` wins; encrypted
  round-trip (C5); gates green.

### Phase 3 — Unified ingress route — **Gate: second provider approved**

- `POST /api/webhooks/ingress/[provider]` (W-1 canonical path): provider
  lookup → `verifyWebhook` → `parseWebhook` → shared pipeline → per-kind
  dispatch (message/echo/status/comment). `/api/whatsapp/webhook` + legacy
  alias delegate to `ingress("ycloud")` internally — same gates, same
  200/401 semantics.
- Keep the route thin: pipeline lives in `lib/messaging/inbound-pipeline.ts`
  so route files stay provider-free.
- Work units:
  1. `feat(messaging): add unified webhook ingress route with provider dispatch`
  2. `refactor(whatsapp): delegate existing webhook routes to ingress` (+C10 test updates)
- Verify: signature negative tests per provider hook; fixture e2e asserting
  identical DB effects on old and new paths; duplicate delivery replay deduped
  via `deliveryId`; gates green.

### Phase 4 — Zernio adapter + social identity (Gate: product approval **and** §2.4 schema landed)

- Land the §2.4 social-identity migration **first** in this phase:
  `lead_identities`, `leads.phone` nullable + partial unique index, synthetic
  `whatsappId` keys, enum/union/`BUFFER_CONFIG` extensions, phone-less
  Instagram fixture.
- Adapter implements `verifyWebhook`/`parseWebhook`/`sendMessage`/
  `sendTemplate`/`resolveMedia` per contract rules (conversation-scoped sends,
  `refreshUrl` media, ≤5s ack via existing buffer decoupling).
- Admin: Zernio credential fields + account registration (new
  `/admin/channels` section or `/admin/agent` card).
- Durable media store is a prerequisite for Zernio media (see risks);
  `public/uploads` is ephemeral on Render.
- Work units (each gated on the previous):
  1. `feat(db): social identity model — lead_identities, nullable phone, synthetic keys`
  2. `feat(messaging): add zernio adapter (signature + inbound parse)` + fixtures incl. phone-less identity
  3. `feat(admin): zernio account config` + `feat(messaging): zernio outbound send + resolveMedia`
  4. `feat(inbox): render instagram/facebook conversations` (admin UI slice)
- Verify: contract suite vs Zernio adapter; fixture replays per event kind
  (incl. `comment.received` → inbox, never the WhatsApp session machine);
  signature negatives; C6 namespacing test; durable-media persistence check;
  gates green.

### Phase 5 — Kapso spike (no production wiring)

- Research-validation only: confirm canonical proxy host/auth, signature
  fixture, batch-envelope parsing, send idempotency, and MPS
  availability/cost — on a test project or mocked fixtures.
- Deliverable: adapter code behind the contract in a spike branch + findings
  doc; **no** `whatsappProvider` wiring, **no** embedded signup (out of v1
  per CR-6 — revisit only with an explicit business decision).
- Work units:
  1. `feat(messaging): kapso adapter spike — signature + parse fixtures`
  2. `docs(socialcrm): kapso spike findings and go/no-go recommendation`
- Verify: contract suite passes against the spike adapter; finding answers
  the open Kapso research items; gates green on the spike branch.

### Phase 6 — Per-channel policy & ops maturity

- Channel-aware inbound policies (reply windows per channel rules, comment→DM
  flows), durable media store migration, `AUTH_SECRET` rotation runbook,
  multi-account sends via `conversations.channelAccountId` if a real install
  needs >1 account per channel.
- Scope set after P4/P5 experience. Verify per slice.

---

## 6. First implementation slice (safe to start once §2.2 is frozen)

**Slice = Phase 1, work unit 1.** Exactly:

- New files only: `src/lib/messaging/types.ts`, `registry.ts`,
  `providers/ycloud.ts` (delegates to existing `lib/ycloud.ts`,
  `whatsapp/ycloud-client.ts`, `whatsapp/signature.ts`, `media/downloader.ts`),
  `provider-contract.test.ts`, `providers/ycloud.test.ts` with recorded
  fixtures, and a barrel `src/lib/messaging/index.ts`.
- **Zero edits to existing product files** → no behavior change; commit is
  fully revertable; nothing references the module until work unit 2.
- **Test gate (W-7/S-8):** the new tests are NOT in `test:agents` yet — run
  them explicitly before committing:
  `node --import tsx --test "src/lib/messaging/**/*.test.ts"`, plus the
  standard gates. Work unit 2 then edits `package.json` to wire them into
  `test:agents` **and** adds the already-on-disk-but-unwired
  `src/lib/whatsapp/web-order-redirect.test.ts`.
- Commit: `feat(messaging): add provider abstraction core and ycloud adapter`.
- Verify before commit: the explicit test command above, `npm run
  test:agents`, `npm run typecheck`, `npm run lint`, `npm run build`.

Why this slice: it freezes the canonical contract every later phase depends
on, proves the adapter shape against the one provider whose behavior is fully
known from code and docs, and cannot regress the installed product.

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Source-reading consistency tests pin the 1184-line webhook route | Refactor silently breaks or needs big test churn | C10: update tests in same commit; migrate pinning to behavioral assertions over time |
| Open provider items (Zernio conversation-create shape, Kapso proxy host/idempotency, reply windows) | Wrong assumptions baked into adapter | Phase 0 gates P4; spike-first P5; contract tolerates unknowns via `raw` passthrough |
| Echo/override semantics are YCloud-specific | New providers may not emit echoes → human replies via native apps go undetected | C7: per-provider echo mapping; admin shows "override detection: unsupported" where absent |
| `platformMessageId` collisions or over-namespacing | Dedup/echo matching corruption | C6 per-channel rule: bare wamid on whatsapp, namespace social ids; `deliveryId` dedup for non-message events |
| Credential shadowing after `channel_accounts` backfill | Admin edits silently ignored → install can't send | C13: `agent_config` preferred for ycloud until admin UI writes the table + required shadowing test |
| `leads.phone`/`whatsappId` notNull blocks social identities | IG/FB DMs can't persist or lead-link | §2.4 schema plan is a hard Phase 4 prerequisite with its own fixture gate |
| `channel` enum extension locks enum values | Postgres enum values can't be dropped | Add values only when the consuming phase lands |
| Scope creep: `channel_accounts`/ingress built before a second provider exists | Dead schema + premature abstraction | CR-6 gate: both phases require provider #2 approval |
| Unified ingress changes 200/401 semantics | Provider retry storms or silent drops | Fixture e2e asserting identical responses on old+new paths; keep fail-closed |
| `tenantId` theater | Fake multitenancy now → wrong assumptions later | Field exists, stays `"default"`; no tenant-scoped logic; real tenancy is a future additive migration |
| `public/uploads` ephemeral on Render | Zernio media links die on redeploy | Durable media store is a Phase 4 prerequisite (also Phase 6 ops) |
| Media allowlist sprawl | SSRF surface grows | C12: add provider domains only with the adapter |
| Buffer keys collide across channels | Cross-channel debounce bleeding | Keys already include channel (`enqueue(channel, userId)`); per-channel isolation asserted in P4 tests |
| Source spec untracked in this worktree | Reference dangling at this base | Tracked on `main` ≥ `fe04b2b`; noted at top — do not commit the brief from this branch |

## 8. Non-goals

- **No multitenancy** — no tenant provisioning, row-level isolation, billing,
  or per-tenant admin. `tenantId` exists only as a forward-compatible field.
- **No Kapso production wiring or embedded signup in v1** — spike only (CR-6);
  revisit only with an explicit business decision.
- **No `channel_accounts`, unified ingress, or routing matrix before a second
  provider is approved** (CR-6); the `whatsappProvider` switch is deferred
  with them.
- No Kapso managed-billing / credit-line features.
- No MCP server integrations in this roadmap (spec mentions them; revisit
  after the messaging layer is stable).
- No migration of the internal Telegram ops bot into the provider model (C9).
- No changes to the session boundary machine, agent prompts/tools, checkout,
  cash, reconcile, or storefront.
- No template-message management UI (YCloud templates exist but are unused;
  `sendTemplate?` is in the contract for Zernio's WA-first-contact need).
- No removal of `agent_config` credential fields or env fallbacks.
- No Meta-direct WhatsApp completion beyond keeping the existing stub working.
- No SMS implementation — `sms` is a type-level channel for forward-compat
  only (no YCloud SMS code exists in the repo).

## 9. Open decisions (resolve in P0 / at each phase gate)

1. Zernio `POST /v1/inbox/conversations` full request shape (evidence flags
   it) — required before `ZernioAdapter.sendMessage`.
2. Whether Zernio-carried WhatsApp is ever wanted — decides the third
   `whatsappProvider` value.
3. Where per-channel policy config lives (`agent_config` jsonb vs a future
   `channel_policies` table) — decide at P6 with real requirements.
4. Whether Kapso justifies production wiring after the spike — business
   decision, not technical.
5. `comments` routing: dedicated inbox section vs. conversation rows —
   decided with the Phase 4 UI slice.
