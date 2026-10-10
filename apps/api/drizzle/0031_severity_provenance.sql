ALTER TABLE "advisories" ADD COLUMN IF NOT EXISTS "severity_source" text;--> statement-breakpoint
ALTER TABLE "advisories" ADD COLUMN IF NOT EXISTS "severity_note" text;--> statement-breakpoint
ALTER TABLE "advisories" ADD COLUMN IF NOT EXISTS "alias_cvss_score" double precision;--> statement-breakpoint
ALTER TABLE "advisories" ADD COLUMN IF NOT EXISTS "alias_source" text;--> statement-breakpoint
ALTER TABLE "advisories" ADD COLUMN IF NOT EXISTS "alias_text" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "severity_source" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "severity_note" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "package_key" text;
