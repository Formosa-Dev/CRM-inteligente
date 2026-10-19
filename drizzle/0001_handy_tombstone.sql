ALTER TABLE "agent_config" ADD COLUMN "telegram_bot_token" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "telegram_chat_id" varchar(50);--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "telegram_webhook_token" varchar(100);--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "telegram_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "whatsapp_system_prompt" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "whatsapp_instructions" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "whatsapp_promociones" text;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN "whatsapp_zonas_delivery" jsonb DEFAULT '[{"zona":"centro","disponible":true,"tiempo":"20-30 min","costo":0},{"zona":"norte","disponible":true,"tiempo":"25-35 min","costo":0},{"zona":"sur","disponible":true,"tiempo":"30-40 min","costo":0}]'::jsonb;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb;