import { createChildLogger } from "../../utils/logger.ts";
import type { ConstituentRow } from "../sources.ts";

const log = createChildLogger({ module: "yahoo-us-enricher" });

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const BATCH_CONCURRENCY = 4;

interface YahooChartResponse {
	chart: {
		result?: Array<{
			meta: {
				symbol: string;
				currency: string;
				regularMarketPrice: number;
				firstTradeDate?: number;
			};
			indicators: {
				quote: Array<{ close: (number | null)[]; volume: (number | null)[] }>;
			};
		}>;
		error?: { code: string; description: string };
	};
}

export interface YahooUsQuote {
	symbol: string;
	exchange: string;
	priceUsd: number;
	avgVolume30d: number;
	avgDollarVolumeUsd: number;
	ipoDate: string | null; // ISO YYYY-MM-DD
}

export interface YahooUsEnrichDeps {
	fetchImpl?: typeof fetch;
}

// Fetches Yahoo chart data for US rows (russell_1000). Returns a map keyed by
// `${symbol}:${exchange}` with price, 30d avg volume, USD-denominated $ADV,
// and an IPO date proxy from `firstTradeDate`.
export async function fetchYahooUsQuotes(
	rows: ConstituentRow[],
	deps: YahooUsEnrichDeps = {},
): Promise<Map<string, YahooUsQuote>> {
	const usRows = rows.filter((r) => r.exchange === "NASDAQ" || r.exchange === "NYSE");
	if (usRows.length === 0) return new Map();

	const fetchImpl = deps.fetchImpl ?? fetch;
	const out = new Map<string, YahooUsQuote>();

	// Throttle: process in concurrency-limited batches to be polite to Yahoo.
	for (let i = 0; i < usRows.length; i += BATCH_CONCURRENCY) {
		const batch = usRows.slice(i, i + BATCH_CONCURRENCY);
		const results = await Promise.all(batch.map((r) => fetchOne(r, fetchImpl)));
		for (const q of results) {
			if (q) out.set(`${q.symbol}:${q.exchange}`, q);
		}
	}

	log.info({ requested: usRows.length, fetched: out.size }, "Yahoo US quotes enrichment complete");
	return out;
}

async function fetchOne(
	row: ConstituentRow,
	fetchImpl: typeof fetch,
): Promise<YahooUsQuote | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${row.symbol}?interval=1d&range=30d`;
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
		const priceUsd = result.meta.regularMarketPrice;
		const avgDollarVolumeUsd = priceUsd * avgVolume30d;
		const ipoDate = result.meta.firstTradeDate
			? new Date(result.meta.firstTradeDate * 1000).toISOString().slice(0, 10)
			: null;

		return {
			symbol: row.symbol,
			exchange: row.exchange,
			priceUsd,
			avgVolume30d,
			avgDollarVolumeUsd,
			ipoDate,
		};
	} catch (err) {
		log.debug(
			{ symbol: row.symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo chart request failed",
		);
		return null;
	}
}
