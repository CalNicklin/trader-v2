import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "yahoo-us-data" });

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export interface YahooUsQuoteData {
	symbol: string;
	exchange: string;
	last: number | null;
	volume: number | null;
	avgVolume: number | null;
	changePercent: number | null;
}

export interface YahooUsBar {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

interface YahooChartResponse {
	chart: {
		result?: Array<{
			meta: {
				symbol?: string;
				currency?: string;
				regularMarketPrice?: number;
				regularMarketVolume?: number;
				previousClose?: number;
			};
			timestamp?: number[];
			indicators: {
				quote: Array<{
					open?: (number | null)[];
					high?: (number | null)[];
					low?: (number | null)[];
					close?: (number | null)[];
					volume?: (number | null)[];
				}>;
			};
		}>;
		error?: { code: string; description: string };
	};
}

export interface YahooFetchDeps {
	fetchImpl?: typeof fetch;
}

// US quote — returns the standard quote shape downstream expects. UK callers
// already route to IBKR via broker/market-data.ts; this module is US-only.
export async function yahooUsQuote(
	symbol: string,
	exchange: string,
	deps: YahooFetchDeps = {},
): Promise<YahooUsQuoteData | null> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
	try {
		const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
		if (!res.ok) {
			log.debug({ symbol, status: res.status }, "Yahoo chart non-200");
			return null;
		}
		const data = (await res.json()) as YahooChartResponse;
		if (data.chart.error) return null;
		const result = data.chart.result?.[0];
		if (!result) return null;

		const volumes = result.indicators.quote[0]?.volume ?? [];
		const validVols = volumes.filter((v): v is number => typeof v === "number" && v > 0);
		const avgVolume =
			validVols.length > 0 ? validVols.reduce((a, b) => a + b) / validVols.length : null;

		const last = result.meta.regularMarketPrice ?? null;
		const prev = result.meta.previousClose ?? null;
		const changePercent =
			last != null && prev != null && prev !== 0 ? ((last - prev) / prev) * 100 : null;

		return {
			symbol,
			exchange,
			last,
			volume: result.meta.regularMarketVolume ?? null,
			avgVolume,
			changePercent,
		};
	} catch (err) {
		log.debug(
			{ symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo chart request failed",
		);
		return null;
	}
}

// US historical bars — mirrors HistoricalBar shape for drop-in replacement.
// Returns newest-last (chronological) to match existing expectations.
export async function yahooUsHistorical(
	symbol: string,
	_exchange: string,
	days: number,
	deps: YahooFetchDeps = {},
): Promise<YahooUsBar[] | null> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const range =
		days <= 5
			? "5d"
			: days <= 30
				? "1mo"
				: days <= 90
					? "3mo"
					: days <= 180
						? "6mo"
						: days <= 365
							? "1y"
							: "5y";
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
	try {
		const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
		if (!res.ok) return null;
		const data = (await res.json()) as YahooChartResponse;
		if (data.chart.error) return null;
		const result = data.chart.result?.[0];
		if (!result?.timestamp || !result.indicators.quote[0]) return null;

		const { open, high, low, close, volume } = result.indicators.quote[0];
		if (!open || !high || !low || !close || !volume) return null;

		const bars: YahooUsBar[] = [];
		for (let i = 0; i < result.timestamp.length; i++) {
			const o = open[i];
			const h = high[i];
			const l = low[i];
			const c = close[i];
			const v = volume[i];
			const ts = result.timestamp[i];
			if (o == null || h == null || l == null || c == null || v == null || ts == null) continue;
			bars.push({
				date: new Date(ts * 1000).toISOString().slice(0, 10),
				open: o,
				high: h,
				low: l,
				close: c,
				volume: v,
			});
		}
		return bars;
	} catch (err) {
		log.debug(
			{ symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo historical request failed",
		);
		return null;
	}
}
