-- Zernio platform set (S-series follow-up): `channel` enum gains the
-- connect-capable Zernio platforms. Idempotent: re-running is a no-op.
ALTER TYPE "public"."channel" ADD VALUE IF NOT EXISTS 'linkedin';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE IF NOT EXISTS 'tiktok';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE IF NOT EXISTS 'youtube';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE IF NOT EXISTS 'threads';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE IF NOT EXISTS 'pinterest';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE IF NOT EXISTS 'discord';--> statement-breakpoint
ALTER TYPE "public"."channel" ADD VALUE IF NOT EXISTS 'slack';
