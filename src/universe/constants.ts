// Liquidity thresholds for investable universe eligibility.
// All symbols in the universe must pass ALL filters below.

export const MIN_AVG_DOLLAR_VOLUME_USD = 5_000_000; // 20-day median dollar volume
export const MIN_PRICE_USD = 5; // US microstructure floor
export const MIN_PRICE_GBP_PENCE = 100; // UK microstructure floor (1 GBP)
export const MIN_FREE_FLOAT_USD = 100_000_000;
export const MAX_SPREAD_BPS = 25;
export const MIN_LISTING_AGE_DAYS = 90;

// Universe size safety caps (additive, not a filter)
export const MAX_UNIVERSE_SIZE = 2_000; // hard ceiling across all index sources
