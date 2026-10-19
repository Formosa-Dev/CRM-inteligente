# SocialCRM — Self-Hosted Product Roadmap

Status: planning baseline. Date: 2026-10-18.
Scope: turn the inherited Muzapp codebase into **SocialCRM**, a generic,
single-install Social CRM + AI-agent product that a business owner or
implementer can deploy as a dedicated instance on **Render + Neon PostgreSQL**.

Non-goals: no multitenant architecture, no SaaS billing, no HA/multi-instance
topology. The product is one dedicated instance per customer.

Design inputs: `docs/socialcrm/multiprovider-source-spec.md` (provider
abstraction spec: YCloud / Zernio / Kapso), `README.md`, `.env.example`,
`AGENTS.md`, `src/db/schema.ts`, `docs/sdk/PENDING_PUBLIC_EXPERIENCE.md`.

---

## 1. Target deployment & configuration experience

The "golden path" for a self-hoster must be achievable without repo commit
access, shell access to the app, or knowledge of the codebase:

1. **Provision** — Render web service (Node 20) + Neon Postgres. Optional
   Upstash Redis for durable queue/rate-limit state.
   - Target artifact: `render.yaml` blueprint (does not exist today) so the
     service, env-var prompts, health check (`/api/health`) and cron jobs are
     declared as infrastructure-as-code instead of manual dashboard steps.
2. **Configure env vars** — `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`,
   `NEXT_PUBLIC_APP_URL` are the only required vars; everything else is
   optional or DB-configured. This contract already exists — preserve it.
3. **Migrate** — canonical schema step must be `drizzle-kit migrate`
   (`npm run db:migrate`). Today README quickstart says `db:push` while the
   `/setup` error state says `db:migrate`; pick migrate for installs/upgrades
   and keep `push` dev-only.
4. **Bootstrap admin** — `/setup` creates the first admin (advisory-locked,
   self-disabling). Already implemented in `src/app/setup/`; keep as-is and
   document it as the supported path. `npm run db:seed` remains the scripted
   alternative and must keep its "no default credentials" contract.
5. **Configure the instance from the UI** — `/admin/agent` already covers
   business identity, AI provider, YCloud, Cloudinary, Meta, Telegram, cron,
   escalation email. Roadmap work extends this to a **channel-accounts**
   model (Phase 3+) instead of one global YCloud credential.
6. **Wire webhooks** — each configured channel account must surface its exact
   inbound URL (e.g. `/api/v1/webhooks/ingress/:provider` per the source spec)
   in the admin UI, copy-pasteable into the provider console.
7. **Verify** — document a post-install checklist: health 200, login works,
   one inbound message lands in `/admin/conversations`, one outbound reply
   sends, media upload succeeds (requires Cloudinary configured).

Success metric: an implementer who has never seen the repo deploys a working
instance in under ~30 minutes using only the published docs.

## 2. Reusable platform core vs. client-specific customizations

### 2.1 Reusable as-is (platform core)

| Area | Where | Notes |
|---|---|---|
| Next.js 16 / React 19 / Drizzle + Neon base | `package.json`, `src/db/index.ts` | `neon-http` driver — see gap G4 |
| First-admin bootstrap | `src/app/setup/` | race-safe advisory lock, self-locking |
| AuthN/AuthZ | `src/auth/`, `src/lib/auth/require-admin.ts` | NextAuth v5, admin/viewer roles, per-email login limiter |
| DB-backed, write-only, encrypted config | `agent_config` + `src/lib/encryption.ts` + `src/lib/integrations.ts` | AES-256-GCM keyed on `AUTH_SECRET`, env fallback, `decryptIfEncrypted` migration tolerance |
| Unified conversation model | `conversations`, `chat_messages`, `leads`, `attachments` + `src/lib/channels/router.ts` | channel-agnostic ingestion, `platformMessageId` idempotency, human override |
| AI provider abstraction | `src/lib/ai/config.ts` | OpenAI-compatible key/base-URL/models via DB→env |
| Infra resilience | buffer, DLQ, rate-limit, circuit breaker, HMAC webhook checks (`src/lib/infra`, queue, idempotency) | Upstash optional, in-memory fallback documented |
| Cron surface | `/api/cron/followup`, `/api/cron/reconcile` | `CRON_SECRET`-gated |
| Admin panel shell | `src/app/(admin)/admin/` | conversations inbox, leads, analytics, agent config |
| Deployment pattern | README §"Deploy to Render" | docs exist; needs blueprint + SocialCRM rebrand |

### 2.2 Client-specific (Muzzarella) — must be decoupled or made configurable

