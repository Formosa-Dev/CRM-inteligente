# SocialCRM — Self-Hosted Product Roadmap

Status: planning baseline, revised after adversarial review (`5dbc72f`,
`docs/socialcrm/roadmaps-review.md`). Date: 2026-10-18.
Scope: turn the inherited Muzapp codebase into **SocialCRM**, a generic,
single-install Social CRM + AI-agent product that a business owner or
implementer can deploy as a dedicated instance on **Render + Neon PostgreSQL**.

Non-goals: no multitenant architecture, no SaaS billing, no HA/multi-instance
topology. The product is one dedicated instance per customer.

Design inputs: `docs/socialcrm/multiprovider-source-spec.md` (provider
abstraction spec), `docs/socialcrm/provider-integration-evidence.md`
(canonical contract), `docs/socialcrm/architecture-roadmap.md` (provider
execution design), `README.md`, `.env.example`, `AGENTS.md`,
`src/db/schema.ts`, `docs/sdk/PENDING_PUBLIC_EXPERIENCE.md`.

> **Tracking note (W-12):** `docs/socialcrm/multiprovider-source-spec.md` was
> untracked at the reviewed base (`c14951d`); it has since been promoted on
> `main` (`fe04b2b`). If this commit lands on a tree without it, the
> references above need the promoted copy merged first. Do not re-commit the
> brief from this work unit.

## 0. Review reconciliation

This revision adopts the reconciled decisions from the review:

- **Canonical contract**: the contract defined in
  `provider-integration-evidence.md` §4, extended with `tenantId: string`
  (constant `"default"` — no tenant logic) and optional `sendTemplate`. This
  document references that contract; it does not redefine it (CR-1).
- **Canonical execution order**: the review's work units 0–9 (§6 of the
  review). The phases below are product-level labels mapped onto that order,
  not a competing plan (see §4.0).
- **v1 provider scope**: contract freeze + messaging seam + `YCloudAdapter`
  now; `channel_accounts` and unified ingress only when a second provider is
  approved; Zernio next; **Kapso is spike-only — no production wiring and no
  embedded signup in v1** (CR-6).
- **Ingress path**: `/api/webhooks/ingress/[provider]` (Next.js dynamic
  segment). There is no `/api/v1` surface; versioning deferred (W-1).
- **Routing v1**: a single `whatsappProvider` field (`ycloud`, later
  `kapso`). A routing matrix is deferred until multiple accounts per channel
  are real (W-13, review §3).
- **Dedup identity**: WhatsApp keeps the bare Meta-global `wamid` as
  `platformMessageId`; social providers store `${provider}:${nativeId}`;
  non-message events (status, comment) dedup on a separate
  `deliveryId`/`providerEventId` (W-4).
- **Installability is a P0 blocker, not a polish item.** The two defects
  below (G3, G4) make a fresh install fail today; every claim in §1 depends
  on them being fixed first.

## 1. Target deployment & configuration experience

The "golden path" for a self-hoster must be achievable without repo commit
access, shell access to the app, or knowledge of the codebase:

1. **Provision** — Render web service (Node ≥20, declared via
   `package.json` `engines`) + Neon Postgres. Upstash Redis is required if
   the queue/worker/DLQ pipeline must run — see G14; buffer and rate-limit
   are the only subsystems with a true in-memory fallback.
   - Target artifact: `render.yaml` blueprint (does not exist today) so the
     service, env-var prompts, health check (`/api/health`) and cron jobs are
     declared as infrastructure-as-code instead of manual dashboard steps.
2. **Configure env vars** — `DATABASE_URL` (Neon), `AUTH_SECRET`, `AUTH_URL`,
   `NEXT_PUBLIC_APP_URL` are the only required vars; everything else is
   optional or DB-configured. README and `.env.example` currently claim "any
   Postgres" — false under `neon-http` (G5); fix the claims or ship a `pg`
   driver path.
3. **Migrate** — canonical schema step is `drizzle-kit migrate`
   (`npm run db:migrate`). **Blocked today by G3** — the journal cannot
   produce a fresh install. `db:push` stays dev-only.
