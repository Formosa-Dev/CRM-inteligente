# SocialCRM — Migration Safety

Status: canonical ops reference for the Drizzle migration layer. The S6 / A2
repair reconstructed the legacy chain; the 2026-10-20 follow-up added an
idempotent index recovery migration for 0022's historical timestamp inversion.
This supersedes every earlier "journal broken" note.

## 1. What was broken

Audited in `repo-hygiene-report.md` §3 and `slices-review.md` C2. The tracked
`drizzle/meta/_journal.json` could not replay the schema on a fresh database:

1. `0001_handy_tombstone` was journaled (idx 1) but
   `drizzle/0001_handy_tombstone.sql` did not exist — it was never committed to
   any branch. `drizzle-kit migrate` aborts on a fresh DB because the migrator
   `readFileSync`s every journaled file *before* checking apply state.
2. `drizzle/0002_unique_phone.sql` existed on disk but was never journaled —
   an orphan the migrator would never apply. It was also destructive (deletes
   duplicate `leads`, and despite its comment it kept the *oldest* row via
   `MIN(id)`, not the most recent) and redundant: its `leads_phone_unique`
   constraint already exists in the journaled `0002_woozy_valkyrie.sql:121`.
3. Six journaled entries (idx 0, 3, 6, 7, 11, 12) had no
   `drizzle/meta/*_snapshot.json`, so `generate`'s diff base and snapshot
   ancestry were broken (drizzle-kit also enforces a linear `prevId` chain).
4. `git history` showed snapshots were committed then bulk-deleted
   (`89d8d33`), and the working journal was re-journaled later — the surviving
   half of each pair was scattered.

## 2. What changed (reconstruction, not consolidation)

The historical 13-entry chain was reconstructed and the current journal now
continues through `0025_restore_hot_path_indexes`. `drizzle-kit check` and
`drizzle-kit generate` validate the current journal/snapshot chain against
`src/db/schema.ts`.

- **Recreated `drizzle/0001_handy_tombstone.sql`** — content derived
  byte-exactly from the surviving state diff between `0000_snapshot` (recovered
  from git commit `afda946`) and the real `0001_snapshot`: ten `ADD COLUMN`s
  (`agent_config.telegram_*`, `whatsapp_system_prompt`,
  `whatsapp_instructions`, `whatsapp_promociones`, `whatsapp_zonas_delivery`;
  `leads.tags`; `orders.tags`). These were *migrated* columns, not push-drift —
  the file was simply lost.
- **Removed `drizzle/0002_unique_phone.sql`** — unjournaled, destructive,
  redundant (constraint covered by `0002_woozy_valkyrie`). Its dedupe intent is
  documented here for the record; if a DB ever needs that cleanup it is a
  reviewed manual op, not a migration.
- **`meta/0000_snapshot.json`**: restored verbatim from git `afda946` (journal
  `when` matches — it is the genuine artifact; the current `0000` SQL differs
  from that commit only by line endings).
- **`meta/0003_snapshot.json`**: synthesized as `0002` state + the three
  session tables + seven session enums (nodes lifted from the tool-generated
  current-schema snapshot). Verified: diff(`0003`→real `0004`) = exactly the
  12 business/AI columns `0004` adds — nothing else.
- **`meta/0006_snapshot.json`**: `0005` state + `alcohol`,`empanadas` in
  `product_category` and `product_line`.
- **`meta/0007_snapshot.json`**: `0006` state + `web_order_redirect_enabled`,
  `web_order_redirect_message` (nodes lifted from real `0008`). Verified:
  diff(`0007`→real `0008`) = exactly `0008`'s additions.
- **`meta/0011_snapshot.json`**: `0010` state + `pizzas` in both enums.
- **`meta/0012_snapshot.json`**: `0011` state − `products.line` −
  `product_line` enum. Verified: deep-equal to a fresh
  `drizzle-kit generate` snapshot of `src/db/schema.ts` (zero diff).
- **`prevId` relinked** on all snapshots to a strict linear chain matching
  journal order (real snapshots `0001`/`0004`/`0008` had `prevId` pointing at
  the zero sentinel or skipping missing files — a repair, not a rewrite of
  schema content).
- `_journal.json` retains 0022's historical timestamp inversion. Changing an
  already-published migration timestamp would make a deployment paused after
  0022 re-run that non-idempotent migration, so it is not safe to rewrite.
  Drizzle Kit reports this as a known warning.
- `0025_restore_hot_path_indexes.sql` repeats 0022's additive indexes with
  `CREATE INDEX IF NOT EXISTS`, so databases that previously skipped 0022
  repair themselves on the next `db:migrate`.

## 3. Canonical migrate path

Fresh database (new install / ephemeral Neon branch):

```bash
DATABASE_URL=... npm run db:migrate   # drizzle-kit migrate
```

Replays journaled migrations `0000` → `0025` and produces exactly the
schema in `src/db/schema.ts`. The app never migrates at boot
(`src/db/index.ts` is a lazy query proxy); migration is always an ops step.

Schema changes from here on: edit `src/db/schema.ts`, `npm run db:generate`,
review the emitted SQL, commit it, apply with `npm run db:migrate`. Do not use
`db:push` on a database you care about — push bypasses the journal entirely.

## 4. Existing databases

- A database that was migrated normally can run `npm run db:migrate`. If it
  ever skipped 0022 because of the former timestamp inversion, 0025 safely
  creates the missing hot-path indexes with `IF NOT EXISTS`.
