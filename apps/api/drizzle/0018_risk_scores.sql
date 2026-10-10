CREATE TABLE "risk_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"score" integer NOT NULL,
	"grade" text NOT NULL,
	"factors" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "risk_scores" ADD CONSTRAINT "risk_scores_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "risk_scores_key" ON "risk_scores" USING btree ("service_id","day");--> statement-breakpoint
CREATE INDEX "risk_scores_service_idx" ON "risk_scores" USING btree ("service_id");