| Area | Evidence |
|---|---|
| Food-domain enums | `product_category` (`hamburguesa`, `pan_mayorista`, `tragos_vip`…), `order_type` (`hamburguesas`, `pan_mayorista`) in `src/db/schema.ts` |
| Restaurant runtime flags in config | `agent_config.isCooking`, `hamburguesasSinStock`, `stockPanDocenas`, `aliasB2c/B2b`, `tiempoEspera`, `menuImageUrl*`, default delivery zones centro/norte/sur |
| Hardcoded storefront routes | `src/app/(storefront)/hamburguesas|pan-mayorista|tragos-vip|promo` |
| Restaurant ops flows | kitchen order board, cash sessions (`/admin/caja`), delivery-arrival notifications with hardcoded copy in `src/lib/channels/router.ts` |
| Brand strings | ~11 `src/` files mention Muzzarella; `package.json` name `muzapp`; `CLOUDINARY_FOLDER = "muzapp"` in `src/app/api/media/upload/route.ts`; Spanish demo catalog `LINEA_CARNE` + prompt in `src/db/seed.ts` |
| Client artifacts in repo root | product JPEGs (~2 MB), `chatprueba.txt`, `nota.txt`, `prompt*.txt`, `PROMPT-*.md`, `clean.js`, `migrate-fix.js`, `fusa stack/`, `fusa-stack/` |
| Customer-PII ops scripts | `scripts/find-hector*.mjs`, `wipe-conv15*.mjs`, `del-order*.mjs`, `clean-conv15*.mjs`, `check-*` one-offs |

Rule of thumb for the fork line: **conversation, lead, message, config,
secrets, auth, agent and channel plumbing are core; catalog shape, order
workflow, kitchen/cash/delivery, prompts and branding are per-install
customization** that belong behind configuration or a "vertical" module.

## 3. Concrete gaps in the inherited repository

- **G1 — No IaC for Render.** No `render.yaml`; deploy is a manual, doc-only
  procedure. A blueprint is the cheapest installability win.
- **G2 — WhatsApp is hardwired to YCloud.** `src/lib/ycloud.ts`,
  `src/lib/whatsapp/ycloud-client.ts`, `/api/whatsapp/webhook`,
  `/api/webhook/whatsapp`. No `ChannelAccount` entity, no provider field on
  conversations, `channel` enum is only `whatsapp|telegram`, one global
  YCloud credential on `agent_config`. Blocks the multiprovider spec.
- **G3 — Migration story is inconsistent and fragile.** README uses
  `db:push` (which runs `drizzle-kit push --force 2>/dev/null || echo …` —
  POSIX-only and error-masking); `/setup` tells users to run `db:migrate`.
  The `drizzle/` journal shows duplicate sequence numbers (`0002` twice) and
  snapshots missing for several entries — needs an integrity pass before it
  can be trusted for fresh installs.
- **G4 — Neon driver is a hard dependency today.** `src/db/index.ts` uses
  `@neondatabase/serverless` `neon()` HTTP driver; a plain Render-Postgres or
  Supabase URL will not work through it. Either document **Neon as required**
  or add a `pg`/postgres-js driver path.
- **G5 — Ephemeral-disk media path.** `/api/media/[...path]` serves files from
  `public/uploads` on local disk — anything stored there is lost on every
  Render redeploy. Admin uploads already go to Cloudinary; inbound-channel
  media needs the same durable-store strategy or a documented limitation.
- **G6 — `AUTH_SECRET` rotation is unhandled.** Rotating it invalidates
  sessions *and* makes all AES-256-GCM ciphertexts undecryptable
  (`src/lib/encryption.ts`). No documented re-encryption/key-rotation runbook.
- **G7 — Single-row `agent_config id=1` assumption** is scattered through
  `src/lib/integrations.ts`, `src/lib/channels/router.ts`, seed. Fine for
  single-install, but the `channel_accounts` refactor must not multiply this
  pattern.
- **G8 — Client PII and junk in-repo.** Ops scripts reference real customer
  names/phones; root has client photos and scratch files. Must be purged for
  a public/generic product. `.env.example` ends with a stray uncommented
  `BUSINESS_OWNER_NAME=`.
- **G9 — Language/i18n decision open.** Agent prompts, seed, admin copy and
  error strings are Spanish-first. Acceptable v0 for an Rioplatense market;
  needs an explicit product decision before claiming "generic".
- **G10 — First-run UX is one long form.** `/admin/agent` works but offers no
  guided checklist ("configure channel → set webhook → test message"). Cheap
  win for implementer experience.
