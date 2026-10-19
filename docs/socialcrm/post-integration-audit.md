# Post-integration audit — provider onboarding wave

Audit pass over `main` after integrating `socialcrm-provider-onboarding`
(`8d897d3` + `dce5bfa`, base `830c492`). Scope: embedded Zernio connect,
per-provider webhook UI, and the surrounding B5/S16 surface (zernio adapter,
ingress, account resolution, lead identities, send paths).

Severity: `bug` = wrong behavior today · `edge` = real but narrow ·
`note` = by-design compromise worth knowing · `cosmetic` = dead code/stale comment.

## Findings

### F1 — Cross-account delivery dedup drop — `bug`, fix already exists
- `src/lib/messaging/channel-events.ts` — `isChannelDeliveryRecorded(provider, deliveryId)`
  reads without `channel_account_id` scope, but migration 0019's unique index is
  `(provider, coalesce(channel_account_id,-1), delivery_id)`. If a provider
  redelivers the same `deliveryId` fanned out to two channel accounts, account
  B's copy is skipped as duplicate after account A persisted → silent event
  loss on multi-account installs.
- **Status**: already fixed in unintegrated branch `socialcrm-postpush-remediation`
  (`bf24f44`) — it adds the `channelAccountId` parameter and the coalesced
  comparison mirroring the index. Integrating that branch closes this; no new
  worktree needed.

### F2 — New account row not visible after create — `bug` (UI)
- `src/app/(admin)/admin/channels/channels-view.tsx` — `const [accounts, setAccounts]
  = useState(initialAccounts)` never re-syncs. `submit()` calls `router.refresh()`
  which delivers a new `initialAccounts` prop, but `useState` keeps the stale
  list; `toggleStatus` mutates the same stale array. The toast says "Cuenta
  conectada" but the table doesn't show the row until a hard navigation.
- **Fix shape**: sync on prop change (`useEffect(() => setAccounts(initialAccounts),
  [initialAccounts])`) or render `initialAccounts` directly and keep only
  optimistic status overrides keyed by id.

### F3 — Single connect-state cookie across platforms — `edge`
- `src/app/(admin)/admin/channels/actions.ts` + callback route — one cookie
  `zernio_connect_state` for all platforms. Starting WhatsApp connect and then
  Instagram connect in another tab overwrites the nonce; the first roundtrip's
  callback fails `oauth-state` validation.
- Low risk: a single admin provisions accounts sequentially, and failure is a
  clean error flash, not corruption. Fix would key the cookie per platform.

### F4 — Dead `eventKey` field — `cosmetic`
- `src/lib/messaging/channel-events.ts` — `toChannelEventInsert` computes
  `eventKey` but `channel_events` has no `event_key` column; the insert drops
  it. Harmless dead field (dedup runs on the real unique indexes). Either add
  the column or drop the field.

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

### F8 — Orphaned lead rows on identity race — `edge`
- `src/lib/messaging/lead-identity.ts` — concurrent first-contact inbounds can
  both create phone-less leads; the `lead_identities` unique resolves to one
  winner, and `linkConversationToLead` only fills `conversationId` when null —
  the loser lead keeps its own `conversationId` stamp, so two leads reference
  the same conversation. Benign but untidy; a corrective pass could merge or
  clear the loser.

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
