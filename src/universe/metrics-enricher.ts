import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import type { FilterCandidate } from "./filters.ts";
import type { ConstituentRow } from "./sources.ts";

// Enriches constituents with market-cap, avg volume, price, and spread data
// sourced from the existing quotes_cache table. Symbols with no cached data
// get null fields and are rejected by the filters with reason "missing_data".
//
// v1 posture: marketCapUsd, freeFloatUsd, and listingAgeDays are all hard-
// coded to null here because we don't yet have enrichers wired for those
// fields. The liquidity filter treats nulls as missing_data, so EVERY
// candidate will be rejected until market-cap / free-float / listing-age
// enrichers land in a follow-up. This is deliberate — Step 1 ships the
// scaffolding (tables, cron, snapshots, filters, health endpoint) so the
// pipeline is production-verified end-to-end before the enrichers hook in.
// The first useful weekly-refresh pass will be AFTER those enrichers ship.
export async function enrichWithMetrics(rows: ConstituentRow[]): Promise<FilterCandidate[]> {
	const db = getDb();
	const symbols = rows.map((r) => r.symbol);
	if (symbols.length === 0) return [];
	const quotes = await db
		.select()
		.from(quotesCache)
		.where(inArray(quotesCache.symbol, symbols))
		.all();
	const map = new Map(quotes.map((q) => [`${q.symbol}:${q.exchange}`, q]));
	return rows.map((r) => {
		const q = map.get(`${r.symbol}:${r.exchange}`);
		const avgDollarVolume = q?.avgVolume != null && q?.last != null ? q.avgVolume * q.last : null;
		return {
			...r,
			marketCapUsd: null,
			avgDollarVolume,
			price: q?.last ?? null,
			freeFloatUsd: null,
			spreadBps:
				q?.bid != null && q?.ask != null && q.bid > 0 && q.ask > 0
					? ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10_000
					: null,
			listingAgeDays: null,
		};
	});
}