4. **Bootstrap admin** — `/setup` creates the first admin and self-locks.
   **Blocked today by G4** — it uses `db.transaction`, which `neon-http`
   does not support. Fix first, then document as the supported path.
   `npm run db:seed` remains the scripted alternative and keeps its "no
   default credentials" contract.
5. **Configure the instance from the UI** — `/admin/agent` already covers
   business identity, AI provider, YCloud, Cloudinary, Meta, Telegram, cron,
   escalation email. Roadmap work extends this to a `channel_accounts` model
   once a second provider is approved (Phase 4).
6. **Wire webhooks** — each configured channel account surfaces its exact
   inbound URL (`/api/webhooks/ingress/[provider]`) in the admin UI,
   copy-pasteable into the provider console.
7. **Verify** — post-install checklist is split into two tiers (W-9):
   - **Deployable**: health 200, migrations applied, `/setup` creates admin,
     login works.
   - **Messaging end-to-end**: one inbound message lands in
     `/admin/conversations`, one outbound reply sends, media upload succeeds
     (requires externally provisioned Neon + a publicly registered webhook;
     not verifiable by blueprint alone).

Success metric (target, to be measured on the first real run — not asserted):
an implementer who has never seen the repo reaches "deployable" in under
~30 minutes using only the published docs.

## 2. Reusable platform core vs. client-specific customizations

### 2.1 Reusable as-is (platform core)

| Area | Where | Notes |
|---|---|---|
| Next.js 16 / React 19 / Drizzle + Neon base | `package.json`, `src/db/index.ts` | `neon-http` driver — Neon required today (G5) |
| First-admin bootstrap | `src/app/setup/` | **Broken on neon-http (G4)** — reusable after the fix, not as-is |
| AuthN/AuthZ | `src/auth/`, `src/lib/auth/require-admin.ts` | NextAuth v5, admin/viewer roles, per-email login limiter |
| DB-backed, write-only, encrypted config | `agent_config` + `src/lib/encryption.ts` + `src/lib/integrations.ts` | AES-256-GCM keyed on `AUTH_SECRET`, env fallback, `decryptIfEncrypted` migration tolerance |
| Unified conversation model | `conversations`, `chat_messages`, `leads`, `attachments` + `src/lib/channels/router.ts` | channel-agnostic ingestion, `platformMessageId` idempotency, human override |
| AI provider abstraction | `src/lib/ai/config.ts` | OpenAI-compatible key/base-URL/models via DB→env |
| Infra resilience — partial | buffer + rate-limit fall back to memory; `src/lib/queue/{producer,worker,dlq}.ts` are **no-ops without Upstash** (G14) | circuit breaker, HMAC webhook checks |
| Cron surface | `/api/cron/followup`, `/api/cron/reconcile` | `CRON_SECRET`-gated |
| Admin panel shell | `src/app/(admin)/admin/` | conversations inbox, leads, analytics, agent config |
| Deployment pattern | README §"Deploy to Render" | docs exist; needs blueprint + SocialCRM rebrand + corrected Neon claims |

### 2.2 Client-specific (Muzzarella) — must be decoupled or made configurable

| Area | Evidence |
|---|---|
| Food-domain enums | `product_category` (`hamburguesa`, `pan_mayorista`, `tragos_vip`…), `order_type` (`hamburguesas`, `pan_mayorista`) in `src/db/schema.ts` |
| Restaurant runtime flags in config | `agent_config.isCooking`, `hamburguesasSinStock`, `stockPanDocenas`, `aliasB2c/B2b`, `tiempoEspera`, `menuImageUrl*`, default delivery zones centro/norte/sur |
| Hardcoded storefront routes | `src/app/(storefront)/hamburguesas|pan-mayorista|tragos-vip|promo` |
| Restaurant ops flows | kitchen order board, cash sessions (`/admin/caja`), delivery-arrival notifications with hardcoded copy in `src/lib/channels/router.ts` |
| Brand strings | 10 `src/` files mention Muzzarella; `package.json` name `muzapp`; `CLOUDINARY_FOLDER = "muzapp"` in `src/app/api/media/upload/route.ts`; Spanish demo catalog `LINEA_CARNE` + prompt in `src/db/seed.ts` |
| Client artifacts in repo root | product JPEGs (~2 MB), `chatprueba.txt`, `nota.txt`, `prompt*.txt`, `PROMPT-*.md`, `clean.js`, `migrate-fix.js`, `fusa stack/`, `fusa-stack/` |
| Customer-PII ops scripts | `scripts/find-hector*.mjs`, `wipe-conv15*.mjs`, `del-order*.mjs`, `clean-conv15*.mjs`, `check-*` one-offs |

