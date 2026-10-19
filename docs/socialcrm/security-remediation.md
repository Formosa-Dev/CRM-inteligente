# SocialCRM — Post-Merge Security Remediation

Status: implemented on `socialcrm-security-remediation` (baseline `280a6d0`).
Scope: cross-account conversation takeover, scoped runtime config, fail-closed
error semantics, account-config FK safety, and durable status/lifecycle events.

## 1. Decisions

1. **Conversation identity is account-aware.** A conversation is identified by
   `(channel, channel_account_id, canonical external user id)`. Legacy rows
   (`channel_account_id IS NULL`) keep their old `(channel, canonical id)`
   identity. Two provisioned accounts may hold the same customer id without
   sharing a row.
2. **No silent rebinding.** A bound account never adopts a legacy row and a
   conversation is never moved from account A to account B. A present mismatch
   is a hard, typed failure.
3. **Exact runtime scope.** Inbound runtime reads `enabled`, allowlists,
   seller/delivery routing, auto-reply/redirect, API key and sender phone from
   the effective account/channel config row, never implicitly from `id = 1`.
4. **Fail closed on errors.** Not-found, mismatch, missing schema and transient
   DB failures are distinct results. Only a positively identified missing
   schema may use the legacy compatibility path. Transient failures produce
   retryable HTTP (`503`) or explicit caller errors, never an ack/drop.
5. **Durable normalized events.** Status/lifecycle/other events persist in
   `channel_events`, idempotent on the provider delivery id (plus a
   platform-message/status key). Id-less status events include the status in
   the synthetic delivery id, so transitions never collapse.
6. **Account deletion cascades its scoped config.** `ON DELETE SET NULL` was
   unsafe because clearing the account while keeping `channel` could collide
   with the channel-scope partial unique index.

## 2. Field-scope matrix

| Field | Scope | Why |
| --- | --- | --- |
| `enabled` | account → channel → global | Kill switch per connected number. |
| `allowedPhoneIds` | scoped | Which identities a number may talk to. |
| `sellerPhoneIds` | scoped | Seller routing belongs to the number. |
| `deliveryPhoneNumber` | scoped | Delivery routing belongs to the number. |
| `autoReply24h`, `autoReply24hMessage` | scoped | First-contact policy per number. |
| `webOrderRedirectEnabled`, `webOrderRedirectMessage` | scoped | Storefront-first policy per number. |
| `ycloudApiKey` | scoped (env fallback only on un-migrated install) | Sending as the account's own credentials. |
| `phoneNumber` / WhatsApp sender | scoped | Sender identity must match the account. |
| `systemPrompt`, business-hours and menu fields | scoped via `agent_config` resolution | Agent behavior per channel/account. |
| Install webhook secrets (`integration_secrets`, env) | **global** | One webhook endpoint per provider/install. |
| Provider registry (`channel → provider`) | **global** | Code-level routing, not business data. |
| Telegram internal ops bot | **global by design** | Single internal bot, not a customer channel. |

The admin UI already edits global / `channel:<c>` / `account:<id>` rows; this
change makes the runtime actually consume those rows.

## 3. Identity and migration

Migration `0015_account_aware_conversations.sql` (additive after a preflight):

- adds `conversations.external_user_id_normalized` and backfills it
  (digits for WhatsApp/SMS/Telegram-phone identifiers, trimmed otherwise);
- creates `(channel, channel_account_id, normalized)` and legacy
  `(channel, normalized) WHERE channel_account_id IS NULL` partial uniques;
- drops the old `(channel, external_user_id)` unique only after the new
  indexes exist.

A `DO` block aborts **before any DDL** if existing rows would collide under
`+/digits` normalization. There is no destructive dedupe: an operator resolves
the listed duplicates and re-runs `db:migrate`.

Account-scoped rows leave the legacy global `whatsapp_id` unique slot `NULL`,
so the same customer on two numbers cannot collide there.

## 4. Canonical resolution results

`resolveChannelAccountStrict` and `resolveChannelAccountByIdStrict` return:

- `resolved` — an active, registered row matching canonical candidates;
- `unprovisioned` — no rows for the channel (legacy install);
- `not-found` — rows exist but none matches;
- `mismatch` — multiple matches or a provider/channel disagreement;
- `schema-not-ready` — SQLSTATE `42P01` / `42703` / `3F000` only;
- `db-error` — every other failure (retryable).

