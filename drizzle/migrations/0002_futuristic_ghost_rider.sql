CREATE TABLE `learning_loop_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`config_type` text NOT NULL,
	`prompt_version` integer DEFAULT 1 NOT NULL,
	`prompt_text` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`hit_rate` real,
	`created_at` text NOT NULL,
	`retired_at` text
);
--> statement-breakpoint
CREATE TABLE `trade_insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`trade_id` integer,
	`insight_type` text NOT NULL,
	`tags` text,
	`observation` text NOT NULL,
	`suggested_action` text,
	`confidence` real,
	`prompt_version` integer,
	`led_to_improvement` integer,
	`created_at` text NOT NULL
);
