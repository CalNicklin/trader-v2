import { ibkrHistorical } from "../broker/market-data.ts";
import { yahooUsHistorical } from "../data/yahoo-us.ts";
import { createChildLogger } from "../utils/logger.ts";
import { type Candle, calcATR, calcRSI, calcVolumeRatio } from "./indicators.ts";

const log = createChildLogger({ module: "historical" });

export interface SymbolIndicators {
	rsi14: number | null;
	atr14: number | null;
	volume_ratio: number | null;
}

interface CacheEntry {
	indicators: SymbolIndicators;
	timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Fetch historical OHLCV data and compute indicators for a symbol.
 * Results are cached for 30 minutes.
 */
export async function getIndicators(symbol: string, exchange: string): Promise<SymbolIndicators> {
	const key = `${symbol}:${exchange}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.indicators;
	}

	try {
		const isUk = exchange === "LSE" || exchange === "AIM";
		const data = isUk
			? await ibkrHistorical(symbol, exchange, 90)
			: await yahooUsHistorical(symbol, exchange, 90);
		if (!data || data.length === 0) {
			log.warn({ symbol, exchange }, "No historical data");
			return { rsi14: null, atr14: null, volume_ratio: null };
		}

		const candles: Candle[] = data.map((d) => ({
			date: new Date(d.date),
			open: d.open ?? null,
			high: d.high ?? null,
			low: d.low ?? null,
			close: d.close ?? null,
			volume: d.volume ?? null,
		}));

		const indicators: SymbolIndicators = {
			rsi14: calcRSI(candles, 14),
			atr14: calcATR(candles, 14),
			volume_ratio: calcVolumeRatio(candles, 20),
		};

		cache.set(key, { indicators, timestamp: Date.now() });
		return indicators;
	} catch (error) {
		log.warn({ symbol, exchange, error }, "Failed to fetch historical data");
		return { rsi14: null, atr14: null, volume_ratio: null };
	}
}

/** Clear the indicator cache (for testing) */
export function clearIndicatorCache(): void {
	cache.clear();
}
