DO $$ BEGIN
	CREATE TYPE "public"."reconcile_status" AS ENUM('detected', 'needs_info', 'loaded', 'dismissed');
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
ALTER TYPE "public"."product_category" ADD VALUE IF NOT EXISTS 'alcohol';--> statement-breakpoint
ALTER TYPE "public"."product_category" ADD VALUE IF NOT EXISTS 'empanadas';--> statement-breakpoint
ALTER TYPE "public"."product_line" ADD VALUE IF NOT EXISTS 'alcohol';--> statement-breakpoint
ALTER TYPE "public"."product_line" ADD VALUE IF NOT EXISTS 'empanadas';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" varchar(120) NOT NULL,
	"type" varchar(30) DEFAULT 'rule' NOT NULL,
	"content" text NOT NULL,
	"source" varchar(30) DEFAULT 'admin' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconcile_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"conversation_id" integer,
	"kind" varchar(30) DEFAULT 'order' NOT NULL,
	"summary" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"status" "reconcile_status" DEFAULT 'detected' NOT NULL,
	"order_id" integer,
	"admin_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reconcile_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"mode" varchar(20) DEFAULT 'scan' NOT NULL,
	"conversations_scanned" integer DEFAULT 0 NOT NULL,
	"orders_created" integer DEFAULT 0 NOT NULL,
	"candidates_created" integer DEFAULT 0 NOT NULL,
	"report" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN IF NOT EXISTS "web_order_redirect_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_config" ADD COLUMN IF NOT EXISTS "web_order_redirect_message" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reconcile_candidates" ADD CONSTRAINT "reconcile_candidates_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reconcile_candidates" ADD CONSTRAINT "reconcile_candidates_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_agent_memories_key" ON "agent_memories" USING btree ("key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reconcile_candidates_conv" ON "reconcile_candidates" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_reconcile_candidates_status" ON "reconcile_candidates" USING btree ("status");
