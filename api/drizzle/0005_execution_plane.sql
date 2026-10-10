CREATE TYPE "public"."job_status" AS ENUM('queued', 'assigned', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('repository_check', 'sbom', 'sca', 'sast', 'secrets', 'iac', 'container_scan', 'kubernetes_check', 'config_analysis', 'license_check', 'artifact_scan', 'policy_eval', 'custom');--> statement-breakpoint
CREATE TYPE "public"."runner_status" AS ENUM('online', 'busy', 'offline', 'draining');--> statement-breakpoint
CREATE TABLE "job_log_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"stream" text DEFAULT 'stdout' NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"service_id" uuid,
	"repository_id" uuid,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"required_tags" text[] DEFAULT '{}' NOT NULL,
	"pool_id" uuid,
	"runner_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"exit_code" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 2 NOT NULL,
	"timeout_seconds" integer DEFAULT 1800 NOT NULL,
	"created_by_id" uuid,
	"created_by_actor" "actor_type" DEFAULT 'USER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"assigned_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "runner_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_type" "scope_type" DEFAULT 'ORGANIZATION' NOT NULL,
	"scope_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_registration_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runner_registration_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "runners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" uuid NOT NULL,
	"name" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"version" text,
	"status" "runner_status" DEFAULT 'offline' NOT NULL,
	"token_hash" text NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"current_job_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runners_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "job_log_chunks" ADD CONSTRAINT "job_log_chunks_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pool_id_runner_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."runner_pools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_runner_id_runners_id_fk" FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pools" ADD CONSTRAINT "runner_pools_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_pools" ADD CONSTRAINT "runner_pools_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_registration_tokens" ADD CONSTRAINT "runner_registration_tokens_pool_id_runner_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."runner_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runner_registration_tokens" ADD CONSTRAINT "runner_registration_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_pool_id_runner_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."runner_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_log_chunks_job_seq_key" ON "job_log_chunks" USING btree ("job_id","seq");--> statement-breakpoint
CREATE INDEX "jobs_status_idx" ON "jobs" USING btree ("status","priority","created_at");--> statement-breakpoint
CREATE INDEX "jobs_project_idx" ON "jobs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "jobs_runner_idx" ON "jobs" USING btree ("runner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runner_pools_scope_slug_key" ON "runner_pools" USING btree ("scope_type","scope_id","slug");--> statement-breakpoint
CREATE INDEX "runner_pools_org_idx" ON "runner_pools" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "runners_pool_idx" ON "runners" USING btree ("pool_id");