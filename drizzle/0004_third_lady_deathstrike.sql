CREATE TABLE `task_agent_assignments` (
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`assignment_state` text DEFAULT 'assigned' NOT NULL,
	`latest_run_id` text,
	`assigned_by` text NOT NULL,
	`assigned_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_agent_assignments_pair_idx` ON `task_agent_assignments` (`task_id`,`agent_id`);