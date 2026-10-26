ALTER TABLE "memories" ADD COLUMN "blob_end_epoch" integer;--> statement-breakpoint
ALTER TABLE "memories" ADD COLUMN "chain_expired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "refill_not_before" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "owners_created_at_idx" ON "owners" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "rate_counters_window_start_idx" ON "rate_counters" USING btree ("window_start");--> statement-breakpoint
CREATE INDEX "refills_owner_idx" ON "refills" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "sessions_owner_expires_at_idx" ON "sessions" USING btree ("owner_id","expires_at");