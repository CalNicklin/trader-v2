import type { WatchlistRow } from "./repo.ts";

// Composite rank: primary = catalyst recency, tiebreaker = reason count.
// Rows returned in order: [highest-rank ... lowest-rank].
// Callers evict from the tail.
export function rankForCapEviction(rows: WatchlistRow[]): WatchlistRow[] {
	return [...rows].sort((a, b) => {
		const cmp = b.lastCatalystAt.localeCompare(a.lastCatalystAt);
		if (cmp !== 0) return cmp;
		const aCount = a.promotionReasons.split(",").length;
		const bCount = b.promotionReasons.split(",").length;
		return bCount - aCount;
	});
}
