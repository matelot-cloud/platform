ALTER TABLE "integrations" ADD COLUMN "scope_type" "scope_type" DEFAULT 'ORGANIZATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN "scope_id" uuid;--> statement-breakpoint
CREATE INDEX "integrations_scope_idx" ON "integrations" USING btree ("scope_type","scope_id");--> statement-breakpoint
UPDATE "integrations" SET "scope_id" = "organization_id" WHERE "scope_id" IS NULL;
