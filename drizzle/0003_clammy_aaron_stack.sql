CREATE TABLE `codex_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`workspace_ref` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `codex_threads_conversation_agent_idx` ON `codex_threads` (`conversation_id`,`agent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `codex_threads_thread_idx` ON `codex_threads` (`thread_id`);--> statement-breakpoint
CREATE TABLE `conversation_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`project_id` text NOT NULL,
	`author_type` text NOT NULL,
	`author_ref` text NOT NULL,
	`body` text NOT NULL,
	`delivery_status` text DEFAULT 'stored' NOT NULL,
	`run_id` text,
	`reply_to_message_id` text,
	`source_type` text DEFAULT 'owner_chat' NOT NULL,
	`source_ref` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversation_messages_conversation_idx` ON `conversation_messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `conversation_messages_project_idx` ON `conversation_messages` (`project_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`default_agent_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `conversations_project_updated_idx` ON `conversations` (`project_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `project_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`label` text NOT NULL,
	`value` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_resources_identity_idx` ON `project_resources` (`project_id`,`resource_type`,`label`);--> statement-breakpoint
CREATE INDEX `project_resources_project_type_idx` ON `project_resources` (`project_id`,`resource_type`);--> statement-breakpoint
CREATE TABLE `project_variables` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`owning_service` text DEFAULT '' NOT NULL,
	`secret_ref` text,
	`configured_status` text DEFAULT 'unknown' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`last_checked_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_variables_name_idx` ON `project_variables` (`project_id`,`name`);--> statement-breakpoint
CREATE TABLE `project_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`repository_ref` text NOT NULL,
	`checkout_path` text NOT NULL,
	`launcher_alias` text,
	`tmux_session` text,
	`code_server_url` text,
	`vnc_url` text,
	`handoff_url` text,
	`instruction_paths` text DEFAULT '[]' NOT NULL,
	`skills_paths` text DEFAULT '[]' NOT NULL,
	`runtime_status` text DEFAULT 'registered' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_workspaces_project_idx` ON `project_workspaces` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_workspaces_checkout_idx` ON `project_workspaces` (`checkout_path`);