- A database maintained only with `db:push` has no trustworthy Drizzle history.
  Do **not** insert a synthetic catch-all migration marker and do **not** replay
  a glob of SQL files. First compare it to `src/db/schema.ts` on a staging
  branch, reconcile real drift, and record a reviewed migration baseline before
  any production change.
- A database that ran only part of the old chain likewise needs a reviewed,
  database-specific reconciliation. There is no safe generic SQL shortcut.

## 5. No manual fresh-DB fallback

Use `npm run db:migrate` for every fresh installation. Do not run
`drizzle/*.sql` with a shell glob: the directory contains the deliberately
unjournaled `0023_timestamptz_DRAFT.sql`, and manual execution does not create
Drizzle's migration records.

## 6. Verification performed (static — no real DB touched)

- `drizzle-kit generate` → "No schema changes, nothing to migrate" (last
  snapshot == `src/db/schema.ts`; valid `prevId` chain).
- `drizzle-kit check` → passes, with the expected warning about 0022's
  preserved historical timestamp inversion.
- Snapshot synthesis cross-verified: `s3→s4`, `s7→s8`, `s12→current` diffs all
  equal the expected migration effects, nothing more.
- `drizzle-kit check` verifies the contiguous journal and snapshot ancestry;
  0022's known timestamp warning remains documented above. 0025 is a custom
  additive migration, intentionally without a schema delta.
- `npm run test:agents` (233 pass, incl. the two tests that read
  `drizzle/0003_session_memory.sql` and `drizzle/0010_peaceful_rocket_racer.sql`
  as fixtures), `npm run typecheck`, `npm run lint`, `npm run build` — all green.

## 7. Residual risks

- `0001_handy_tombstone.sql` is reconstructed from the `0000→0001` snapshot
  diff; the produced schema state is exact, but the original file's bytes (and
  thus its stored hash) are lost forever. Harmless for skipping (migrator uses
  `created_at` ordering), noted for audit completeness.
- Snapshots `0003`, `0006`, `0007`, `0011`, `0012` are synthesized artifacts —
  schema-state verified against adjacent real snapshots, but not byte-products
  of a historical `generate`. This only matters for archaeology (`squash`/`up`);
  `generate`/`migrate`/`check` are fully functional.
- A database that ran only part of the old chain has no automated path:
  reconcile it to `src/db/schema.ts` in staging before any production change.
- `0015_account_aware_conversations.sql` aborts (before DDL) when existing
  conversations collide under `+/digits` canonicalization; resolve the listed
  duplicates and re-run `db:migrate`.
- `0016_account_config_cascade.sql` replaces the unsafe `SET NULL` FK with
  `CASCADE` (account deletion removes its scoped config row).
- `0017_channel_events.sql` adds durable, idempotent status/lifecycle events.
- `src/lib/agent-consistency.test.ts` reads two migration files by name
  (`0003_session_memory.sql`, `0010_peaceful_rocket_racer.sql`) — future
  migration cleanup must keep those files or update the test (owned outside
  this slice).

## 8. Pending DRAFT — A-47: naive `timestamp` → `timestamptz`

`drizzle/0023_timestamptz_DRAFT.sql` is **not journaled and not applied** —
it exists for review + staging rehearsal only.

### What it converts

| Table | Columns |
| --- | --- |
| `users` | `created_at`, `updated_at` |
| `products` | `created_at`, `updated_at` |
| `agent_config` | `updated_at` (naive, missed by the finding's column list) |
| `conversations` | `created_at`, `updated_at` |
| `leads` | `created_at` |

`ALTER COLUMN ... TYPE timestamptz USING <col> AT TIME ZONE 'UTC'` reads each
naive value **as if it were UTC** — the pinned `'UTC'` is deliberate, it does
not defer to the session timezone.

### Which timezone were existing rows probably written in?

Almost certainly **UTC** — but verify, don't trust:

- `defaultNow()` is server-side and Neon clusters default to `TimeZone=UTC`;
  JS `Date` writes through `neon-http` serialize as UTC instants.
- The risk: anything written by a session with a non-UTC `TimeZone` (e.g. a
  manual `psql` session in `America/Argentina/Cordoba`) stored local
  wall-clock; converting as UTC shifts those rows by +3h.

### Verify on staging BEFORE activating

1. `SHOW TimeZone;` on the production DB — confirm UTC (or record the real
   value and adjust the `AT TIME ZONE` argument).
2. Sanity-check adjacent columns: `conversations.created_at` vs
   `last_message_at` (timestamptz) written at the same moment, or
   `leads.created_at` vs `lead_identities.created_at`. A consistent ~3h
   offset = Argentina wall-clock values, not UTC.
3. Exercise the TZ-sensitive read paths (`toolsManagement.ts`-style day
   filters, followup cron windows) on staging copies.
4. Apply in low traffic: each `ALTER TYPE` rewrites the column under an
   `ACCESS EXCLUSIVE` lock. The draft wraps all five tables in one
   `BEGIN/COMMIT` — keep it that way.
5. Ship the matching `src/db/schema.ts` change (`{ withTimezone: true }`)
   **in the same deploy** — otherwise Drizzle keeps writing naive values
   that Postgres re-coerces via session TZ, recreating the bug.

### Rollback shape

Only clean **before** new timestamptz writes accumulate. Per column:

```sql
ALTER TABLE <table>
  ALTER COLUMN <col> TYPE timestamp
  USING <col> AT TIME ZONE 'UTC';
```

Stores the UTC wall-clock of each instant — identical to pre-migration
state iff the UTC assumption held. Rows written while the column was
timestamptz lose their TZ marker; if any exist, decide per-table whether
they were authored in UTC or local time — there is no automatic way back.
