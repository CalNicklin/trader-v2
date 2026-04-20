import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { fetchYahooUkQuotes, type YahooUkQuote } from "./enrichers/yahoo-uk.ts";
import type { FilterCandidate } from "./filters.ts";
import {
	fetchSymbolProfiles,
	getProfiles,
	PROFILE_CACHE_TTL_DAYS,
	type SymbolProfile,
	upsertProfiles,
} from "./profile-fetcher.ts";
import type { ConstituentRow, FetchLike } from "./sources.ts";

const log = createChildLogger({ module: "universe-metrics-enricher" });

// Enriches constituents with market-cap, free-float, price, volume, and spread.
// Strategy:
//   - US candidates (russell_1000): fetch FMP profile for market-cap + free-float
//     + listing-age, with a `symbol_profiles` cache (last-known-good on failure).
//   - UK candidates (ftse_350, aim_allshare): at refresh time, quotes_cache is
//     usually empty for fresh candidates, so we pull price + 30d avg volume
//     from Yahoo chart and compute avg-dollar-volume with GBP→USD FX. No FMP
//     profile fetch (FMP paywalled LSE/FTSE post-Aug-2025). freeFloatUsd +
//     listingAgeDays stay null — the liquidity filter treats them as optional.
//   - All candidates also get quotes_cache data if present (IBKR-populated);
//     when a UK row has both Yahoo and quotes_cache, the metrics_enricher
//     prefers quotes_cache for price/spread (live) and Yahoo for $ADV
//     (30-day averaged).
export interface EnrichOptions {
	fetchImpl?: FetchLike;
	// Override Yahoo UK enricher; defaults to live Yahoo chart API.
	// Tests pass `() => new Map()` to disable the enricher entirely.
	yahooUkEnricher?: (rows: ConstituentRow[]) => Promise<Map<string, YahooUkQuote>>;
}

interface QuoteRow {
	symbol: string;
	exchange: string;
	last: number | null;
	avgVolume: number | null;
	bid: number | null;
	ask: number | null;
}

export async function enrichWithMetrics(
	rows: ConstituentRow[],
	options: EnrichOptions = {},
): Promise<FilterCandidate[]> {
	if (rows.length === 0) return [];

	const profiles = await resolveProfiles(rows, options.fetchImpl ?? fetch);
	const quotes = await loadQuotes(rows);
	const yahooUk = await safeYahooUk(rows, options.yahooUkEnricher);

	return rows.map((r) => enrichOne(r, profiles, quotes, yahooUk));
}

// Wrap Yahoo enrichment in a try/catch so the refresh as a whole survives a
// Yahoo outage. Empty map on failure → UK rows fall back to quotes_cache
// (likely empty on first refresh → filter rejects as missing_data, which is
// the same "fail gracefully" behaviour as a missing FMP profile).
async function safeYahooUk(
	rows: ConstituentRow[],
	override?: (rows: ConstituentRow[]) => Promise<Map<string, YahooUkQuote>>,
): Promise<Map<string, YahooUkQuote>> {
	const enricher = override ?? fetchYahooUkQuotes;
	try {
		return await enricher(rows);
	} catch (err) {
		log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"Yahoo UK enrichment failed — UK rows will lack price/volume",
		);
		return new Map();
	}
}

// ---- helpers ----

function keyOf(symbol: string, exchange: string): string {
	return `${symbol}:${exchange}`;
}

// Explicit allowlist — if a new indexSource is added to ConstituentRow that
// needs FMP profile enrichment, add it here. Anything not listed is treated
// as "skip profile fetch, rely on quotes_cache data only" (currently UK
// markets, but safe default for any non-US index we might add).
const US_PROFILE_INDEXES = new Set<ConstituentRow["indexSource"]>(["russell_1000"]);

function isUsRow(r: ConstituentRow): boolean {
	return US_PROFILE_INDEXES.has(r.indexSource);
}

