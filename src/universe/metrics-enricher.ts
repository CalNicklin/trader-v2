import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import type { FilterCandidate } from "./filters.ts";
import type { ConstituentRow } from "./sources.ts";

// Enriches constituents with market-cap, avg volume, price, and spread data
// sourced from the existing quotes_cache table. Symbols with no cached data
// get null fields and are rejected by the filters with reason "missing_data".
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
