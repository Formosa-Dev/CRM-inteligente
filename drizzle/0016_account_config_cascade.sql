-- S18: account-scoped agent_config rows are deleted with their account.
-- The previous detach behavior cleared channel_account_id while leaving
-- channel set, which could collide with agent_config_channel_scope_uq.
-- CASCADE removes the scoped row atomically; channel-scoped/global rows are
-- unaffected because they carry no channel_account_id.
ALTER TABLE "agent_config" DROP CONSTRAINT "agent_config_channel_account_id_channel_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "agent_config" ADD CONSTRAINT "agent_config_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;