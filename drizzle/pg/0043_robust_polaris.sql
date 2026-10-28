ALTER TABLE "finding_prefixes" ADD COLUMN "vikunja_project_id" text;--> statement-breakpoint
ALTER TABLE "findings" ADD COLUMN "vikunja_done" boolean;