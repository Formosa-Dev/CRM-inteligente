# Post-integration audit — provider onboarding wave

Audit pass over `main` after integrating `socialcrm-provider-onboarding`
(`8d897d3` + `dce5bfa`, base `830c492`). Scope: embedded Zernio connect,
per-provider webhook UI, and the surrounding B5/S16 surface (zernio adapter,
ingress, account resolution, lead identities, send paths).

Severity: `bug` = wrong behavior today · `edge` = real but narrow ·
`note` = by-design compromise worth knowing · `cosmetic` = dead code/stale comment.

## Findings

### F1 — Cross-account delivery dedup drop — `bug` — **FIXED** (`705a21c`)
- `src/lib/messaging/channel-events.ts` — `isChannelDeliveryRecorded(provider, deliveryId)`
  read without `channel_account_id` scope while migration 0019's unique index is
  `(provider, coalesce(channel_account_id,-1), delivery_id)` → account A's
  marker suppressed account B's identical delivery id.
- **Closed**: `socialcrm-postpush-remediation` integrated (`705a21c` +
  `7e44dbe`) — the read now takes `channelAccountId` and mirrors the coalesced
  partition; plus a bonus: real phone numbers in test fixtures replaced with
  NANP `+1 555 01xx` and a digest-only whole-repo privacy guard added.

### F2 — New account row not visible after create — `bug` (UI) — **FIXED** (`234be4e`)
- `channels-view.tsx` held `useState(initialAccounts)` — `router.refresh()`
  delivered fresh props but the stale local copy won; the new row needed a
  hard navigation.
- **Closed**: rows now derive from props; only per-id status overrides live
  in local state (`socialcrm-admin-channels-fixes`). Note: the naive
  `useEffect` re-sync is rejected by React 19 lint (`set-state-in-effect`) —
  the props-derived shape is the correct pattern.

### F3 — Single connect-state cookie across platforms — `edge` — **FIXED** (`68a85a4`)
- One `zernio_connect_state` cookie for all platforms — a second connect
  clobbered the first nonce.
- **Closed**: `connectStateCookieName(platform)` helper keys the cookie per
  platform; callback validates `platform` first to name the cookie. Covered
  by `zernio-connect.test.ts`.

### F4 — ~~Dead `eventKey` field~~ — **NOT A BUG** (audit correction)
- `eventKey` looked unused because `channel_events` has no `event_key`
  column — but it is the dedup key of the injected `ChannelEventRepository`
  used by `channel-events.test.ts`. It stays.

### F9 — Zernio-bound WhatsApp accounts never reach the agent — `gap` — **MITIGATED** (`6f310df`)
- `src/app/api/webhooks/ingress/[provider]/route.ts` gates the app pipeline on
  `provider.id === "ycloud" && channel === "whatsapp"`. A WhatsApp number
  connected via Zernio embedded connect persists inbound messages but the
  agent never replies — silently. Same for Kapso WhatsApp accounts.
- Pre-existing design deferral (agent dispatch is YCloud-only until the agent
  layer is provider-generalized), but S16 makes the trap one click away.
- **Mitigation shipped**: the channels view warns next to the WhatsApp connect
  button that agent auto-reply requires the YCloud-bound account
  (`socialcrm-admin-channels-fixes`, `6f310df`).
- **Open**: provider-generalized agent dispatch (route the app pipeline by
  resolved `channel === "whatsapp"` + account capability rather than
  `provider.id`). That is a design change, not a bug fix — track separately.

