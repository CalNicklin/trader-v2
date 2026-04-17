CREATE TABLE `research_outcome` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`news_analysis_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`predicted_direction` text NOT NULL,
	`confidence` real NOT NULL,
	`event_type` text NOT NULL,
	`price_at_call` real,
	`realised_move_24h` real,
	`realised_move_48h` real,
	`filled_24h_at` text,
	`filled_48h_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `research_outcome_analysis_idx` ON `research_outcome` (`news_analysis_id`);--> statement-breakpoint
CREATE INDEX `research_outcome_symbol_idx` ON `research_outcome` (`symbol`,`exchange`);