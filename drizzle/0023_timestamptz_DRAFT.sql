-- 0023_timestamptz_DRAFT.sql — DRAFT, NOT APPLIED, NOT IN THE JOURNAL.
--
-- Audit A-47: legacy tables keep naive `timestamp` columns while newer
-- tables use `timestamptz`. Reads/compares become session-TimeZone
-- dependent. This draft converts them assuming existing values were
-- written as UTC (see docs/socialcrm/migration-safety.md BEFORE running).
--
-- `USING col AT TIME ZONE 'UTC'` interprets each naive value AS UTC and
-- stores the equivalent timestamptz instant.
--
-- Columns converted:
--   users.created_at / updated_at        (schema.ts:75-76)
--   products.created_at / updated_at     (schema.ts:97-98)
--   agent_config.updated_at              (schema.ts:203 — naive, missed by
--                                         the original finding list)
--   conversations.created_at / updated_at(schema.ts:317-318)
--   leads.created_at                     (schema.ts:433)
--
-- Schema.ts MUST be updated in the same deploy (`{ withTimezone: true }`)
-- or Drizzle will keep emitting naive timestamps on write.

BEGIN;

ALTER TABLE users
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE products
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE agent_config
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE conversations
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC',
  ALTER COLUMN updated_at TYPE timestamptz USING updated_at AT TIME ZONE 'UTC';

ALTER TABLE leads
  ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';

COMMIT;

-- Rollback shape (only valid BEFORE new timestamptz writes accumulate):
--   ALTER TABLE <t> ALTER COLUMN <c> TYPE timestamp
--     USING <c> AT TIME ZONE 'UTC';
-- See docs/socialcrm/migration-safety.md for the full checklist.
