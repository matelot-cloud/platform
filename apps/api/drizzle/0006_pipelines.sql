CREATE TYPE "public"."pipeline_status" AS ENUM('created', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pipeline_trigger" AS ENUM('manual', 'push', 'schedule', 'api', 'retry');--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'pending';--> statement-breakpoint
ALTER TYPE "public"."job_status" ADD VALUE 'skipped';--> statement-breakpoint
CREATE TABLE "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"service_id" uuid,
	"repository_id" uuid,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"ref" text,
	"status" "pipeline_status" DEFAULT 'created' NOT NULL,
	"trigger" "pipeline_trigger" DEFAULT 'manual' NOT NULL,
	"stages" jsonb NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "pipeline_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "stage_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pipelines_project_idx" ON "pipelines" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pipelines_project_number_key" ON "pipelines" USING btree ("project_id","number");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_pipeline_idx" ON "jobs" USING btree ("pipeline_id");