# SocialCRM Roadmaps — Adversarial Review

**Decision up front:** all three documents are useful and none is rejected, but none is safe to execute as written. The provider facts are the strongest part; the weak parts are (1) three incompatible adapter contracts, (2) a migration journal that cannot produce a fresh install, (3) a `/setup` flow that uses a transaction the Neon HTTP driver does not support, (4) a schema that cannot store phone-less social identities, and (5) an unresolved scope split between “contract only” and “build ChannelAccount + Kapso”.

| Field | Value |
|---|---|
| Base | `c14951d887db80cfc8058b21282833e193db2c24` |
| Review branch | `socialcrm-roadmaps-review` (not merged; source branches untouched) |
| Reviewed commits | `4e983a6` architecture · `ab7ae2f` evidence · `1425a9f` self-hosted |
| Source brief | `docs/socialcrm/multiprovider-source-spec.md`, untracked, treated as requirements only |
| Method | Static code/schema/deployment inspection + primary provider docs spot checks. No secrets read. No DB writes. No source edits. |
| Content integrity | `git hash-object` of each reviewed file matches `git rev-parse <commit>:<path>` |

## Verdicts

| Commit | Document | Verdict | Condition |
|---|---|---|---|
| `4e983a6` | `docs/socialcrm/architecture-roadmap.md` | **APPROVE WITH REQUIRED FIXES** | Freeze one contract; fix credential cutover; add social-identity schema plan; correct call-site inventory and test gate. |
| `ab7ae2f` | `docs/socialcrm/provider-integration-evidence.md` | **APPROVE WITH REQUIRED FIXES** | Make its contract canonical (with `tenantId` and `sendTemplate?`) or explicitly subordinate it; reconcile its “do not build” recommendation with the other two documents. |
| `1425a9f` | `docs/socialcrm/self-hosted-product-roadmap.md` | **APPROVE WITH REQUIRED FIXES** | P1 is blocked until the migration journal and `/setup` transaction are fixed; remove or gate the Kapso embedded-signup acceptance criterion. |

No commit is **REJECT**: every defect is fixable in the documents or in a small preparatory work unit. `1425a9f` is closest to reject because its central installability promise cannot be met by the current repository, but the document already contains the right P0 hook; it needs the correct severity and scope.

## 1. Findings (prioritized)

### CRITICAL

#### CR-1 — The three documents define three incompatible contracts

`architecture-roadmap.md` §2.2 (lines 78–120), `provider-integration-evidence.md` §4 (lines 205–287), and the source brief §4.1 (lines 95–119) disagree on the interface that Phase 0 is supposed to freeze:

| Element | Architecture §2.2 | Evidence §4 | Source brief §4.1 |
|---|---|---|---|
| Signature verification | `verifySignature({rawBody, headers, account})` → `boolean` | `verifyWebhook({headers, rawBody, secret})` → `{ok, reason?}` | none |
| Inbound parsing | `parseInbound(...)` → array | `parseWebhook(...)` → array | `parseInboundWebhook(...)` → single object |
| Outbound | `send(account, msg)` | `sendMessage` + optional `sendTemplate` | `sendMessage` + optional `sendTemplate` |
| Media | `downloadMedia?` | `resolveMedia?` | none |
| Account shape | `tenantId`, `externalAccountId`, `EncryptedJson` | no `tenantId`, `providerAccountId`, `senderAddress` | `tenantId`, `providerAccountId`, `phoneNumberId` |
| Event shape | `providerEventId`, `senderId`, `media`, `location`, `kind` | `deliveryId`, `sender{}`, `mediaRefs[]`, `direction`, `status` | not defined |
| Channel values | `ChannelId` has no `comment` | `ChannelKind` includes `comment` and `messenger` | `ChannelType` has neither |
| Naming | `NormalizedInboundEvent` | `NormalizedInboundEvent` | `SystemInboundEvent` |

**Impact:** a Phase 0 “contract freeze” cannot succeed while three contracts exist. Adapters written to one will not satisfy the others, and the `comment`/`messenger` conflation will leak into the schema.
**Required fix:** designate one canonical contract. Recommended: evidence §4, extended with `tenantId: string` and optional `sendTemplate`, with `comment` as an event kind rather than a channel. Make architecture §2.2 and source brief §4.1 explicitly reference it instead of redefining it.

#### CR-2 — The migration journal cannot produce a fresh install, and the self-hosted doc misdiagnoses it

