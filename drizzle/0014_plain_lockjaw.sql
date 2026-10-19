ALTER TABLE "agent_config" ADD COLUMN "channel" "channel";--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "channel_account_id" integer;--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_config_channel_account_uq" ON "agent_config" USING btree ("channel_account_id") WHERE channel_account_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_config_channel_scope_uq" ON "agent_config" USING btree ("channel") WHERE channel is not null and channel_account_id is null;