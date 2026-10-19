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
   platform-message/status key).
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
| `updateOrderStatus` notification failure | status updated; action returns `success: false` with reason |

`sendOutboundMessage` now throws on missing Telegram config/credentials and on
unbound WhatsApp without credentials instead of silently dropping.

## 6. Event persistence

`channel_events` (migration `0017`) stores provider, channel, account,
delivery id, platform message id, kind, direction, status, timestamp and the
raw payload. Unique keys:

- `(provider, delivery_id)` — provider redelivery is idempotent;
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
- `channel-events.test.ts` — idempotency, status keys, schema classification,
  additive migration.
- `ingress.test.ts` — passive echo identity uses `providerConversationId`,
  no placeholder on DB failure.
- `src/app/api/whatsapp/webhook/route.test.ts` — raw-body HMAC plus `401`/`503`
  HTTP statuses.

## 9. Residual risks

- `0015` intentionally fails (before DDL) if production already contains
  `+/digits` identity duplicates; those must be resolved manually.
- `channel_events` keeps a `SET NULL` FK on account deletion (event history is
  preserved); this is safe because the table has no account-scoped uniqueness.
- Non-YCloud providers remain passive-only until their adapters ship; the
  identity/account plumbing is provider-generic.
