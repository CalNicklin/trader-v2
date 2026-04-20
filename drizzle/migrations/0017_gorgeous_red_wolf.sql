CREATE TABLE `symbol_ciks` (
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`cik` integer NOT NULL,
	`entity_name` text,
	`source` text DEFAULT 'sec_company_tickers' NOT NULL,
	`fetched_at` text NOT NULL,
	PRIMARY KEY(`symbol`, `exchange`)
);
--> statement-breakpoint
CREATE INDEX `symbol_ciks_cik_idx` ON `symbol_ciks` (`cik`);