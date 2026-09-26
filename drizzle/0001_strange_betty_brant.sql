CREATE TABLE `runtime_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `setup_job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`requested_by` text NOT NULL,
	`runner_status` integer,
	`output` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
