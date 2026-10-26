ALTER TABLE "owners" ADD COLUMN "auto_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "missing_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "seller_sales" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "decisions_closed_created_at_idx" ON "decisions" USING btree ("created_at") WHERE "decisions"."status" in ('refused', 'expired', 'failed');--> statement-breakpoint
UPDATE "seller_sales" SET "delivered_at" = "settled_at" WHERE "status" = 'settled';
