ALTER TABLE "sboms" ADD COLUMN IF NOT EXISTS "image_digest" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sboms_image_digest_idx" ON "sboms" ("service_id", "image_digest");--> statement-breakpoint
-- Cheap part of the backfill: SBOMs whose target ref names a digest. The rest is read from the documents at API start (SbomService.backfillImageDigests).
UPDATE "sboms" SET "image_digest" = lower(substring("target_ref" from '@(sha256:[0-9a-fA-F]{64})')) WHERE "image_digest" IS NULL AND "target" = 'image' AND "target_ref" ~ '@sha256:[0-9a-fA-F]{64}';