- **G11 — Docs are Muzapp-branded** and describe the food business deploy;
  `docs/manual-operativo-mrs-muzzarella.md`, README hero copy, DESIGN.MD.
  Rebrand + provider setup guides needed.
- **G12 — Test coverage is domain-shaped.** `npm run test:agents` exercises
  restaurant flows (checkout, cash, telegram). No contract tests for a
  provider interface or unified ingress — must be added with Phase 3.

## 4. Phased roadmap

Each phase lists deliverables and acceptance criteria. Phases are
independently shippable; P0/P1 make a deployable Muzapp-as-is product, P2
makes it generic, P3/P4 deliver the multiprovider spec.

### Phase 0 — Repo hygiene & trust baseline (no behavior change)

**Deliverables**
- Remove customer-PII scripts and scratch/client files from the product repo
  (move ops scripts to a private ops repo if still needed).
- Fix `.env.example` (`BUSINESS_OWNER_NAME` comment or removal), align
  migration instructions, audit `drizzle/` journal integrity.
- Rebrand surface that ships to users: `package.json` name, `CLOUDINARY_FOLDER`,
  README/AGENTS/docs naming, seeded demo content made neutral.

**Acceptance criteria**
- `git grep` finds no customer names/phones; no stray root artifacts.
- `npm run test:agents`, `typecheck`, `lint`, `build` all green, unchanged.

### Phase 1 — Installable core on Render + Neon

**Deliverables**
- `render.yaml` blueprint: web service, `DATABASE_URL`/`AUTH_SECRET`/`AUTH_URL`/
  `NEXT_PUBLIC_APP_URL` prompts, `healthCheckPath: /api/health`, optional
  Upstash + cron job definitions for `/api/cron/*`.
- Canonical migrate-on-install/upgrade path; setup page text aligned.
- Install guide + post-install verification checklist (§1.7).
- Neon requirement documented, or a `pg` driver path added behind env switch.

**Acceptance criteria**
- Fresh clone → deploy via blueprint → `/setup` → login → send+receive a
  WhatsApp message end-to-end, documented by the install guide alone.
- No secret value ever leaves the server (write-only UI preserved).

### Phase 2 — Generic domain model (de-Muzzarella)

**Deliverables**
- Catalog categories and order types become data-driven (DB-configured
  taxonomy) or behind a `vertical` config; restaurant-specific
  `agent_config` fields grouped into a vertical/feature block.
- Storefront routes genericized or made optional per vertical.
- Default agent prompts neutral; kitchen/cash/delivery modules gated by
  feature flags with safe off-defaults for non-food installs.

**Acceptance criteria**
- A fresh install with no vertical configured shows a functional generic
  CRM inbox/leads/admin; no hamburguesa/Muzzarella strings render.
- Migrations are additive; existing Muzapp installs upgrade without data loss
  (see §5).

### Phase 3 — Messaging core + YCloud adapter (source spec §3–§5)

**Deliverables**
- `messaging-core`: `IMessagingProvider`, `ChannelAccount`,
  `OutboundMessage`, normalized `SystemInboundEvent` per the source spec.
- `channel_accounts` table (single-tenant: one DB, N accounts);
  conversations gain a channel-account reference; legacy `channel` enum
  extended (`instagram`, `facebook`, `sms` as needed).
- Unified ingress `POST /api/v1/webhooks/ingress/:provider` with per-provider
  signature validation; existing YCloud webhook logic lifted into
  `YCloudAdapter`; legacy routes kept as aliases during transition.
- Admin: channel accounts CRUD, per-account webhook URL display, routing
  rules per spec §6 matrix.
- Backfill migration: existing `agent_config` YCloud fields → one
  `channel_accounts` row; keep old fields readable for rollback.

**Acceptance criteria**
- WhatsApp via YCloud works end-to-end exclusively through the adapter;
  duplicate-webhook idempotency and human-override behavior preserved.
- Contract tests: every adapter passes the same inbound/outbound/normalize
  suite; ingress rejects bad signatures per provider.

### Phase 4 — Zernio + Kapso adapters

**Deliverables**
- `ZernioAdapter`: Instagram/FB/etc channels, HMAC-SHA256 webhook validation,
  `comment.received` handling → inbox.
- `KapsoAdapter`: WABA send/receive, embedded-signup link generation so the
  owner onboards their own Meta assets without shell access.
- Configurable routing matrix (channel → preferred provider) in admin.

**Acceptance criteria**
- An Instagram DM via Zernio lands in `/admin/conversations` and can be
  answered from the same UI.