Rule of thumb for the fork line: **conversation, lead, message, config,
secrets, auth, agent and channel plumbing are core; catalog shape, order
workflow, kitchen/cash/delivery, prompts and branding are per-install
customization** that belong behind configuration or a "vertical" module.

## 3. Concrete gaps in the inherited repository

Install blockers first — these make the §1 golden path fail today.

- **G3 — BLOCKER: the migration journal cannot produce a fresh install.**
  - `drizzle/meta/_journal.json` entry `idx: 1` points to
    `0001_handy_tombstone`, but `drizzle/0001_handy_tombstone.sql` does not
    exist — `drizzle-kit migrate` aborts on it.
  - The directory contains **two** `0002` files: `0002_unique_phone.sql`
    (tracked but absent from the journal; performs a destructive `leads`
    dedupe, reassigns `orders`, adds `leads_phone_unique`) and
    `0002_woozy_valkyrie.sql`.
  - `src/db/schema.ts:285` declares `leads.phone` `.notNull().unique()` — a
    journal-migrated fresh DB lacks that constraint.
  - Snapshots missing for journal entries `0003`, `0006`, `0007`, `0011`,
    `0012`.
  - Also: README quickstart uses `db:push`
    (`drizzle-kit push --force 2>/dev/null || echo …` — POSIX-only,
    error-masking) while `/setup` says `db:migrate`. `push` is dev-only.
- **G4 — BLOCKER: `/setup` uses a transaction the driver doesn't support.**
  `src/app/setup/actions.ts:40` calls `db.transaction(...)`; the repo's own
  comment at `src/lib/checkout/service.ts:31-34` states the `neon-http`
  driver "does not support `db.transaction()` (it throws)". First-admin
  bootstrap returns 500 instead of creating the admin — the golden path
  fails at the first screen. Same unsupported pattern at
  `src/app/(admin)/admin/clients/actions.ts:206`.
- **G5 — BLOCKER (user-facing): Neon is a hard dependency, docs deny it.**
  `src/db/index.ts` uses `@neondatabase/serverless` `neon()` HTTP driver, so
  a plain Render-Postgres or Supabase URL will not work — yet `README.md:54`
  says "Neon / Render PG / any Postgres" and `.env.example:20` says "Neon,
  Render Postgres, Supabase". Fix both docs to require Neon, or add a `pg`/
  postgres-js driver path.
- **G1 — No IaC for Render.** No `render.yaml`; deploy is manual, doc-only.
  Also `package.json` has no `engines` field — Node ≥20 is only implied.
- **G2 — WhatsApp is hardwired to YCloud.** `src/lib/ycloud.ts`,
  `src/lib/whatsapp/ycloud-client.ts`, `/api/whatsapp/webhook`,
  `/api/webhook/whatsapp`. No provider field on conversations, `channel`
  enum is only `whatsapp|telegram`, one global YCloud credential on
  `agent_config`. Direct-send call sites are wider than the obvious list:
  dashboard and orders actions also send (`dashboard-actions-server.ts:89-92`,
  `orders/actions.ts:189-190,239-240`); `api/agent/test` only checks config.
- **G6 — Ephemeral-disk media.** `/api/media/[...path]` serves
  `public/uploads` from local disk — lost on every Render redeploy
  (`src/lib/media/downloader.ts:10`). Admin uploads go to Cloudinary;
  inbound-channel media needs the same durable store before Zernio inbound.
- **G7 — `AUTH_SECRET` rotation unhandled.** Rotating it invalidates
  sessions *and* makes all AES-256-GCM ciphertexts undecryptable
  (`src/lib/encryption.ts`). No runbook — must ship before production
  installs, not as polish.
