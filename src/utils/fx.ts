import { createChildLogger } from "./logger.ts";

const log = createChildLogger({ module: "fx" });

interface FxCache {
	rate: number;
	timestamp: number;
}

const cache = new Map<string, FxCache>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface FrankfurterResponse {
	amount: number;
	base: string;
	date: string;
	rates: Record<string, number>;
}

export async function getExchangeRate(from: string, to: string): Promise<number> {
	if (from === to) return 1;

	const key = `${from}${to}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.rate;
	}

	try {
		const res = await fetch(
			`https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
		);
		if (res.ok) {
			const data = (await res.json()) as FrankfurterResponse;
			const rate = data.rates[to];
			if (rate != null && rate > 0) {
				cache.set(key, { rate, timestamp: Date.now() });
				return rate;
			}
		}
	} catch (error) {
		log.warn({ from, to, error }, "Frankfurter FX fetch failed, using fallback");
	}

	// Hardcoded fallback rates — only hit if Frankfurter is down.
	const fallbacks: Record<string, number> = {
		GBPUSD: 1.27,
		USDGBP: 0.79,
	};
	return fallbacks[key] ?? 1;
}

export async function convertCurrency(amount: number, from: string, to: string): Promise<number> {
	const rate = await getExchangeRate(from, to);
	return amount * rate;
}

export function getTradeFriction(exchange: string, side: "BUY" | "SELL"): number {
	switch (exchange) {
		case "LSE":
			return side === "BUY" ? 0.006 : 0.001;
		case "AIM":
			return 0.001;
		case "NASDAQ":
		case "NYSE":
			return 0.002;
		default:
			return 0.002;
	}
}
