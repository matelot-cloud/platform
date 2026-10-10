CREATE TABLE "environment_finding_snapshots" (
	"environment_id" uuid NOT NULL,
	"day" timestamp with time zone NOT NULL,
	"version" text,
	"image_ref" text,
	"sbom_id" uuid,
	"critical" integer DEFAULT 0 NOT NULL,
	"high" integer DEFAULT 0 NOT NULL,
	"medium" integer DEFAULT 0 NOT NULL,
	"low" integer DEFAULT 0 NOT NULL,
	"kev" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environment_finding_snapshots" ADD CONSTRAINT "environment_finding_snapshots_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environment_finding_snapshots" ADD CONSTRAINT "environment_finding_snapshots_sbom_id_sboms_id_fk" FOREIGN KEY ("sbom_id") REFERENCES "public"."sboms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "env_finding_snapshots_key" ON "environment_finding_snapshots" USING btree ("environment_id","day");