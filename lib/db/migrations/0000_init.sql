CREATE TYPE "public"."agent_name" AS ENUM('TREE', 'VIS', 'ACT', 'PAGES', 'MEDIA', 'CODE', 'FIX', 'VERIFY');--> statement-breakpoint
CREATE TYPE "public"."artifact_kind" AS ENUM('screenshot', 'axtree', 'video', 'log');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'fixing', 'fixed', 'verified', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."handoff_kind" AS ENUM('approval', 'question');--> statement-breakpoint
CREATE TYPE "public"."handoff_status" AS ENUM('pending', 'approved', 'rejected', 'answered');--> statement-breakpoint
CREATE TYPE "public"."patch_status" AS ENUM('proposed', 'applied', 'verified', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."run_phase" AS ENUM('baseline', 'final');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'crawling', 'auditing', 'fixing', 'verifying', 'awaiting_approval', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'serious', 'moderate', 'minor');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('DECIDE', 'FLAG', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."wcag_level" AS ENUM('A', 'AA');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" text NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finding_id" uuid,
	"run_id" uuid NOT NULL,
	"kind" "artifact_kind" NOT NULL,
	"mime_type" text NOT NULL,
	"data" "bytea",
	"storage_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifacts_payload_present" CHECK ("artifacts"."data" IS NOT NULL OR "artifacts"."storage_path" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "criteria" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"level" "wcag_level" NOT NULL,
	"principle" text NOT NULL,
	"plain_english" text NOT NULL,
	"verdict" "verdict" NOT NULL,
	"agent" "agent_name",
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state_dependent" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"phase" "run_phase" NOT NULL,
	"page_id" uuid,
	"page_url" text NOT NULL,
	"criterion" text NOT NULL,
	"level" "wcag_level" NOT NULL,
	"verdict" "verdict" NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"severity" "severity" NOT NULL,
	"agent" "agent_name" NOT NULL,
	"summary" text NOT NULL,
	"detail" text,
	"source_path" text,
	"fix_id" uuid,
	"session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "findings_criterion_not_blank" CHECK (length(btrim("findings"."criterion")) > 0),
	CONSTRAINT "findings_criterion_is_wcag" CHECK ("findings"."criterion" IN ('1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5', '1.3.1', '1.3.2', '1.3.3', '1.3.4', '1.3.5', '1.4.1', '1.4.2', '1.4.3', '1.4.4', '1.4.5', '1.4.10', '1.4.11', '1.4.12', '1.4.13', '2.1.1', '2.1.2', '2.1.4', '2.2.1', '2.2.2', '2.3.1', '2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.4.5', '2.4.6', '2.4.7', '2.4.11', '2.5.1', '2.5.2', '2.5.3', '2.5.4', '2.5.7', '2.5.8', '3.1.1', '3.1.2', '3.2.1', '3.2.2', '3.2.3', '3.2.4', '3.2.6', '3.3.1', '3.3.2', '3.3.3', '3.3.4', '3.3.7', '3.3.8', '4.1.2', '4.1.3'))
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"kind" "handoff_kind" NOT NULL,
	"intent" text NOT NULL,
	"reason" text NOT NULL,
	"evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "handoff_status" DEFAULT 'pending' NOT NULL,
	"response" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"crawled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"file_path" text NOT NULL,
	"diff" text NOT NULL,
	"finding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "patch_status" DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid NOT NULL,
	"phase" "run_phase" NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"max_sandboxes" integer DEFAULT 4 NOT NULL,
	"sandboxes_used" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"repo_full_name" text NOT NULL,
	"deployed_url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_fix_id_patches_id_fk" FOREIGN KEY ("fix_id") REFERENCES "public"."patches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_run_phase_fk" FOREIGN KEY ("run_id","phase") REFERENCES "public"."runs"("id","phase") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patches" ADD CONSTRAINT "patches_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_target_id_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."targets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "targets" ADD CONSTRAINT "targets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "artifacts_finding_id_idx" ON "artifacts" USING btree ("finding_id");--> statement-breakpoint
CREATE INDEX "artifacts_run_id_idx" ON "artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "findings_run_phase_idx" ON "findings" USING btree ("run_id","phase");--> statement-breakpoint
CREATE INDEX "findings_criterion_idx" ON "findings" USING btree ("criterion");--> statement-breakpoint
CREATE INDEX "findings_run_status_idx" ON "findings" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "findings_run_criterion_idx" ON "findings" USING btree ("run_id","criterion");--> statement-breakpoint
CREATE INDEX "findings_page_id_idx" ON "findings" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "findings_fix_id_idx" ON "findings" USING btree ("fix_id");--> statement-breakpoint
CREATE INDEX "handoffs_run_id_idx" ON "handoffs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "handoffs_run_status_idx" ON "handoffs" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "pages_run_id_idx" ON "pages" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_run_url_key" ON "pages" USING btree ("run_id","url");--> statement-breakpoint
CREATE INDEX "patches_run_id_idx" ON "patches" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "patches_run_file_idx" ON "patches" USING btree ("run_id","file_path");--> statement-breakpoint
CREATE INDEX "runs_target_id_idx" ON "runs" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "runs_status_idx" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_id_phase_key" ON "runs" USING btree ("id","phase");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "targets_user_id_idx" ON "targets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "targets_user_repo_url_key" ON "targets" USING btree ("user_id","repo_full_name","deployed_url");