- **G8 — Single-row `agent_config id=1` assumption** scattered through
  `src/lib/integrations.ts`, `src/lib/channels/router.ts`, seed. Acceptable
  for single-install, but `channel_accounts` must not multiply the pattern —
  and the resolver must not shadow later admin edits (see Phase 4).
- **G9 — Client PII and junk in-repo.** Ops scripts reference real customer
  names/phones; root has client photos and scratch files. `.env.example`
  ends with a stray uncommented `BUSINESS_OWNER_NAME=` and falsely claims
  the DLQ runs in memory (G14).
- **G10 — Language/i18n decision open.** Agent prompts, seed, admin copy and
  error strings are Spanish-first. Needs an explicit product decision before
  claiming "generic".
- **G11 — First-run UX is one long form.** `/admin/agent` works but offers
  no guided checklist ("configure channel → set webhook → test message").
- **G12 — Docs are Muzapp-branded**: `docs/manual-operativo-mrs-muzzarella.md`,
  README hero copy, DESIGN.MD. Rebrand + provider setup guides needed.
- **G13 — Test coverage is domain-shaped and unwired.** `test:agents`
  exercises restaurant flows; `src/lib/whatsapp/web-order-redirect.test.ts`
  exists on disk but is not in the script. No provider-contract or ingress
  tests exist.
- **G14 — Queue/DLQ have no in-memory fallback.** `producer.ts:17`,
  `worker.ts:19`, `dlq.ts:18` are no-ops without Upstash; only buffer and
  rate-limit degrade gracefully. For a single-instance install either
  Upstash becomes required, or the queue is documented as disabled-by-default.

## 4. Phased roadmap

### 4.0 Mapping to the canonical order

The review's §6 work units are the execution sequence; these phases are the
same work seen from the product/installability side:

| This doc | Canonical units | Scope |
|---|---|---|
| P0 Repo trust | 1 (+ parts of 0) | migration repair, `/setup` fix, doc truth, hygiene |
| P1 Installable core | 1 (rest) | blueprint, install docs, rotation runbook |
| P2 Generic domain | — (orthogonal) | de-branding, vertical decoupling |
| P3 Messaging seam | 2–4 | contract-adherent core + `YCloudAdapter` + facade + inbound extraction — **no `channel_accounts`** |
| P4 Multi-provider enablement | 5–6 | `channel_accounts`, resolver, ingress — **gated on second-provider approval** |
| P5 Zernio | 7 | gated on social-identity schema + research + product approval |
| P6 Kapso spike | 8 | research only — no wiring, no embedded signup |
| P7 Operational polish | 9 | per-channel policy, durable media, i18n |

Parallel lanes: P0/P1 and P3 can run concurrently after contract freeze.
P4 does not start until P0/P1 and P3 are green. P5 does not start until P4
is green and the social-identity schema is approved.

### Phase 0 — Repo trust baseline (BLOCKER — prerequisite for everything)

**Deliverables**
- **Migration journal repair (G3):** restore or renumber the missing `0001`
  entry; introduce a new guarded/idempotent migration that adds the
  `leads.phone` unique constraint for installs that never ran the orphan
  `0002_unique_phone.sql` (do **not** blindly journal the destructive
  dedupe — existing installs may already have run it); regenerate missing
  snapshots; align README/`/setup`/`.env.example` on `db:migrate` as the
  canonical path (`db:push` documented dev-only).
- **`/setup` fix (G4):** rewrite first-admin creation without
  `db.transaction` — e.g. a single conditional
  `INSERT … WHERE NOT EXISTS (SELECT 1 FROM users)` plus a session-level
  `pg_advisory_lock` via raw SQL, or a `db.batch` path. Apply the same fix
  to `src/app/(admin)/admin/clients/actions.ts:206`. Add a concurrent-submit
  test proving a single admin results from parallel first-access requests.
- **Doc truth (G5, G9, G14):** README and `.env.example` corrected to
  Neon-required (or `pg` driver path landed); `.env.example` DLQ claim and
  stray `BUSINESS_OWNER_NAME` fixed; Upstash made explicitly required-or-
  disabled per the G14 decision.