`self-hosted-product-roadmap.md` G3 (lines 95–100) says the journal has duplicate `0002` sequence numbers. That is not what the repository shows:

- `drizzle/meta/_journal.json` entry `idx: 1` points to `0001_handy_tombstone`, but `drizzle/0001_handy_tombstone.sql` does not exist. A fresh `drizzle-kit migrate` cannot read that entry.
- `drizzle/0002_unique_phone.sql` is tracked but absent from the journal. It performs a destructive dedupe of `leads`, reassigns `orders`, and adds `leads_phone_unique`.
- `src/db/schema.ts:285` declares `leads.phone` as `.notNull().unique()`, so a fresh database migrated from the journal will lack the unique constraint the schema expects.
- Snapshots are missing for journal entries `0003`, `0006`, `0007`, `0011`, and `0012`.

**Impact:** `drizzle-kit migrate` on a fresh Neon branch is expected to abort on the missing `0001` file; even after restoring it, the orphan `0002` never runs. `self-hosted` P1 acceptance (lines 163–166) and the “under ~30 minutes” success metric (lines 49–50) are not achievable.
**Required fix:** restore or renumber `0001`, introduce a guarded/idempotent migration for the unique constraint (do not blindly journal the destructive `0002` as-is; existing installs may have run it), regenerate snapshots, then prove `drizzle-kit migrate` on an empty Neon branch and confirm `drizzle-kit generate` produces no diff. This is a P0 blocker, not a “later integrity pass”.

#### CR-3 — `/setup` uses an interactive transaction that the documented driver does not support

`self-hosted-product-roadmap.md` §1.4 (lines 34–37) says `/setup` is “already implemented … keep as-is” and §2.1 (line 59) calls it a “race-safe advisory lock”. In code:

- `src/app/setup/actions.ts:40` calls `db.transaction(...)`.
- The repository’s own comment at `src/lib/checkout/service.ts:31-34` states that the `neon-http` driver backing `db` “does not support `db.transaction()` (it throws)”.
- The same unsupported pattern also appears at `src/app/(admin)/admin/clients/actions.ts:206` (separate bug).

**Impact:** the first-admin bootstrap is expected to return a 500 instead of creating the admin, so the Render + Neon golden path fails at the first screen.
**Required fix:** rewrite setup as a single conditional insert plus a session-level advisory lock (or a `db.batch`/SQL path), add a concurrent-submit test, and stop advertising `/setup` as “keep as-is” until it is verified on `neon-http`.

#### CR-4 — The schema cannot represent phone-less social identities, which the evidence says will arrive

`provider-integration-evidence.md` §4 rule 8 (lines 314–315) correctly says “never assume `sender.phone` exists” and makes BSUID first-class. The current schema and router do not support that:

- `conversations.whatsappId` is `notNull().unique()` (`src/db/schema.ts:187`). `src/lib/channels/router.ts:76-79` synthesizes `tg_<id>` for Telegram; Instagram/Facebook/comment rows have no defined synthetic value.
- `leads.phone` is `notNull().unique()` (`src/db/schema.ts:285`). `src/lib/channels/router.ts:89-90` auto-links by phone, and `autoAttachToLead` looks up `leads.phone` (`:203-215`).
- `BUFFER_CONFIG` only defines `whatsapp` and `telegram` (`src/lib/buffer/config.ts:1-13`); the router’s `Channel` union is also only those two (`src/lib/channels/router.ts:7`).

**Impact:** Instagram/Facebook DMs and comments without a phone cannot be persisted or lead-linked as designed. Calling `normalizePhone()` on a social handle is not a valid identity strategy. Architecture C3’s “migrations are additive only” (lines 144–147) is false as stated.
**Required fix:** design a social identity model before Phase 4: nullable `leads.phone` or a `lead_identities(channel, external_id)` table; a synthetic `whatsappId` convention (for example `${channel}:${externalUserId}`) or a nullable column; extend `Channel` and `BUFFER_CONFIG`; add a phone-less Instagram fixture that exercises persistence and dedup.

#### CR-5 — Credential resolution will silently ignore admin edits after backfill

`architecture-roadmap.md` §2.1 (line 72) and Phase 2 (lines 262–270) define resolution as `channel_accounts → agent_config → env`. The admin UI still writes only `agent_config` (`src/app/(admin)/admin/agent/actions.ts:256-261` and `:306-311`).

