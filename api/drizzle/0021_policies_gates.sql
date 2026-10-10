CREATE TYPE "public"."gate_result" AS ENUM('pass', 'warn', 'fail');--> statement-breakpoint
CREATE TYPE "public"."policy_action" AS ENUM('block', 'warn');--> statement-breakpoint
CREATE TABLE "gate_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"environment_id" uuid,
	"subject" jsonb NOT NULL,
	"result" "gate_result" NOT NULL,
	"violations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_ids" text[] DEFAULT '{}' NOT NULL,
	"job_id" uuid,
	"deployment_id" uuid,
	"actor" text,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"scope_type" "scope_type" NOT NULL,
	"scope_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"environment_kinds" text[] DEFAULT '{}' NOT NULL,
	"rules" jsonb NOT NULL,
	"action" "policy_action" DEFAULT 'block' NOT NULL,
	"enforce_on_deploy" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gate_evaluations" ADD CONSTRAINT "gate_evaluations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_evaluations" ADD CONSTRAINT "gate_evaluations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_evaluations" ADD CONSTRAINT "gate_evaluations_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gate_evaluations_env_idx" ON "gate_evaluations" USING btree ("environment_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "gate_evaluations_service_idx" ON "gate_evaluations" USING btree ("service_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "policies_org_idx" ON "policies" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "policies_scope_idx" ON "policies" USING btree ("scope_type","scope_id");