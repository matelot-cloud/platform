CREATE TABLE IF NOT EXISTS "signing_keys" (
  "kid" text PRIMARY KEY,
  "purpose" text NOT NULL,
  "public_pem" text NOT NULL,
  "private_pem_encrypted" bytea NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "retired_at" timestamp with time zone
);--> statement-breakpoint
ALTER TYPE "integration_auth_type" ADD VALUE IF NOT EXISTS 'gcp_wif';--> statement-breakpoint
ALTER TYPE "integration_auth_type" ADD VALUE IF NOT EXISTS 'aws_wif';--> statement-breakpoint
ALTER TYPE "integration_auth_type" ADD VALUE IF NOT EXISTS 'azure_wif';
