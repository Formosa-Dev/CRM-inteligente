-- A-12: swap the global platform_message_id unique index for an
-- account-scoped one. The old index deduplicated across the whole install,
-- so dual-provider/dual-account deliveries of the same platform id dropped
-- every copy but the first. The new index partitions by
-- coalesce(channel_account_id, -1): each account dedups within itself and
-- legacy NULL-account rows keep their own (-1) partition, preserving the
-- pre-migration semantics for unbound messages. Same swap as 0019 did for
-- channel_events.
DROP INDEX "idx_chat_messages_platform_id";--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_messages_platform_id" ON "chat_messages" USING btree (coalesce("channel_account_id", -1),"platform_message_id");