async function resolveProfiles(
	rows: ConstituentRow[],
	fetchImpl: FetchLike,
): Promise<Map<string, SymbolProfile>> {
	const profiles = new Map<string, SymbolProfile>();
	const usRows = rows.filter(isUsRow);
	if (usRows.length === 0) return profiles;

	const now = Date.now();
	const ttlMs = PROFILE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

	const stale: string[] = [];
	const cachedMap = await getProfiles(
		usRows.map((r) => ({ symbol: r.symbol, exchange: r.exchange })),
	);
	for (const r of usRows) {
		const key = keyOf(r.symbol, r.exchange);
		const cached = cachedMap.get(key);
		if (cached) profiles.set(key, cached);
		const isFresh = cached != null && now - Date.parse(cached.fetchedAt) <= ttlMs;
		if (!isFresh) stale.push(r.symbol);
	}

	if (stale.length === 0) return profiles;

	try {
		const fresh = await fetchSymbolProfiles(stale, fetchImpl);
		// FMP returns the symbol's primary exchange string; align each fresh
		// profile with the constituent row's exchange (NASDAQ/NYSE) so cache
		// keys stay consistent.
		const rowBySymbol = new Map(usRows.map((r) => [r.symbol, r]));
		const aligned: SymbolProfile[] = fresh.map((p) => {
			const r = rowBySymbol.get(p.symbol);
			return { ...p, exchange: r?.exchange ?? p.exchange };
		});

		await upsertProfiles(aligned);
		for (const p of aligned) {
			profiles.set(keyOf(p.symbol, p.exchange), p);
		}
	} catch (err) {
		log.warn(
			{
				err: err instanceof Error ? err.message : String(err),
				staleCount: stale.length,
			},
			"Profile fetch failed; using last-known-good cache where available",
		);
		// On fetch failure, any cached profile (even stale) remains in the map.
	}

	return profiles;
}

async function loadQuotes(rows: ConstituentRow[]): Promise<Map<string, QuoteRow>> {
	const db = getDb();
	const symbols = rows.map((r) => r.symbol);
	if (symbols.length === 0) return new Map<string, QuoteRow>();
	const quotes = await db
		.select()
		.from(quotesCache)
		.where(inArray(quotesCache.symbol, symbols))
		.all();
	return new Map(quotes.map((q) => [keyOf(q.symbol, q.exchange), q] as const));
}

function enrichOne(
	row: ConstituentRow,
	profiles: Map<string, SymbolProfile>,
	quotes: Map<string, QuoteRow>,
	yahooUk: Map<string, YahooUkQuote>,
): FilterCandidate {
	const key = keyOf(row.symbol, row.exchange);
	const profile = profiles.get(key) ?? null;
	const quote = quotes.get(key) ?? null;
	const yahoo = yahooUk.get(key) ?? null;

	// Price priority: live quotes_cache > Yahoo 30d last close.
	const price = quote?.last ?? yahoo?.priceGbpPence ?? null;

	// avgDollarVolume: for UK rows prefer Yahoo's pre-computed USD value (handles
	// GBp→USD FX correctly). For US rows (or UK rows with quotes_cache data) fall
	// back to the native-unit computation. Note: the native-unit fallback is only
	// correct for USD-denominated rows (russell_1000); UK rows without Yahoo data
	// will have nonsense dollar volume and get filtered out as low_dollar_volume,
	// which is the desired safe-default behaviour.
	const avgDollarVolume =
		yahoo?.avgDollarVolumeUsd ??
		(quote?.avgVolume != null && quote?.last != null ? quote.avgVolume * quote.last : null);

	const spreadBps =
		quote?.bid != null && quote?.ask != null && quote.bid > 0 && quote.ask > 0
			? ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 10_000
			: null;

	// freeFloatUsd: floatShares × price if available, else sharesOutstanding × price
	// as overestimate fallback. See spec for rationale.
	let freeFloatUsd: number | null = null;
	if (profile != null && price != null) {
		if (profile.freeFloatShares != null) {
			freeFloatUsd = profile.freeFloatShares * price;
		} else if (profile.sharesOutstanding != null) {
			freeFloatUsd = profile.sharesOutstanding * price;
		}
	}

	const listingAgeDays = profile?.ipoDate
		? Math.floor((Date.now() - Date.parse(profile.ipoDate)) / 86_400_000)
		: null;

	return {
		...row,
		marketCapUsd: profile?.marketCapUsd ?? null,
		avgDollarVolume,
		price,
		freeFloatUsd,
		spreadBps,
		listingAgeDays,
	};
}
