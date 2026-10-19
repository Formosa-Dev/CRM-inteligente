CREATE TABLE "channel_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"provider" text NOT NULL,
	"channel" "channel",
	"channel_account_id" integer,
	"provider_account_id" text,
	"delivery_id" text NOT NULL,
	"platform_message_id" text,
	"kind" text NOT NULL,
	"direction" text NOT NULL,
	"status" text,
	"event_timestamp" timestamp with time zone,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "channel_events" ADD CONSTRAINT "channel_events_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_events_provider_delivery_uq" ON "channel_events" USING btree ("provider","delivery_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_events_provider_platform_uq" ON "channel_events" USING btree ("provider","platform_message_id","kind","status") WHERE platform_message_id is not null and status is not null;--> statement-breakpoint
CREATE INDEX "channel_events_account_created_idx" ON "channel_events" USING btree ("channel_account_id","created_at");--> statement-breakpoint
CREATE INDEX "channel_events_provider_platform_idx" ON "channel_events" USING btree ("provider","platform_message_id");