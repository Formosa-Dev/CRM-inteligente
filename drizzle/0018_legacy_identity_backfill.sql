-- Legacy identity backfill + JS-aligned canonicalization (additive).
--
-- 1. Rows created before `external_user_id` existed only carry `whatsapp_id`.
--    Backfill the missing identity so the account-aware lookup stops missing
--    them (and insert conflicts on the legacy WhatsApp unique key).
-- 2. `0015` normalized with `btrim` (spaces only) while the runtime uses
--    JS `trim()` (tabs/newlines included). Re-normalize every row with the
--    same whitespace + phone rules.
--
-- Preflight aborts BEFORE any data update when the new canonical identities
-- would collide, so a failed run never leaves a partially rewritten space.
DO $$
DECLARE
  duplicate record;
BEGIN
  SELECT channel, channel_account_id, identity_key INTO duplicate
  FROM (
    SELECT
      channel,
      channel_account_id,
      CASE
        WHEN COALESCE(
          external_user_id,
          CASE
            WHEN channel = 'telegram' AND whatsapp_id LIKE 'tg_%'
              THEN substr(whatsapp_id, 4)
            ELSE whatsapp_id
          END
        ) IS NULL THEN NULL
        WHEN channel IN ('whatsapp', 'sms')
          OR (
            channel = 'telegram'
            AND regexp_replace(
              COALESCE(
                external_user_id,
                CASE
                  WHEN whatsapp_id LIKE 'tg_%' THEN substr(whatsapp_id, 4)
                  ELSE whatsapp_id
                END
              ),
              '^\s+|\s+$',
              '',
              'g'
            ) ~ '^[+0-9() .-]+$'
          )
          THEN regexp_replace(
            COALESCE(
              external_user_id,
              CASE
                WHEN channel = 'telegram' AND whatsapp_id LIKE 'tg_%'
                  THEN substr(whatsapp_id, 4)
                ELSE whatsapp_id
              END
            ),
            '\D',
            '',
            'g'
          )
        ELSE regexp_replace(
          COALESCE(
            external_user_id,
            CASE
              WHEN channel = 'telegram' AND whatsapp_id LIKE 'tg_%'
                THEN substr(whatsapp_id, 4)
              ELSE whatsapp_id
            END
          ),
          '^\s+|\s+$',
          '',
          'g'
        )
      END AS identity_key
    FROM conversations
  ) normalised
  WHERE identity_key IS NOT NULL
  GROUP BY channel, channel_account_id, identity_key
  HAVING count(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'conversation identity backfill collision: channel=%, account=%, key=% — resolve duplicates manually before applying',
      duplicate.channel, duplicate.channel_account_id, duplicate.identity_key;
  END IF;
END $$;--> statement-breakpoint

UPDATE "conversations"
SET "external_user_id" = CASE
  WHEN "channel" = 'telegram' AND "whatsapp_id" LIKE 'tg_%'
    THEN substr("whatsapp_id", 4)
  ELSE "whatsapp_id"
END
WHERE "external_user_id" IS NULL
  AND "whatsapp_id" IS NOT NULL;--> statement-breakpoint

-- Clear changed keys first (NULL is allowed by the partial uniques) so a
-- single-statement rewrite can never hit a transient unique violation.
UPDATE "conversations"
SET "external_user_id_normalized" = NULL
WHERE "external_user_id" IS NOT NULL
  AND "external_user_id_normalized" IS DISTINCT FROM (
    CASE
      WHEN "channel" IN ('whatsapp', 'sms')
        OR (
          "channel" = 'telegram'
          AND regexp_replace("external_user_id", '^\s+|\s+$', '', 'g')
            ~ '^[+0-9() .-]+$'
        )
        THEN regexp_replace("external_user_id", '\D', '', 'g')
      ELSE regexp_replace("external_user_id", '^\s+|\s+$', '', 'g')
    END
  );--> statement-breakpoint

UPDATE "conversations"
SET "external_user_id_normalized" = CASE
  WHEN "channel" IN ('whatsapp', 'sms')
    OR (
      "channel" = 'telegram'
      AND regexp_replace("external_user_id", '^\s+|\s+$', '', 'g')
        ~ '^[+0-9() .-]+$'
    )
    THEN regexp_replace("external_user_id", '\D', '', 'g')
  ELSE regexp_replace("external_user_id", '^\s+|\s+$', '', 'g')
END
WHERE "external_user_id" IS NOT NULL
  AND "external_user_id_normalized" IS NULL;--> statement-breakpoint
