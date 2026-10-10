CREATE TYPE "public"."finding_status" AS ENUM('open', 'fixed', 'accepted', 'false_positive', 'not_affected');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('critical', 'high', 'medium', 'low', 'unknown');--> statement-breakpoint
CREATE TABLE "advisories" (
	"id" text PRIMARY KEY NOT NULL,
	"aliases" text[] DEFAULT '{}' NOT NULL,
	"summary" text,
	"details" text,
	"severity" "severity" DEFAULT 'unknown' NOT NULL,
	"cvss_score" double precision,
	"cvss_vector" text,
	"epss_score" double precision,
	"epss_percentile" double precision,
	"kev" boolean DEFAULT false NOT NULL,
	"kev_due_date" timestamp with time zone,
	"published_at" timestamp with time zone,
	"modified_at" timestamp with time zone,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"affected" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "component_checks" (
	"component_id" uuid PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"advisory_ids" text[] DEFAULT '{}' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "finding_sboms" (
	"finding_id" uuid NOT NULL,
	"sbom_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"advisory_id" text NOT NULL,
	"severity" "severity" DEFAULT 'unknown' NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"fixed_version" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"status_changed_by_id" uuid,
	"status_changed_at" timestamp with time zone,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "component_checks" ADD CONSTRAINT "component_checks_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_sboms" ADD CONSTRAINT "finding_sboms_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_sboms" ADD CONSTRAINT "finding_sboms_sbom_id_sboms_id_fk" FOREIGN KEY ("sbom_id") REFERENCES "public"."sboms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_advisory_id_advisories_id_fk" FOREIGN KEY ("advisory_id") REFERENCES "public"."advisories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_status_changed_by_id_users_id_fk" FOREIGN KEY ("status_changed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "advisories_severity_idx" ON "advisories" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "advisories_modified_idx" ON "advisories" USING btree ("modified_at");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_sboms_key" ON "finding_sboms" USING btree ("finding_id","sbom_id");--> statement-breakpoint
CREATE INDEX "finding_sboms_sbom_idx" ON "finding_sboms" USING btree ("sbom_id");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_key" ON "findings" USING btree ("service_id","component_id","advisory_id");--> statement-breakpoint
CREATE INDEX "findings_org_status_idx" ON "findings" USING btree ("organization_id","status","severity");--> statement-breakpoint
CREATE INDEX "findings_service_idx" ON "findings" USING btree ("service_id","status");