ALTER TABLE "image_tags" ADD COLUMN "built_at" timestamp with time zone DEFAULT now() NOT NULL;
UPDATE "image_tags" SET "built_at" = "last_seen_at";