**Impact:** once the YCloud account row is backfilled from `agent_config`, a later key or webhook-secret change made in `/admin/agent` is shadowed by the stale `channel_accounts` value. C2’s claim that `agent_config` “remains writable” (lines 140–143) is technically true but operationally false. This is exactly the kind of cutover bug that removes a deployed install’s ability to send.
**Required fix:** until the admin UI writes `channel_accounts`, make the resolver prefer `agent_config` for the legacy `ycloud/whatsapp` account, or dual-write both locations, or compare `updatedAt`. Add a test that edits the legacy field after backfill and asserts the new value wins.

#### CR-6 — Scope is unresolved: “contract only” versus “build ChannelAccount + routing + Kapso”

The documents do not agree on the v1 deliverable:

- Evidence verdict (lines 10–25) and checklist item 8 (lines 394–395): do **not** build the routing matrix or `ChannelAccount` table now; Kapso is deferred and spike-only.
- Architecture Phase 2–3 (lines 253–284) builds `channel_accounts` and unified ingress; Phase 5 (lines 301–311) switches WhatsApp to Kapso.
- Self-hosted Phase 3–4 (lines 184–219) builds `channel_accounts`, admin CRUD, a routing matrix, and Kapso embedded-signup onboarding.
- Source brief §7 (lines 224–230) asks for messaging-core, all adapters, and the unified ingress.

**Impact:** three teams following three documents would build three different products. The self-hosted Kapso acceptance criterion (“WhatsApp channel can be switched YCloud↔Kapso by configuration alone”, lines 218–219) directly contradicts evidence’s “Kapso is deferred … no production wiring”.
**Required fix:** make an explicit v1 decision. Recommended: contract + YCloud adapter + installability now; `channel_accounts` and unified ingress when a second provider is approved; Zernio next; Kapso spike only; embedded signup out of v1.

### WARNING

