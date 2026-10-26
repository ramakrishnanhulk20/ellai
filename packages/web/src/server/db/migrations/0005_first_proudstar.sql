CREATE INDEX "grants_owner_idx" ON "grants" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "questions_owner_idx" ON "questions" USING btree ("owner_id");