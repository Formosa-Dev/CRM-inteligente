-- Hot-path indexes (audit A-28/A-29/A-30). All additive, all btree.
--
-- orders: ZERO indexes before this migration — every hot filter seq-scanned.
--   phone_number  → customer order lookups (order tools, lead-utils)
--   lead_id       → orders↔leads joins (scoped queries, deleteLeadCascade)
--   (delivered_at) WHERE delivered+!followup_sent → followup cron predicate
--   (status, created_at) → kitchen queue + per-status analytics windows
--   (created_at)  → status-agnostic date ranges (analytics, sales coach, cash)
--
-- chat_messages(conversation_id, created_at): history reads are
--   `WHERE conversation_id ORDER BY created_at` — the hottest join.
-- conversations(channel, channel_account_id): inbox account filter
--   (gap documented in src/lib/conversations/filters.ts).
-- leads(channel_account_id / conversation_id): scoped joins + lead↔conv.
-- attachments(lead_id / conversation_id / message_id): all three FKs were
--   unindexed; lead_id is also hit by deleteLeadCascade.
-- order_context_items(conversation_id, status): every cart read/write.
CREATE INDEX "attachments_lead_idx" ON "attachments" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "attachments_conversation_idx" ON "attachments" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "chat_messages_conversation_created_idx" ON "chat_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "conversations_channel_account_idx" ON "conversations" USING btree ("channel","channel_account_id");--> statement-breakpoint
CREATE INDEX "leads_channel_account_idx" ON "leads" USING btree ("channel_account_id");--> statement-breakpoint
CREATE INDEX "leads_conversation_idx" ON "leads" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "order_context_items_conversation_status_idx" ON "order_context_items" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE INDEX "orders_phone_number_idx" ON "orders" USING btree ("phone_number");--> statement-breakpoint
CREATE INDEX "orders_lead_id_idx" ON "orders" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "orders_followup_due_idx" ON "orders" USING btree ("delivered_at") WHERE status = 'delivered' AND followup_sent = false;--> statement-breakpoint
CREATE INDEX "orders_status_created_idx" ON "orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");