import {
	MAX_SPREAD_BPS,
	MIN_AVG_DOLLAR_VOLUME_USD,
	MIN_FREE_FLOAT_USD,
	MIN_LISTING_AGE_DAYS,
	MIN_PRICE_GBP_PENCE,
	MIN_PRICE_USD,
} from "./constants.ts";
import type { ConstituentRow } from "./sources.ts";

export interface FilterCandidate extends ConstituentRow {
	marketCapUsd: number | null;
	avgDollarVolume: number | null;
	price: number | null;
	freeFloatUsd: number | null;
	spreadBps: number | null;
	listingAgeDays: number | null;
}

export type RejectionReason =
	| "missing_data"
	| "low_dollar_volume"
	| "low_price"
	| "low_float"
	| "wide_spread"
	| "recent_listing";

export interface FilterResult {
	passed: FilterCandidate[];
	rejected: Array<{ candidate: FilterCandidate; reasons: RejectionReason[] }>;
}

export function applyLiquidityFilters(candidates: FilterCandidate[]): FilterResult {
	const passed: FilterCandidate[] = [];
	const rejected: FilterResult["rejected"] = [];

	for (const c of candidates) {
		const reasons: RejectionReason[] = [];

		// Missing-data check: price and avgDollarVolume are the hard requirements —
		// without them we can't evaluate liquidity at all. freeFloatUsd is NOT
		// required because UK (LSE/AIM) candidates systematically lack this data
		// (FMP profile coverage is US-only). Free-float still gets a threshold
		// check below when present.
		if (c.avgDollarVolume == null || c.price == null) {
			reasons.push("missing_data");
		}

		if (c.avgDollarVolume != null && c.avgDollarVolume < MIN_AVG_DOLLAR_VOLUME_USD) {
			reasons.push("low_dollar_volume");
		}

		if (c.price != null) {
			const isUk = c.exchange === "LSE" || c.exchange === "AIM";
			const floor = isUk ? MIN_PRICE_GBP_PENCE : MIN_PRICE_USD;
			if (c.price < floor) reasons.push("low_price");
		}

		if (c.freeFloatUsd != null && c.freeFloatUsd < MIN_FREE_FLOAT_USD) {
			reasons.push("low_float");
		}

		// Spread is tolerated as optional — many LSE/AIM names won't have live spread.
		// Only reject if we have a measurement AND it exceeds the cap.
		if (c.spreadBps != null && c.spreadBps > MAX_SPREAD_BPS) {
			reasons.push("wide_spread");
		}

		// Listing age is tolerated as optional too — if we don't know, we don't reject.
		if (c.listingAgeDays != null && c.listingAgeDays < MIN_LISTING_AGE_DAYS) {
			reasons.push("recent_listing");
		}

		if (reasons.length === 0) {
			passed.push(c);
		} else {
			rejected.push({ candidate: c, reasons });
		}
	}

	return { passed, rejected };
}