- **Hygiene (G9):** remove customer-PII scripts and client artifacts
  (private ops repo if still needed); `package.json` rebrand +
  `"engines": { "node": ">=20" }`; `CLOUDINARY_FOLDER` and seeded demo
  content made neutral.

**Acceptance criteria**
- `drizzle-kit migrate` succeeds on an **empty Neon branch**; a subsequent
  `drizzle-kit generate` produces **no diff**; `leads.phone` unique exists.
- `/setup` verified on `neon-http`: creates one admin under concurrent
  submits, then self-locks.
- `git grep` finds no customer names/phones; `npm run test:agents`,
  `typecheck`, `lint`, `build` green, unchanged.

### Phase 1 — Installable core on Render + Neon

**Deliverables**
- `render.yaml` blueprint: web service, `DATABASE_URL`/`AUTH_SECRET`/
  `AUTH_URL`/`NEXT_PUBLIC_APP_URL` prompts, `healthCheckPath: /api/health`,
  Upstash + cron job declarations for `/api/cron/*` per the G14 decision.
- Install guide + two-tier post-install checklist (§1.7).
- `AUTH_SECRET` rotation runbook including ciphertext re-encryption (G7) —
  ships **before** the first production install is advertised.
- `web-order-redirect.test.ts` wired into `test:agents` (G13).

**Acceptance criteria**
- *Deployable:* fresh clone → blueprint deploy → migrate → `/setup` → login
  → health 200, from the install guide alone.
- *Messaging end-to-end:* documented as requiring external Neon provisioning
  + registered webhook; measured, not assumed (§1 target).

### Phase 2 — Generic domain model (de-Muzzarella)

**Deliverables**
- Catalog categories and order types data-driven or behind a `vertical`
  config; restaurant `agent_config` fields grouped into a feature block.
- Storefront routes genericized or optional per vertical; kitchen/cash/
  delivery behind feature flags, off by default for non-food installs.
- Default agent prompts neutral; demo seed neutral and opt-in.

**Acceptance criteria**
- Fresh install with no vertical configured shows a functional generic
  CRM inbox/leads/admin; no hamburguesa/Muzzarella strings render.
- Migrations additive; existing Muzapp installs upgrade without data loss.

### Phase 3 — Messaging seam + YCloudAdapter (contract-adherent, no table)

**Deliverables** — canonical units 2–4; new files only, no behavior change.
- Messaging core implementing the canonical contract (evidence §4 +
  `tenantId` constant + `sendTemplate?`). Interface seam only — **no
  `channel_accounts` table yet** (it waits for an approved second provider).
- `YCloudAdapter` satisfying the contract; outbound facade
  (`messenger.send`) covering the **complete** send-site inventory:
  dashboard, orders, webhook, queue, cron, Telegram tools, channel router —
  not just the obvious clients (W-5).
- Inbound parse extraction preserving today's gate order (signature →
  dedup → buffer → agent); signature/fixture tests proving old and new paths
  produce identical DB effects.
- Contract test suite (`provider-contract.test.ts`, `ycloud.test.ts`) run
  explicitly and wired into `test:agents` (W-7).

**Acceptance criteria**
- WhatsApp via YCloud behaves identically through the adapter: wamid dedup,
  retry/override semantics, human override intact.
- New tests run in the gate; `typecheck`/`lint`/`build` green.

### Phase 4 — `channel_accounts` + unified ingress (gated: second provider approved)

**Deliverables** — canonical units 5–6.
- `channel_accounts` table + credential resolver + safe backfill from
  `agent_config`. **Shadowing fix (CR-5):** until the admin UI writes
  `channel_accounts`, the resolver prefers `agent_config` for the legacy
  `ycloud/whatsapp` account (or dual-writes / compares `updatedAt`) — plus a
  test that edits the legacy field after backfill and asserts the new value
  wins.
- `conversations.channelAccountId` — nullable additive FK, backfilled to the
  default account (W-13: an FK, not default-resolution-per-send, so a future
  multi-account setup is safe).
