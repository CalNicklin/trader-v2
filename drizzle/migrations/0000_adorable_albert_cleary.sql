CREATE TABLE `agent_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text NOT NULL,
	`phase` text,
	`message` text NOT NULL,
	`data` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`portfolio_value` real NOT NULL,
	`cash_balance` real NOT NULL,
	`positions_value` real NOT NULL,
	`daily_pnl` real NOT NULL,
	`daily_pnl_percent` real NOT NULL,
	`total_pnl` real NOT NULL,
	`paper_strategies_active` integer DEFAULT 0 NOT NULL,
	`live_strategies_active` integer DEFAULT 0 NOT NULL,
	`trades_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_snapshots_date_unique` ON `daily_snapshots` (`date`);--> statement-breakpoint
CREATE TABLE `earnings_calendar` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`date` text NOT NULL,
	`estimated_eps` real,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `graduation_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`event` text NOT NULL,
	`from_tier` text,
	`to_tier` text,
	`evidence` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `improvement_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`files_changed` text,
	`pr_url` text,
	`status` text DEFAULT 'PROPOSED' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `live_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`quantity` real NOT NULL,
	`avg_cost` real NOT NULL,
	`current_price` real,
	`unrealized_pnl` real,
	`market_value` real,
	`stop_loss_price` real,
	`trailing_stop_price` real,
	`high_water_mark` real,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `live_positions_symbol_exchange_unique` ON `live_positions` (`symbol`,`exchange`);--> statement-breakpoint
CREATE TABLE `live_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`side` text NOT NULL,
	`quantity` real NOT NULL,
	`order_type` text NOT NULL,
	`limit_price` real,
	`fill_price` real,
	`commission` real,
	`friction` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`ib_order_id` integer,
	`reasoning` text,
	`confidence` real,
	`pnl` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`filled_at` text
);
--> statement-breakpoint
CREATE TABLE `news_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`headline` text NOT NULL,
	`url` text,
	`symbols` text,
	`sentiment` real,
	`confidence` real,
	`tradeable` integer,
	`event_type` text,
	`urgency` text,
	`classified_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_positions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`quantity` real NOT NULL,
	`entry_price` real NOT NULL,
	`current_price` real,
	`stop_loss` real,
	`trailing_stop` real,
	`high_water_mark` real,
	`unrealized_pnl` real,
	`opened_at` text NOT NULL,
	`closed_at` text
);
--> statement-breakpoint
CREATE TABLE `paper_trades` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text DEFAULT 'NASDAQ' NOT NULL,
	`side` text NOT NULL,
	`quantity` real NOT NULL,
	`price` real NOT NULL,
	`friction` real DEFAULT 0 NOT NULL,
	`pnl` real,
	`signal_type` text NOT NULL,
	`reasoning` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `quotes_cache` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`symbol` text NOT NULL,
	`exchange` text NOT NULL,
	`last` real,
	`bid` real,
	`ask` real,
	`volume` integer,
	`avg_volume` integer,
	`change_percent` real,
	`news_sentiment` real,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quotes_cache_symbol_exchange_unique` ON `quotes_cache` (`symbol`,`exchange`);--> statement-breakpoint
CREATE TABLE `strategies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`parameters` text NOT NULL,
	`signals` text,
	`universe` text,
	`status` text DEFAULT 'paper' NOT NULL,
	`virtual_balance` real DEFAULT 10000 NOT NULL,
	`parent_strategy_id` integer,
	`generation` integer DEFAULT 1 NOT NULL,
	`created_by` text DEFAULT 'seed',
	`created_at` text NOT NULL,
	`retired_at` text
);
--> statement-breakpoint
CREATE TABLE `strategy_metrics` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`strategy_id` integer NOT NULL,
	`sample_size` integer DEFAULT 0 NOT NULL,
	`win_rate` real,
	`expectancy` real,
	`profit_factor` real,
	`sharpe_ratio` real,
	`sortino_ratio` real,
	`max_drawdown_pct` real,
	`calmar_ratio` real,
	`consistency_score` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `strategy_mutations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer NOT NULL,
	`child_id` integer NOT NULL,
	`mutation_type` text NOT NULL,
	`parameter_diff` text,
	`parent_sharpe` real,
	`child_sharpe` real,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `token_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_creation_tokens` integer,
	`cache_read_tokens` integer,
	`estimated_cost_usd` real NOT NULL,
	`status` text,
	`created_at` text NOT NULL
);