`agent_config` uses the same shape (`resolved` with `source`
`account|channel|global`, `not-found`, `schema-not-ready`, `db-error`).
Cache keys are `channel:<c>|account:<id|none>`; only exact-scope results are
cached. A chained global fallback is never cached as scoped config.

## 5. HTTP and send semantics

| Situation | Behavior |
| --- | --- |
| Invalid/missing signature | `401` |
| Foreign echo / no matching account | `200` ignore (not retryable, no mutation) |
| Missing/inactive provisioned account for traffic | `200` fail-closed skip |
| Retryable account/config/dedup/persistence failure | `503` |
| `channel_events` schema missing (un-migrated) | explicit log + `200` until migration runs |
| Ambiguous phone→account binding on send | explicit caller error, no send |
| Bound account unresolvable / provider mismatch | explicit caller error, no send |
| Provider send failure | surfaced (`SendResult`, tool error, action failure) |
| YCloud image/document send | account `apiKey` + `senderAddress`; no global fallback when an account is bound |
| Delivery-arrived notification | scoped account/config; explicit `ok` / retryable failure; no `id=1` |
| Cron follow-up transient account/send failure | claim released + `503` so the next tick retries |
| Cron/queue ambiguous or unresolvable account | no send; cron keeps claim for manual review / queue moves to DLQ |
| Multi-event webhook | one retryable event makes the whole envelope `503` |
| `updateOrderStatus` notification failure | status updated; action returns `success: false` with reason |

`sendOutboundMessage` now throws on missing Telegram config/credentials and on
unbound WhatsApp without credentials instead of silently dropping.

## 6. Event persistence

`channel_events` (migration `0017`) stores provider, channel, account,
delivery id, platform message id, kind, direction, status, timestamp and the
raw payload. Unique keys:

- `(provider, coalesce(channel_account_id, -1), delivery_id)` — provider
  redelivery is idempotent **per account**; a provider-side delivery id is
  only unique per sender account, and migration `0019` re-scoped the index so
  two provisioned accounts can both persist the same delivery id while legacy
  `NULL` rows dedup in their own partition;
- `(provider, platform_message_id, kind, status)` where platform id and status
  are present — status transitions stay distinct but replay-safe.

Status/lifecycle/other events are persisted before the `200` ack in both the
canonical WhatsApp pipeline and the unified passive ingress. Empty protocol
echoes remain non-persisted by design and are documented by the
`isProtocolArtifact` gate.

## 7. Deletion safety

Migration `0016_account_config_cascade.sql` replaces
`agent_config.channel_account_id` `ON DELETE SET NULL` with `ON DELETE CASCADE`.
Deleting a `channel_accounts` row removes its scoped config row atomically,
so it cannot land in the channel-scoped uniqueness space. Global/channel rows
carry no `channel_account_id` and are unaffected.

## 8. Test coverage (deterministic, no `DATABASE_URL`)

- `conversation-identity.test.ts` — two-account separation, legacy null rows,
  `+/digits`, concurrent create races, mismatch guard.
- `accounts.test.ts` — canonical candidate matching, ambiguity, DB-failure
  fail-closed.
- `errors.test.ts` — schema vs transient classification.
- `agent-config-scope.test.ts` — channel+account cache keys, exact-scope-only
  caching, cascade migration.
- `order-status-notify.test.ts` — bound A/B routing, ambiguous/unresolvable
  failure, retryable send errors.
- `send-account.test.ts` — shared cron/queue/admin decision: A/B, retry,
  drop, ambiguous, not-found, legacy-only-when-unprovisioned.
- `router-account.test.ts` — bound row selection never returns a legacy row.
- `delivery-notify.test.ts` — delivery/customer notification, lookup failure,
  retryable send failure.
- `webhook-response.test.ts` — multi-event aggregation (`503` wins).
- `messenger.test.ts` image/document — A/B account credentials and sender.
- `channel-events.test.ts` — idempotency, status keys, schema classification,
  additive migration.
- `ingress.test.ts` — passive echo identity uses `providerConversationId`,
  no placeholder on DB failure, and business-only self-address candidates.
- `auto-reply.test.ts` — first-contact retry gate and deterministic marker.
- `security-round3.test.ts` — mocked-DB legacy `whatsapp_id` fallback,
  two-account passive pipeline, two-event signed webhook, blank scoped key,
  and Meta fail-closed routing.
- `src/lib/queue/worker.test.ts` — popped-payload retry/DLQ on unexpected
  throws and re-enqueue failures.