- `POST /api/webhooks/ingress/[provider]`; YCloud delegates to it; legacy
  webhook routes unchanged as aliases.
- Single `whatsappProvider` switch field for v1; no routing matrix.
- Dedup rules: bare `wamid` for WhatsApp, `${provider}:${nativeId}` for
  social ids, `deliveryId` for status/comment events (W-4).

**Acceptance criteria**
- Encryption round-trip, fallback order, and shadowing test pass; backfill
  migration is idempotent.
- Ingress returns 401/200 parity with legacy routes; duplicate replay is
  deduped; fixture e2e green.

### Phase 5 — Zernio adapter + social identity (gated: research + product approval)

**Deliverables** — canonical unit 7.
- **Prerequisite — social-identity schema (CR-4):** nullable `leads.phone`
  or a `lead_identities(channel, external_id)` table; synthetic conversation
  key convention (e.g. `${channel}:${externalUserId}`) or nullable
  `whatsappId`; `Channel`/`channel` enum/`BUFFER_CONFIG` extended; a
  phone-less Instagram fixture exercising persistence + dedup.
- **Prerequisite — durable media store (G6):** inbound media off ephemeral
  `public/uploads` before Zernio media lands.
- `ZernioAdapter`: Instagram/FB channels, raw-body HMAC webhook validation,
  `comment.received` handled as an **event kind**, not a channel (W-14).
- Provider research closed first: Zernio conversation-create shape, pacing
  (~10/min), reply-window rules.

**Acceptance criteria**
- Contract suite passes for Zernio; phone-less identity fixture lands in
  `/admin/conversations` and is answerable; comment/message fixtures pass.

### Phase 6 — Kapso spike only (no production code path)

**Deliverables** — canonical unit 8.
- Time-boxed spike: proxy auth, `X-Webhook-Signature` validation, batch
  parse, send idempotency (`X-Idempotency-Key`), MPS availability/cost for a
  single-install operator.
- **Explicitly excluded from v1:** production wiring, the YCloud↔Kapso
  config switch as an acceptance claim, and **embedded signup / setup-link
  onboarding** — that requires an explicit business decision first (CR-6).

**Acceptance criteria**
- Spike report answers the open research items; **no acceptance claim** is
  made on Kapso send/receive in v1.

### Phase 7 — Operational polish

**Deliverables** — canonical unit 9.
- Per-channel policy/reply-window handling, durable media (if not shipped
  in P5), i18n decision (G10), guided first-run checklist (G11),
  observability for ingress/adapter failures, upgrade runbook
  (backup → migrate → deploy → smoke checklist).

**Acceptance criteria**
- Media survives redeploys; rotation runbook rehearsed on staging; upgrade
  runbook rehearsed on an anonymized copy of a real database.

## 5. Migration safety

- `drizzle-kit migrate` is canonical for installs/upgrades; `db:push` is
  dev-only and never run against production (and its POSIX-only,
  error-masking script form is fixed or removed — G3).
- Schema evolution: additive-only columns/tables; enum changes via new
  migrations; no renames without a compatibility step or two-phase rollout.
- `channel_accounts` rollout is expand-migrate-contract: add table,
  backfill, switch reads (with the CR-5 shadowing rule), deprecate writes
  last — each step separately deployable.
- **Rollback reality (W-8):** there is no CI and `drizzle-kit` does not
  generate down migrations. The gate is: every migration is exercised on a
  fresh ephemeral Neon branch, and rollback is validated by restoring the
  Neon branch/backup and re-migrating — until CI plus explicit rollback
  scripts exist.
- Journal integrity (G3) is verified as part of P0 acceptance — a fresh
  `migrate` on an empty branch plus a clean `generate`.

## 6. Secrets safety invariants (must hold in every phase)

- `AUTH_SECRET` derives the AES-256-GCM key for all stored credentials —
  never logged, never committed, never returned to the client. Rotation
  requires the P1 re-encryption runbook (G7).
- Admin-entered secrets stay write-only in the UI (empty submit keeps value,
  `CLEAR` removes) and decrypt only server-side via `decryptIfEncrypted`.
