# SocialCRM — Slices Review (S1 / S2 / S3)

Reviewer: fresh-context adversarial review.
Baseline: `400daa15b2528a76695c20e8fc0a59f11c3228df`.
Reviewed heads (immutable, not modified):

| Slice | Branch | Head | Scope |
|---|---|---|---|
| S1 messaging core | `socialcrm-messaging-core` | `6ca09f4d2fdb04ca24a5b15cb5aa6fa4f6fd9e9f` | 6 new files under `src/lib/messaging`, +1072 |
| S2 repository hygiene | `socialcrm-repo-hygiene` | `31ea0f6fc16453b9412b938cd526c842d244b1d1` | `332acf0` deletions + `31ea0f6` audit, 51 files |
| S3 Render blueprint | `socialcrm-render-blueprint` | `28e054c2dcbc7da260c56eb048dfb8272845fe54` | `render.yaml` + `docs/socialcrm/install-render-neon.md` |

Review inputs: the branch diffs, `docs/socialcrm/execution-control.md`,
`docs/socialcrm/provider-integration-evidence.md`,
`docs/socialcrm/architecture-roadmap.md`, `AGENTS.md`, the actual routes in
`src/app/api/**`, the DB driver in `src/db/index.ts`, the auth/setup paths, and
the installed dependency behavior. Worker claims were treated as untrusted.

## Verdicts

| Slice | Verdict | Reason |
|---|---|---|
| S1 messaging core | **APPROVE — with warnings** | Additive and inert: no existing file is touched, signature/parser behavior matches the existing YCloud route, and all gates pass. Two contract behaviors are not implemented (`idempotencyKey`, accurate `retryable`) and must be fixed before B1 call sites rely on them. |
| S2 repository hygiene | **APPROVE — with warnings** | All 49 deletions are unreferenced by build/runtime/scripts; build/tests/typecheck/lint pass. Residual PII remains in tracked docs and the stale repomix snapshot, and the audit report itself repeats the customer first name. |
| S3 Render blueprint | **CHANGES REQUIRED** | The Blueprint schema is valid, but the documented end-to-end install path does not work: `/setup` throws on the neon-http driver, the psql migration fallback fails, and the generated cron secret is not URL-encoded. |

Do not integrate S3 until the three CRITICAL items below are repaired (or the
guide is rewritten to a path that actually works). S1 and S2 can be integrated
independently; neither overlaps the other's files.

## CRITICAL

### C1 — S3: `/setup` cannot work on the documented neon-http driver

`createFirstAdmin` wraps the bootstrap in `db.transaction(...)` and takes a
PostgreSQL session advisory lock:

- `src/app/setup/actions.ts:40-42` (`db.transaction`, `pg_advisory_xact_lock`)
- `src/db/index.ts:1-10` uses `drizzle-orm/neon-http` over `neon()`.
- Installed driver: `node_modules/drizzle-orm/neon-http/session.js:151-152`
  throws `No transactions support in neon-http driver`.

Even if transactions existed, neon-http is stateless request/response HTTP:
there is no session that can hold an advisory lock across statements. The
install guide makes `/setup` the primary post-deploy step
(`docs/socialcrm/install-render-neon.md:30-35, 102-111`) and calls it
"race-safe advisory lock". It is not.

This is preexisting at the baseline (not introduced by S3), but S3 is the
slice that sells `/setup` as the golden path, so S3 cannot be approved as a
working install path until this is fixed. Verified with a dummy URL:

```bash
DATABASE_URL='postgresql://user:pass@example.invalid/db?sslmode=require' \
  node --import tsx -e "import('./src/db/index.ts').then(async (m)=>{const db=m.default?.db??m.db;await db.transaction(async()=>{});console.log('unexpected success')}).catch(e=>console.log('transaction error:',e.message))"
# transaction error: No transactions support in neon-http driver
```

**Repair (choose one):**

1. Rewrite `createFirstAdmin` without `db.transaction`: atomic
   `INSERT ... ON CONFLICT`/CAS plus a singleton guard, then update the guide.
2. If that is deferred, remove `/setup` from the Render golden path and make
   `npm run db:seed` the documented first-admin path (it uses plain inserts and
   works), including the required local/Render-shell prerequisite.

Also fix the same broken pattern in
`src/app/(admin)/admin/clients/actions.ts:206` before it is exercised.

### C2 — S3: the documented psql fallback fails and can delete data

The install guide says the journal is damaged and offers a fallback:

`docs/socialcrm/install-render-neon.md:94-100`

