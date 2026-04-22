ALTER TABLE `trade_insights` ADD `quarantined` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `trade_insights`
SET `quarantined` = 1
WHERE `insight_type` = 'trade_review'
  AND `created_at` < '2026-04-22T12:37:00Z';
