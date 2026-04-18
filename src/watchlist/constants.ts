// Promotion triggers
export const VOLUME_TRIGGER_RATIO = 3.0;
export const EARNINGS_LOOKAHEAD_DAYS = 5;
export const RESEARCH_MIN_CONFIDENCE = 0.75;
export const FEEDBACK_INSIGHT_THRESHOLD = 3;
export const FEEDBACK_INSIGHT_WINDOW_DAYS = 14;
export const FEEDBACK_MIN_CONFIDENCE = 0.8;

// Watchlist state
export const WATCHLIST_CAP_SOFT = 150;
export const WATCHLIST_CAP_HARD = 300;
export const DEFAULT_PROMOTION_TTL_HOURS = 72;

// Enrichment
export const ENRICH_BATCH_SIZE = 10;
export const ENRICHMENT_RETRY_HOURS = 24;
export const ENRICHMENT_DEMOTION_HOURS = 48;

// Demotion
export const STALENESS_HOURS = 72;
export const VOLUME_COLLAPSE_SESSIONS = 3;
export const POSITION_CLOSED_IDLE_HOURS = 24;

export type PromotionReason = "news" | "research" | "earnings" | "volume" | "feedback";
export type DemotionReason =
	| "stale"
	| "resolved"
	| "volume_collapse"
	| "universe_removed"
	| "feedback_demote"
	| "position_closed"
	| "enrichment_failed"
	| "cap_eviction";