- **W-1 — Ingress path inconsistency.** Architecture uses `/api/webhooks/ingress/[provider]` (§2 line 47–49, Phase 3 line 274); evidence uses `/api/webhooks/ingress/:provider` (§7 item 6, lines 385–388); source brief and self-hosted use `/api/v1/webhooks/ingress/:provider` (brief line 204; self-hosted lines 43 and 192). Next.js syntax is `[provider]`, not `:provider`. Pick one path and one versioning policy. Recommendation: `/api/webhooks/ingress/[provider]`, because the rest of the app has no `/api/v1` surface.
- **W-2 — Architecture’s interface cannot send WhatsApp templates.** `architecture-roadmap.md` §2.2 (lines 112–119) has no `sendTemplate`, while the source brief §4.1 (line 101) and evidence §4 (lines 282–283) include it. Zernio’s WhatsApp first contact requires a template (evidence lines 109–116), and Kapso’s send docs state non-template messages need an open 24-hour window. Add `sendTemplate?` or declare Zernio WhatsApp out of scope.
- **W-3 — Evidence contradicts itself on `tenantId`.** §4 `ChannelAccount` (lines 215–225) has no `tenantId`; §5 (lines 344–345) says “`ChannelAccount`/`tenantId` fields exist in the contract”. Add the field or delete the claim.
- **W-4 — `platformMessageId` namespacing is unresolved.** Architecture C6 (lines 154–158) says every new provider stores `${provider}:${nativeId}`. Evidence §7 item 5 (lines 381–383) says the wamid namespace is Meta-global and recommends confirming cross-provider ids. For WhatsApp-via-Kapso, namespacing the same wamid would break parity and echo matching; for Instagram it is necessary. Decide per channel: keep WhatsApp wamids bare, namespace social ids. Also define event-level dedup (`deliveryId`/`providerEventId`) for status and comment events that have no message id.
- **W-5 — Direct-send inventory is incomplete and contains a non-existent call site.** Architecture §1 (line 34) lists “admin test”, but `src/app/api/agent/test/route.ts` only checks config and never sends. It omits `src/app/(admin)/admin/dashboard-actions-server.ts:89-92` and `src/app/(admin)/admin/orders/actions.ts:189-190,239-240`. Phase 1 (lines 237–240) also misses those two. A refactor driven by this list will leave direct YCloud calls behind.
- **W-6 — YCloud SMS is marked “verified in repo”.** Architecture §4 (line 187) marks YCloud `sms` as `(V)`, and the legend (line 183) defines `V` as verified in repo code. There is no SMS implementation in `src/`; `ChannelId` includes `sms` only on paper. Change to `(S)`/unverified or remove `sms` from v1.
- **W-7 — The first slice adds tests that do not run.** Architecture §6 (lines 322–340) adds `provider-contract.test.ts` and `providers/ycloud.test.ts` while insisting on “zero edits to existing files”. `package.json`’s `test:agents` lists 13 files; the new tests are not among them. Separately, `src/lib/whatsapp/web-order-redirect.test.ts` is not in `test:agents` either (14 test files on disk). Run the new tests explicitly in unit 1 and wire them into the gate in unit 2; document or add the missing existing test.
- **W-8 — “Up and down in CI” is not supported by the repository.** Self-hosted §5 (lines 243–244) requires every migration to be exercised up and down on a Neon branch in CI. There is no `.github/workflows`, no down-migration script, and `drizzle-kit` does not generate down migrations. Either add CI plus explicit rollback scripts, or reword the gate to “restore the Neon branch/backup and re-migrate”.
- **W-9 — Install acceptance overclaims what a blueprint can do.** Self-hosted Phase 1 (lines 163–166) requires “fresh clone → deploy via blueprint → `/setup` → login → send+receive WhatsApp”. This depends on CR-2, CR-3, an externally provisioned Neon database, and a publicly registered YCloud webhook. Split the criterion into “deployable” and “messaging end-to-end”; measure the 30-minute metric before asserting it.
- **W-10 — Queue and DLQ are not “in-memory fallback”.** Self-hosted §2.1 (line 64) says “Upstash optional, in-memory fallback documented” for buffer, DLQ, rate-limit, and circuit breaker. In code, `src/lib/queue/producer.ts:17`, `worker.ts:19`, and `dlq.ts:18` are no-ops without Upstash; only buffer and rate-limit have true in-memory fallbacks. `.env.example` also says the DLQ runs in memory, which is false. Correct the doc or make the queue explicitly optional for single-instance installs.
- **W-11 — Neon-only reality contradicts two shipped docs.** Self-hosted G4 (lines 101–104) is correct, but `README.md:54` says “Neon / Render PG / any Postgres” and `.env.example:20` says “Neon, Render Postgres, Supabase”. The roadmap must include fixing both, or add a `pg` driver path. This is a direct user-facing installation failure, not a cosmetic doc issue.
- **W-12 — The reviewed commits reference a file absent from their base.** Architecture line 16, evidence line 4, and self-hosted lines 11 and 269 point to `docs/socialcrm/multiprovider-source-spec.md`; the requested base has no `docs/socialcrm/` (`git ls-tree`), and this review branch intentionally leaves the brief untracked. Against that base the references are broken. Current `main` has since promoted a copy (`fe04b2b`, outside the reviewed commits), which resolves the issue there; if these commits are merged onto `c14951d` alone, add a tracked note. Do not commit the brief in this review work unit.
- **W-13 — Conversation-to-account association is undefined.** Self-hosted Phase 3 (lines 189–191) says conversations gain a channel-account reference; architecture C3 (lines 144–147) says no rewrite and relies on `externalUserId`. A single install may have multiple accounts on one channel. Decide: add a nullable `channelAccountId` FK (additive) or resolve the default account per send and document that multi-account sends go to the default. The latter is unsafe for a future Zernio multi-profile setup.
- **W-14 — Evidence’s channel taxonomy conflates channel and event kind.** `ChannelKind` (lines 211–214) includes `comment`, which architecture treats as an event `kind`. Keep `ChannelId` (`whatsapp|instagram|facebook|telegram|sms|...`) separate from `EventKind` (`message|echo|status|comment|...`).

### SUGGESTION

- **S-1 — Path typo.** Architecture §1 (line 38) cites `src/lib/db/index.ts`; the file is `src/db/index.ts`.
- **S-2 — Fix the call-site label.** Remove “admin test” from architecture §1 (line 34) or point it at a real sender; the actual admin send sites are the dashboard and orders actions.
- **S-3 — Correct G3’s wording.** Self-hosted line 98 says the journal shows duplicate `0002`; the journal has one `0002`, the directory has two `0002` SQL files, and `0001` is missing. Exact wording matters because the fixes differ.
- **S-4 — Muzzarella count.** Self-hosted line 77 says “~11 `src/` files”; `grep -ril muzzarella src` returns 10. Harmless, but make it exact or keep the tilde.
- **S-5 — Cross-link the evidence.** Architecture §4 (lines 183–197) still marks Zernio/Kapso as `S`/`?` even though `ab7ae2f` resolves many of those items. Link evidence §1–§3 and downgrade `[RESEARCH]` items that are now verified.
- **S-6 — Declare the Node version.** Self-hosted says “Node 20” (line 22); `package.json` has no `engines` field. Add `"engines": { "node": ">=20" }`.
- **S-7 — Zernio platform count.** Evidence lines 138–140 say “16 platforms” and list WordPress/Shopify as social platforms. Zernio’s current docs list 17 including Google Business; WordPress/Shopify are documented as Blogs API targets, not social publishing. Minor accuracy fix.
- **S-8 — Make the first slice runnable.** In architecture §6, add the exact command for the new tests (for example `node --import tsx --test src/lib/messaging/**/*.test.ts`) so “zero edits” does not also mean “zero test execution”.

