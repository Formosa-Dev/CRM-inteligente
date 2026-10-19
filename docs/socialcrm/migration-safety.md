# SocialCRM — Migration Safety

Status: canonical ops reference for the Drizzle migration layer. Written by the
S6 / A2 journal-repair slice (2026-10-19). Supersedes the "journal broken" note
in `execution-control.md` §2.7 — the journal is repaired as of this commit.

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

The full 13-entry journal is preserved. `drizzle-kit generate` on the repaired
chain reports "No schema changes, nothing to migrate" — i.e. the journaled
chain's end-state is provably identical to `src/db/schema.ts`.

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
- `_journal.json` unchanged: 13 entries, original tags/whens preserved.
  `drizzle.config.ts` unchanged.

## 3. Canonical migrate path

Fresh database (new install / ephemeral Neon branch):

```bash
DATABASE_URL=... npm run db:migrate   # drizzle-kit migrate
```

Replays `0000` → `0012` and produces exactly the schema in
`src/db/schema.ts`. The app never migrates at boot (`src/db/index.ts` is a
lazy query proxy); migration is always an ops step.

Schema changes from here on: edit `src/db/schema.ts`, `npm run db:generate`,
review the emitted SQL, commit it, apply with `npm run db:migrate`. Do not use
`db:push` on a database you care about — push bypasses the journal entirely.

## 4. Existing databases

`drizzle-orm`'s migrator skips journaled entries whose `when` is ≤ the latest
`created_at` in `drizzle.__drizzle_migrations` (it never compares hashes for
already-applied entries). All 13 entries keep their original `when` values, so:

- A database that genuinely ran the old chain has `created_at` ≥
  `1792000001000` (idx 12's `when`) → `db:migrate` is a no-op. Safe.
- A database maintained only via `db:push` has an empty/absent migrations
  table → `db:migrate` would attempt the full chain and fail on existing
  objects. If the DB is already at the current schema, mark the journal
  applied once:

  ```sql
  CREATE SCHEMA IF NOT EXISTS drizzle;
  CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY,
    hash text NOT NULL,
    created_at bigint
  );
  INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")
  VALUES ('seeded-after-journal-repair', 1792000001000);
  ```

  (`hash` is informational for skipping; `created_at` must be ≥ the last
  journal `when` = `1792000001000`. Future generated migrations get newer
  `when` values and apply normally.)
- Precondition for that seed: the DB must actually match `src/db/schema.ts`.
  If unsure, run `drizzle-kit push --verbose` to preview the residual diff and
  abort before confirming; reconcile real drift first.

## 5. Emergency fresh-DB sequence (no drizzle-kit)

Every SQL file replays under plain `psql` — `--> statement-breakpoint` markers
are SQL line comments. Journal order = filename order here:

```bash
for f in drizzle/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
psql "$DATABASE_URL" -c "
  CREATE SCHEMA IF NOT EXISTS drizzle;
  CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
    id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);
  INSERT INTO drizzle.__drizzle_migrations (\"hash\", \"created_at\")
  VALUES ('psql-bootstrapped', 1792000001000);"
```

Then `npm run db:migrate` is a no-op until the next generated migration.

## 6. Verification performed (static — no real DB touched)

- `drizzle-kit generate` → "No schema changes, nothing to migrate" (last
  snapshot == `src/db/schema.ts`; valid `prevId` chain).
- `drizzle-kit check` → clean.
- Snapshot synthesis cross-verified: `s3→s4`, `s7→s8`, `s12→current` diffs all
  equal the expected migration effects, nothing more.
- Journal/SQL/snapshot cross-check script: 13 journaled entries ↔ 13 `.sql`
  ↔ 13 `_snapshot.json`, contiguous idx, monotonic `when`, tag==prefix.
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
- A database that ran *part* of the old chain but is not at the schema
  end-state has no automated path: reconcile to `src/db/schema.ts` manually,
  then seed per §4.
- `src/lib/agent-consistency.test.ts` reads two migration files by name
  (`0003_session_memory.sql`, `0010_peaceful_rocket_racer.sql`) — future
  migration cleanup must keep those files or update the test (owned outside
  this slice).