- `src/app/api/whatsapp/webhook/route.test.ts` — raw-body HMAC plus `401`/`503`
  HTTP statuses.

## 9. Residual risks

- `0015` intentionally fails (before DDL) if production already contains
  `+/digits` identity duplicates; those must be resolved manually.
- `channel_events` keeps a `SET NULL` FK on account deletion (event history is
  preserved); this is safe because the table has no account-scoped uniqueness.
- Non-YCloud providers remain passive-only until their adapters ship; the
  identity/account plumbing is provider-generic.
- A retryable redirect/fixed-reply send returns `503`, but inbound dedup means
  a provider replay will not resend that deterministic reply; the failure is
  surfaced rather than silently acked.
- Meta direct webhook only resolves accounts for the registered WhatsApp
  provider and only when `metadata.phone_number_id` / display number is
  present. In v1 that provider is YCloud; a Meta-direct-only install with no
  matching provisioned row is skipped (fail closed).
- `0018` re-normalizes existing identities. Like `0015` it aborts before any
  update when the new canonical identities collide; an operator must resolve
  the listed duplicates first.
- The auto-reply idempotency marker is stored as an assistant message with a
  deterministic `platform_message_id`; it is real outbound history, but on a
  first contact it can appear before the inbound message row until that row is
  persisted later in the same request.
- `leads.phone` is `UNIQUE`, so a customer who messages two provisioned
  accounts shares a single lead row; `leads.channel_account_id` follows the
  account that most recently contacted them (account-scoped order lookups
  attribute orders to that owner). Per-account duplicate leads are impossible
  by constraint — this is the intended ownership model, not per-account lead
  state.
- Account-scoped order/lead reads attribute through `leads.channel_account_id`.
  Orders whose `lead_id` is `NULL` (no matching lead row at creation time)
  carry no account attribution and are therefore invisible to account-bound
  scopes — fail closed by design; legacy unbound contexts still read them
  phone-globally.
- The `wa-inbound:*` rate-limit and buffer/dedup keys keep their exact legacy
  shape for `channel_account_id IS NULL`; the `acct<N>:` prefix only applies
  to provisioned accounts, so old and new installs behave identically.

## 10. Corrective review (post-`db3659c`)

The independent review findings were addressed in the corrective commit(s):

| Finding | Fix |
| --- | --- |
| YCloud media ignored scoped credentials | image/document now use `sendDirectlyWithAccount` with the resolved `apiKey`/`senderAddress`; behavior tests cover A/B. |
| Delivery arrived used `agent_config id=1` and swallowed errors | `delivery-notify.ts` + resolved context; failures return `502/503`. |
| Cron/queue fail-open | shared `decideSendAccount`; cron releases claims on retryable failures and returns `503`; queue retries transient and DLQs permanent. |
| Multi-event status kept only last | `aggregateWebhookStatuses`; any retryable event makes the envelope `503`. |
| `not-found` mapped to legacy | `DefaultAccountResolution.not-found` is a hard fail; legacy only for `unprovisioned`/`schema-not-ready`. |
| Order history used phone-only `limit(1)` | history uses the resolved conversation/account from `sendOrderStatusNotification` or account-scoped `findOrCreateConversation`. |
| Retryable metadata ignored | `classifyError` honors explicit `retryable` flags (resolution/send errors). |
| Redirect/fixed reply failures swallowed | send-then-persist, explicit `502/503`, never unconditional success. |
| Status id-less collision | synthetic delivery id includes status. |
| Legacy row chosen over bound row | `selectBoundConversationId` returns only the bound row. |
| Meta webhook created null-account rows | resolves `metadata.phone_number_id`/display number; fail-closed skip or `503`. |
| Provider IDs matched by digit suffix | `looksLikePhone` requires phone punctuation and >=7 digits; `phoneMatches` rejects `waba-2`/`acc-123`. |


## 11. Corrective review round 3 (`280a6d0..778ec30`)

The fresh review of the remediation range returned CHANGES_REQUIRED. The
findings below are fixed on top of `778ec30`:

| Finding | Fix |
| --- | --- |
| Unbound admin WhatsApp reply bypassed account resolution and used global/env credentials | `sendOutboundMessage` now calls the shared `decideSendAccount` (phone binding first, then the single active account). Ambiguous/not-found/db-error are hard failures; the legacy config/env pair is reachable only for a genuinely unprovisioned channel. |
| Legacy NULL `external_user_id` rows lost the `whatsapp_id` fallback | Null-account lookups fall back to `whatsapp_id` (including the `tg_` form). Migration `0018` backfills `external_user_id` from `whatsapp_id` and re-canonicalizes, preflighting collisions first so it cannot raise `23505` mid-update. |
| Blank scoped `ycloudApiKey` silently fell back to global/env | Account/channel rows with a blank key now materialize as a `mismatch` (explicit fail). Only a resolved `global` source or `schema-not-ready` may use the install key/env. |
| Auto-reply ignored `retryable` and was not retry-idempotent | Permanent failures return `502`, retryable ones `503`. Sends carry a deterministic idempotency key and record a marker; the gate resends only when the first contact never produced a message, and never after the marker exists. |
| Meta webhook could auto-pick the sole account | Resolution requires Meta routing candidates and the registered WhatsApp provider; missing routing key/provider or a provider mismatch skips the message. |
| Echo/status resolution accepted the customer `to` as a self address | Direction-aware `eventSelfAddresses`: inbound uses `to`; outbound/status uses `sender.phone`/`from` only. |
| Unexpected queue throw lost the popped payload | The retry policy is extracted and applied to the popped payload; unexpected throws retry with `retryCount`, then DLQ, and a failed re-enqueue falls back to the DLQ. |
| Synthetic status ids could collide across envelope keys | The synthetic id hashes a stable, sorted representation of every normalized envelope candidate, including `whatsappMessageUpdated`. |
| Missing two-account/route behavior coverage | Added a mocked-DB two-account passive-pipeline test, a two-event signed webhook route test, and a Meta fail-closed test; `assertConversationAccount` is now wired into identity resolution. |
| Delivery notification used the install-wide latest pending order | Account-scoped contexts join `orders → leads` and filter by `leads.channel_account_id`; the unbound/legacy context keeps the historical lookup. |
| Dead `id=1`-based location forwarding helper; SQL/JS trim drift | Removed `forwardLocationToDelivery`; `0018` re-normalizes with whitespace trimming that includes tabs/newlines, matching the runtime canonicalizer. |

## 12. Corrective review round 4 (`71483c1..`)

The fresh review of `280a6d0..71483c1` returned CHANGES_REQUIRED. The
findings below are fixed on top of `71483c1`:

| Finding | Fix |
| --- | --- |
| **H1** `triggerAgentForConversation` bypassed send-account resolution (`agentConfig id=1` + env credentials) | The dashboard action now resolves the sender through the same decision path as outbound sends: bound conversation → `resolveChannelAccountById`; unbound WhatsApp → `resolveUnboundWhatsAppSend` (binding → single active account → legacy only when truly unprovisioned); non-WhatsApp unbound → `resolveChannelAccount`. `ambiguous`/`fail`/unresolvable return a typed failure — never a silent global-credential send. |
| **H2** Buffer/dedup/rate-limit keys were `${channel}:${phone}` with no account | `accountScopedInboundKey` namespaces the inbound identity as `acct<N>:<phone>` for bound events; the `wa-inbound:` rate limit, `BufferManager.isContentDuplicate`, `enqueue`, and `scheduleBufferProcessing` (lock/timer/fetch/last-processed) all key off it. `channelAccountId NULL` keeps the exact legacy key shape. |
| **H3** `leads.channel_account_id` was written nowhere — the scoped delivery join was dead code | Every conversation-context lead write stamps the column when the account is known: `captureLeadIfNew` (insert + re-contact restamp), conversation auto-linking, inbound location/address updates, and the WhatsApp `createOrder` lead upserts. Telegram/admin/API writes have no conversation account and stay `NULL`. Because `leads.phone` is unique, the column records the owning (most recent) account. |
| **M1** `notifyDeliveryOrder` composed `decrypt(scoped) \|\| env` credentials | It now resolves the sender exactly like outbound sends: bound conversation → `resolveChannelAccountByIdStrict` (a blank scoped key is an explicit `mismatch` — the notification logs and skips rather than falling back); unbound → `resolveUnboundWhatsAppSend` where legacy env credentials only apply to a genuinely unprovisioned channel. |
| **L1** `get-number.ts` was a dead global-credential helper | Deleted — no live callers existed (only generated-doc references). |
| **L2** `ingress.ts` header claimed no `channel_events` table exists | Header and `logAckedWithoutPersistence` comments now describe the real persistence path (`persistChannelEvent` for status/lifecycle/other kinds; the log helper is only for protocol artifacts, unsupported kinds, or unresolvable identities). |
| **L3** `(provider, delivery_id)` uniqueness was provider-wide | Fixed additively: migration `0019_channel_events_scoped_delivery` drops the old index and recreates it as `(provider, coalesce(channel_account_id, -1), delivery_id)` — `0017` is untouched and `NULL` rows keep a dedicated partition. `FakeDb` models the same key so tests exercise the real constraint. |
| **L4** Order lifecycle and agent context reads were phone-global | `findActiveOrder`/`getActiveOrderSnapshot` accept an optional `channelAccountId` and join `orders → leads` when bound; the agent's customer-context queries (lead, preferences, recent orders, pending order) scope by the conversation's account; agent tools (`getOrderStatus`, `addToOrder`, `updateOrder`, `cancelOrder`, `suggestProducts`, `getClientHistory`) gate reads/mutations through `isOrderVisibleToScope` or the owning-lead join using `currentAgentConfigScope()`. `NULL` scope/account keeps every legacy phone-global path unchanged — that boundary is deliberate: an unprovisioned install has exactly one account universe. |

