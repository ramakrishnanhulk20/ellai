CREATE INDEX "memories_decision_idx" ON "memories" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "memories_status_created_at_idx" ON "memories" USING btree ("status","created_at");