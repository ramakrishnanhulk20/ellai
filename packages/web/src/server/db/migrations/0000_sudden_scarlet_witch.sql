CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"max_pending" integer DEFAULT 5 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "agents_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agents_id_owner_id_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "agents_label_length" CHECK (char_length("agents"."label") between 1 and 60),
	CONSTRAINT "agents_kind_known" CHECK ("agents"."kind" in ('external', 'builtin')),
	CONSTRAINT "agents_token_prefix_length" CHECK (char_length("agents"."token_prefix") <= 12)
);
--> statement-breakpoint
CREATE TABLE "decision_citations" (
	"decision_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	CONSTRAINT "decision_citations_decision_id_memory_id_pk" PRIMARY KEY("decision_id","memory_id")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"seller_url" text NOT NULL,
	"seller_method" text NOT NULL,
	"seller_host" text NOT NULL,
	"body_hash" text NOT NULL,
	"purpose" text NOT NULL,
	"recipient" text NOT NULL,
	"amount_atomic" bigint NOT NULL,
	"asset" text NOT NULL,
	"network" text NOT NULL,
	"challenge_id" text,
	"nonce" text,
	"min_epoch" bigint,
	"max_epoch" bigint,
	"expires_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"rule" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_id_owner_id_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "decisions_amount_positive" CHECK ("decisions"."amount_atomic" > 0),
	CONSTRAINT "decisions_seller_method_known" CHECK ("decisions"."seller_method" in ('GET', 'POST')),
	CONSTRAINT "decisions_outcome_known" CHECK ("decisions"."outcome" in ('approved', 'refused', 'asked')),
	CONSTRAINT "decisions_rule_known" CHECK ("decisions"."rule" in ('paused', 'over_payment_max', 'over_daily_budget', 'refused_recipient', 'bad_outcome', 'grant', 'learned', 'recall_unavailable', 'no_match', 'too_many_pending')),
	CONSTRAINT "decisions_status_known" CHECK ("decisions"."status" in ('open', 'paid', 'asked', 'answered', 'refused', 'expired', 'failed')),
	CONSTRAINT "decisions_request_key_length" CHECK (char_length("decisions"."request_key") <= 128),
	CONSTRAINT "decisions_seller_url_length" CHECK (char_length("decisions"."seller_url") <= 2048),
	CONSTRAINT "decisions_seller_host_length" CHECK (char_length("decisions"."seller_host") <= 253),
	CONSTRAINT "decisions_purpose_length" CHECK (char_length("decisions"."purpose") <= 500),
	CONSTRAINT "decisions_recipient_length" CHECK (char_length("decisions"."recipient") <= 66),
	CONSTRAINT "decisions_asset_length" CHECK (char_length("decisions"."asset") <= 256),
	CONSTRAINT "decisions_network_length" CHECK (char_length("decisions"."network") <= 32),
	CONSTRAINT "decisions_challenge_id_length" CHECK (char_length("decisions"."challenge_id") <= 128),
	CONSTRAINT "decisions_nonce_length" CHECK (char_length("decisions"."nonce") <= 128),
	CONSTRAINT "decisions_reason_length" CHECK (char_length("decisions"."reason") <= 400)
);
--> statement-breakpoint
CREATE TABLE "grant_uses" (
	"grant_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_uses_decision_id_unique" UNIQUE("decision_id")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"recipient" text NOT NULL,
	"max_amount_atomic" bigint NOT NULL,
	"seller_url" text NOT NULL,
	"seller_method" text NOT NULL,
	"body_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grants_decision_id_unique" UNIQUE("decision_id"),
	CONSTRAINT "grants_id_owner_id_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "grants_max_amount_positive" CHECK ("grants"."max_amount_atomic" > 0),
	CONSTRAINT "grants_seller_method_known" CHECK ("grants"."seller_method" in ('GET', 'POST')),
	CONSTRAINT "grants_recipient_length" CHECK (char_length("grants"."recipient") <= 66),
	CONSTRAINT "grants_seller_url_length" CHECK (char_length("grants"."seller_url") <= 2048)
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"decision_id" uuid,
	"recipient" text,
	"amount_atomic" bigint,
	"verdict" text,
	"seller_host" text,
	"sentence" text NOT NULL,
	"namespace" text NOT NULL,
	"writer_public_key" text NOT NULL,
	"job_id" text,
	"blob_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "memories_blob_id_unique" UNIQUE("blob_id"),
	CONSTRAINT "memories_id_owner_id_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "memories_owner_decision_facts" CHECK ("memories"."kind" <> 'owner_decision' or ("memories"."verdict" is not null and "memories"."recipient" is not null and "memories"."amount_atomic" is not null)),
	CONSTRAINT "memories_kind_known" CHECK ("memories"."kind" in ('owner_decision', 'outcome')),
	CONSTRAINT "memories_verdict_known" CHECK ("memories"."verdict" in ('approve', 'refuse')),
	CONSTRAINT "memories_status_known" CHECK ("memories"."status" in ('pending', 'confirmed', 'failed')),
	CONSTRAINT "memories_recipient_length" CHECK (char_length("memories"."recipient") <= 66),
	CONSTRAINT "memories_seller_host_length" CHECK (char_length("memories"."seller_host") <= 253),
	CONSTRAINT "memories_sentence_length" CHECK (char_length("memories"."sentence") <= 1000),
	CONSTRAINT "memories_namespace_length" CHECK (char_length("memories"."namespace") <= 64),
	CONSTRAINT "memories_job_id_length" CHECK (char_length("memories"."job_id") <= 128),
	CONSTRAINT "memories_blob_id_length" CHECK (char_length("memories"."blob_id") <= 128)
);
--> statement-breakpoint
CREATE TABLE "owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sui_address" text NOT NULL,
	"purse_address" text NOT NULL,
	"memwal_account_id" text,
	"delegate_registered_at" timestamp with time zone,
	"allowance_id" text,
	"allowance_checked_at" timestamp with time zone,
	"per_payment_max_atomic" bigint DEFAULT 50000 NOT NULL,
	"daily_budget_atomic" bigint DEFAULT 500000 NOT NULL,
	"approvals_needed" integer DEFAULT 2 NOT NULL,
	"distance_cutoff" real DEFAULT 0.5 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"auto_paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owners_sui_address_unique" UNIQUE("sui_address"),
	CONSTRAINT "owners_purse_address_unique" UNIQUE("purse_address"),
	CONSTRAINT "owners_memwal_account_id_unique" UNIQUE("memwal_account_id"),
	CONSTRAINT "owners_allowance_id_unique" UNIQUE("allowance_id"),
	CONSTRAINT "owners_approvals_needed_range" CHECK ("owners"."approvals_needed" between 1 and 10),
	CONSTRAINT "owners_distance_cutoff_range" CHECK ("owners"."distance_cutoff" > 0 and "owners"."distance_cutoff" <= 2),
	CONSTRAINT "owners_sui_address_length" CHECK (char_length("owners"."sui_address") <= 66),
	CONSTRAINT "owners_memwal_account_id_length" CHECK (char_length("owners"."memwal_account_id") <= 66),
	CONSTRAINT "owners_allowance_id_length" CHECK (char_length("owners"."allowance_id") <= 66),
	CONSTRAINT "owners_auto_paused_reason_length" CHECK (char_length("owners"."auto_paused_reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"purse_address" text NOT NULL,
	"recipient" text NOT NULL,
	"amount_atomic" bigint NOT NULL,
	"digest" text NOT NULL,
	"tx_bytes_base64" text NOT NULL,
	"signed_at" timestamp with time zone NOT NULL,
	"valid_until_epoch" bigint NOT NULL,
	"released_at" timestamp with time zone,
	"seller_status" integer,
	"delivered" boolean,
	"settlement" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	"mismatch_reason" text,
	CONSTRAINT "payments_decision_id_unique" UNIQUE("decision_id"),
	CONSTRAINT "payments_digest_unique" UNIQUE("digest"),
	CONSTRAINT "payments_amount_positive" CHECK ("payments"."amount_atomic" > 0),
	CONSTRAINT "payments_settlement_known" CHECK ("payments"."settlement" in ('pending', 'verified', 'mismatch', 'not_landed')),
	CONSTRAINT "payments_recipient_length" CHECK (char_length("payments"."recipient") <= 66),
	CONSTRAINT "payments_mismatch_reason_length" CHECK (char_length("payments"."mismatch_reason") <= 200)
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"decision_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	"answer" text,
	"reason" text,
	"memory_id" uuid,
	CONSTRAINT "questions_answer_has_time" CHECK (("questions"."answer" is null) = ("questions"."answered_at" is null)),
	CONSTRAINT "questions_answer_known" CHECK ("questions"."answer" in ('approve', 'refuse')),
	CONSTRAINT "questions_reason_length" CHECK (char_length("questions"."reason") <= 300)
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_counters_key_window_start_pk" PRIMARY KEY("key","window_start"),
	CONSTRAINT "rate_counters_key_length" CHECK (char_length("rate_counters"."key") <= 200)
);
--> statement-breakpoint
CREATE TABLE "refills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"allowance_id" text NOT NULL,
	"amount_atomic" bigint NOT NULL,
	"digest" text NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "refills_digest_unique" UNIQUE("digest"),
	CONSTRAINT "refills_amount_positive" CHECK ("refills"."amount_atomic" > 0),
	CONSTRAINT "refills_status_known" CHECK ("refills"."status" in ('pending', 'verified', 'failed')),
	CONSTRAINT "refills_allowance_id_length" CHECK (char_length("refills"."allowance_id") <= 66)
);
--> statement-breakpoint
CREATE TABLE "seller_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenge_id" text NOT NULL,
	"payer" text,
	"amount_atomic" bigint NOT NULL,
	"recipient" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"digest" text,
	"settled_at" timestamp with time zone,
	"status" text DEFAULT 'issued' NOT NULL,
	CONSTRAINT "seller_sales_challenge_id_unique" UNIQUE("challenge_id"),
	CONSTRAINT "seller_sales_digest_unique" UNIQUE("digest"),
	CONSTRAINT "seller_sales_status_known" CHECK ("seller_sales"."status" in ('issued', 'settled', 'rejected')),
	CONSTRAINT "seller_sales_payer_length" CHECK (char_length("seller_sales"."payer") <= 66),
	CONSTRAINT "seller_sales_digest_length" CHECK (char_length("seller_sales"."digest") <= 64)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "signin_nonces" (
	"nonce" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD CONSTRAINT "decision_citations_decision_same_owner_fk" FOREIGN KEY ("decision_id","owner_id") REFERENCES "public"."decisions"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_citations" ADD CONSTRAINT "decision_citations_memory_same_owner_fk" FOREIGN KEY ("memory_id","owner_id") REFERENCES "public"."memories"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_agent_same_owner_fk" FOREIGN KEY ("agent_id","owner_id") REFERENCES "public"."agents"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_uses" ADD CONSTRAINT "grant_uses_grant_same_owner_fk" FOREIGN KEY ("grant_id","owner_id") REFERENCES "public"."grants"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_uses" ADD CONSTRAINT "grant_uses_decision_same_owner_fk" FOREIGN KEY ("decision_id","owner_id") REFERENCES "public"."decisions"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_decision_same_owner_fk" FOREIGN KEY ("decision_id","owner_id") REFERENCES "public"."decisions"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_decision_same_owner_fk" FOREIGN KEY ("decision_id","owner_id") REFERENCES "public"."decisions"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_decision_same_owner_fk" FOREIGN KEY ("decision_id","owner_id") REFERENCES "public"."decisions"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_decision_same_owner_fk" FOREIGN KEY ("decision_id","owner_id") REFERENCES "public"."decisions"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_memory_same_owner_fk" FOREIGN KEY ("memory_id","owner_id") REFERENCES "public"."memories"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refills" ADD CONSTRAINT "refills_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_live_request_unique" ON "decisions" USING btree ("owner_id","request_key") WHERE "decisions"."status" in ('open', 'asked');--> statement-breakpoint
CREATE INDEX "memories_refusal_lookup_idx" ON "memories" USING btree ("owner_id","recipient","verdict");--> statement-breakpoint
CREATE INDEX "payments_owner_signed_at_idx" ON "payments" USING btree ("owner_id","signed_at");