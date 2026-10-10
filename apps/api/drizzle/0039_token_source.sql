ALTER TABLE "personal_access_tokens" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'ui';--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD COLUMN IF NOT EXISTS "oauth_client_id" text;