## 2. Per-document assessment

### `4e983a6` — `architecture-roadmap.md`

**Correctness and evidence quality:** high for current-state claims. The webhook route, signature implementation, two YCloud clients, media allowlist, channel router, meta stub, Telegram scope, `neon-http` limitation, and source-reading tests all match the code. The phase gates and rollback unit are concrete and reviewable.

**Why it is not approvable as-is:** CR-1 (contract), CR-4 (social identity schema), CR-5 (credential shadowing), W-5 (incomplete call-site inventory), W-6 (SMS marked verified), W-7 (unwired tests). The “first slice is safe to start now” claim is true only if the contract is frozen first and the new tests are actually executed.

**Required fixes:** adopt the canonical contract; add the social-identity schema design before Phase 4; fix the resolver cutover; correct §1’s inventory and §4’s SMS status; add the test command.

### `ab7ae2f` — `provider-integration-evidence.md`

**Correctness and evidence quality:** strongest of the three. Spot checks against primary docs on 2026-10-19 matched the key claims:

- YCloud: `YCloud-Signature` format, HMAC over `{t}.{rawBody}`, 7 retries, `<6s`/`>10s` guidance, `POST /v2/webhookEndpoints`, ≤20 endpoints, returned `whsec_*`.
- Zernio: base `https://zernio.com/api/v1`, Bearer auth, `X-Zernio-Signature` raw-body HMAC (no timestamp), `X-Late-*` aliases, 50 endpoints, `webhook.test`, 7 attempts / ~51h, event list.
- Kapso: `X-Webhook-Signature` raw-body HMAC, 10s/40s retries, default `max_attempts: 3`, `X-Idempotency-Key`, setup links, `@kapso/sdk` MPS requirement, send endpoint and Graph-shaped body.

The doc also labels its own uncertain claims (Kapso proxy host, Kapso idempotency, platform-webhook signature, Zernio request shape, Zernio/Late rebrand, pricing). That is good research hygiene.

**Why it is not approvable as-is:** CR-1 (its contract is one of three), W-3 (`tenantId` inconsistency), CR-6 (its “do not build” recommendation conflicts with the other two and with the source brief), and the minor taxonomy issue (W-14 / S-7). Its verdict should be framed as a recommendation to confirm with the product owner, not as an evidence finding.

**Required fixes:** make this contract canonical (add `tenantId`, keep `sendTemplate?`, separate event kinds); state explicitly whether the recommendation supersedes the source brief’s scope; fix the platform list.

### `1425a9f` — `self-hosted-product-roadmap.md`

**Correctness and evidence quality:** the gap analysis is concrete and mostly verified: no `render.yaml`, `neon-http` coupling, `public/uploads` on ephemeral disk, `AUTH_SECRET` rotation problem, `agent_config id=1` scattering, PII scripts, `.env.example` stray key, `db:push` vs `db:migrate` mismatch, Muzzarella-specific routes/flags. The phased structure is sensible.

**Why it is not approvable as-is:** CR-2 (migration journal), CR-3 (`/setup` transaction), CR-6 (Kapso embedded signup), W-8 (no CI/down), W-9 (install acceptance), W-10 (queue/DLQ), W-11 (Neon docs). The P0/P1 order is correct, but the document understates the migration and setup blockers as “integrity” and “keep as-is”.

**Required fixes:** promote the journal repair and `/setup` fix to explicit P0 blockers with acceptance evidence; remove Kapso embedded signup from P1/P4 acceptance or gate it behind a business decision; align Phase 3/4 with the architecture’s table/routing decision; correct the queue/DLQ and Neon statements.

## 3. Contradictions and overlap

