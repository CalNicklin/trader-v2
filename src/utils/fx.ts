import YahooFinance from "yahoo-finance2";
import { createChildLogger } from "./logger.ts";

const log = createChildLogger({ module: "fx" });

const yf = new YahooFinance();

interface FxCache {
	rate: number;
	timestamp: number;
}

const cache = new Map<string, FxCache>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function getExchangeRate(from: string, to: string): Promise<number> {
	if (from === to) return 1;

	const key = `${from}${to}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.rate;
	}

	try {
		const symbol = `${from}${to}=X`;
		const quote = await yf.quote(symbol);
		if (quote.quoteType === "CURRENCY" && quote.regularMarketPrice) {
			const rate = quote.regularMarketPrice;
			cache.set(key, { rate, timestamp: Date.now() });
			return rate;
		}
	} catch (error) {
		log.warn({ from, to, error }, "FX rate fetch failed, using fallback");
	}

	// Hardcoded fallback rates
	const fallbacks: Record<string, number> = {
		GBPUSD: 1.27,
		USDGBP: 0.79,
	};
	return fallbacks[key] ?? 1;
}

export async function convertCurrency(
	amount: number,
	from: string,
	to: string,
): Promise<number> {
	const rate = await getExchangeRate(from, to);
	return amount * rate;
}

/** Get the friction cost for a round-trip trade on a given exchange */
export function getTradeFriction(exchange: string, side: "BUY" | "SELL"): number {
	switch (exchange) {
		case "LSE":
			// 0.5% stamp duty on buys only, ~0.1% spread
			return side === "BUY" ? 0.006 : 0.001;
		case "AIM":
			// 0% stamp duty, ~0.1% spread
			return 0.001;
		case "NASDAQ":
		case "NYSE":
			// ~0.2% FX spread each way
			return 0.002;
		default:
			return 0.002;
	}
}
