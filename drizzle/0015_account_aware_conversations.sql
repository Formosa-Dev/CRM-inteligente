-- S17: account-aware conversation identity (additive, preflighted).
-- Identity becomes (channel, channel_account_id, canonical external user id)
-- for bound rows; legacy null-account rows keep (channel, canonical id).
-- A preflight aborts BEFORE any DDL when existing rows would collide under
-- canonical (+/digits) normalization, so a failed migration never leaves a
-- partially rewritten identity space.
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
        WHEN channel IN ('whatsapp', 'sms')
          OR (channel = 'telegram' AND external_user_id ~ '^[+0-9() .-]+$')
          THEN regexp_replace(external_user_id, '\D', '', 'g')
        ELSE btrim(external_user_id)
      END AS identity_key
    FROM conversations
    WHERE external_user_id IS NOT NULL
  ) normalised
  GROUP BY channel, channel_account_id, identity_key
  HAVING count(*) > 1
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'conversation identity backfill collision: channel=%, account=%, key=% — resolve duplicates manually before applying',
      duplicate.channel, duplicate.channel_account_id, duplicate.identity_key;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_user_id_normalized" varchar(255);--> statement-breakpoint
UPDATE "conversations"
SET "external_user_id_normalized" = CASE
  WHEN "channel" IN ('whatsapp', 'sms')
    OR ("channel" = 'telegram' AND "external_user_id" ~ '^[+0-9() .-]+$')
    THEN regexp_replace("external_user_id", '\D', '', 'g')
  ELSE btrim("external_user_id")
END
WHERE "external_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_account_external_uq" ON "conversations" USING btree ("channel","channel_account_id","external_user_id_normalized") WHERE external_user_id_normalized is not null and channel_account_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_legacy_external_uq" ON "conversations" USING btree ("channel","external_user_id_normalized") WHERE external_user_id_normalized is not null and channel_account_id is null;--> statement-breakpoint
CREATE INDEX "conversations_channel_identity_idx" ON "conversations" USING btree ("channel","external_user_id_normalized");--> statement-breakpoint
DROP INDEX "conversations_channel_external_user_uq";
