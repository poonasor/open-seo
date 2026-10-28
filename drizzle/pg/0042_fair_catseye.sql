CREATE TABLE "finding_measurements" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"kind" text NOT NULL,
	"rules_version" text NOT NULL,
	"window_start" text NOT NULL,
	"window_end" text NOT NULL,
	"metrics" text NOT NULL,
	"deltas" text,
	"verdict" text,
	"sources" text NOT NULL,
	"measured_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_prefixes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"prefix" text NOT NULL,
	"site" text NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "finding_stage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"finding_id" text NOT NULL,
	"from_stage" text,
	"to_stage" text NOT NULL,
	"actor" text NOT NULL,
	"note" text,
	"at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"prefix" text NOT NULL,
	"number" integer NOT NULL,
	"site" text NOT NULL,
	"stage" text DEFAULT 'finding' NOT NULL,
	"finding" text NOT NULL,
	"target_page" text,
	"evidence" text,
	"route_status" text,
	"vikunja_task_id" text,
	"vikunja_task_url" text,
	"live_at" text,
	"remeasure_due_at" text,
	"verdict" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL,
	"updated_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "finding_measurements" ADD CONSTRAINT "finding_measurements_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_prefixes" ADD CONSTRAINT "finding_prefixes_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finding_stage_events" ADD CONSTRAINT "finding_stage_events_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "finding_measurements_unique_idx" ON "finding_measurements" USING btree ("finding_id","kind","rules_version","window_end");--> statement-breakpoint
CREATE UNIQUE INDEX "finding_prefixes_project_prefix_idx" ON "finding_prefixes" USING btree ("project_id","prefix");--> statement-breakpoint
CREATE INDEX "finding_stage_events_finding_idx" ON "finding_stage_events" USING btree ("finding_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_prefix_number_idx" ON "findings" USING btree ("prefix","number");--> statement-breakpoint
CREATE INDEX "findings_project_stage_idx" ON "findings" USING btree ("project_id","stage");