- WhatsApp channel can be switched YCloud↔Kapso by configuration alone, with
  WA regression tests green.

### Phase 5 — Operational polish

**Deliverables**
- Durable inbound-media strategy (Cloudinary/S3-style store instead of
  `public/uploads`), `AUTH_SECRET` rotation runbook with re-encryption step,
  i18n decision, observability for ingress/adapter failures.
- Upgrade runbook: backup → migrate → deploy → smoke checklist.

**Acceptance criteria**
- Media survives redeploys; rotation runbook verified on a staging clone;
  upgrade runbook rehearsed on a copy of a real (anonymized) database.

## 5. Migration safety

- `drizzle-kit migrate` is canonical for installs/upgrades; `db:push --force`
  is dev-only and must never be run against a production DB. Fix the
  journal/sequence anomalies (G3) before treating migrations as product API.
- Schema evolution rules: additive-only columns/tables; enum changes via new
  migrations; no renames without a compatibility view or two-phase rollout.
- `channel_accounts` rollout is expand-migrate-contract: add table, backfill
  from `agent_config`, switch reads, deprecate writes last — each step a
  separately deployable commit.
- Every migration must be exercised up and down on an ephemeral Neon branch
  in CI/release gating.

## 6. Secrets safety invariants (must hold in every phase)

- `AUTH_SECRET` derives the AES-256-GCM key for all stored credentials —
  never logged, never committed, never returned to the client. Rotation
  requires the documented re-encryption procedure (G6).
- Admin-entered secrets stay write-only in the UI (empty submit keeps value,
  `CLEAR` removes) and decrypt only server-side via `decryptIfEncrypted`.
- Webhook endpoints validate provider signatures/secrets before any DB write;
  inbound payloads are treated as untrusted.
- `.env*` remain gitignored; `.env.example` is the only tracked env file and
  must never contain real values.
- No customer PII in tests, fixtures, docs or committed scripts.

## 7. Documentation changes

- `README.md` → SocialCRM-branded install guide (Render+Neon golden path,
  blueprint flow, provider matrix, webhook table, custom domain).
- New under `docs/socialcrm/`: `install-render-neon.md`,
  `configuration-reference.md` (env vs DB precedence), per-provider setup
  guides (`providers/ycloud.md`, `zernio.md`, `kapso.md`),
  `upgrade-runbook.md`, `secrets-and-rotation.md`,
  `migration-safety.md`.
- `AGENTS.md` and `.env.example` updated alongside any config surface change;
  keep `docs/socialcrm/multiprovider-source-spec.md` as the design reference.
- Retire or archive Muzzarella-specific ops docs from the product tree.

## 8. Test & release gates

Floor (all already exist — keep green): `npm run test:agents`,
`npm run typecheck`, `npm run lint`, `npm run build` (with
`NODE_OPTIONS=--max-old-space-size=8192` on low-memory machines).

Add per phase:
- **P1**: fresh-install smoke script (migrate → seed → setup → login →
  health 200) run against an ephemeral Neon branch.
- **P3**: `IMessagingProvider` contract suite (send/parse/normalize) executed
  against every adapter with mocked HTTP; ingress signature tests per
  provider; idempotent-replay tests on `platformMessageId`.
- **P4**: channel-switch regression — same inbox behavior with provider A vs B.
- **Every release**: `git diff --check`, build, full test suite, migration
  up/down on ephemeral DB, manual smoke of setup + one inbound + one outbound
  message, docs diff reviewed for stale instructions.

## 9. Risks & open decisions

- **Neon coupling (G4)**: documenting "Neon required" is cheap; a driver
  abstraction costs more but widens compatibility. Decide in P1.
- **i18n (G9)**: shipping Spanish-first is viable short-term; extracting
  strings is a large touch — decide before P2 de-branding work doubles it.
- **Restaurant feature flags**: gating kitchen/cash/delivery adds config
  surface; removing them entirely loses Muzapp-parity installs. Recommend
  flags with off-by-default.
- **`agent_config` god-row**: the single-row table mixes identity, secrets,
  feature flags and vertical settings. Phases 2–3 should split it by concern
  rather than keep appending columns.
- **Spec drift**: the multiprovider spec sketches `tenantId` fields —
  single-install means `tenantId` is a constant; keep the field for shape
  compatibility but do not build tenancy logic around it.

## 10. Out of scope

Multitenancy/tenant isolation, hosted billing, multi-region or multi-instance
HA, non-Render deployment targets (documented as "should work on any Node +
Postgres host", not guaranteed), and any change to the single-admin-bootstrap
security model.
