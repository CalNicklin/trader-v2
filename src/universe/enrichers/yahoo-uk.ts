import { createChildLogger } from "../../utils/logger.ts";
import type { ConstituentRow } from "../sources.ts";

const log = createChildLogger({ module: "yahoo-uk-enricher" });

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const BATCH_CONCURRENCY = 4;

// Yahoo chart endpoint payload we care about
interface YahooChartResponse {
	chart: {
		result?: Array<{
			meta: {
				symbol: string;
				currency: string;
				regularMarketPrice: number;
			};
			indicators: {
				quote: Array<{ close: (number | null)[]; volume: (number | null)[] }>;
			};
		}>;
		error?: { code: string; description: string };
	};
}

export interface YahooUkQuote {
	symbol: string;
	exchange: string;
	priceGbpPence: number;
	avgVolume30d: number;
	avgDollarVolumeUsd: number;
}

export interface YahooUkEnrichDeps {
	fetchImpl?: typeof fetch;
	fetchFxImpl?: () => Promise<number>;
}

// Fetches Yahoo chart data for UK rows (ftse_350, aim_allshare). Returns a map
// keyed by `${symbol}:${exchange}` carrying price (native GBp pence), 30d avg
// volume, and the FX-converted avg dollar volume in USD — the unit our
// liquidity filter expects.
//
// We do this at refresh time because IBKR's quotes_cache only covers symbols
// already being actively tracked. New UK candidates (never seen before) have
// no quotes_cache entry and would be filter-rejected as missing_data.
export async function fetchYahooUkQuotes(
	rows: ConstituentRow[],
	deps: YahooUkEnrichDeps = {},
): Promise<Map<string, YahooUkQuote>> {
	const ukRows = rows.filter((r) => r.exchange === "LSE" || r.exchange === "AIM");
	if (ukRows.length === 0) return new Map();

	const fetchImpl = deps.fetchImpl ?? fetch;
	const fxImpl = deps.fetchFxImpl ?? defaultFetchGbpUsd;

	const gbpUsd = await fxImpl();

	const out = new Map<string, YahooUkQuote>();
	// Throttle: process in concurrency-limited batches to be polite to Yahoo
	for (let i = 0; i < ukRows.length; i += BATCH_CONCURRENCY) {
		const batch = ukRows.slice(i, i + BATCH_CONCURRENCY);
		const results = await Promise.all(batch.map((r) => fetchOne(r, fetchImpl, gbpUsd)));
		for (const quote of results) {
			if (quote) out.set(`${quote.symbol}:${quote.exchange}`, quote);
		}
	}

	log.info(
		{ requested: ukRows.length, fetched: out.size, fx: gbpUsd },
		"Yahoo UK quotes enrichment complete",
	);
	return out;
}

async function fetchOne(
	row: ConstituentRow,
	fetchImpl: typeof fetch,
	gbpUsd: number,
): Promise<YahooUkQuote | null> {
	const yahooSymbol = `${row.symbol}.L`;
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=30d`;
	try {
		const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
		if (!res.ok) {
			log.debug({ symbol: row.symbol, status: res.status }, "Yahoo chart non-200");
			return null;
		}
		const data = (await res.json()) as YahooChartResponse;
		if (data.chart.error) {
			log.debug({ symbol: row.symbol, err: data.chart.error.description }, "Yahoo chart error");
			return null;
		}
		const result = data.chart.result?.[0];
		if (!result) return null;

		const volumes = result.indicators.quote[0]?.volume ?? [];
		const validVols = volumes.filter((v): v is number => typeof v === "number" && v > 0);
		if (validVols.length === 0) return null;

		const avgVolume30d = validVols.reduce((a, b) => a + b, 0) / validVols.length;
		const priceGbpPence = result.meta.regularMarketPrice;
		const priceGbp = result.meta.currency === "GBp" ? priceGbpPence / 100 : priceGbpPence;
		const avgDollarVolumeUsd = priceGbp * gbpUsd * avgVolume30d;

		return {
			symbol: row.symbol,
			exchange: row.exchange,
			priceGbpPence,
			avgVolume30d,
			avgDollarVolumeUsd,
		};
	} catch (err) {
		log.debug(
			{ symbol: row.symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo chart request failed",
		);
		return null;
	}
}

// Default FX source: Frankfurter (ECB data, no key required, verified live).
async function defaultFetchGbpUsd(): Promise<number> {
	const res = await fetch("https://api.frankfurter.dev/v1/latest?from=GBP&to=USD");
	if (!res.ok) {
		throw new Error(`Frankfurter FX fetch failed: ${res.status} ${res.statusText}`);
	}
	const data = (await res.json()) as { rates: { USD: number } };
	return data.rates.USD;
}
