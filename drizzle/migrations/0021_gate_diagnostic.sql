CREATE TABLE `gate_diagnostic` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gate_name` text NOT NULL,
	`trigger_symbol` text NOT NULL,
	`trigger_news_event_id` integer NOT NULL,
	`fired_at` text NOT NULL,
	`basket_snapshot_at_fire` text NOT NULL,
	`basket_snapshot_at_5d` text,
	`basket_avg_move_pct` real,
	`basket_hit_threshold` integer,
	`measured_at` text
);
--> statement-breakpoint
CREATE INDEX `gate_diagnostic_gate_fired_idx` ON `gate_diagnostic` (`gate_name`, `fired_at`);
--> statement-breakpoint
CREATE INDEX `gate_diagnostic_unmeasured_idx` ON `gate_diagnostic` (`measured_at`, `fired_at`);
