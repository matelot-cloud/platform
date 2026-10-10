ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "running" boolean NOT NULL DEFAULT true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "findings_running_idx" ON "findings" ("service_id", "status", "running");
