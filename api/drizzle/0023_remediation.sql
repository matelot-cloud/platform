CREATE TYPE "public"."remediation_status" AS ENUM('open', 'in_progress', 'done', 'wont_fix');--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'jira';--> statement-breakpoint
CREATE TABLE "remediation_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"sla_days" jsonb NOT NULL,
	"default_issue_integration_id" uuid,
	"jira_project_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "remediations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"kind" "exception_kind" NOT NULL,
	"match_id" text NOT NULL,
	"component_name" text,
	"title" text NOT NULL,
	"severity" "severity" NOT NULL,
	"status" "remediation_status" DEFAULT 'open' NOT NULL,
	"owner_id" uuid,
	"due_at" timestamp with time zone,
	"finding_ids" text[] DEFAULT '{}' NOT NULL,
	"code_finding_ids" text[] DEFAULT '{}' NOT NULL,
	"issue_provider" text,
	"issue_key" text,
	"issue_url" text,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "remediation_settings" ADD CONSTRAINT "remediation_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediation_settings" ADD CONSTRAINT "remediation_settings_default_issue_integration_id_integrations_id_fk" FOREIGN KEY ("default_issue_integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remediations" ADD CONSTRAINT "remediations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "remediations_service_idx" ON "remediations" USING btree ("service_id","status");--> statement-breakpoint
CREATE INDEX "remediations_org_idx" ON "remediations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "remediations_open_key" ON "remediations" USING btree ("service_id","kind","match_id","component_name") WHERE status in ('open','in_progress');