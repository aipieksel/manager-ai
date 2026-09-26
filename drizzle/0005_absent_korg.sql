CREATE TABLE `slack_notification_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`display_name` text NOT NULL,
	`event_type` text DEFAULT 'social.post.published' NOT NULL,
	`slack_channel_id` text NOT NULL,
	`allowed_platforms` text DEFAULT '["linkedin","x"]' NOT NULL,
	`message_template` text DEFAULT '{agent} published {title} on {platform}: {url}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_notification_routes_principal_event_idx` ON `slack_notification_routes` (`principal_id`,`event_type`);