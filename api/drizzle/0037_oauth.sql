CREATE TABLE IF NOT EXISTS "oauth_clients" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "redirect_uris" text[] NOT NULL DEFAULT '{}',
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_used_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_codes" (
  "code_hash" text PRIMARY KEY,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "code_challenge" text NOT NULL,
  "resource" text,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_refresh_tokens" (
  "token_hash" text PRIMARY KEY,
  "client_id" text NOT NULL REFERENCES "oauth_clients"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "scope" text NOT NULL,
  "personal_token_id" uuid REFERENCES "personal_access_tokens"("id") ON DELETE SET NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
