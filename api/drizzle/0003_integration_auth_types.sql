CREATE TYPE "public"."integration_auth_type" AS ENUM('app', 'token', 'basic', 'ssh', 'none');--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'github_token';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'gitlab';--> statement-breakpoint
ALTER TYPE "public"."integration_provider" ADD VALUE 'git';--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "auth_type" "integration_auth_type" DEFAULT 'app' NOT NULL;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "clone_url" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "ssh_url" text;