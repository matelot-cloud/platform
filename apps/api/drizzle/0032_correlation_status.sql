ALTER TABLE "sboms" ADD COLUMN IF NOT EXISTS "correlation_status" text NOT NULL DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "sboms" ADD COLUMN IF NOT EXISTS "correlated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sboms" ADD COLUMN IF NOT EXISTS "correlation_error" text;--> statement-breakpoint
ALTER TABLE "advisories" ADD COLUMN IF NOT EXISTS "alias_checked_at" timestamp with time zone;--> statement-breakpoint
-- SBOMs that already have linked findings were correlated under the old flow.
UPDATE "sboms" SET "correlation_status" = 'done', "correlated_at" = now() WHERE "correlation_status" = 'pending' AND EXISTS (SELECT 1 FROM "finding_sboms" fs WHERE fs."sbom_id" = "sboms"."id");
--> statement-breakpoint
-- Clean SBOMs (no findings) from before this migration are done too; only new ingests start pending.
UPDATE "sboms" SET "correlation_status" = 'done', "correlated_at" = coalesce("correlated_at", "created_at") WHERE "correlation_status" = 'pending' AND "created_at" < now() - interval '10 minutes';
