CREATE TYPE "public"."deployment_source" AS ENUM('api', 'cli', 'manual', 'kubernetes');--> statement-breakpoint
CREATE TYPE "public"."release_source" AS ENUM('git_tag', 'github_release', 'gitlab_release', 'manual', 'api');--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'registry';--> statement-breakpoint
ALTER TYPE "public"."job_type" ADD VALUE 'kubernetes_inventory';--> statement-breakpoint
CREATE TABLE "container_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"integration_id" uuid,
	"name" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"release_id" uuid,
	"image_tag_id" uuid,
	"version" text,
	"image_ref" text,
	"source" "deployment_source" DEFAULT 'api' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deployed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deployed_by_id" uuid,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "image_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_id" uuid NOT NULL,
	"tag" text NOT NULL,
	"digest" text,
	"release_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"repository_id" uuid,
	"version" text NOT NULL,
	"tag" text,
	"commit_sha" text,
	"source" "release_source" DEFAULT 'manual' NOT NULL,
	"notes" text,
	"html_url" text,
	"released_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "container_images" ADD CONSTRAINT "container_images_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_images" ADD CONSTRAINT "container_images_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_images" ADD CONSTRAINT "container_images_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_images" ADD CONSTRAINT "container_images_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_image_tag_id_image_tags_id_fk" FOREIGN KEY ("image_tag_id") REFERENCES "public"."image_tags"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_deployed_by_id_users_id_fk" FOREIGN KEY ("deployed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_tags" ADD CONSTRAINT "image_tags_image_id_container_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."container_images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_tags" ADD CONSTRAINT "image_tags_release_id_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "container_images_service_name_key" ON "container_images" USING btree ("service_id","name");--> statement-breakpoint
CREATE INDEX "deployments_env_idx" ON "deployments" USING btree ("environment_id","deployed_at");--> statement-breakpoint
CREATE INDEX "deployments_service_idx" ON "deployments" USING btree ("service_id");--> statement-breakpoint
CREATE UNIQUE INDEX "image_tags_image_tag_key" ON "image_tags" USING btree ("image_id","tag");--> statement-breakpoint
CREATE INDEX "image_tags_digest_idx" ON "image_tags" USING btree ("digest");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_service_version_key" ON "releases" USING btree ("service_id","version");--> statement-breakpoint
CREATE INDEX "releases_service_idx" ON "releases" USING btree ("service_id","released_at");