| Topic | Architecture | Evidence | Self-hosted | Reconciliation |
|---|---|---|---|---|
| Contract | Own interface (§2.2) | Own corrected interface (§4) | Source-spec interface (Phase 3) | Freeze evidence §4 + `tenantId` + `sendTemplate?`; reference it everywhere. |
| `channel_accounts` table | Build in Phase 2 | “Do not build now” (verdict) | Build in Phase 3 | Build only when a second provider is approved; keep interface-only until then. |
| Routing | One `whatsappProvider` field, no rule table (§2.3) | Hard-code `whatsapp → ycloud`; no matrix | Admin routing matrix (§4 P3/P4) | Adopt architecture’s one-field switch for v1; defer the matrix. |
| Kapso | Adapter + switch; embedded signup gated (P5) | Deferred; spike only | Adapter + embedded signup + switch (P4) | Spike only in v1; embedded signup out. |
| Ingress URL | `/api/webhooks/ingress/[provider]` | `/api/webhooks/ingress/:provider` | `/api/v1/webhooks/ingress/:provider` | One path: `/api/webhooks/ingress/[provider]` unless API versioning is adopted. |
| Dedup id | Namespace new providers (C6) | Wamid is Meta-global; confirm namespacing | Source-spec `platformMessageId` | Bare wamid for WhatsApp; namespace social ids; add `deliveryId`. |
| Phase numbering | P0 research → P1 core → P2 table → P3 ingress → P4 Zernio → P5 Kapso → P6 policy | Checklist 1–10 | P0 hygiene → P1 Render → P2 generic → P3 core → P4 adapters → P5 polish | Use the reconciled order in §6; keep phase IDs as labels, not competing plans. |
| Multitenancy | `tenantId` constant `"default"` | `tenantId` claimed but absent from interface | Constant `tenantId`; no tenancy | Add the field; keep it constant; no tenant logic. |

**Overlap that should be merged, not duplicated:** architecture Phase 2 and self-hosted Phase 3 both define `channel_accounts`; architecture Phase 3 and self-hosted Phase 3 both define unified ingress; architecture Phase 4/5 and self-hosted Phase 4 both define Zernio/Kapso. One document should own the design; the others should link to it.

## 4. Fit with current code, schema, and deployment reality

| Claim / plan | Verified reality | Fit |
|---|---|---|
| Render + Neon, `neon-http` | `src/db/index.ts:1-16`; `src/lib/checkout/service.ts:31-34` says interactive transactions throw | Correct; but CR-3 (`/setup`) violates it. |
| `drizzle-kit migrate` is the canonical install path | Journal references missing `0001`; orphan `0002_unique_phone.sql`; snapshots missing | **Blocked** (CR-2). |
| `/setup` is reusable as-is | `src/app/setup/actions.ts:40` uses `db.transaction` | **Broken** on the documented driver (CR-3). |
| `render.yaml` absent | Confirmed (`ls render.yaml`) | Correct gap; P1 deliverable is real. |
| `/api/health` exists | `src/app/api/health/route.ts` | Correct. |
| Cron routes exist and are `CRON_SECRET`-gated | `src/app/api/cron/{followup,reconcile}/route.ts` | Correct. |
| `channel` enum only `whatsapp|telegram` | `src/db/schema.ts:48` | Correct. |
| `conversations.whatsappId` is the legacy key | `src/db/schema.ts:187` (`notNull().unique()`); router synthesizes `tg_` (`:76-79`) | Architecture C3 understates the social-channel impact (CR-4). |
| `leads.phone` is the lead identity | `src/db/schema.ts:285` (`notNull().unique()`) | Conflicts with phone-less social identities (CR-4). |
| `agent_config` is the credential editor | Admin writes only `agent_config` (`agent/actions.ts:256-261`, `306-311`) | Resolver priority creates a shadowing trap (CR-5). |
| Direct send sites are known | Missing dashboard/orders sends; “admin test” does not send | Inventory is incomplete (W-5). |
| Upstash optional with in-memory fallback | Buffer/rate-limit fall back; queue/producer/worker/DLQ are no-ops | Overstated (W-10). |
| No provider contract tests | Confirmed; `test:agents` has 13 files and omits one existing test | Correct gap; new tests must be wired (W-7). |
| No CI, no down migrations | `.github/workflows` absent; no rollback scripts | “Up and down in CI” is aspirational (W-8). |
| README and `.env.example` support any Postgres | README:54 and `.env.example:20` say so; `neon-http` does not | Contradiction to fix (W-11). |

## 5. Missing prerequisites and unsafe assumptions

