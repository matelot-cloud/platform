CREATE TYPE "public"."environment_kind" AS ENUM('development', 'testing', 'staging', 'production');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('github');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('pending', 'connected', 'error', 'disconnected');--> statement-breakpoint
CREATE TYPE "public"."repository_role" AS ENUM('primary', 'secondary');--> statement-breakpoint
CREATE TYPE "public"."service_kind" AS ENUM('api', 'worker', 'web', 'library', 'firmware', 'infrastructure', 'other');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processed', 'failed', 'ignored');--> statement-breakpoint
ALTER TYPE "public"."scope_type" ADD VALUE 'SERVICE';--> statement-breakpoint
ALTER TYPE "public"."scope_type" ADD VALUE 'ENVIRONMENT';--> statement-breakpoint
CREATE TABLE "environments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" "environment_kind" NOT NULL,
	"internet_facing" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"name" text NOT NULL,
	"status" "integration_status" DEFAULT 'pending' NOT NULL,
	"external_account_id" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credentials_encrypted" "bytea",
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text,
	"visibility" text,
	"archived" boolean DEFAULT false NOT NULL,
	"languages" jsonb,
	"html_url" text,
	"branch_protection" jsonb,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_repositories" (
	"service_id" uuid NOT NULL,
	"repository_id" uuid NOT NULL,
	"role" "repository_role" DEFAULT 'primary' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "service_kind" DEFAULT 'other' NOT NULL,
	"criticality" "criticality",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid,
	"provider" "integration_provider" NOT NULL,
	"provider_delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_repositories" ADD CONSTRAINT "service_repositories_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_repositories" ADD CONSTRAINT "service_repositories_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_service_slug_key" ON "environments" USING btree ("service_id","slug");--> statement-breakpoint
CREATE INDEX "integrations_org_idx" ON "integrations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_provider_account_key" ON "integrations" USING btree ("provider","external_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_integration_external_key" ON "repositories" USING btree ("integration_id","external_id");--> statement-breakpoint
CREATE INDEX "repositories_full_name_idx" ON "repositories" USING btree ("full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "service_repositories_key" ON "service_repositories" USING btree ("service_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "services_project_slug_key" ON "services" USING btree ("project_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_provider_delivery_key" ON "webhook_deliveries" USING btree ("provider","provider_delivery_id");