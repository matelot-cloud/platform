CREATE TYPE "public"."exception_kind" AS ENUM('vulnerability', 'code');--> statement-breakpoint
CREATE TABLE "exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_type" "scope_type" NOT NULL,
	"scope_id" uuid NOT NULL,
	"kind" "exception_kind" NOT NULL,
	"match_id" text NOT NULL,
	"match_component" text,
	"status" "finding_status" DEFAULT 'accepted' NOT NULL,
	"reason" text NOT NULL,
	"ticket_url" text,
	"requested_by_id" uuid,
	"approved_by_id" uuid,
	"approved_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"applied_finding_ids" text[] DEFAULT '{}' NOT NULL,
	"applied_code_finding_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exceptions" ADD CONSTRAINT "exceptions_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "exceptions_org_idx" ON "exceptions" USING btree ("organization_id","expires_at");--> statement-breakpoint
CREATE INDEX "exceptions_scope_idx" ON "exceptions" USING btree ("scope_type","scope_id");