```bash
for f in drizzle/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

That glob orders `drizzle/0002_unique_phone.sql` before
`drizzle/0002_woozy_valkyrie.sql`. The first file updates `orders.lead_id`
(`drizzle/0002_unique_phone.sql:17-29`), but `orders.lead_id` is only added by
`drizzle/0002_woozy_valkyrie.sql:103`. On a fresh database the fallback stops
with `column o.lead_id does not exist` at the first `ON_ERROR_STOP=1` failure.
If it reached the end, `0002_unique_phone.sql:29` adds
`leads_phone_unique`, then `0002_woozy_valkyrie.sql:121` adds the same
constraint again and fails.

The same loop is not safe on an existing database: `0002_unique_phone.sql:8-15`
deletes duplicate leads (the file itself warns about this), and the later
migrations are not idempotent. Missing `drizzle/0001_handy_tombstone.sql`
(journaled at `drizzle/meta/_journal.json` idx 1, not present on disk) is also
silently skipped by the glob, so the fallback cannot be presented as the
canonical schema path.

**Repair:** repair the journal first (S6/A2), or provide a tested fresh-install
sequence that (a) skips the missing `0001`, (b) excludes the unjournaled
`0002_unique_phone.sql` (its unique constraint is already in
`0002_woozy_valkyrie.sql`), and (c) is explicitly marked "fresh database only".
Do not advertise a destructive loop as an upgrade path.

### C3 — S3: the generated cron secret is not URL-safe

`CRON_SECRET` is generated by Render as a base64 value
(`render.yaml:51-56`), then interpolated into a URL without encoding:

- `render.yaml:92` followup
- `render.yaml:112` reconcile scan
- `render.yaml:132` reconcile sweep

The app reads it with `URLSearchParams.get("key")`
(`src/app/api/cron/followup/route.ts:22-30`,
`src/app/api/cron/reconcile/route.ts:20-28`). In a URL query, `+` is decoded as
a space, so any generated secret containing `+` fails the constant-time
comparison and every cron run returns 401. Standard base64 has `+` in roughly
half of 32-byte values; the `openssl rand -base64 32` example in the guide has
the same problem.

Verified:

```text
secret:  "AbC+dEf/123=="
parsed:  "AbC dEf/123=="
equal:   false
```

**Repair:** use `curl --get --data-urlencode "key=${CRON_SECRET}"` (and
`--data-urlencode "mode=sweep"` for the sweep), or generate a URL-safe/hex
secret. Keep the app's raw comparison as-is.

## WARNING

### W1 — S3: first-deploy health check versus schema migration

`healthCheckPath: /api/health` (`render.yaml:25`) queries the `users` table
(`src/app/api/health/route.ts:8`) and returns 500 until the schema exists. The
guide tells the operator to migrate "while the first build runs"
(`install-render-neon.md:30-33, 92-93`). Render cancels a deploy that does not
pass health checks within 15 minutes, and the guide gives no recovery step for
a cancelled first deploy (run migration, then trigger a manual deploy). The
prerequisites also omit the local clone/`psql`/Node toolchain needed to run the
migration, while the guide claims no app shell is required.

### W2 — S3: repository docs contradict the Neon-only runtime

The new guide correctly says Neon is required (`install-render-neon.md:8-9`),
but the repo still tells users the opposite:

- `README.md:54`: `PostgreSQL | Neon / Render PG / any Postgres`
- `README.md:70`: scripted bootstrap uses `npm run db:push`
- `.env.example:20`: `PostgreSQL connection string (Neon, Render Postgres, Supabase, etc.)`
- `src/db/index.ts:1-10` is `neon-http` only; the guide itself says Render PG /
  RDS / Supabase will not connect (`install-render-neon.md:8-9`).

This is preexisting, but the Render slice is the moment to reconcile it. Update
README and `.env.example` to point at the install guide and to `db:migrate` for
installs.

### W3 — S3: pooled Neon URL is used for schema migrations

The guide tells the operator to copy the pooled (`-pooler`) URL
(`install-render-neon.md:22-24, 47-48`) and then run `db:migrate`/`psql` with
that same URL (`:83-100`). Neon's own pooling guidance is to use a **direct**
connection for schema migrations and `pg_dump`; pooled connections use
transaction mode and do not support session-level state/advisory locks. Use
the direct URL for §3 migrations and the pooled URL for the runtime
`DATABASE_URL`, or verify the chosen migration path against an ephemeral Neon
branch.

### W4 — S1: `idempotencyKey` is part of the frozen contract but is ignored

`src/lib/messaging/types.ts:51` documents
`idempotencyKey → ycloud externalId`, and evidence §6 says the compat pass must
"Add `externalId` pass-through". `sendMessage` never reads the field
(`src/lib/messaging/providers/ycloud.ts:329-360`), and the delegated
`sendText`/`sendImage`/`sendDocument` functions do not accept it. A caller that
sets the key to make retries safe gets a silent no-op and possible duplicate
sends.

**Repair before B1:** thread `externalId` through the existing YCloud senders
and add a test, or remove the promise from the type/comment.

### W5 — S1: `retryable` misclassifies permanent failures

`toSendResult` marks every error except one beginning with `"Missing "` as
retryable (`src/lib/messaging/providers/ycloud.ts:287-293`). Existing YCloud
senders return `YCloud error 400: ...` / `YCloud error 422: ...` for permanent
client errors, so those become `retryable: true`. Conversely, 5xx errors have
already exhausted the sender's own 3-attempt budget before reaching the
adapter. Callers cannot use the flag safely yet.

**Repair:** classify `4xx`/validation/permanent errors as non-retryable, add
tests for 400/500/fetch/missing-credential cases, or document that
`retryable` is advisory only.

### W6 — S1: the new tests are not in the repository's canonical test gate

`npm run test:agents` is an explicit list
(`package.json:12`) and does not include
`src/lib/messaging/provider-contract.test.ts` or
`src/lib/messaging/providers/ycloud.test.ts`. The tests pass when run directly
(31/31), but a normal `test:agents` run will never execute them. S1's ownership
is `src/lib/messaging/**` only, so this is an integration task, not a reason to
edit the slice: wire the files into the test command/CI when cherry-picking.

### W7 — S1: empty `deliveryId` is a legal-looking dedup key

`baseEvent` and the inbound/echo/status fallbacks produce `deliveryId: ""`
when the payload has no event id
(`src/lib/messaging/providers/ycloud.ts:175, 203-204, 238-239`). The contract
defines `deliveryId` as the durable delivery-level dedup key (evidence §4
rule 3). If a future ingress persists it as-is, every id-less event collapses
into the same dedup key. Make empty IDs explicit (skip dedup or reject the
event) and add a fixture without `id`.

### W8 — S2: residual PII and a report that repeats a customer name

The deletion set itself is clean, but the slice's privacy objective is not
complete:

- `docs/repomix-output-adriangmrraa-muzapp.md` embeds the pre-deletion source,
  including the deleted scripts and customer data. The audit report flags it
  (`docs/socialcrm/repo-hygiene-report.md:105`) but leaves it tracked.
- `docs/prueba.txt`, `docs/mirar.txt`, `docs/chat-analysis/segmentos.md`,
  `docs/manual-operativo-mrs-muzzarella.md` and kept scripts still contain the
  customer name/phone (the report lists them at §4.1).
- The new report itself repeats the customer first name at lines 20, 21, 24,
  37, 47 and 171; `AGENTS.md` says never commit customer names.

This is documented as a follow-up, not a reason to revert the deletions, but
redact the report and schedule the residual-PII slice (including a decision on
history rewriting if the files must be erased, not just untracked).

### W9 — S3/S2: `.env.example` is safe but its DB comment is misleading

No secret values are present and the `BUSINESS_OWNER_NAME` fix is correct
(`.env.example:97-99`). However `.env.example:20` still claims Neon, Render
Postgres and Supabase are interchangeable, which contradicts the actual
driver and the new install guide. Fix in the same docs-reconciliation pass as
W2.

## SUGGESTION

- **S1:** Add send-path tests with mocked `sendText`/`sendImage`/`sendDocument`
  (argument mapping, wamid propagation, error mapping). Current tests cover
  validation branches and parsing, not delegation.
- **S1:** Add an echo/status parity test against
  `src/app/api/whatsapp/webhook/route.ts`. The adapter uses
  `message.wamid ?? message.id` for echo `platformMessageId`
  (`providers/ycloud.ts:241`), while the route uses `msg.id`
  (`src/app/api/whatsapp/webhook/route.ts`, echo handler). They match in the
  fixtures but are not pinned by a parity test.
- **S1:** Clarify echo recipient semantics. `normalizeEcho` sets
  `sender.phone` to the business number and leaves the customer only in `raw`
  (`providers/ycloud.ts:242-243`); the frozen event has no recipient field. A
  future pipeline cannot route echoes without reading `raw`.
- **S1:** `resolveMedia` returns a caller-provided `url` without a host check
  (`providers/ycloud.ts:370-374`). The comment says allowlist enforcement is
  downstream in `downloadMedia`; document that contract or validate the host
  here.
- **S2:** Consider deleting or regenerating the stale repomix snapshot in the
  same follow-up instead of leaving a full copy of the removed content.
- **S3:** The `CRON_SECRET` DB-over-env precedence is a trap (the admin UI
  value wins, while cron jobs copy the env value). The guide mentions it in
  troubleshooting; consider removing the duplicate admin field for cron or
  making the precedence explicit in the UI.
- **S3:** Add a first-deploy recovery section: if Render cancels the deploy on
  the health check, run the migration and trigger a manual deploy. Add the
  local Node/`psql` prerequisite or make `db:seed` the supported shell path.
- **S3:** Update `README.md` to link the new install guide rather than keeping a
  second, conflicting Render procedure.

## Evidence and commands run

All commands were run in the existing per-slice worktrees; no source branch was
modified (worktrees remained clean). `node_modules` was already installed.

| Check | Command | Result |
|---|---|---|
| Immutable heads | `git cat-file -t <sha>` for baseline + 3 heads | all `commit` |
| Diff shape | `git diff --stat 400daa1..<head>` | S1 6 files/+1072; S2 51 files/+220/−2160; S3 2 files/+323 |
| Whitespace | `git diff --check 400daa1..<head>` (all three) | clean (exit 0) |
| S1 tests | `node --import tsx --test src/lib/messaging/provider-contract.test.ts src/lib/messaging/providers/ycloud.test.ts` | 31 passed, 0 failed |
| S1 gates | `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:agents` | all pass; `test:agents` does not include the new files |
| S2 gates | `npm run test:agents`, `npm run typecheck`, `npm run lint`, `NODE_OPTIONS=--max-old-space-size=8192 npm run build` | tests 239 (233 pass, 6 skip), typecheck/lint/build pass |
| S2 references | `git grep -n -I -E '<deleted patterns>' <head> -- . ':!docs/repomix...' ':!docs/socialcrm/repo-hygiene-report.md' ':!docs/socialcrm/execution-control.md' ':!docs/socialcrm/self-hosted-product-roadmap.md'` | no live references |
| S2 binary risk | build after deleting 11 root images | passes; no source/import references to the images |
| S3 schema | YAML parse + JSON Schema `https://render.com/schema/render.yaml.json` | `VALID against render schema` |
| S3 build input | `npm ci --dry-run --ignore-scripts` | exit 0 (lockfile in sync) |
| S3 cron encoding | Node `new URL('...?key=AbC+dEf/123==').searchParams.get('key')` | `AbC dEf/123==` (mismatch) |
| S3 neon-http | dummy `DATABASE_URL` + `db.transaction(...)` | throws `No transactions support in neon-http driver` |
| S3 migration statics | journal/SQL cross-check | `0001` journaled but missing; `0002_unique_phone.sql` unjournaled; loop order fails |

## Integration order

1. **S2 repository hygiene** — independent, no runtime code; integrate first so
   the audit/journal context is on `main`.
2. **S1 messaging core** — additive, inert, no existing files touched; safe to
   integrate after or before S2. Wire the new tests into the integration/CI
   test command in the same integration step.
3. **S3 Render blueprint** — **blocked**. Integrate only after C1–C3 are fixed
   and W1–W3 are reconciled; otherwise the install guide ships a path that
   cannot complete.

There is no file overlap among the three slices, so S1/S2 order is a
preference, not a dependency. S3 must be last because its guide depends on the
hygiene/journal context and the runtime fixes.

## Required repair tasks before integration

| ID | Slice | Priority | Task |
|---|---|---|---|
| R1 | S3 | CRITICAL | Make `/setup` work without neon-http transactions/advisory locks, or switch the guide to `db:seed` and document the shell prerequisite. Remove the "race-safe advisory lock" claim. |
| R2 | S3 | CRITICAL | Replace the `drizzle/*.sql` fallback with a tested fresh-DB sequence (skip missing `0001`, exclude `0002_unique_phone.sql`) or repair the journal first. Do not present it as an upgrade path. |
| R3 | S3 | CRITICAL | URL-encode `CRON_SECRET` in all three cron commands, or generate a URL-safe secret. |
| R4 | S3 | WARNING | Document first-deploy health-check recovery and add the migration prerequisites; use a direct Neon URL for migrations and a pooled URL for runtime. |
| R5 | S3 | WARNING | Reconcile `README.md` and `.env.example` with the Neon-only / `db:migrate` reality. |
| R6 | S1 | WARNING | Implement `idempotencyKey → externalId` or remove the contract claim; classify `retryable` correctly; handle empty `deliveryId`. |
| R7 | S1 | WARNING | Wire the new messaging tests into the canonical test command/CI during integration. |
| R8 | S2 | WARNING | Redact the customer name from the audit report and schedule the residual-PII cleanup (repomix snapshot, `docs/*.txt`, kept scripts). |
| R9 | all | SUGGESTION | Add send-path/echo-parity tests; update the install guide's wording and recovery steps. |

## Review conclusion

S1 and S2 are safe to integrate as independent work units after the listed
warnings are triaged. S3 is **not** safe to ship as an install guide: the
schema path fails, `/setup` throws on the configured driver, and the cron
secret is unreliable. The Render blueprint file itself validates, but the
slice's acceptance criterion "guide covers provision → migrate → /setup →
config → webhooks → verify" is not met until R1–R3 are closed.
