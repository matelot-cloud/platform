ALTER TABLE "image_tags" ALTER COLUMN "built_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "image_tags" ALTER COLUMN "built_at" DROP NOT NULL;UPDATE "image_tags" SET "built_at" = NULL;
