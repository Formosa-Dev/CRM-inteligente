CREATE TABLE "lead_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"lead_id" integer NOT NULL,
	"channel" "channel" NOT NULL,
	"external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead_identities" ADD CONSTRAINT "lead_identities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_identities_channel_external_uq" ON "lead_identities" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "lead_identities_lead_idx" ON "lead_identities" USING btree ("lead_id");