New regression coverage: `src/lib/messaging/security-round4.test.ts`
(25 tests) — bound/ambiguous/legacy send-decision paths for the admin trigger,
account-namespaced inbound keys and buffer isolation, lead stamping +
account-scoped delivery lookup, delivery-notification credential selection
(bound-blank fails closed, bound-valid sends as the account, unbound-ambiguous
fails closed, unbound-unprovisioned uses legacy creds), per-account
`channel_events` delivery dedup, and account-scoped order/lifecycle/tool
reads with a phone-global legacy fallback.

## 13. Corrective review round 5

Round 4 closed cross-ACCOUNT leakage. Round 5 closes cross-CUSTOMER
leakage inside one account (and inside the shared legacy plane), plus a
credential fail-open where a real account with empty scoped credentials
could delegate to the install-global sender.

| Finding | Fix |
| --- | --- |
| **HIGH** Model-supplied `orderId`/`phone` trusted raw — a customer could read/mutate another customer's same-account or legacy order, fetch another lead's PII/history, or write another phone's address | `AgentConfigScope` now carries `customerPhone` — the server-side normalized conversation phone, bound by `resolveScopeForConversation` (and by the webhook pipeline's `configScope`). Every customer-facing tool resolves identity through the scope, never the model args: `getOrderStatus`/`addToOrder`/`updateOrder`/`cancelOrder` require `order.phoneNumber === scope.customerPhone` after the account check (a foreign order answers not-found, unchanged); `suggestProducts`, `getClientHistory`, and `saveAddress` ignore the model's phone arg entirely when a customer is bound. Scopes WITHOUT `customerPhone` — internal/admin/tool-preview callers — keep the arg-driven semantics unchanged. |
| **MEDIUM** `env:`/`unknown` credentialsRef materialized an account with empty credentials, which then delegated to the install-global sender (`agent_config` → env) | Two-layer fail-close. (a) `accounts.ts`: an `env:PREFIX` ref that yields no send credential (no API_KEY and no ACCESS_TOKEN), and any unknown ref (`vault:`, typos), throws `MissingScopedCredentialError` → strict resolvers return `mismatch` — the account is never materialized. (b) `providers/ycloud.ts` `sendMessage`: a real `channel_accounts` row (numeric `id`) with an empty scoped `apiKey` returns a non-retryable failure BEFORE any send decision — it can never reach the delegated `sendText`/`sendImage`/`sendDocument` in `src/lib/ycloud.ts` (`getYCloudCreds` → `getBusinessInfo`), which remain reachable ONLY via the explicit placeholder/caller-resolved paths (unprovisioned/legacy sends). |

New regression coverage: `src/lib/messaging/security-round5.test.ts`
(16 tests) — normalized customerPhone binding on the scope; two-customer
orderId/phone/history/address/cancel/update/add cases under both a bound
account scope and a legacy NULL scope (cross-customer = not-found or
scoped-override, own-customer = pass, scope-less = legacy semantics); env-ref
empty-vars and `vault:` refs resolving to strict `mismatch`; a real account
with an empty key failing text/image/document sends with zero global-sender
invocations; the placeholder path still delegating; and a scoped key sending
directly with its own `X-API-Key`.

Residual boundary (unchanged, intentional): the legacy NULL-account plane is
shared — a customer-bound scope there still only sees its own customer's
objects (the phone gate does not require an account), but it may reach
legacy rows of the SAME phone regardless of lead ownership.
