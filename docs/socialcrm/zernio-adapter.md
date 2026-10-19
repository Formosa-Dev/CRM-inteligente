# ZernioAdapter — implementation notes

`src/lib/messaging/providers/zernio.ts` implements the canonical
`MessagingProvider` contract (`provider-integration-evidence.md` §4) for
Zernio — the social-channel provider (Instagram/Facebook DMs, plus WhatsApp /
Telegram / SMS / Reddit alternatives). Registered in `registry.ts` but **not
channel-routed** — `whatsapp → ycloud` stays the v1 binding; the adapter is
reachable via `POST /api/webhooks/ingress/zernio`. Accounts are provisioned
through `channel_accounts` rows (`provider='zernio'`, `providerAccountId` =
Zernio `accountId`, `credentialsRef` e.g. `env:ZERNIO_`).

## Verified (docs.zernio.com MDX sources, fetched 2026-10-19)

- **Signature**: `X-Zernio-Signature` = lowercase hex HMAC-SHA256 over the
  raw body, **no timestamp**. Legacy alias `X-Late-Signature` accepted.
  `timingSafeEqual`; missing secret/header → fail closed (route 401s). Replay
  protection is deliveryId dedup only (signature has no freshness).
- **Delivery key**: `payload.id` (stable UUID) == `X-Zernio-Event-Id` header;
  legacy `X-Late-Event-Id`. Missing everywhere → `zernio:synth:<hash16>`.
- **Envelope**: `{id, event, timestamp, test?, profiles?, message|comment,
  conversation, account, metadata}`. `account.accountId` →
  `providerAccountId`; `message.platform`/`comment.platform`/`account.platform`
  → `raw.platform` channel hint (`isChannelKind` gates it; unknown platforms
  like tiktok/slack fail closed).
- **Event mapping**: `message.received` → `message.received`/inbound;
  `message.sent` → `message.echo`/outbound; `message.delivered|read|played|
  failed` → `message.status`/outbound (`statusAt` timestamp, `error` on
  failed); `comment.received` → `comment.received`/inbound;
  `account.*`/`whatsapp.*` → `account.lifecycle`; rest → `other`.
- **Sender** (`message.received`): `sender.phoneNumber` (E.164, WA only) or
  whatsapp `sender.id` → `sender.phone`; `sender.businessScopedUserId` /
  `parentBusinessScopedUserId` → `bsuid`/`parentBsuid`; non-WA `sender.id` →
  `socialId`; `username`/`whatsappUsername`/`name` mapped.
- **Echo keying** (kapso parity): `providerConversationId` =
  `conversation.participantId` (customer) on echoes vs `conversation.id`
  inbound — one conversation per customer. Thread id always on
  `providerThreadId` → `conversations.external_thread_id`.
  `echoOrigin:"api"` when `sentVia ∈ {api, broadcast, sequence, workflow,
  comment_automation, bulk-api}` or `source = cloud_api` → role "assistant".
- **Conversation-scoped sends**: `POST /v1/inbox/conversations/{id}/messages`
  `{accountId, message?, attachmentUrl/Type/Name?, template?, interactive?,
  replyTo?}` → `data.messageId`; `Idempotency-Key` honored (24h replay).
- **First contact**: `POST /v1/inbox/conversations` `{accountId,
  participantId, message | templateName+templateLanguage+templateParams}`.
  IG/FB cannot be opened API-side (PLATFORM_NOT_SUPPORTED — Meta requires
  customer-first); WhatsApp open requires a template (TEMPLATE_REQUIRED).
- **Media**: webhook attachments carry NO `refreshUrl`; the adapter
  synthesizes it as the re-mint endpoint
  `GET /v1/inbox/conversations/{convId}/messages/{platformMessageId}/
  attachments/{index}?accountId={accountId}` and `resolveMedia` fetches it
  with Bearer. WhatsApp media `url` points at the authenticated
  `/v1/whatsapp/media/{mediaId}` — download promptly (Meta drops media).
- **Standby/handover**: inbound messages under another app's control arrive
  flagged `metadata.standby: true` (read defensively; not filtered yet).

## [RESEARCH] — open items kept as named seams

| Item | Seam | Current value |
|---|---|---|
| Re-mint endpoint response shape | `resolveMedia` tolerates JSON `{url}`/`{data:{url}}` and redirects | not documented — correct once observed |
| `templateParams` ordering | `createTemplateParams()` flattens Meta `components[].parameters[]` texts | positional order assumed; verify vs approved template |
| Non-ChannelKind platforms (tiktok, slack, …) | `raw.platform` hint + `isChannelKind` gate | events fail closed (no channel) — expand enum if adopted |

## Provisioning checklist (per account)

1. Zernio dashboard → API key + `accountId` for the connected profile.
2. `POST /v1/webhooks/settings` (or dashboard) with
   `url = https://<host>/api/webhooks/ingress/zernio`, caller-chosen `secret`,
   `events` incl. `message.received`, `message.sent`, `message.delivered`,
   `message.read`, `message.failed`, `comment.received`, `account.*`.
3. Env: `ZERNIO_WEBHOOK_SECRET` (the same secret), `ZERNIO_API_KEY` when
   `credentialsRef = env:ZERNIO_` (per-account: `env:ZERNIO_MAIN_` →
   `ZERNIO_MAIN_API_KEY`).
4. Admin → Canales → row `provider=zernio`, `channel`, `providerAccountId`,
   `senderAddress`, `credentialsRef`.
