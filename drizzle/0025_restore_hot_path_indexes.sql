-- Custom SQL migration file, put your code below! --
-- 0022 originally had an out-of-order journal timestamp. Drizzle can skip an
-- entry whose timestamp is older than an already-applied migration, so repeat
-- the additive indexes defensively for existing deployments. New installs run
-- 0022 first; IF NOT EXISTS makes this migration harmless in both cases.
CREATE INDEX IF NOT EXISTS "attachments_lead_idx" ON "attachments" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_conversation_idx" ON "attachments" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_conversation_created_idx" ON "chat_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_channel_account_idx" ON "conversations" USING btree ("channel","channel_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_channel_account_idx" ON "leads" USING btree ("channel_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "leads_conversation_idx" ON "leads" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "order_context_items_conversation_status_idx" ON "order_context_items" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_phone_number_idx" ON "orders" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_lead_id_idx" ON "orders" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_followup_due_idx" ON "orders" USING btree ("delivered_at") WHERE status = 'delivered' AND followup_sent = false;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_created_idx" ON "orders" USING btree ("created_at");
