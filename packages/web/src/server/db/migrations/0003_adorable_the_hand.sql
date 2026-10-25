ALTER TABLE "owners" ADD COLUMN "blob_scan_cursor" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "outcome_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "settlement_failed_reads" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "seller_sales_expires_at_idx" ON "seller_sales" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "signin_nonces_expires_at_idx" ON "signin_nonces" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_blob_scan_cursor_length" CHECK (char_length("owners"."blob_scan_cursor") <= 512);--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_settlement_failed_reads_nonnegative" CHECK ("payments"."settlement_failed_reads" >= 0);