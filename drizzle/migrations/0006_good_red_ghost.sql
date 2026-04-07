CREATE TABLE `news_analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`news_event_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`sentiment` real NOT NULL,
	`urgency` text NOT NULL,
	`event_type` text NOT NULL,
	`direction` text NOT NULL,
	`trade_thesis` text NOT NULL,
	`confidence` real NOT NULL,
	`recommend_trade` integer NOT NULL,
	`in_universe` integer NOT NULL,
	`price_at_analysis` real,
	`price_after_1d` real,
	`price_after_1w` real,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `news_analyses_news_event_idx` ON `news_analyses` (`news_event_id`);--> statement-breakpoint
CREATE INDEX `news_analyses_symbol_idx` ON `news_analyses` (`symbol`);--> statement-breakpoint
CREATE INDEX `news_analyses_in_universe_idx` ON `news_analyses` (`in_universe`);--> statement-breakpoint
CREATE UNIQUE INDEX `news_analyses_event_symbol_uniq` ON `news_analyses` (`news_event_id`,`symbol`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_trade_insights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer,
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
--> statement-breakpoint
INSERT INTO `__new_trade_insights`("id", "strategy_id", "trade_id", "insight_type", "tags", "observation", "suggested_action", "confidence", "prompt_version", "led_to_improvement", "created_at") SELECT "id", "strategy_id", "trade_id", "insight_type", "tags", "observation", "suggested_action", "confidence", "prompt_version", "led_to_improvement", "created_at" FROM `trade_insights`;--> statement-breakpoint
DROP TABLE `trade_insights`;--> statement-breakpoint
ALTER TABLE `__new_trade_insights` RENAME TO `trade_insights`;--> statement-breakpoint
PRAGMA foreign_keys=ON;