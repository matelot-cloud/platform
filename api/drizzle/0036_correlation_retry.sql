ALTER TABLE "sboms" ADD COLUMN IF NOT EXISTS "correlation_attempts" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "sboms" ADD COLUMN IF NOT EXISTS "correlation_next_retry_at" timestamp with time zone;--> statement-breakpoint
-- SBOMs currently failed are retried on the next tick
UPDATE "sboms" SET "correlation_next_retry_at" = now() WHERE "correlation_status" = 'failed' AND "correlation_next_retry_at" IS NULL;
