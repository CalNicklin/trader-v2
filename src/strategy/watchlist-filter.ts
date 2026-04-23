import { isNull } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { watchlist } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

/**
 * Universe Rollout Step 3 (TRA-20).
 *
 * Strategies are migrating off the hardcoded `universe` JSON column and onto a
 * live watchlist filter. This module defines the filter schema, parses the
 * strategy row's `watchlist_filter`, queries the watchlist, and formats
 * symbols in the `"SYMBOL:EXCHANGE"` shape the rest of the evaluator expects.
 *
 * Rollback: flip `USE_WATCHLIST=false` in the env. Strategies fall back to
 * the static `universe` column without a code change.
 */

const log = createChildLogger({ module: "watchlist-filter" });

export type PromotionReason =
	| "news"
	| "research"
	| "earnings"
	| "insider"
	| "volume"
	| "rotation"
	| "feedback";

export type Horizon = "intraday" | "days" | "weeks";

export type DirectionalBias = "long" | "short" | "ambiguous";

export type Exchange = "NASDAQ" | "NYSE" | "LSE" | "AIM";

export interface WatchlistFilter {
	/** At least one of these promotion reasons must be on the watchlist row. */
	promotionReasons: PromotionReason[];
	/** If true, exclude rows where `enriched_at IS NULL` (Opus hasn't analysed yet). */
	enrichedRequired: boolean;
	/** Filter on `watchlist.horizon`. Empty array = no filter. */
	horizons: Horizon[];
	/** Filter on `watchlist.directional_bias`. Empty array = no filter. */
	directionalBiases: DirectionalBias[];
	/** Optional exchange allow-list. Empty / absent = all exchanges allowed. */
	exchanges?: Exchange[];
}

export function parseWatchlistFilter(raw: string | null): WatchlistFilter | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return null;
		if (!Array.isArray(parsed.promotionReasons)) return null;
		if (typeof parsed.enrichedRequired !== "boolean") return null;
		if (!Array.isArray(parsed.horizons)) return null;
		if (!Array.isArray(parsed.directionalBiases)) return null;
		return parsed as WatchlistFilter;
	} catch {
		return null;
	}
}

function matchesFilter(
	row: {
		exchange: string;
		promotionReasons: string;
		horizon: string | null;
		directionalBias: string | null;
		enrichedAt: string | null;
	},
	filter: WatchlistFilter,
): boolean {
	if (filter.enrichedRequired && !row.enrichedAt) return false;

	if (filter.exchanges && filter.exchanges.length > 0) {
		if (!filter.exchanges.includes(row.exchange as Exchange)) return false;
	}

	if (filter.horizons.length > 0) {
		if (!row.horizon || !filter.horizons.includes(row.horizon as Horizon)) return false;
	}

	if (filter.directionalBiases.length > 0) {
		if (
			!row.directionalBias ||
			!filter.directionalBiases.includes(row.directionalBias as DirectionalBias)
		) {
			return false;
		}
	}

	if (filter.promotionReasons.length > 0) {
		// `watchlist.promotion_reasons` is a comma-separated string (see Step 2 schema).
		const rowReasons = row.promotionReasons
			.split(",")
			.map((r) => r.trim())
			.filter((r) => r.length > 0);
		const overlap = filter.promotionReasons.some((req) => rowReasons.includes(req));
		if (!overlap) return false;
	}

	return true;
}

/**
 * Query the watchlist for non-demoted rows matching the filter. Returns
 * symbols as `"SYMBOL:EXCHANGE"` strings (the qualified form `buildEffectiveUniverse`
 * expects — no bare symbols so downstream dedup is clean).
 */
export async function getWatchlistUniverse(filter: WatchlistFilter): Promise<string[]> {
	const db = getDb();
	// Pull the live (non-demoted) rows and filter in-process. The watchlist
	// rarely exceeds a few hundred rows; in-process filtering keeps the
	// filter semantics (`promotion_reasons` is a CSV) readable without
	// reaching for raw SQL.
	const rows = await db
		.select({
			symbol: watchlist.symbol,
			exchange: watchlist.exchange,
			promotionReasons: watchlist.promotionReasons,
			horizon: watchlist.horizon,
			directionalBias: watchlist.directionalBias,
			enrichedAt: watchlist.enrichedAt,
		})
		.from(watchlist)
		.where(isNull(watchlist.demotedAt));

	const matched = rows.filter((r) => matchesFilter(r, filter));
	return matched.map((r) => `${r.symbol}:${r.exchange}`);
}

/**
 * Core public entrypoint. Given a strategy row, return the list of symbols
 * that should drive evaluation this tick.
 *
 * Dispatch logic:
 * - If `USE_WATCHLIST=false` OR `watchlistFilter` is null/empty → static
 *   `universe` column (existing behaviour, unchanged).
 * - Else → watchlist-filtered symbols.
 *
 * The returned list is then fed to `buildEffectiveUniverse` +
 * `filterByLiquidity` by the caller, exactly as before.
 */
export async function getEffectiveUniverseForStrategy(strategy: {
	id: number;
	universe: string | null;
	watchlistFilter: string | null;
}): Promise<{ universe: string[]; source: "static" | "watchlist" }> {
	const config = getConfig();
	const filter = parseWatchlistFilter(strategy.watchlistFilter);

	if (!config.USE_WATCHLIST || !filter) {
		const staticUniverse: string[] = strategy.universe ? JSON.parse(strategy.universe) : [];
		return { universe: staticUniverse, source: "static" };
	}

	const watchlistUniverse = await getWatchlistUniverse(filter);
	return { universe: watchlistUniverse, source: "watchlist" };
}

/**
 * Dual-write comparison helper. Computes both universes side-by-side so the
 * evaluator can log divergence during the 5-day parity period regardless of
 * which source is live. Returns the divergence + sizes; caller decides what
 * to log and which to actually use.
 */
export async function compareUniverses(strategy: {
	id: number;
	universe: string | null;
	watchlistFilter: string | null;
}): Promise<{
	staticUniverse: string[];
	watchlistUniverse: string[];
	onlyStatic: string[];
	onlyWatchlist: string[];
	inBoth: string[];
} | null> {
	const filter = parseWatchlistFilter(strategy.watchlistFilter);
	if (!filter) return null;

	const staticUniverse: string[] = strategy.universe ? JSON.parse(strategy.universe) : [];
	const watchlistUniverse = await getWatchlistUniverse(filter);

	const staticSet = new Set(staticUniverse);
	const watchlistSet = new Set(watchlistUniverse);

	const onlyStatic = staticUniverse.filter((s) => !watchlistSet.has(s));
	const onlyWatchlist = watchlistUniverse.filter((s) => !staticSet.has(s));
	const inBoth = staticUniverse.filter((s) => watchlistSet.has(s));

	return { staticUniverse, watchlistUniverse, onlyStatic, onlyWatchlist, inBoth };
}

export function logUniverseComparison(
	strategyId: number,
	cmp: NonNullable<Awaited<ReturnType<typeof compareUniverses>>>,
	source: "static" | "watchlist",
): void {
	log.info(
		{
			module: "evaluator:universe-compare",
			strategyId,
			staticUniverseSize: cmp.staticUniverse.length,
			watchlistUniverseSize: cmp.watchlistUniverse.length,
			divergence: {
				onlyStatic: cmp.onlyStatic,
				onlyWatchlist: cmp.onlyWatchlist,
				inBothCount: cmp.inBoth.length,
			},
			source,
		},
		"Universe source comparison",
	);
}
