CREATE TABLE `symbol_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`market_cap_usd` real,
	`shares_outstanding` real,
	`free_float_shares` real,
	`ipo_date` text,
	`fetched_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `symbol_profiles_symbol_exchange_unique` ON `symbol_profiles` (`symbol`,`exchange`);