CREATE TYPE "public"."backup_status" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TABLE "backup_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "backup_status" NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archive" text,
	"bytes" bigint,
	"destination" text,
	"error" text,
	"step" text
);
--> statement-breakpoint
CREATE INDEX "backup_reports_finished_idx" ON "backup_reports" USING btree ("status","finished_at");