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
// TRA-41: per-region cap eviction. UK names age faster on the wall clock
// than US ones (LSE close 16:30 UK vs US close 21:00 UK), so a single sweep
// at 22:55 UK with a global cap deterministically evicts UK every night.
// Splitting the cap into two regional pools — each pass run shortly after
// its market close — gives UK a fair share of the watchlist.
export const WATCHLIST_CAP_UK = 30;
export const WATCHLIST_CAP_US = 120;
export const UK_EXCHANGES = ["LSE", "AIM"] as const;
export const US_EXCHANGES = ["NASDAQ", "NYSE"] as const;
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
