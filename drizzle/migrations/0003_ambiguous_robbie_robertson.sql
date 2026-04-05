ALTER TABLE `news_events` ADD `earnings_surprise` real;--> statement-breakpoint
ALTER TABLE `news_events` ADD `guidance_change` real;--> statement-breakpoint
ALTER TABLE `news_events` ADD `management_tone` real;--> statement-breakpoint
ALTER TABLE `news_events` ADD `regulatory_risk` real;--> statement-breakpoint
ALTER TABLE `news_events` ADD `acquisition_likelihood` real;--> statement-breakpoint
ALTER TABLE `news_events` ADD `catalyst_type` text;--> statement-breakpoint
ALTER TABLE `news_events` ADD `expected_move_duration` text;--> statement-breakpoint
ALTER TABLE `quotes_cache` ADD `news_earnings_surprise` real;--> statement-breakpoint
ALTER TABLE `quotes_cache` ADD `news_guidance_change` real;--> statement-breakpoint
ALTER TABLE `quotes_cache` ADD `news_management_tone` real;--> statement-breakpoint
ALTER TABLE `quotes_cache` ADD `news_regulatory_risk` real;--> statement-breakpoint
ALTER TABLE `quotes_cache` ADD `news_acquisition_likelihood` real;--> statement-breakpoint
ALTER TABLE `quotes_cache` ADD `news_catalyst_type` text;--> statement-breakpoint
ALTER TABLE `quotes_cache` ADD `news_expected_move_duration` text;