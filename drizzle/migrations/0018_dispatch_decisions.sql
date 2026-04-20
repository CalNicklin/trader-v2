CREATE TABLE `dispatch_decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`action` text NOT NULL,
	`reasoning` text NOT NULL,
	`source` text NOT NULL,
	`source_news_event_id` integer,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `dispatch_decisions_active_idx` ON `dispatch_decisions` (`expires_at`, `action`);
--> statement-breakpoint
CREATE INDEX `dispatch_decisions_strategy_symbol_idx` ON `dispatch_decisions` (`strategy_id`, `symbol`);
