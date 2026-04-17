CREATE TABLE `investable_universe` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`index_source` text NOT NULL,
	`market_cap_usd` real,
	`avg_dollar_volume` real,
	`price` real,
	`free_float_usd` real,
	`spread_bps` real,
	`listing_age_days` integer,
	`inclusion_date` text NOT NULL,
	`last_refreshed` text NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `investable_universe_symbol_exchange_unique` ON `investable_universe` (`symbol`,`exchange`);--> statement-breakpoint
CREATE TABLE `universe_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`snapshot_date` text NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`action` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `universe_snapshots_date_idx` ON `universe_snapshots` (`snapshot_date`);