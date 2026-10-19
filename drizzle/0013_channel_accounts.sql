-- S11: channel_accounts + multi-identity columns (additive only).
-- New table `channel_accounts` (unique on provider+provider_account_id),
-- `channel` enum gains instagram/facebook/sms/reddit, conversations/leads/
-- chat_messages gain channel_account_id + external identity columns.
-- `whatsapp_id`/`leads.phone` drop NOT NULL — their UNIQUE constraints stay
-- (Postgres allows multiple NULLs, preserving legacy dedup); identity-level
-- uniqueness moves to the partial unique indexes on (channel, external_user_id)
-- WHERE external_user_id IS NOT NULL.
ALTER TYPE "public"."channel" ADD VALUE 'instagram';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE 'facebook';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE 'sms';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE 'reddit';--> statement-breakpoint
CREATE TABLE "channel_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"provider" text NOT NULL,
	"channel" "channel" NOT NULL,
	"provider_account_id" text NOT NULL,
	"sender_address" text NOT NULL,
	"display_name" text,
	"credentials_ref" text,
	"agent_config_id" integer,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "whatsapp_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "leads" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "channel_account_id" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "channel_account_id" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_thread_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "channel" "channel";--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "external_user_id" text;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "channel_account_id" integer;--> statement-breakpoint
ALTER TABLE "channel_accounts" ADD CONSTRAINT "channel_accounts_agent_config_id_agent_config_id_fk" FOREIGN KEY ("agent_config_id") REFERENCES "public"."agent_config"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_accounts_provider_account_uq" ON "channel_accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_channel_external_user_uq" ON "conversations" USING btree ("channel","external_user_id") WHERE external_user_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "leads_channel_external_user_uq" ON "leads" USING btree ("channel","external_user_id") WHERE external_user_id is not null;