DROP INDEX `slack_notification_routes_principal_event_idx`;--> statement-breakpoint
ALTER TABLE `slack_notification_routes` ADD `trigger_key` text DEFAULT 'social_post_published' NOT NULL;--> statement-breakpoint
ALTER TABLE `slack_notification_routes` ADD `event_family` text DEFAULT 'marketing.social' NOT NULL;--> statement-breakpoint
ALTER TABLE `slack_notification_routes` ADD `description` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `slack_notification_routes` ADD `variable_names` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `slack_notification_routes_principal_trigger_idx` ON `slack_notification_routes` (`principal_id`,`trigger_key`);