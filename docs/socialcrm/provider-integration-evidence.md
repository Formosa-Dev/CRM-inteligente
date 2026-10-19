# Provider Integration Evidence — YCloud / Zernio / Kapso

Research for the multi-provider messaging abstraction proposed in
`docs/socialcrm/multiprovider-source-spec.md`. Provider claims below come from
each provider's official documentation, fetched **2026-10-18**. Product context:
SocialCRM ships as a **self-hosted single-install** on Render + Neon (one
business per install). Multitenancy stays possible in the contract but is not
implemented now.

## How to read this document

- **§1–§3 are verified provider evidence** — claims traceable to official docs
  (sources in §8), plus an explicitly labeled unverified-facts table (§3).
- **§4 is the CANONICAL adapter contract.** It resolves review CR-1:
  `architecture-roadmap.md` §2.2 and `multiprovider-source-spec.md` §4.1 are
  superseded and must reference §4 instead of redefining the interface.
- **§5–§7 are product recommendations, not evidence findings.** They propose
  the v1 scope and routing below and require product-owner confirmation before
  becoming decisions.

## Verdict (recommendations — pending product-owner confirmation)

- **v1 scope — supersedes the source brief's "build everything" ask.** Build
  now: contract freeze (§4) + `YCloudAdapter` extraction. Deferred until a
  second provider is approved: `channel_accounts` table, unified ingress route,
  per-provider webhook registration API. `multiprovider-source-spec.md` §7
  remains the requirements record for the target end-state, not the v1 plan.
- **WhatsApp stays on YCloud for v1.** The existing pipeline already matches
  YCloud's documented send API, webhook signature scheme, and payload shapes.
  No provider migration is justified for a single install.
- **Social channels (Instagram/Facebook) → Zernio** when that feature is
  approved. It is the only candidate that covers them; it also covers WhatsApp,
  so a future consolidation path exists.
- **Kapso is deferred — spike only, no production wiring, embedded signup out
  of v1.** Its differentiators (Multi-Partner Solution, embedded signup for
  customers, managed Meta billing, pre-verified number pools) solve
  *multi-customer onboarding* problems a single install does not have. §4 keeps
  it expressible so it can be added later cheaply.

## 1. Evidence matrix

| Capability | YCloud | Zernio | Kapso |
|---|---|---|---|
| Role | WhatsApp BSP infra + SMS/email | Omnichannel social + messaging API (incl. WhatsApp, iMessage, calls) | WhatsApp-only BSP / tech provider |
| API base | `https://api.ycloud.com/v2` | `https://zernio.com/api/v1` | `https://api.kapso.ai/platform/v1` (admin) + `https://api.kapso.ai/meta/whatsapp/v24.0` (Graph-proxy sends) |
| Auth | `X-API-Key` header | `Authorization: Bearer <key>` | `X-API-Key` header |
| Send message | `POST /whatsapp/messages` (queued) or `POST /whatsapp/messages/sendDirectly` (sync) | `POST /inbox/conversations` then `POST /inbox/conversations/{id}/messages` | `POST /meta/whatsapp/v24.0/{phoneNumberId}/messages` (Meta Graph shape) |
| Onboarding | Manual: connect WABA + number in console; Partner Center embedded signup / "TP Lite" link for tech partners | `GET /connect/whatsapp` → `authUrl` (Embedded Signup, hosted or headless, coexistence option); credentials path; Zernio-provisioned numbers (KYC); sandbox | Setup links `POST /platform/v1/customers/{id}/setup_links` (hosted or `@kapso/sdk` embedded, MPS); instant pre-verified numbers; own-Meta-app path |
| Webhook registration | Console or `POST /v2/webhookEndpoints` (≤20 endpoints, returns `whsec_*` secret) | `POST /v1/webhooks/settings` (≤50 endpoints; **you** choose `secret`) | `POST /platform/v1/whatsapp/phone_numbers/{id}/webhooks` (`kind: kapso|meta`; **you** choose `secret_key`); platform webhooks tab for project events (auto-generated secret) |
| Signature | `YCloud-Signature: t={ts},s={hex}` — HMAC-SHA256 over `{t}.{rawBody}` | `X-Zernio-Signature` — hex HMAC-SHA256 over raw body (**no timestamp**) | `X-Webhook-Signature` — hex HMAC-SHA256 over raw body (**no timestamp/prefix**) |
| Delivery dedup | Event `id` (`evt_*`); message `wamid` | `payload.id` / `X-Zernio-Event-Id` (legacy `X-Late-Event-Id`); `message.platformMessageId` (wamid) | `X-Idempotency-Key`; `message.id` (wamid) |
| Ack / retries | 2xx fast (<6s recommended); 7 retries: 10s,30s,5m,30m,1h,2h,2h | 2xx within 5s; 7 attempts exp-backoff capped 24h (~51h), then DLQ + redeliver | 200 within 10s; retries at 10s and 40s (`max_attempts` default 3) |
| Send idempotency | `externalId` field | `Idempotency-Key` header (24h replay) | Not documented |
| Official SDK | `@ycloud-cpaas/ycloud-sdk-node` (+ Go/Java/PHP) | `@zernio/node`, Python `zernio`, CLI, hosted MCP, OpenAPI spec | `@kapso/whatsapp-cloud-api` (open source, Graph-compatible) + `@kapso/sdk` (frontend onboarding), CLI, MCP, n8n |