- Webhook endpoints validate provider signatures/secrets before any DB
  write; inbound payloads are treated as untrusted.
- `.env*` remain gitignored; `.env.example` is the only tracked env file and
  must never contain real values.
- No customer PII in tests, fixtures, docs or committed scripts.

## 7. Documentation changes

- `README.md` → SocialCRM-branded install guide (Render + **Neon-required**
  golden path, blueprint flow, provider matrix, webhook table, custom
  domain) and its "any Postgres" claim corrected (G5).
- `.env.example` → Neon requirement, DLQ/Upstash truth (G14),
  `BUSINESS_OWNER_NAME` cleaned up.
- New under `docs/socialcrm/`: `install-render-neon.md`,
  `configuration-reference.md` (env vs DB precedence), provider setup guides
  (`providers/ycloud.md`, `zernio.md`; `kapso.md` only if the spike
  graduates), `upgrade-runbook.md`, `secrets-and-rotation.md` (P1),
  `migration-safety.md`.
- `AGENTS.md` updated alongside any config surface change. The canonical
  contract lives in `provider-integration-evidence.md`; adapter/ingress
  design detail lives in `architecture-roadmap.md` — this document links to
  them rather than duplicating (review §3).
- Retire or archive Muzzarella-specific ops docs from the product tree.

## 8. Test & release gates

Floor (all already exist — keep green): `npm run test:agents`,
`npm run typecheck`, `npm run lint`, `npm run build` (with
`NODE_OPTIONS=--max-old-space-size=8192` on low-memory machines).

Add per phase:
- **P0**: `drizzle-kit migrate` on an empty Neon branch + clean
  `drizzle-kit generate`; `/setup` concurrent-submit test; rollback rehearsal
  via branch restore + re-migrate (W-8 mechanism, not aspirational CI).
- **P1**: fresh-install smoke (migrate → seed → `/setup` → login → health
  200) on an ephemeral Neon branch.
- **P3**: canonical contract suite against every adapter with mocked HTTP;
  signature fixtures; idempotent-replay tests on `platformMessageId`;
  parity test asserting identical DB effects on old vs new inbound paths.
- **P4**: credential-shadowing test (edit legacy `agent_config` field after
  backfill → new value wins); encryption round-trip; ingress 401/200 parity;
  duplicate-replay dedup.
- **P5**: phone-less identity fixture; comment-as-event-kind fixtures.
- **Every release**: `git diff --check`, build, full suite, fresh-branch
  migration check, manual smoke of `/setup` + one inbound + one outbound,
  docs diff reviewed for stale instructions. New tests must be added to
  `test:agents` (or an equivalent wired script) when created (W-7).

## 9. Risks & open decisions

- **Neon coupling (G5)**: documenting "Neon required" is cheap; a driver
  abstraction widens compatibility. Decide in P0 — but fix the README/
  `.env.example` claims either way.
- **Queue/DLQ posture (G14)**: Upstash-required vs queue-disabled for
  single-instance installs is a product decision — the current "optional"
  claim is false.
- **i18n (G10)**: Spanish-first is viable short-term; string extraction is a
  large touch — decide before P2 doubles the work.
- **Restaurant feature flags**: gating kitchen/cash/delivery adds config
  surface; removing them loses Muzapp-parity installs. Recommend flags,
  off-by-default.
- **`agent_config` god-row**: mixes identity, secrets, feature flags and
  vertical settings. P2–P4 should split by concern rather than keep
  appending columns.
- **Kapso business decision**: MPS/embedded-signup availability and cost for
  a single-install operator are unverified; spike (P6) must close that
  before any production commitment.
- **Spec drift**: the source brief's `tenantId` is kept in the contract as a
  constant `"default"` for shape compatibility — no tenancy logic is built
  around it.

## 10. Out of scope

Multitenancy/tenant isolation, hosted billing, multi-region or
multi-instance HA, non-Render deployment targets (documented as "should work
on any Node + Neon host", not guaranteed), Kapso production wiring and
embedded signup in v1, a multi-account-per-channel routing matrix in v1, and
any change to the single-admin-bootstrap security model.
