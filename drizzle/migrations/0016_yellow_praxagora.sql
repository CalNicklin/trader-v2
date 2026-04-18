CREATE TABLE `catalyst_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`event_type` text NOT NULL,
	`source` text NOT NULL,
	`payload` text,
	`fired_at` text NOT NULL,
	`led_to_promotion` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `catalyst_events_symbol_exchange_fired_idx` ON `catalyst_events` (`symbol`,`exchange`,`fired_at`);--> statement-breakpoint
CREATE INDEX `catalyst_events_type_fired_idx` ON `catalyst_events` (`event_type`,`fired_at`);--> statement-breakpoint
CREATE TABLE `watchlist` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`promoted_at` text NOT NULL,
	`last_catalyst_at` text NOT NULL,
	`promotion_reasons` text NOT NULL,
	`catalyst_summary` text,
	`directional_bias` text,
	`horizon` text,
	`research_payload` text,
	`enriched_at` text,
	`enrichment_failed_at` text,
	`expires_at` text NOT NULL,
	`demoted_at` text,
	`demotion_reason` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watchlist_active_symbol_exchange_unique` ON `watchlist` (`symbol`,`exchange`) WHERE "watchlist"."demoted_at" IS NULL;--> statement-breakpoint
CREATE INDEX `watchlist_demoted_at_idx` ON `watchlist` (`demoted_at`);--> statement-breakpoint
CREATE INDEX `watchlist_enriched_at_idx` ON `watchlist` (`enriched_at`);