## 2. Per-provider detail

### 2.1 YCloud — matches current implementation

- **Send.** `POST /v2/whatsapp/messages/sendDirectly` submits synchronously;
  `POST /v2/whatsapp/messages` queues. Types: template, text, image, video,
  audio, document, sticker, location, interactive, contacts, reaction.
  Recipient via `to` (E.164) or `recipient` (BSUID/parent BSUID). Media can be
  referenced by uploaded `id`; the repo uses `link`, which works in production.
  `filterUnsubscribed`/`filterBlocked` exist on the queued endpoint only.
  `externalId` reconciles messages to internal records.
  Source: docs.ycloud.com/en/api-reference/guides/whatsapp-platform/send-whatsapp-message
- **Inbound payload.** `type: "whatsapp.inbound_message.received"` →
  `whatsappInboundMessage` with `id`, `wamid`, `wabaId`, `from`, `fromUserId`,
  `fromParentUserId` (BSUID fields — Meta's identity migration), `customerProfile{name,username}`,
  `to`, `sendTime`, `type`, per-type content, optional `context` (quoted reply),
  optional `groupId`. Echo events `whatsapp.message.echo` /
  `whatsapp.smb.message.echoes` and `whatsapp.smb.history` exist — the repo
  already handles the echo pair.
  Source: docs.ycloud.com/reference/webhook-events-payloads,
  docs.ycloud.com/en/api-reference/guides/examples/webhook-examples/whatsapp-inbound-message-webhook-examples
- **Signature.** `YCloud-Signature: t={unix},s={hmac-sha256-hex}` over
  `{t}.{rawBody}`. The repo's `src/lib/whatsapp/signature.ts` implements this
  exactly, including `timingSafeEqual` and a 300s tolerance (the tolerance is
  our defensive addition — docs don't mandate it). Verified verbatim.
- **Webhook ops.** `POST /v2/webhookEndpoints` returns a `secret` (`whsec_*`);
  ≤20 endpoints; header `X-Webhook-Endpoint-ID` also sent. Retries: 7 attempts
  (10s, 30s, 5m, 30m, 1h, 2h, 2h). Respond 2xx quickly (<6s recommended, >10s
  may be deprioritized).
  Source: docs.ycloud.com/reference/configure-webhooks,
  docs.ycloud.com/reference/webhook-integration-guide,
  docs.ycloud.com/en/api-reference/guides/api-fundamentals/configure-webhooks
- **Onboarding.** Single business: connect WABA + phone in the console, create
  an API key, register the webhook. Partner Center additionally offers Embedded
  Signup and "Partner Direct Link (TP Lite)" for tech partners — the future
  multitenant path, out of scope now.
  Source: docs.ycloud.com/en/partner-center/technical-development-partners/embedded-signup.md
- **Media.** `GET /v2/whatsapp/media/{mediaId}` → `{url, mime_type, file_name}`;
  file download carries the same `X-API-Key`. Matches
  `src/lib/media/downloader.ts` (`downloadYCloudMedia`).
- **SDK.** `@ycloud-cpaas/ycloud-sdk-node` (github.com/YCloud-Developers) is
  official; also Go/Java/PHP per docs.ycloud.com/reference/sdks. The repo's raw
  `fetch` client is thin and correct — no reason to swap.

### 2.2 Zernio — the social-channel provider (and viable WhatsApp alternative)

Zernio appears to be the renamed "Late" API (legacy `X-Late-Signature` /
`X-Late-Event-Id` header aliases are kept for compatibility; inferred, not
stated in the pages read).

- **Auth.** `Authorization: Bearer <key>` against `https://zernio.com/api/v1`.
  Keys via dashboard or `POST /v1/api-keys` (full value returned once, optional
  expiry); a verify-credential endpoint exists.
- **Onboarding.** Hierarchy is team → profiles → accounts. WhatsApp:
  `GET /v1/connect/whatsapp?profileId&redirect_url&onboarding=api` returns an
  `authUrl` (Embedded Signup); the user lands back on `redirect_url` with
  `accountId`. Variants: Zernio-hosted signup page (`signup=hosted`), headless
  list+select phone number (`list-whatsapp-phone-numbers` →
  `select-phone-number`), credentials connect (WABA id + phone number id +
  token), `POST /v1/connect/whatsapp/embedded-signup` for your own Meta app,
  Zernio-purchased numbers (KYC, `whatsapp.number.*` lifecycle events),
  coexistence (keeps WhatsApp Business app; caps throughput ~20 msg/s and
  disables groups/calling), and a shared sandbox number. For a single install
  the operator can also just connect in the Zernio dashboard.
  Source: docs.zernio.com/platforms/whatsapp.mdx,
  docs.zernio.com/guides/connecting-accounts.mdx
- **Send.** Conversation-scoped: `POST /v1/inbox/conversations` to open (for
  WhatsApp first contact, with a template), then
  `POST /v1/inbox/conversations/{conversationId}/messages` with text,
  attachments, quick replies, buttons, `template: {elements:[{name,language,
  components}]}`, or `interactive` (list/CTA/Flow/location-request). Sends
  accept an `Idempotency-Key` header (24h replay, `Idempotent-Replayed: true`).
  WhatsApp per-recipient pacing ≈10/min (Meta error 131056). Broadcasts via
  `POST /v1/broadcasts`. `POST .../read` sends blue ticks on eligible accounts.
  Source: docs.zernio.com/messages/send-inbox-message.mdx
- **Webhooks.** `POST /v1/webhooks/settings` {`name`,`url`,`events`,`secret`} —
  the `secret` is caller-chosen (never generated), ≤50 endpoints, optional
  `profileIds`/`accountIds` scoping and `customHeaders`.
  `POST /v1/webhooks/test` fires `webhook.test` (always delivered, single
  attempt). Headers: `X-Zernio-Event`, `X-Zernio-Event-Id`,
  `X-Zernio-Signature` = lowercase hex HMAC-SHA256 of the **raw body** — no
  timestamp, so replay protection relies on event-id dedup. Respond 2xx within
  5s; 7 attempts with exp-backoff to 24h cap (~51h total), then dead-letter +
  `Redeliver`. Routing fields: `account.accountId`, `profiles[].externalId`,
  `conversationId`, `message.platformMessageId` (wamid on WhatsApp).
  Source: docs.zernio.com/webhooks
- **Events.** `message.received/sent/delivered/read/failed/edited/deleted`,
  `comment.received`, `reaction.received`, `referral.received`,
  `conversation.started/control_changed`, `account.connected/disconnected`,
  `whatsapp.template.*`, `whatsapp.account.*`, `whatsapp.number.*`,
  `whatsapp.contact.identity_changed`, plus posts/ads/calls/automation
  families. `comment.received` covers the IG/FB comment-to-inbox flow.
- **Inbound media.** Attachments carry `{type, url (signed, expires),
  refreshUrl, mimeType, originalType}` — persist `refreshUrl` (re-mints the
  URL), never the signed `url`.
- **Channels.** The current docs list 17 platforms including Google Business
  Profile: Instagram, Facebook, Threads, TikTok, YouTube, X, LinkedIn,
  Pinterest, Reddit, Bluesky, Telegram, Discord, Slack, Snapchat (pending
  approval), Google Business Profile, plus WordPress and Shopify — which are
  documented as Blogs/commerce API targets, not social-publishing channels.
  Messaging surfaces on top: WhatsApp, SMS, voice calls, iMessage.
- **SDK.** `@zernio/node` (`new Zernio({apiKey})`), Python `zernio`, CLI,
  hosted MCP server, OpenAPI spec for codegen.

### 2.3 Kapso — WhatsApp BSP whose value is multi-customer onboarding

- **Auth.** `X-API-Key` (project key, dashboard → Integrations → API keys) on
  both the platform API (`https://api.kapso.ai/platform/v1`) and the Meta-proxy
  (`https://api.kapso.ai/meta/whatsapp/v24.0/...`).
- **Onboarding.** Per-customer setup links
  (`POST /platform/v1/customers/{customerId}/setup_links`) with
  `meta_billing_mode: partner_managed|customer_managed` and connection type
  `dedicated|coexistence`; hosted link or embedded via `@kapso/sdk` (requires an
  active Multi-Partner Solution — not a generic embedded-signup SDK). Also:
  "instant setup" Kapso-provided pre-verified numbers and an own-Meta-app path
  (embedded-signup config ID, tech-provider status). Connection detection via
  project webhook `whatsapp.phone_number.created`.
  Source: docs.kapso.ai/docs/platform/tech-providers/embed-onboarding,
  docs.kapso.ai/docs/platform/setup-links/detect-connection
- **Send.** `POST /meta/whatsapp/v24.0/{phoneNumberId}/messages` with the exact
  Meta Graph API body (`messaging_product`, `to` or `recipient` for BSUID,
  `type`, content). Every Cloud API type incl. flows, calling, Pix orders.
  Because the shape is Meta's, a Kapso adapter is nearly free once a
  Graph-shaped sender exists.
  Source: docs.kapso.ai/docs/whatsapp/send-messages/text.md
- **Webhooks.** Per-number:
  `POST /platform/v1/whatsapp/phone_numbers/{phone_number_id}/webhooks` with
  `kind: 'kapso'` (default; Kapso v2 payloads, optional buffering → batch
  envelope `body.data[]` flagged by `X-Webhook-Batch`) or `kind: 'meta'` (raw
  forwarded Graph payload; only one meta webhook per number). `secret_key` is
  required and caller-chosen. Headers: `X-Webhook-Event`,
  `X-Webhook-Signature` (hex HMAC-SHA256 over raw body, no prefix/timestamp),
  `X-Idempotency-Key`, `X-Webhook-Payload-Version: v2`. Respond 200 within
  10s; retries at 10s and 40s (`max_attempts` default 3); after max retries a
  batch falls back to individual deliveries.
  Source: docs.kapso.ai/docs/platform/webhooks/overview,
  docs.kapso.ai/docs/platform/webhooks/message-events.md
- **Events.** `whatsapp.message.received/sent/delivered/read/failed`,
  `whatsapp.conversation.created/ended/inactive`,
  `whatsapp.contact.identity_changed`,
  `whatsapp.contact.marketing_preference_changed`, `whatsapp.thread.*`
  (shared-number routing). v2 payload: `{message{...,kapso{direction,status,
  processing_status,origin,has_media,content,statuses[]}}, conversation{id,
  contact_name,phone_number,business_scoped_user_id,...,kapso{counts}},
  is_new_conversation, phone_number_id}`. Route by top-level `phone_number_id`.
- **SDK.** `@kapso/whatsapp-cloud-api` (open source,
  github.com/gokapso/whatsapp-cloud-api-js) mirrors the Cloud API surface —
  works against Meta directly (`accessToken`) or the Kapso proxy (`baseUrl` +
  `kapsoApiKey`), adds `fields=kapso(...)`, history queries, and a server-side
  `normalizeWebhook()` for meta payloads. `@kapso/sdk` is frontend onboarding
  only. CLI, hosted MCP, n8n node, Chat SDK exist too.

## 3. Unverified or unavailable facts

| Item | Status |
|---|---|
| Kapso Meta-proxy base URL | Docs show `https://api.kapso.ai/meta/whatsapp` (send guides) and `https://app.kapso.ai/api/meta/` (SDK quickstart). Confirm the canonical host before implementing. |
| Kapso send idempotency | No idempotency/`externalId` equivalent documented for the proxy send; duplicate-safe retries are not guaranteed. |
| Kapso project/platform webhook signature | Overview implies the same `X-Webhook-Signature` HMAC flow with an auto-generated secret, but the platform-webhook header isn't separately documented. |
| Zernio signature freshness | `X-Zernio-Signature` has no timestamp — replay protection is dedup-only (`X-Zernio-Event-Id`). Their sample uses `!==` string compare; we should still use `timingSafeEqual`. |
| Zernio `POST /v1/inbox/conversations` request shape | Referenced everywhere (participantId, template-first-contact) but the full field list wasn't verified; check before implementing `ZernioAdapter.sendMessage`. |
| YCloud `GET ?token` echo | The repo's GET handler echoes a `token` query param (console verification handshake); not seen in the docs pages reviewed — keep it as-is, it's harmless. |
| Zernio = "Late" rebrand | Inferred from `X-Late-*` legacy header aliases; not stated in the pages read. |
| Pricing / messaging limits per plan | Out of scope; not evaluated. |

## 4. Adapter contract — CANONICAL (single-install edition)

**This is the one canonical contract** (resolves review CR-1). Derived from
the source brief's `IMessagingProvider`, corrected against the evidence.
`architecture-roadmap.md` §2.2 and `multiprovider-source-spec.md` §4.1 must
reference this section, not redefine it. Term mapping vs. the other documents:
`deliveryId` ≙ `providerEventId` · `mediaRefs` ≙ `media` · `resolveMedia` ≙
`downloadMedia` · `sendMessage` ≙ `send` · `verifyWebhook` ≙ `verifySignature`
· `parseWebhook` ≙ `parseInbound`.

Two decisions baked in:

- **`tenantId` is on `ChannelAccount`** (review W-3): the field exists so a
  multitenant migration needs no interface change, but v1 hard-codes it to
  `"default"` and implements no tenant logic.
- **`sendTemplate?` stays** (review W-2): Zernio WhatsApp first contact and any
  send outside the 24h window require a template; Kapso/YCloud reach the same
  rule through Meta.
- **Channels and event kinds are separate** (review W-14): `comment` and
  `messenger` are not channels — comments are `EventKind`s arriving on
  `instagram`/`facebook` accounts, and Messenger DMs arrive on `facebook`.

```ts
type ProviderId = 'ycloud' | 'zernio' | 'kapso';

/** Delivery surface. 'facebook' covers Page posts, Messenger DMs and
 *  comments on them; 'instagram' covers DMs and comments. Extend (tiktok,
 *  threads, …) when a Zernio account of that platform is enabled. */
type ChannelId =
  | 'whatsapp' | 'instagram' | 'facebook' | 'telegram' | 'sms';

/** What happened — not a channel. */
type EventKind =
  | 'message.received' | 'message.echo' | 'message.status'
  | 'comment.received' | 'account.lifecycle' | 'other';

interface ChannelAccount {
  id: string;
  /** v1: constant "default". Field exists for multitenant migration;
   *  no tenant logic is implemented. */
  tenantId: string;
  provider: ProviderId;
  channel: ChannelId;
  /** ycloud: sender E.164 · zernio: accountId · kapso: phoneNumberId */
  providerAccountId: string;
  /** E.164 phone (WhatsApp/SMS) or page/handle id (social) */
  senderAddress: string;
  credentials: { apiKey: string; webhookSecret: string; accessToken?: string };
  status: 'active' | 'disconnected' | 'error';
}

interface OutboundMessage {
  to: string;                    // E.164 phone, BSUID, or social user id
  type: 'text' | 'image' | 'document' | 'template' | 'interactive';
  text?: string;
  mediaUrl?: string;             // public link; adapters may upload first
  template?: { name: string; language: string; components?: unknown[] };
  interactive?: unknown;         // provider-native passthrough
  replyToMessageId?: string;
  idempotencyKey?: string;       // → ycloud externalId / zernio Idempotency-Key
}

type SendResult =
  | { ok: true; providerMessageId: string; status: string }
  | { ok: false; error: string; retryable: boolean };

interface NormalizedInboundEvent {
  provider: ProviderId;
  /** delivery-level dedup key: evt_* | X-Zernio-Event-Id | X-Idempotency-Key */
  deliveryId: string;
  kind: EventKind;
  direction: 'inbound' | 'outbound' | 'na';
  /** routing key: wabaId | zernio accountId | kapso phone_number_id */
  providerAccountId: string;
  providerConversationId?: string;   // zernio conversationId / kapso conv.id
  platformMessageId?: string;        // wamid / mid — durable message dedup
  sender: {
    phone?: string; bsuid?: string; parentBsuid?: string;
    username?: string; socialId?: string; name?: string;
  };
  type?: 'text' | 'image' | 'audio' | 'video' | 'document'
       | 'location' | 'sticker' | 'interactive' | 'reaction' | 'unknown';
  text?: string;
  mediaRefs?: { id?: string; url?: string; refreshUrl?: string;
                mimeType?: string; filename?: string }[];
  replyToMessageId?: string;
  status?: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  raw: unknown;
}

interface MessagingProvider {
  readonly id: ProviderId;
  /** 'timestamped-hmac' (ycloud t.s) vs 'raw-body-hmac' (zernio, kapso) */
  readonly signatureScheme: 'timestamped-hmac' | 'raw-body-hmac';
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
  sendTemplate?(account: ChannelAccount, msg: OutboundMessage): Promise<SendResult>;
  resolveMedia?(account: ChannelAccount, ref: { id?: string; url?: string; refreshUrl?: string }):
    Promise<{ url: string; mimeType?: string; filename?: string }>;
}
```

Contract rules driven by the evidence:

1. **Always `request.text()` first, verify, then `JSON.parse`.** All three
   schemes sign the raw body. (The repo already does this.)
2. **Signature variants:** YCloud parses `t=...,s=...`, signs `{t}.{body}`,
   enforce ~300s tolerance + `timingSafeEqual`. Zernio/Kapso: hex HMAC-SHA256
   of the raw body, `timingSafeEqual`; accept Zernio's `X-Late-Signature`
   alias as fallback.
3. **Two dedup keys, both durable:** `deliveryId` (provider delivery id —
   catches retries/DLQ replays of the *same event*) and `platformMessageId`
   (wamid/mid — already unique-indexed in `chat_messages`; catches cross-event
   repeats of the *same message*).
4. **Ack fast, process async.** Strictest window is Zernio's 5s. The existing
   BufferManager already decouples ingress from agent work — keep that
   invariant inside adapters.
5. **`parseWebhook` returns an array.** Kapso `X-Webhook-Batch` envelopes and
   YCloud's one-event-per-POST both normalize cleanly.
6. **Zernio sends are conversation-scoped.** `sendMessage` must resolve-or-
   create a conversation (`POST /v1/inbox/conversations`) keyed by
   `(accountId, to)`; cache it. YCloud/Kapso send directly to the recipient.
7. **Echo/status normalization.** YCloud `whatsapp.message.echo` /
   `whatsapp.smb.message.echoes` → `message.echo`/`direction: outbound`;
   Zernio `message.sent` + payload direction; Kapso `whatsapp.message.sent` +
   `message.kapso.direction`. Status updates (`delivered/read/failed`) map to
   `kind: 'message.status'`, never trigger agent work.
8. **BSUID everywhere.** All three now emit `fromUserId`/BSUID-style fields —
   `sender.bsuid` is a first-class field; never assume `sender.phone` exists.
9. **Media is provider-shaped.** YCloud: `GET /v2/whatsapp/media/{id}` →
   `{url}` + API-key download (implemented). Kapso: Graph media flow via proxy.
   Zernio: use `refreshUrl`, never the expiring signed `url`.
10. **Webhook registration differs** and stays outside `sendMessage`: YCloud
    `POST /v2/webhookEndpoints` or console; Zernio `POST /v1/webhooks/settings`
    (team-wide, we pick the secret); Kapso `POST .../phone_numbers/{id}/
    webhooks` (per number, we pick `secret_key`). For a single install,
    registering via each provider's console/dashboard is acceptable.

## 5. Routing recommendation (single-install — pending owner confirmation)

```
channel 'whatsapp'            ──→ provider 'ycloud'  (only wired provider in v1)
channel 'instagram'|'facebook' ──→ provider 'zernio' (when a second provider is approved)
channel 'sms'                 ──→ undecided ('ycloud' or 'zernio') — decide later
channel 'telegram'            ──→ native Bot API, unchanged — outside this matrix
provider 'kapso'              ──→ reserved; no routes in v1
```

(Messenger DMs ride `facebook` accounts; comments arrive as `comment.received`
events on `instagram`/`facebook` accounts — neither is a separate channel.)

- **v1 — recommended, explicit scope decision:** hard-code the registry
  `whatsapp → ycloud`. Credentials stay in `agent_config` (encrypted) + env
  fallback. This **supersedes the source brief §7 scope** ("build
  messaging-core + all adapters + unified ingress"): the brief stays the
  requirements record for the multichannel end-state; this document is the v1
  plan proposal.
- **`channel_accounts` table and unified ingress: deferred-conditional, not
  refused.** They are built the moment a second provider is approved — the
  same position the architecture and self-hosted roadmaps converge on after
  reconciliation. Until then a DB table with exactly one row buys nothing.
- **Later (social channels approved):** enable Zernio with one API key + one
  webhook endpoint + `message.received`/`comment.received` subscriptions; its
  `accountId`/`profiles[].externalId` map onto `providerAccountId`/`tenantId`
  when multitenancy arrives.
- **Kapso as a WhatsApp fallback:** because its send endpoint accepts raw
  Cloud-API payloads, it doubles as a disaster-recovery path if the YCloud
  account ever fails — worth a spike, not a build.
- Multitenancy stays open: `ChannelAccount.tenantId` exists in the contract
  (constant `"default"`, unused) and `providerAccountId` is already
  provider-shaped, so a later `channel_accounts` table is a mechanical
  materialization, not a redesign.

## 6. YCloud compatibility plan

Goal: wrap, don't rewrite. Zero behavioral change for the existing pipeline.

| Existing code | Adapter destination | Compatibility notes |
|---|---|---|
| `src/lib/ycloud.ts` (`sendText/sendImage/sendDocument`) | `YCloudAdapter.sendMessage` | Keep `sendDirectly`, retry-on-5xx, 20s timeout, `wamid` capture. Add `externalId` pass-through. |
| `src/lib/whatsapp/ycloud-client.ts` | Fold into same adapter | Duplicate sender — unify behind the interface. |
| `src/lib/whatsapp/signature.ts` | `YCloudAdapter.verifyWebhook` | Already matches docs exactly; move as-is. |
| `src/app/api/whatsapp/webhook/route.ts` payload handling | `YCloudAdapter.parseWebhook` + existing pipeline | Keep: `whatsappInboundMessage` extraction, `SUPPORTED_TYPES` filter, echo handler, `isProtocolArtifact` gate, dedup-before-lookup, rate limit, GET `?token` echo (stays in the route, not the adapter). |
| `downloadYCloudMedia` (`src/lib/media/downloader.ts`) | `YCloudAdapter.resolveMedia` | Keep `api.ycloud.com`/`cdn.ycloud.com` allowlist. |
| `getYCloudApiKey` / `getIntegrationSecrets().ycloudWebhookSecret` (`src/lib/integrations.ts`) | Credential resolver per provider | Same encrypted `agent_config` → env pattern; add `zernioApiKey`/`zernioWebhookSecret` fields only when Zernio lands. |
| New: `whatsappInboundMessage.fromUserId`/`fromParentUserId` | `sender.bsuid`/`parentBsuid` | Parse now — Meta's BSUID migration makes phones optional across all providers. |

Non-goals for the compat pass: switching to the queued `/whatsapp/messages`
endpoint, adopting `@ycloud-cpaas/ycloud-sdk-node`, changing credential
storage, touching the schema.

## 7. Ordered implementation & test checklist

1. **Freeze the canonical contract (§4).** `src/lib/messaging/types.ts` +
   `MessagingProvider` registry (`whatsapp → ycloud` only), including
   `tenantId` (constant `"default"`), `sendTemplate?`, and the
   `ChannelId`/`EventKind` split.
   Gate: `npm run typecheck`.
2. **Extract `YCloudAdapter`** (pure refactor of §6).
   Gates: `npm run test:agents`, `npm run lint`; webhook route behavior
   unchanged (manual smoke against a replayed YCloud event).
3. **Signature unit tests** (all three schemes, fixtures):
   - YCloud: valid, wrong secret, tampered body, expired `t`, malformed header.
   - Zernio: raw-body HMAC valid/invalid + `X-Late-Signature` alias.
   - Kapso: raw-body HMAC valid/invalid; batch envelope.
4. **Parser unit tests** with recorded fixtures → `NormalizedInboundEvent`:
   YCloud inbound text/image/audio/location, echo, smb echo, `whatsapp.message.updated`;
   Zernio `message.received` (with `account.accountId`, `platformMessageId`),
   `comment.received`; Kapso `whatsapp.message.received` single + batched.
5. **Dedup hardening (decided rule):** WhatsApp `wamid`s are stored **bare** in
   `platformMessageId` — the namespace is Meta-global and namespacing would
   break echo matching across YCloud/Kapso. Social platform message/comment
   ids (Instagram, Facebook, …) are stored **namespaced** as
   `${provider}:${nativeId}`. `deliveryId` provides durable dedup for events
   with no message id (status, comment, lifecycle).
   Test: same fixture POSTed twice → single side effect.
6. **Unified ingress (only when provider #2 is approved):**
   `POST /api/webhooks/ingress/[provider]` (Next.js dynamic segment; no
   `/api/v1` — the app has no versioned API surface) → secret per provider →
   `verifyWebhook` → `parseWebhook` → existing pipeline. Keep
   `/api/whatsapp/webhook` as the YCloud binding until then.
7. **ZernioAdapter** (when social channels are prioritized): API key →
   connect test account (dashboard or `GET /v1/connect/whatsapp`) →
   `POST /v1/webhooks/settings` {`message.received`,`comment.received`} →
   `POST /v1/webhooks/test` e2e → send via conversation create+message →
   media `refreshUrl` roundtrip → 10/min pacing test.
8. **KapsoAdapter** (spike only): confirm proxy base URL + auth on a test
   project; signature fixture; batch parsing; no production wiring.
9. **E2E per provider:** tunnel (cloudflared/ngrok) → real deliveries →
   assert 401 on bad signature, 200 within the provider ack window, retry
   replay is deduped, agent pipeline fires once.
10. **Ops docs:** `.env.example` gains `ZERNIO_*`/`KAPSO_*` vars when enabled;
    runbook: how to register each provider's webhook + where secrets live.

## 8. Sources (accessed 2026-10-18)

- YCloud send guide — https://docs.ycloud.com/en/api-reference/guides/whatsapp-platform/send-whatsapp-message
- YCloud configure webhooks — https://docs.ycloud.com/reference/configure-webhooks · https://docs.ycloud.com/en/api-reference/guides/api-fundamentals/configure-webhooks
- YCloud webhook integration guide — https://docs.ycloud.com/reference/webhook-integration-guide
- YCloud webhook events & payloads — https://docs.ycloud.com/reference/webhook-events-payloads · https://docs.ycloud.com/en/api-reference/guides/examples/webhook-examples/whatsapp-inbound-message-webhook-examples
- YCloud SDKs — https://docs.ycloud.com/reference/sdks · https://github.com/YCloud-Developers/ycloud-sdk-node
- YCloud Partner Center / embedded signup — https://docs.ycloud.com/en/partner-center/technical-development-partners/embedded-signup.md
- Zernio webhooks (events, retries, signatures, dedup) — https://docs.zernio.com/webhooks
- Zernio WhatsApp platform — https://docs.zernio.com/platforms/whatsapp.mdx
- Zernio send message — https://docs.zernio.com/messages/send-inbox-message.mdx
- Zernio connecting accounts — https://docs.zernio.com/guides/connecting-accounts.mdx
- Zernio create webhook settings — https://docs.zernio.com/webhooks/create-webhook-settings
- Zernio migrating from Twilio (signature/auth comparison) — https://docs.zernio.com/resources/migrations/migrating-from-twilio
- Kapso webhooks overview — https://docs.kapso.ai/docs/platform/webhooks/overview
- Kapso message events & payloads — https://docs.kapso.ai/docs/platform/webhooks/message-events.md
- Kapso send text — https://docs.kapso.ai/docs/whatsapp/send-messages/text.md
- Kapso TypeScript SDK quickstart — https://docs.kapso.ai/docs/whatsapp/typescript-sdk/introduction.md · https://github.com/gokapso/whatsapp-cloud-api-js
- Kapso embed onboarding / setup links / connection detection — https://docs.kapso.ai/docs/platform/tech-providers/embed-onboarding · https://docs.kapso.ai/docs/platform/setup-links/detect-connection
- Kapso doc index — https://docs.kapso.ai/llms.txt
