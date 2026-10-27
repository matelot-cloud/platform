ALTER TABLE "jobs" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
-- existing queued jobs: claimable since creation (pending ones get it when their stage opens)
UPDATE "jobs" SET "queued_at" = "created_at" WHERE "status" = 'queued' AND "queued_at" IS NULL;
