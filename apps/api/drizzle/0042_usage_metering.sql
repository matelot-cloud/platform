CREATE TABLE IF NOT EXISTS "usage_active_users" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "month" text NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "month")
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_active_users_month_idx" ON "usage_active_users" ("month");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_snapshots" (
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "month" text NOT NULL,
  "metrics" jsonb NOT NULL,
  "final" boolean NOT NULL DEFAULT false,
  "computed_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("organization_id", "month")
);
