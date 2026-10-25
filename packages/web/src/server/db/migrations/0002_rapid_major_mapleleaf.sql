ALTER TABLE "memories" ADD COLUMN "submit_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "chain_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "public_proof" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "last_ticked_at" timestamp with time zone;