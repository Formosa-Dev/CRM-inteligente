# KapsoAdapter — implementation notes

`src/lib/messaging/providers/kapso.ts` implements the canonical
`MessagingProvider` contract (`provider-integration-evidence.md` §4) for Kapso.
Registered in `registry.ts` but **not channel-routed** — `whatsapp → ycloud`
stays the v1 binding; the adapter is reachable via
`POST /api/webhooks/ingress/kapso`. Credentials plug in later through
`channel_accounts` rows (`provider='kapso'`, `providerAccountId` = Meta
`phone_number_id`, `credentialsRef` e.g. `env:KAPSO_*`).

## Verified (docs.kapso.ai, fetched 2026-10-19)

- **Signature**: `X-Webhook-Signature` = hex HMAC-SHA256 over the raw body, no
  prefix/timestamp. Verified with `timingSafeEqual`; missing secret/header →
  fail closed (route 401s). `secret_key` is caller-chosen at registration
  (`POST /platform/v1/whatsapp/phone_numbers/{id}/webhooks`, `kind: 'kapso'`).
- **Event routing**: event name arrives in the `X-Webhook-Event` header;
  `X-Webhook-Payload-Version: v2`. Top-level `phone_number_id` is the account
  routing key → `providerAccountId`. `X-Idempotency-Key` → `deliveryId`
  (delivery-level dedup; retries reuse it).
- **v2 payload**: `{message{...,kapso{direction,status,processing_status,
  origin,has_media,content,statuses[],transcript,media_url,media_data}},
  conversation{id,contact_name,phone_number,business_scoped_user_id,...},
  is_new_conversation, phone_number_id}`.
- **Event mapping**: `whatsapp.message.received` → `message.received`/inbound;
  `whatsapp.message.sent` → `message.echo`/outbound (direction honored from
  `message.kapso.direction`); `whatsapp.message.delivered|read|failed` →
  `message.status`/outbound (`message.kapso.status`); `whatsapp.contact.*` →
  `account.lifecycle`; other `whatsapp.*` (conversation/thread) → `other`.
  Echoes/statuses go through the passive ingress path — never the agent.
- **Batching**: `X-Webhook-Batch: true` (or `body.batch === true`) →
  `{type, batch:true, data[], batch_info}`; `data[]` items share the
  unbuffered v2 shape. Each item gets `deliveryId` = `<idempotencyKey>:<wamid>`
  so batch retries dedup per item.
- **Send**: `POST {KAPSO_GRAPH_PROXY_BASE}/{phoneNumberId}/messages` with
  `X-API-Key` project key and exact Meta Graph body (`messaging_product`,
  `to`/`recipient` for BSUID, `type`, content, `context.message_id`).
  Response `messages[0].id` → `providerMessageId` (bare wamid, C6).
- **Media**: `message.kapso.media_url` (kapso-hosted) or
  `media_data{url,filename,content_type}` populate `mediaRefs` directly.
- **Dedup**: wamids stay **bare** in `platformMessageId` (Meta-global, C6).
  Id-less envelopes get a deterministic `kapso:synth:<hash16>` `deliveryId`.

## [RESEARCH] — open items kept as named seams (one-line corrections)

| Item | Seam | Current value |
|---|---|---|
| Canonical Graph-proxy host beyond the send path | `KAPSO_GRAPH_PROXY_BASE` (kapso.ts) | `https://api.kapso.ai/meta/whatsapp/v24.0` — docs show this host for sends; SDK quickstart hints `app.kapso.ai/api/meta/` (evidence §3) |
| Send idempotency semantics | `kapsoSendIdempotencyHeaders()` | forwards caller `idempotencyKey` as `Idempotency-Key` header; not documented by Kapso — ignored if unsupported |
| Media metadata path on the proxy | `kapsoMediaMetadataUrl()` | `GET {base}/{mediaId}?phone_number_id=…` — mirrors Meta Graph `GET /{media-id}` |
| Media CDN domains | `KAPSO_MEDIA_DOMAINS` | `["api.kapso.ai","lookaside.fbsbx.com"]`; passed to `downloadMedia` as per-call `extraAllowedDomains` only for kapso-resolved media (C12) — global allowlist untouched |
| Download auth for resolved media URLs | downstream `downloadMedia` call site | pass `{ "X-API-Key": apiKey }` when fetching kapso-resolved URLs (Meta CDN URLs may be pre-signed) |

## Credential model (no env/global fallback — unlike ycloud)

- `account.credentials` resolve **only** from the `channel_accounts` row's
  `credentialsRef` (accounts.ts `resolveCredentials`): `env:KAPSO_*` →
  `KAPSO_API_KEY` / `KAPSO_WEBHOOK_SECRET` / `KAPSO_ACCESS_TOKEN`.
  `credentialsRef: "agent_config"` or unset → **empty credentials** for kapso
  (`credentialsFromAgentConfig` is ycloud-only) → adapter fails closed.
- `sendMessage`/`sendTemplate`/`resolveMedia` require `credentials.apiKey` and
  `providerAccountId`; missing → `{ok:false, retryable:false}` / throw —
  never `process.env` or `agent_config`.
- Webhook secret at ingress: existing per-provider seam
  `resolveWebhookSecret("kapso")` → `KAPSO_WEBHOOK_SECRET` env (same
  install-level seam as ycloud, keyed per provider; absent → 401).
- `accessToken` is reserved for future Meta-direct flows — unused by the
  proxy send path.

## Known limits / residual risks

- v1 is **passive persistence only** on this route: `message.received`/
  `message.echo` persist to conversations/chat_messages; statuses/lifecycle
  persist to `channel_events`. No agent dispatch until the agent layer is
  provider-generalized (S15) and `whatsappProvider` gains `"kapso"`.
- Multiple kapso numbers each need their own `channel_accounts` row; inbound
  matching is by `phone_number_id` (fail-closed on no match).
- Echo `providerConversationId` = customer phone (`message.to`), matching the
  ycloud echo convention so echoes land in the customer conversation.
- `whatsapp.thread.*` / `whatsapp.conversation.*` map to `other` and persist
  via `channel_events` — reclassify later if a dedicated kind is needed.
- `git diff --check`, `test:agents`, `typecheck`, `lint`, `build` green at
  landing.
