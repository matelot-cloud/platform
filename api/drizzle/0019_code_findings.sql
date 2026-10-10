CREATE TYPE "public"."code_finding_kind" AS ENUM('secret', 'iac', 'sast');--> statement-breakpoint
CREATE TABLE "code_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"repository_id" uuid,
	"kind" "code_finding_kind" NOT NULL,
	"rule_id" text NOT NULL,
	"title" text NOT NULL,
	"severity" "severity" DEFAULT 'unknown' NOT NULL,
	"category" text,
	"file" text NOT NULL,
	"start_line" integer,
	"end_line" integer,
	"evidence" text,
	"resolution" text,
	"references" text[] DEFAULT '{}' NOT NULL,
	"fingerprint" text NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"ref" text,
	"last_job_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"status_changed_by_id" uuid,
	"status_changed_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "code_findings" ADD CONSTRAINT "code_findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_findings" ADD CONSTRAINT "code_findings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_findings" ADD CONSTRAINT "code_findings_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_findings" ADD CONSTRAINT "code_findings_status_changed_by_id_users_id_fk" FOREIGN KEY ("status_changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "code_findings_key" ON "code_findings" USING btree ("service_id","kind","fingerprint");--> statement-breakpoint
CREATE INDEX "code_findings_org_idx" ON "code_findings" USING btree ("organization_id","status","severity");