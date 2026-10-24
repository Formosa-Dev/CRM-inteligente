-- S0 — Schema foundation (SocialCRM channel/provider port; see
-- docs/port-channels-delta.md Area 9). Additive only, creates no rows.
--
-- 1. agent_inbound_jobs — durable inbound-turn queue (AH `0012` port,
--    varchar/uuid ids → integer serials). Partial-unique index keeps at most
--    one LIVE (queued/running) job per dedup_key; 'dead' is the DLQ. Code
--    treats a missing table (42P01) as "queue disabled" until this lands.
-- 2. agent_config *Enc columns — per-provider AES-GCM credentials for the
--    scoped credential chain (S2). telegram pair already exists
--    (telegram_bot_token/telegram_webhook_token); ycloud_api_key stays the
--    legacy plaintext field.
-- 3. chat_messages sender columns — nullable/honest-attribution set.
--    `role` stays populated (dual-write) during the transition.
--    content_type extends AH's enum with audio/video (SC's richer media).
-- 4. wa_template_fallback — AH stores it in a `settings` k/v table; SC has
--    none, so agent_config (the existing scoped config surface) is its home.

CREATE TYPE "public"."message_content_type" AS ENUM('text', 'image', 'audio', 'document', 'video', 'system');--> statement-breakpoint
CREATE TYPE "public"."message_delivery_state" AS ENUM('received', 'queued', 'sent', 'failed', 'imported');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_sender_kind" AS ENUM('customer', 'agent', 'operator');--> statement-breakpoint
CREATE TABLE "agent_inbound_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"dedup_key" text NOT NULL,
	"channel" "channel" NOT NULL,
	"channel_account_id" integer,
	"conversation_id" integer NOT NULL,
	"conversation_key" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_inbound_jobs_status_check" CHECK ("agent_inbound_jobs"."status" in ('queued', 'running', 'done', 'dead'))
);
--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "zernio_api_key_enc" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "zernio_webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "kapso_api_key_enc" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "kapso_webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "ycloud_webhook_secret_enc" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "wa_template_fallback" jsonb;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "direction" "message_direction";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "sender_kind" "message_sender_kind";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "sender_ref" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "delivery_state" "message_delivery_state";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "provider_conversation_id" text;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "content_type" "message_content_type";--> statement-breakpoint
ALTER TABLE "agent_inbound_jobs" ADD CONSTRAINT "agent_inbound_jobs_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_inbound_jobs" ADD CONSTRAINT "agent_inbound_jobs_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_inbound_jobs_live_dedup_uq" ON "agent_inbound_jobs" USING btree ("dedup_key") WHERE "agent_inbound_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "agent_inbound_jobs_claim_idx" ON "agent_inbound_jobs" USING btree ("run_after") WHERE "agent_inbound_jobs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "agent_inbound_jobs_status_created_idx" ON "agent_inbound_jobs" USING btree ("status","created_at");