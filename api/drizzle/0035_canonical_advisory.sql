ALTER TABLE "advisories" ADD COLUMN IF NOT EXISTS "canonical_id" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "canonical_id" text;--> statement-breakpoint
-- Canonical = the CVE among the record's aliases (lowest when several), else the record id itself.
UPDATE "advisories" SET "canonical_id" = coalesce((SELECT min(a) FROM unnest("aliases") a WHERE a ~* '^CVE-\d{4}-\d+$'), CASE WHEN "id" ~* '^(DEBIAN-)?CVE-\d{4}-\d+$' THEN regexp_replace("id", '^DEBIAN-', '', 'i') ELSE "id" END) WHERE "canonical_id" IS NULL;--> statement-breakpoint
UPDATE "findings" f SET "canonical_id" = a."canonical_id" FROM "advisories" a WHERE a."id" = f."advisory_id" AND f."canonical_id" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "findings_canonical_idx" ON "findings" ("service_id", "canonical_id");
