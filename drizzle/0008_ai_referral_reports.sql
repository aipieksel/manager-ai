CREATE TABLE `report_channel_policies` (
	`installation_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`report_key` text NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`reviewed_by` text NOT NULL,
	`reviewed_at` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `channel_id`, `report_key`),
	CONSTRAINT "report_channel_policies_enabled" CHECK("report_channel_policies"."enabled" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `report_configurations` (
	`report_key` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`api_app_id` text NOT NULL,
	`executor_id` text NOT NULL,
	`executor_version_id` text NOT NULL,
	`reference_id` text NOT NULL,
	`reference_sha256` text NOT NULL,
	`source_config_id` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`preflight_verified_at` integer,
	`updated_at` integer NOT NULL,
	CONSTRAINT "report_key_fixed" CHECK("report_configurations"."report_key"='site.ai_referrals'),
	CONSTRAINT "report_configurations_enabled" CHECK("report_configurations"."enabled" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `report_grants` (
	`installation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`report_key` text NOT NULL,
	`project_id` text NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`reviewed_by` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `user_id`, `report_key`, `project_id`),
	CONSTRAINT "report_grants_active" CHECK("report_grants"."active" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `report_jobs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`invocation_key` text NOT NULL,
	`payload_hash` text NOT NULL,
	`installation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`requester_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`config_revision` integer NOT NULL,
	`request_json` text NOT NULL,
	`config_json` text NOT NULL,
	`stage` text DEFAULT 'preflight' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`sequence` integer DEFAULT 0 NOT NULL,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`dispatch_attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`result_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `report_jobs_invocation_key_idx` ON `report_jobs` (`invocation_key`);--> statement-breakpoint
CREATE TABLE `slack_report_deliveries` (
	`run_id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`root_thread_ts` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`file_id` text,
	`artifact_id` text,
	`fence` integer DEFAULT 0 NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
