ALTER TABLE "agents" DROP CONSTRAINT "agents_token_prefix_length";--> statement-breakpoint
ALTER TABLE "refills" ADD COLUMN "valid_until_epoch" bigint;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_live_builtin_per_owner" ON "agents" USING btree ("owner_id") WHERE "agents"."kind" = 'builtin' and "agents"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "decisions_owner_created_at_idx" ON "decisions" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "memories_owner_created_at_idx" ON "memories" USING btree ("owner_id","created_at");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_token_prefix_length" CHECK (char_length("agents"."token_prefix") <= 24);