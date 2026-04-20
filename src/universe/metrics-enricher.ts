import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { fetchUsProfiles, type UsProfile } from "./enrichers/us-profile.ts";
import { fetchYahooUkQuotes, type YahooUkQuote } from "./enrichers/yahoo-uk.ts";
import type { FilterCandidate } from "./filters.ts";
import type { ConstituentRow, FetchLike } from "./sources.ts";

const log = createChildLogger({ module: "universe-metrics-enricher" });

// Enriches constituents with market-cap, free-float, price, volume, and spread.
// Strategy:
//   - US candidates (russell_1000): compose profile from EDGAR shares frames +
//     Yahoo US chart (price, $ADV, IPO date). No FMP calls.
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
	// Override US profile enricher; defaults to live EDGAR + Yahoo US composer.
	// Tests pass `() => new Map()` to disable the enricher entirely.
	usProfileEnricher?: (rows: ConstituentRow[]) => Promise<Map<string, UsProfile>>;
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

	const usProfiles = await safeUsProfiles(rows, options.usProfileEnricher);
	const quotes = await loadQuotes(rows);
	const yahooUk = await safeYahooUk(rows, options.yahooUkEnricher);

	return rows.map((r) => enrichOne(r, usProfiles, quotes, yahooUk));
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

async function safeUsProfiles(
	rows: ConstituentRow[],
	override?: (rows: ConstituentRow[]) => Promise<Map<string, UsProfile>>,
): Promise<Map<string, UsProfile>> {
	const enricher = override ?? fetchUsProfiles;
	try {
		return await enricher(rows);
	} catch (err) {
		log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"US profile enrichment failed — US rows will lack market cap / IPO date",
		);
		return new Map();
	}
}

// ---- helpers ----

function keyOf(symbol: string, exchange: string): string {
	return `${symbol}:${exchange}`;
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
	usProfiles: Map<string, UsProfile>,
	quotes: Map<string, QuoteRow>,
	yahooUk: Map<string, YahooUkQuote>,
): FilterCandidate {
	const key = keyOf(row.symbol, row.exchange);
	const usProfile = usProfiles.get(key) ?? null;
	const quote = quotes.get(key) ?? null;
	const yahooUkQ = yahooUk.get(key) ?? null;

	// Price priority: live quotes_cache > US profile (Yahoo) > UK pence.
	const price = quote?.last ?? usProfile?.priceUsd ?? yahooUkQ?.priceGbpPence ?? null;

	// avgDollarVolume priority:
	//  - Yahoo UK (FX-converted USD) for UK rows
	//  - Yahoo US (native USD) for US rows
	//  - quotes_cache fallback (native × volume; correct for US, wrong for UK
	//    — but UK always has a yahooUkQ hit so the fallback is US-only in practice)
	const avgDollarVolume =
		yahooUkQ?.avgDollarVolumeUsd ??
		usProfile?.avgDollarVolumeUsd ??
		(quote?.avgVolume != null && quote?.last != null ? quote.avgVolume * quote.last : null);

	const spreadBps =
		quote?.bid != null && quote?.ask != null && quote.bid > 0 && quote.ask > 0
			? ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 10_000
			: null;

	// Free-float proxy: US rows derive from sharesOutstanding × priceUsd as an
	// overestimate (same fallback FMP profile used when floatShares was null).
	// UK rows have no free-float source in v1 — stays null. The liquidity filter
	// treats freeFloatUsd as optional, so null doesn't reject.
	let freeFloatUsd: number | null = null;
	if (usProfile?.sharesOutstanding != null && usProfile?.priceUsd != null) {
		freeFloatUsd = usProfile.sharesOutstanding * usProfile.priceUsd;
	}

	const listingAgeDays = usProfile?.ipoDate
		? Math.floor((Date.now() - Date.parse(usProfile.ipoDate)) / 86_400_000)
		: null;

	return {
		...row,
		marketCapUsd: usProfile?.marketCapUsd ?? null,
		avgDollarVolume,
		price,
		freeFloatUsd,
		spreadBps,
		listingAgeDays,
	};
}
