ALTER TYPE "integration_provider" ADD VALUE IF NOT EXISTS 'bitbucket';--> statement-breakpoint
ALTER TABLE "remediation_settings" DROP CONSTRAINT IF EXISTS "remediation_settings_pkey";--> statement-breakpoint
ALTER TABLE "remediation_settings" ADD COLUMN IF NOT EXISTS "scope_type" "scope_type" DEFAULT 'ORGANIZATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "remediation_settings" ADD COLUMN IF NOT EXISTS "scope_id" uuid;--> statement-breakpoint
ALTER TABLE "remediation_settings" ADD COLUMN IF NOT EXISTS "issue_provider" text;--> statement-breakpoint
UPDATE "remediation_settings" SET "scope_id" = "organization_id" WHERE "scope_id" IS NULL;--> statement-breakpoint
ALTER TABLE "remediation_settings" ALTER COLUMN "scope_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "remediation_settings" ALTER COLUMN "sla_days" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "remediation_settings" ADD CONSTRAINT "remediation_settings_pkey" PRIMARY KEY ("scope_type", "scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remediation_settings_org_idx" ON "remediation_settings" ("organization_id");
