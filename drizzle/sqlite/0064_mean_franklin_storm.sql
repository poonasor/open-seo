CREATE TABLE `finding_measurements` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`kind` text NOT NULL,
	`rules_version` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`metrics` text NOT NULL,
	`deltas` text,
	`verdict` text,
	`sources` text NOT NULL,
	`measured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_measurements_unique_idx` ON `finding_measurements` (`finding_id`,`kind`,`rules_version`,`window_end`);--> statement-breakpoint
CREATE TABLE `finding_prefixes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prefix` text NOT NULL,
	`site` text NOT NULL,
	`last_number` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `finding_prefixes_project_prefix_idx` ON `finding_prefixes` (`project_id`,`prefix`);--> statement-breakpoint
CREATE TABLE `finding_stage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`finding_id` text NOT NULL,
	`from_stage` text,
	`to_stage` text NOT NULL,
	`actor` text NOT NULL,
	`note` text,
	`at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`finding_id`) REFERENCES `findings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `finding_stage_events_finding_idx` ON `finding_stage_events` (`finding_id`,`at`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`prefix` text NOT NULL,
	`number` integer NOT NULL,
	`site` text NOT NULL,
	`stage` text DEFAULT 'finding' NOT NULL,
	`finding` text NOT NULL,
	`target_page` text,
	`evidence` text,
	`route_status` text,
	`vikunja_task_id` text,
	`vikunja_task_url` text,
	`live_at` text,
	`remeasure_due_at` text,
	`verdict` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_prefix_number_idx` ON `findings` (`prefix`,`number`);--> statement-breakpoint
CREATE INDEX `findings_project_stage_idx` ON `findings` (`project_id`,`stage`);