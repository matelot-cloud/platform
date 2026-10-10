ALTER TABLE "notification_channels" ADD COLUMN "scope_type" "scope_type" DEFAULT 'ORGANIZATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "scope_id" uuid;