- **Contract freeze is not possible yet.** Naming, methods, event shape, and account shape differ (CR-1).
- **Fresh install is not possible yet.** The migration journal and `/setup` must be repaired first (CR-2, CR-3).
- **Social identity is not modeled.** Phone-less DMs/comments need a lead-identity decision and a synthetic conversation key (CR-4).
- **Credential cutover is not safe.** Admin edits to `agent_config` will be shadowed after backfill (CR-5).
- **v1 scope is not decided.** “Contract only” and “build ChannelAccount + routing + Kapso” cannot both be true (CR-6).
- **Multi-account routing is not designed.** Conversations have no account reference; `resolveChannelAccount` defaults per channel (W-13).
- **Provider research is incomplete for implementation.** Zernio conversation-create shape and pacing; Kapso platform-webhook signature and send idempotency; YCloud BSUID/`externalId` details; social reply-window rules (evidence §3 already flags most).
- **Durable media is missing before Zernio inbound.** `public/uploads` is ephemeral on Render (`src/lib/media/downloader.ts:10`, `src/app/api/media/[...path]/route.ts`); G5 is real and should precede Zernio media.
- **CI and rollback are missing.** No workflow, no down migrations; the release gate needs a concrete mechanism (W-8).
- **The source brief is untracked in the requested base.** Every document references a file that does not exist at `c14951d` (W-12). Current `main` has since promoted a copy, which resolves the issue there but is outside the reviewed commits.
- **Runbook and secret rotation are missing.** `AUTH_SECRET` rotation breaks stored ciphertext (G6); this is correctly identified but not scheduled before a production install.
- **Rate-limit/throughput behavior is unverified per provider.** Zernio ~10/min pacing and Kapso/Meta limits need measurement before broadcast bursts.

## 6. Single reconciled execution order

**Scope decision first (before any provider code):** adopt evidence §4 as the canonical contract, extended with `tenantId` and `sendTemplate?`; keep WhatsApp on YCloud; build the seam + YCloud adapter now; add `channel_accounts`/ingress when a second provider is approved; Zernio next; Kapso spike only; embedded signup out of v1.

| # | Work unit | Depends on | Gate |
|---|---|---|---|
| 0 | Contract freeze + doc reconciliation (CR-1, W-1–W-4, W-14) | — | One interface, one ingress path, one dedup rule; architecture §2.2 and self-hosted Phase 3/4 reference it. |
| 1 | Repo trust: repair migrations (CR-2), fix `/setup` (CR-3), fix README/`.env.example` Neon claims (W-11), add `render.yaml` + `engines` | 0 | `drizzle-kit migrate` on empty Neon branch; `/setup` concurrent test; health 200; login; `npm run test:agents/typecheck/lint/build`. |
| 2 | Messaging core + `YCloudAdapter`, new files only, tests runnable (architecture P1 unit 1) | 0 | `test:agents` + explicit new tests; typecheck/lint/build; no behavior change. |
| 3 | Outbound facade with complete call-site inventory (architecture P1 unit 2) | 2 | Dashboard/orders/webhook/queue/cron/Telegram/router all through `messenger.send`; wamid/retry/override parity. |
| 4 | Inbound parse extraction + signature/fixture tests (architecture P1 unit 3) | 3 | Gate order unchanged; old and new paths produce identical DB effects. |
| 5 | `channel_accounts` + resolver + safe backfill (architecture P2) | 1, 2 | Encryption round-trip; fallback order; credential-shadowing test (CR-5); idempotent migration. |
| 6 | Unified ingress route; YCloud delegates; legacy routes unchanged (architecture P3) | 4, 5 | 401/200 parity; duplicate replay deduped; fixture e2e. |
| 7 | Zernio adapter + social schema/UI (architecture P4 / self-hosted P4) | 6 + provider research + product approval | Contract suite; phone-less identity fixture; comment/message fixtures; buffer config; media durable store. |
| 8 | Kapso spike, no production wiring (architecture P5 / evidence item 8) | 6 + business decision | Proxy auth; signature; batch parse; no embedded signup; no acceptance claim. |
| 9 | Per-channel policy, durable media, rotation, i18n (architecture P6 / self-hosted P5) | 7, 8 | Reply-window tests; rotation runbook; media survives redeploy; i18n decision. |

Parallel lanes: 1 and 2 can run concurrently after 0. Do not start 5 until 1 and 2 are green. Do not start 7 until 5 and 6 are green and the social-identity schema is approved.

## 7. Verification evidence

