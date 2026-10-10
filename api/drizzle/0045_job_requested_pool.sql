ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "requested_pool_id" uuid REFERENCES "runner_pools"("id") ON DELETE SET NULL;--> statement-breakpoint
-- jobs never claimed carry the pool that was requested at creation; for claimed ones pool_id is the claiming runner's
-- pool (not a constraint), so they keep no binding
UPDATE "jobs" SET "requested_pool_id" = "pool_id" WHERE "pool_id" IS NOT NULL AND "attempts" = 0;--> statement-breakpoint
-- queued jobs pinned to an earlier claimer's pool by the old requeue: free them
UPDATE "jobs" SET "pool_id" = NULL WHERE "status" = 'queued' AND "attempts" > 0 AND "requested_pool_id" IS NULL;
