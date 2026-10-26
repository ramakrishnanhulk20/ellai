CREATE TABLE "step_ups" (
	"nonce" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"action" text NOT NULL,
	"change_hash" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "step_ups_action_known" CHECK ("step_ups"."action" in ('create_agent', 'loosen_settings')),
	CONSTRAINT "step_ups_change_hash_hex" CHECK ("step_ups"."change_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "step_ups_message_length" CHECK (char_length("step_ups"."message") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "step_ups" ADD CONSTRAINT "step_ups_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "step_ups_expires_at_idx" ON "step_ups" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "step_ups_owner_idx" ON "step_ups" USING btree ("owner_id");