**Repository / commit checks**

- `git rev-parse HEAD` → `c14951d887db80cfc8058b21282833e193db2c24` (base).
- `git log --oneline --all` → the three reviewed commits are branch tips; no merge into `main`.
- `git hash-object` vs `git rev-parse <sha>:<path>` → exact content match for all three files.
- `git show --check <sha>` and `git diff --check <base> <sha>` → clean for all three commits.
- `git diff --check` on the review working tree → exit 0 (only `.atl` registry changes and the untracked `docs/socialcrm/` exist).
- `git ls-tree -r <base> | grep socialcrm` → no `docs/socialcrm/` at base; the source brief is untracked.

**Static code/schema checks**

- `src/db/index.ts` (`neon-http`); `src/lib/checkout/service.ts:31-34`.
- `src/app/setup/actions.ts:40`; `src/app/(admin)/admin/clients/actions.ts:206`.
- `src/db/schema.ts:48,187,285`; `src/lib/channels/router.ts:7,76-79,89-90,203-215`.
- `src/lib/buffer/config.ts:1-13`; `src/lib/queue/{producer,worker,dlq}.ts`.
- `src/app/(admin)/admin/agent/actions.ts:256-261,306-311`.
- Direct-send grep across `src/` (dashboard, orders, webhook, queue, cron, Telegram tools, router).
- `drizzle/meta/_journal.json` vs `drizzle/*.sql`; `drizzle/meta/*.json`.
- `package.json` `test:agents` (13 files; `web-order-redirect.test.ts` omitted).
- `render.yaml` absent; `src/app/api/health/route.ts` present; cron routes present; no `.github/workflows`.

**Primary provider docs spot-checked (2026-10-19)**

- YCloud: `docs.ycloud.com/reference/configure-webhooks`; `docs.ycloud.com/en/api-reference/guides/api-fundamentals/implement-a-webhook-receiver`.
- Zernio: `docs.zernio.com/` (base URL/auth); `docs.zernio.com/webhooks` (signature, retries, dedup, events); `docs.zernio.com/multi-tenant/inbox`.
- Kapso: `docs.kapso.ai/docs/platform/webhooks/security`; `docs.kapso.ai/docs/platform/webhooks/advanced`; `docs.kapso.ai/docs/whatsapp/send-messages/text.md`; `docs.kapso.ai/docs/platform/setup-links/create-and-configure`; `docs.kapso.ai/docs/platform/tech-providers/embed-onboarding`; `docs.kapso.ai/api/rate-limits`.

**Post-review repository state**

While this review was running, local `main` advanced to `400daa1` (the three documents cherry-picked as `1ee04cf`/`8bdc7be`/`de8901e`, the source spec promoted as `fe04b2b`, and `docs/socialcrm/execution-control.md` added). The three reviewed branch tips were not modified. `execution-control.md` independently resolves the ingress path, contract choice, `channel_accounts` timing, and journal issue (CR-1/CR-2/W-1/CR-6), but it does not address CR-3 (`/setup` transaction), CR-4 (phone-less identities), CR-5 (credential shadowing), or the Kapso embedded-signup conflict. This note is context only; the verdicts apply to the requested base and the three immutable commits.

**Not run**

- `npm run test:agents`, `npm run typecheck`, `npm run lint`, `npm run build`: not run because the reviewed commits are documentation-only and the review made no source changes. The test-gate findings above are static (file lists and script contents), not runtime results.
- No database migration or webhook was executed; migration and `/setup` findings are static inspections of the journal, schema, and driver usage.

**Remaining unverified**

- Zernio `POST /v1/inbox/conversations` full request shape, per-recipient pacing, and pricing/limits.
- Kapso platform-webhook signature for the auto-generated secret; Kapso send idempotency; canonical proxy host beyond the send-docs `v24.0` path.
- YCloud inbound payload field details (`externalId`, BSUID fields) and production behavior of the repo’s `link` media approach.
- Social reply-window rules (Instagram/Facebook) for C8.
- Render blueprint behavior and Neon-branch CI; neither exists in the repository.
- Kapso MPS availability/cost for a single-install operator.

## 8. Bottom line

Merge all three after the CRITICAL fixes, in the order above. Do not start the YCloud refactor before the contract is frozen; do not claim a fresh install before the migration journal and `/setup` are fixed; do not build Zernio before the phone-less identity model exists; do not build Kapso embedded signup for a single-install product without an explicit business decision.

**Skill Resolution: injected**
