# SocialCRM — Execution Control

Status: active orchestration document. Owner: main-worktree orchestrator.
Created: 2026-10-18. Supersedes nothing; binds the three planning docs into
one executable spine.

## 0. Canon — which doc wins where

| Document | Authority over |
|---|---|
| `multiprovider-source-spec.md` | Product requirements (Spanish input). Not API authority. |
| `provider-integration-evidence.md` | Provider facts, webhook/signature shapes, `NormalizedInboundEvent`/`OutboundMessage`/`SendResult` contract, dedup model, implementation checklist order. |
| `architecture-roadmap.md` | Module layout (`src/lib/messaging/`), `ChannelAccount` shape, compatibility constraints C1–C12, phased work units. |
| `self-hosted-product-roadmap.md` | Installability gaps G1–G12, product phases, secrets invariants, docs plan. |
| This file | Sequencing, ownership, gates, slice status. |

Where the source docs disagree, this file resolves it (§2). Errata: the
architecture roadmap §1 cites `src/lib/db/index.ts`; the real driver file is
`src/db/index.ts` (neon-http).

## 1. Product invariants (binding on every slice)

- Self-hosted single-install on Render + Neon. One business per deploy.
  `tenantId` may exist as a constant `"default"` column — never build tenancy
  logic.
- YCloud stays the WhatsApp provider for v1. The existing webhook, pipeline
  order, and `agent_config` credential editor keep working untouched.
- Fail-closed webhooks, additive-only migrations, AES-256-GCM at rest,
  write-only secrets UI, no PII in commits.
- Conventional commits, no AI attribution. Each commit an independently
  revertable work unit; tests/docs travel with the behavior they cover.
- No push, no deploy, no migrations against real DBs, no secret access.

## 2. Canon resolutions

1. **Ingress path**: `POST /api/webhooks/ingress/[provider]` (App Router
   segment). The spec's `/api/v1/webhooks/ingress/:provider` is a sketch;
   do not build a versioned path.
2. **Contract freeze**: use evidence §4 verbatim for `MessagingProvider`,
   `NormalizedInboundEvent`, `OutboundMessage`, `SendResult`,
   `signatureScheme`, and `ChannelAccount` (`id`, `tenantId`, `provider`,
   `channel`, `providerAccountId`, `senderAddress`, `credentials`,
   `status`). **No** `isDefault`/`displayAddress` — account defaulting is a
   schema/resolver concern and `senderAddress` covers the display role
   (final-review R-1). Channels are `whatsapp`, `instagram`, `facebook`,
   `telegram`, `sms`; `comment`/`messenger` are event kinds, never channel
   values. On name conflicts prefer evidence names (`providerAccountId`,
   `deliveryId`). `parseWebhook` returns an **array**.
3. **`channel_accounts` timing**: do NOT create the table in the early
   slices. Hard-code the registry `whatsapp → ycloud`; resolve credentials
   via `agent_config → env` (existing pattern). The table lands in slice B3,
   immediately before the first non-YCloud provider work.
