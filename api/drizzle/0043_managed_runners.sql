ALTER TABLE "runner_pools" ADD COLUMN IF NOT EXISTS "managed" boolean NOT NULL DEFAULT false;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runner_pools_one_managed" ON "runner_pools" ("managed") WHERE "managed";
