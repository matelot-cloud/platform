CREATE TABLE IF NOT EXISTS "platform_heartbeats" (
  "name" text PRIMARY KEY,
  "last_seen_at" timestamp with time zone NOT NULL DEFAULT now(),
  "detail" jsonb
);