4. **Unified ingress timing**: lands with B4, just before provider #2 — not
   as a standalone early phase. `/api/whatsapp/webhook` remains the YCloud
   binding until then (evidence checklist #6).
5. **DB driver**: Neon + `neon-http` is the documented requirement.
   A `pg`/postgres-js fallback is deferred (decision recorded; revisit only
   if a real install needs non-Neon Postgres).
6. **i18n**: Spanish-first accepted for v0. String extraction deferred;
   revisit before the P2 de-branding work doubles its cost.
7. **Drizzle journal**: broken (confirmed: `0001_handy_tombstone` in journal
   has no SQL file; `0002_unique_phone.sql` exists but is not in the journal;
   two `0002` files). Treat migrations as untrusted until repaired by A2;
   no new migration may be generated until the journal is fixed.

## 3. Execution spine (dependency graph)

```
Track A — installability/self-hosted            Track B — provider seam
A0 repo hygiene ──► P0 journal repair (S6) ──►  B0 contract+YCloudAdapter (new files only)
   │                P0 /setup + clients       │            │
   │                neon-http fix (S7)        ├─► B1 send facade call sites
   │                    │                     │            │
   └──────────► A1 render.yaml+install ──►    └─► B2 inbound extraction (webhook route slim)
                  (S3 publishes ONLY                     │
                   after P0 is green)             GATE: provider #2 decision (Zernio creds/account)
                                                                ▼
                                          B3 channel_accounts table+resolver
                                                                ▼
                                          B4 unified ingress (ycloud delegates)
                                                                ▼
                                          B5 ZernioAdapter (IG/FB) ─► B6 Kapso spike (no prod wiring)
   A3 ops polish (later, incl. de-brand vertical)
```

Rules: B0–B2 are pure refactors — zero behavior change, each commit
independently revertable. B3+ require real provider credentials/decision
and are NOT launchable autonomously yet. A-track slices never touch
`src/lib/messaging`, `src/lib/whatsapp`, webhook routes, or the schema.

## 4. Slices (ownership + commit boundaries + acceptance)

Status legend: `queued` `running` `in-review` `integrated` `blocked`.

| ID | Slice | Owns (files) | Depends on | Commits | Acceptance | Status |
|---|---|---|---|---|---|---|
| S1 | `socialcrm-messaging-core` | `src/lib/messaging/**` (new only) | none | 1: `feat(messaging): add provider abstraction core and ycloud adapter` | Contract = evidence §4 verbatim (no `isDefault`/`displayAddress`; channels exclude `comment`/`messenger`); YCloudAdapter delegates; contract+adapter tests; all gates green | integrated (S8 folded in, see §8) |
| S8 | S1 contract alignment | `src/lib/messaging/**`, `src/lib/ycloud.ts` (externalId passthrough only), `package.json` test list | S1 reviewed | `fix(messaging): align provider contract with canonical evidence` | Drops `isDefault`/`displayAddress` and `comment`/`messenger` channels; `idempotencyKey`→`externalId` passthrough; correct `retryable` classification; deterministic `ycloud:synth:` deliveryId; tests wired into `test:agents` | integrated |
| S2 | `socialcrm-repo-hygiene` | root scratch/PII files (list below), `.env.example`, `docs/socialcrm/repo-hygiene-report.md` | none | 1: `chore(repo): remove client PII scripts and scratch artifacts` 2: `docs(socialcrm): add repo hygiene audit report` | `git grep` finds no customer names/phones in removed set; `.env.example` `BUSINESS_OWNER_NAME` fixed; audit lists drizzle journal anomalies (verify-only, no fix); gates green | integrated (see §8) |
| S3 | `socialcrm-implementer-docs` (repaired on `socialcrm-render-blueprint` base) | `render.yaml`, `docs/socialcrm/install-render-neon.md`, `.env.example` (sync comment only if needed) | S6+S7 green | 1: `feat(infra): add render.yaml blueprint and Render+Neon install guide` | Blueprint declares web service, required env prompts, `healthCheckPath: /api/health`, cron jobs; guide covers provision→migrate→/setup→config→webhooks→verify; no secret values; lint/typecheck unaffected | integrated (`b443f3a`, repaired by S10) |
| S10 | S3 repair + implementer docs pack | `render.yaml`, `docs/socialcrm/install-render-neon.md`, `docs/socialcrm/implementer-*.md` + `transform-repo.md` (new), `README.md`, `.env.example` | S3 reviewed | `fix(infra): url-encode cron secrets and align render blueprint` + `docs(socialcrm): rewrite install guide for fork-first Render deploy` + `docs(socialcrm): add implementer onboarding and AI-agent guides` | R1–R5 + W1–W3 from `slices-review.md` closed; fork-first flow documented; docs internally consistent | integrated (`f3eeae5`+`fe8f107`+`87fde5e`, see §8) |
| S4 | B1 send facade | `broadcast.ts`, `queue/worker.ts`, `cron/followup`, `tools{WhatsApp,Management}.ts`, `create-order.ts`, `channels/router.ts`, `response-sender.ts` | S1+S8 | `refactor(whatsapp): route outbound sends through messaging facade` (+test updates same commit) | Identical send behavior; tests incl. C10 source-readers updated | integrated (`5aa763a`, see §8) |
| S5 | B2 inbound extraction | `api/whatsapp/webhook/route.ts`, adapter parse | S4 | `refactor(whatsapp): extract inbound parsing into ycloud adapter` | Ordering tests updated; fixture parity | running (`socialcrm-inbound-extract`) |
| S6 | A2 journal repair | `drizzle/**`, `docs/socialcrm/migration-safety.md` | S2 report | `fix(db): repair migration journal integrity` | `drizzle-kit migrate` runs clean on ephemeral branch | integrated (`dbcd486`, see §8) |
| S7 | /setup neon-http fix | `src/app/setup/actions.ts`, `src/app/(admin)/admin/clients/actions.ts`, tests | none | `fix(setup): replace neon-http transaction with atomic bootstrap` | `/setup` creates first admin without `db.transaction`/advisory locks; same fix applied to `clients/actions.ts:206`; tests cover concurrency path | integrated (`d96d1b0`+`7570207`, see §8) |
| S9 | residual-PII cleanup | `docs/chats.txt`, `mirar.txt`, `prueba.txt`, `xxx.txt`, `chat-analysis/segmentos.md`, `manual-operativo*`, `repomix-output-*.md`, `scripts/restore-lead*.mjs`, `get-chat-by-phone.ts`, `find-tg-convs.mjs`, `wipe-customers.mjs` | S2 | `chore(repo): scrub residual customer PII from docs and scripts` | No customer name/phone in tracked files; docs of real value redacted (not deleted); repomix snapshot deleted or regenerated post-scrub | queued — needs product call on docs disposition |
| S11 | channel_accounts + identity schema | `src/db/schema.ts`, `drizzle/` migration (additive), `src/lib/messaging/types.ts` (ChannelKind extend) | S5 | `feat(db): add channel_accounts and multi-identity columns` | `channel_accounts` table; `conversations.channelAccountId`; `whatsappId`/`leads.phone` nullable + composite uniqueness; `channelEnum` gains instagram/facebook/sms/reddit; gates green on ephemeral DB | queued (per multi-channel-requirements.md) |
| S12 | unified ingress + passive persistence | `src/app/api/webhooks/ingress/[provider]/route.ts` (new), shared inbound pipeline | S5, S11 | `feat(messaging): add provider ingress route with passive persistence` | All event kinds persisted (messages, statuses, echoes, comments); old `/api/whatsapp/webhook` still works | queued |
| S13 | per-channel/per-account agent config | `agent_config` scope columns, `/admin/agent` selector UI, config-copy action | S11 | `feat(admin): bind agent config to channel/account with selector` | Selector binds config to channel or account; account→channel→global resolution; copy action replicates config | queued |
| S14 | conversations channel/account filter | `/admin/conversations` UI | S11 | `feat(admin): filter conversations by channel and account` | Filter chips by channel + connected number | queued |
| S15 | handoff transport generalization | `resolveHandoffTransport`, operator-send paths | S4 done; S11 | `refactor(messaging): route handoff/operator sends through messenger on all channels` | Operator replies + takeover work identically on every provider | queued |
| S16 | provider connection onboarding | connection UI + embedded signup flow | S11, provider creds | `feat(admin): provider connection onboarding` | Meta embedded signup or manual key entry per provider | queued — needs Meta/Kapso decision |

S2 deletion set (from roadmap G8): `scripts/find-hector*.mjs`,
`scripts/wipe-conv15*.mjs`, `scripts/del-order*.mjs`,
`scripts/clean-conv15*.mjs`, `scripts/check-*` one-offs, root
`chatprueba.txt`, `nota.txt`, `prompt*.txt`, `PROMPT-*.md`, `clean.js`,
`migrate-fix.js`, `fusa stack/`, `fusa-stack/`, product JPEGs (~2 MB).
Worker must `git grep` each deleted name for live references before
removing; anything referenced stays and is reported instead.

## 5. Verification gates (every slice, no exceptions)

1. `npm run test:agents`
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build` (`NODE_OPTIONS=--max-old-space-size=8192` if OOM)
5. `git diff --check` clean; conventional commits; no secrets/PII.

Docs-only slices run gates 1–4 only if they touched executable files.

## 6. Orchestration protocol (binding on the main-worktree orchestrator)

- Workers run in Orca worktrees (`orca worktree create --no-parent`), ff-
  merged to local `main` after creation (worktrees base on `origin/main`,
  not local HEAD). Launch: `devin --model swe-2-max --permission-mode
  dangerous --respect-workspace-trust false`.
- Lifecycle: `running → in-review → completed` in Orca (`workspaceStatus` +
  comment). Only the orchestrator may mark `completed`, and only after
  fresh review.
- Every worker return is untrusted: collect terminal transcript, `git
  status/log/diff --check`, review the diff, run gates, then cherry-pick
  into `main`. Never merge unreviewed work.
- Copy every required input into the worktree before launch; never depend
  on `external_directory` approval.
- After each integration, pick the next dependency-ready slice and launch.
  Stop only for required provider credentials/accounts or a true product
  decision.
- Persist state to Engram project `socialcrm`: keys
  `socialcrm/execution-state`, `decision/<topic>`, `sdd/<slice>/apply-progress`.

## 7. Blocked / needs-human

- Zernio account + API key (gates B5). Kapso test project (gates B6).
- Real Neon ephemeral branch or staging DB for migration verification (S6
  can proceed dry-run; up/down verification needs a throwaway DB).
- Product decisions deferred, not blocking current slices: i18n (§2.6),
  non-Neon driver (§2.5), Kapso embedded-signup fit for single-install,
  restaurant vertical extraction strategy (A2).

## 8. Integration log

| Date | Integrated | From worktree | New main SHA |
|---|---|---|---|
| 2026-10-18 | `docs(socialcrm): add multichannel provider architecture roadmap` | `socialcrm-architecture-plan` 4e983a6 | 1ee04cf |
| 2026-10-18 | `docs(socialcrm): provider integration evidence for ycloud, zernio, kapso` | `socialcrm-provider-research` ab7ae2f | 8bdc7be |
| 2026-10-18 | `docs(socialcrm): add self-hosted product roadmap for Render + Neon` | `socialcrm-selfhosted-readiness` 1425a9f | de8901e |
| 2026-10-18 | `docs(socialcrm): promote multiprovider source spec to canonical doc` | main (root file promotion) | fe04b2b |
| 2026-10-19 | `docs(socialcrm): add execution control plan ...` | main | 400daa1 |
| 2026-10-19 | Review+repair chain: evidence `37821fd`, roadmaps-review `5dbc72f`, plans-rereview `036d106`, architecture r1+r2 `ae708c1`+`d497619`, self-hosted r1+r2 `9a5c20f`+`8fa6788`, final-review `36d2a99`, slices-review `be457b6` | review branches (all docs-only, `diff --check` clean, verdicts APPROVE) | `0b1c6b1..bc6b176` |
| 2026-10-19 | `chore(repo): remove client PII scripts and scratch artifacts` + `docs(socialcrm): add repo hygiene audit report` | `socialcrm-repo-hygiene` `332acf0`+`31ea0f6` | `1b3cbcc`+`bbd5743` |
| 2026-10-19 | `feat(messaging): add provider abstraction core and ycloud adapter` + `fix(messaging): align provider contract with canonical evidence` + `test(messaging): exercise synth deliveryId with truly id-less envelope` | `socialcrm-messaging-core` `6ca09f4`+`91d4f6d`+`817edce` | `8f70b86`+`0075573`+`f98f581` |
| 2026-10-19 | `fix(db): repair migration journal integrity` (13-entry journal coherent: 0001 SQL recreated from snapshot diff, 5 snapshots synthesized+verified, `0002_unique_phone` orphan removed; + `migration-safety.md`) | `socialcrm-journal-repair` `43b249b` | `dbcd486` |
| 2026-10-19 | `fix(setup): bootstrap first admin with a single atomic INSERT` + `fix(admin): delete lead and orders atomically without db.transaction` (9 new tests; residual gap: different-email concurrent bootstrap needs singleton index — deferred schema work) | `socialcrm-setup-fix` `247eae7`+`d320d48` | `d96d1b0`+`7570207` |
| 2026-10-19 | `feat(infra): add render.yaml blueprint and Render+Neon install guide` + `fix(infra): url-encode CRON_SECRET` + `docs(socialcrm): repair install path and reconcile README/env` + `docs(socialcrm): implementer onboarding + AI-agent guide + transform-repo` | `socialcrm-implementer-docs` `28e054c`+`3237e53`+`c031afc`+`9b3db88` | `b443f3a`+`f3eeae5`+`fe8f107`+`87fde5e` |
| 2026-10-19 | `feat(messaging): route outbound WhatsApp sends through messenger facade` (messenger.ts + tests; 11 call-site files / 15 sends migrated; `ycloud-client.ts` folded into adapter; webhook route inbound untouched) | `socialcrm-send-facade` `280495e` | `5aa763a` |
