CREATE TYPE "public"."sbom_format" AS ENUM('cyclonedx', 'spdx');--> statement-breakpoint
CREATE TYPE "public"."sbom_source" AS ENUM('runner', 'ci_upload', 'manual');--> statement-breakpoint
CREATE TYPE "public"."sbom_target" AS ENUM('source', 'image', 'artifact');--> statement-breakpoint
CREATE TABLE "components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purl" text NOT NULL,
	"type" text NOT NULL,
	"namespace" text,
	"name" text NOT NULL,
	"version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "components_purl_unique" UNIQUE("purl")
);
--> statement-breakpoint
CREATE TABLE "sbom_components" (
	"sbom_id" uuid NOT NULL,
	"component_id" uuid NOT NULL,
	"direct" boolean,
	"licenses" text[] DEFAULT '{}' NOT NULL,
	"locations" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sboms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"release_id" uuid,
	"image_tag_id" uuid,
	"repository_id" uuid,
	"job_id" uuid,
	"source" "sbom_source" NOT NULL,
	"target" "sbom_target" NOT NULL,
	"target_ref" text NOT NULL,
	"format" "sbom_format" NOT NULL,
	"spec_version" text,
	"tool" text,
	"component_count" integer DEFAULT 0 NOT NULL,
	"digest" text NOT NULL,
	"raw_gz" "bytea" NOT NULL,
	"generated_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sbom_components" ADD CONSTRAINT "sbom_components_sbom_id_sboms_id_fk" FOREIGN KEY ("sbom_id") REFERENCES "public"."sboms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sbom_components" ADD CONSTRAINT "sbom_components_component_id_components_id_fk" FOREIGN KEY ("component_id") REFERENCES "public"."components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_image_tag_id_image_tags_id_fk" FOREIGN KEY ("image_tag_id") REFERENCES "public"."image_tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sboms" ADD CONSTRAINT "sboms_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "components_name_idx" ON "components" USING btree ("name");--> statement-breakpoint
CREATE INDEX "components_type_name_idx" ON "components" USING btree ("type","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sbom_components_key" ON "sbom_components" USING btree ("sbom_id","component_id");--> statement-breakpoint
CREATE INDEX "sbom_components_component_idx" ON "sbom_components" USING btree ("component_id");--> statement-breakpoint
CREATE INDEX "sboms_service_idx" ON "sboms" USING btree ("service_id","created_at");--> statement-breakpoint
CREATE INDEX "sboms_release_idx" ON "sboms" USING btree ("release_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sboms_service_digest_key" ON "sboms" USING btree ("service_id","digest");