### F10 — Telegram `platform_message_id` is a per-chat counter — `bug` — **FIXED** (`46e4608`)
- `src/app/api/telegram/webhook/[token]/route.ts` stored
  `String(message.message_id)` raw. Telegram `message_id` is a per-chat
  monotonic counter (1, 2, 3, …) shared by every chat, while
  `chat_messages.platform_message_id` dedup is global → a second authorized
  chat's early messages collide with the first chat's rows and get dropped as
  false duplicates (or false-positive against any provider's numeric ids).
- Latent in practice (single authorized chat today) but real data loss on any
  multi-chat install.
- **Closed**: `telegramPlatformMessageId(chatId, messageId)` in
  `src/lib/telegram/bot.ts` namespaces the key `tg_<chat>_<id>`
  (`socialcrm-tg-dedup-scope`). Covered by
  `src/lib/telegram/platform-message-id.test.ts` (helper + source guard).
- Note: rows stored before the fix keep bare ids — only replays of pre-fix
  messages could double-insert under the new key; acceptable (Telegram does
  not replay acked updates).

### F5 — Telegram identities normalized into `leads.phone` — `note`
- `src/lib/messaging/conversation-identity.ts` — `telegram` is a phone channel;
  numeric TG user ids pass `PHONE_SHAPED` and store digit-stripped in
  `leads.phone`, and `ensureLeadIdentity` is skipped for phone channels →
  telegram leads never get `lead_identities` rows. Consistent dedup today
  (deterministic), but a person known on Telegram and later on WhatsApp cannot
  merge — no shared identity row. By-design gap to revisit if cross-channel
  merge ships.

### F6 — Zernio events without `platform` skip persistence — `note`
- `ingress.ts` `resolveIngressContext` — `channelForProvider("zernio")` is
  undefined, so events with no `message/comment/account.platform` are dropped
  with a warn before any `channel_events` row. Fail-safe (no account can be
  attributed), but a silent skip if Zernio ever omits the field. Consider a
  persisted "unroutable" marker if this proves to happen.

### F7 — `platformMessageId` dedup is global — `note`
- `chat_messages.platform_message_id` unique is global (no provider/account
  scope) and `isMessageDuplicate` matches that scope. Consistent today —
  provider id formats are effectively namespaced — but a cross-provider id
  collision would false-positive dedup. Would need a schema change to scope;
  documented, not urgent.

### F8 — Orphaned lead rows on identity race — `edge` — **FIXED** (`ab6840b`, refined in review follow-up)
- `src/lib/messaging/lead-identity.ts` — concurrent first-contact inbounds can
  both create leads. The race is explicit when the raw provider ids differ but
  normalize to one canonical identity (for example whitespace variants):
  `leads_channel_external_user_uq` keys on the raw
  `(channel, external_user_id)`, so both inserts succeed, while
  `lead_identities_channel_external_uq` keys on the normalized
  `(channel, external_id)` and only one identity insert wins. The loser then
  carried its own `conversationId` stamp, so two leads could reference the same
  conversation.
- **Closed**: the losing path tracks `createdLeadId` and re-reads the winning
  identity owner. A just-created **phone-less** loser shell is deleted. A
  just-created loser shell that **carries a phone** is preserved (deleting it
  would discard a matchable identifier) with its duplicate `conversationId`
  cleared, so only the identity winner stays linked to the conversation.
  Pre-existing phone-matched leads are never deleted.
- Coverage: `lead-identity.test.ts` — "raw-id variants converging on one
  identity drop the phone-less loser shell", "a phone-bearing loser shell keeps
  its phone and loses the duplicate conversation stamp", and "FakeDb rejects
  identical raw channel/externalUserId like Postgres". FakeDb now mirrors both
  `leads.phone` and the partial raw `leads(channel, externalUserId)` indexes.

## Fixed before integration

- **Callback redirect base**: `backToChannels` originally built the redirect
  from env (`AUTH_URL` chain) — a missing/stale env could bounce the operator
  to `localhost` on a real deploy. Changed to `req.nextUrl.origin`
  (`dce5bfa`).

## Open research seams (documented in code, not bugs)

- `zernioAccountFieldNames` — `fetchZernioAccount` reads camelCase and
  snake_case defensively; confirm real payload field names on first live
  connect.
- Kapso embedded signup — deferred by design; provisioning stays manual.
- Zernio `resolveMedia` re-mint endpoint is synthesized from payload fields —
  verify against live payloads.

## Verification state at audit time

- `git diff --check`: clean. Worktree contained only the two user-owned
  untracked files.
- Post-integration gates: see execution-control §8 log; suite re-run on
  integrated main recorded with this audit.
