import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";

const log = createChildLogger({ module: "fmp" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FmpQuoteData {
	symbol: string;
	exchange: string;
	last: number | null;
	bid: number | null;
	ask: number | null;
	volume: number | null;
	avgVolume: number | null;
	changePercent: number | null;
}

export interface FmpHistoricalBar {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

// ---------------------------------------------------------------------------
// Rate limiter — 300 requests/minute sliding window
// ---------------------------------------------------------------------------

const RATE_LIMIT = 300;
const WINDOW_MS = 60_000;
let requestTimestamps: number[] = [];

async function waitForRateLimit(): Promise<void> {
	const now = Date.now();
	// Prune timestamps outside the window
	requestTimestamps = requestTimestamps.filter((t) => now - t < WINDOW_MS);

	if (requestTimestamps.length >= RATE_LIMIT) {
		// Wait until the oldest request in the window expires
		const oldest = requestTimestamps[0]!;
		const waitMs = oldest + WINDOW_MS - now + 1;
		log.warn({ waitMs, queued: requestTimestamps.length }, "FMP rate limit reached, waiting");
		await Bun.sleep(waitMs);
		// Re-prune after waiting
		const afterWait = Date.now();
		requestTimestamps = requestTimestamps.filter((t) => afterWait - t < WINDOW_MS);
	}

	requestTimestamps.push(Date.now());
}

export function _resetRateLimiter(): void {
	requestTimestamps = [];
}

// ---------------------------------------------------------------------------
// Symbol mapping
// ---------------------------------------------------------------------------

export function toFmpSymbol(symbol: string, exchange: string): string {
	if (exchange === "LSE" || exchange === "AIM") return `${symbol}.L`;
	return symbol;
}

// ---------------------------------------------------------------------------
// Generic fetcher
// ---------------------------------------------------------------------------

class FmpFatalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FmpFatalError";
	}
}

export async function fmpFetch<T>(
	path: string,
	params: Record<string, string> = {},
): Promise<T | null> {
	const config = getConfig();
	const url = new URL(`https://financialmodelingprep.com/stable${path}`);
	url.searchParams.set("apikey", config.FMP_API_KEY);
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value);
	}

	try {
		const result = await withRetry(
			async () => {
				await waitForRateLimit();
				const response = await fetch(url.toString(), {
					signal: AbortSignal.timeout(10_000),
				});

				if (response.status === 403) {
					throw new FmpFatalError(`FMP 403 Forbidden: ${url.pathname} — check API key`);
				}

				if (response.status === 429 || response.status >= 500) {
					throw new Error(`FMP HTTP ${response.status}: ${url.pathname}`);
				}

				if (!response.ok) {
					log.warn({ status: response.status, path }, "FMP non-retryable error");
					return null;
				}

				return (await response.json()) as T;
			},
			`fmp:${path}`,
			{ maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10000, backoffMultiplier: 2 },
		);
		return result;
	} catch (error) {
		if (error instanceof FmpFatalError) {
			log.error({ path, error: error.message }, "FMP fatal config error");
			throw error;
		}
		log.error(
			{ path, error: error instanceof Error ? error.message : String(error) },
			"FMP fetch failed after retries",
		);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Exchange routing helpers
// ---------------------------------------------------------------------------

function isLseOrAim(exchange: string): boolean {
	return exchange === "LSE" || exchange === "AIM";
}

// ---------------------------------------------------------------------------
// Quote — single symbol
// ---------------------------------------------------------------------------

export async function fmpQuote(symbol: string, exchange: string): Promise<FmpQuoteData | null> {
	// LSE/AIM: route through IBKR (FMP Starter doesn't support .L quotes)
	if (isLseOrAim(exchange)) {
		const { ibkrQuote } = await import("../broker/market-data.ts");
		return ibkrQuote(symbol, exchange);
	}

	const fmpSym = toFmpSymbol(symbol, exchange);
	const data = await fmpFetch<
		Array<{
			symbol: string;
			price: number;
			volume: number;
			avgVolume: number;
			changesPercentage: number;
		}>
	>(`/quote`, { symbol: fmpSym });

	if (!data || data.length === 0) {
		log.warn({ symbol, exchange, fmpSym }, "No quote data from FMP");
		return null;
	}

	const q = data[0]!;
	return {
		symbol,
		exchange,
		last: q.price ?? null,
		bid: null,
		ask: null,
		volume: q.volume ?? null,
		avgVolume: q.avgVolume ?? null,
		changePercent: q.changesPercentage ?? null,
	};
}

// ---------------------------------------------------------------------------
// Batch quotes — chunks of 100
// ---------------------------------------------------------------------------

export async function fmpBatchQuotes(
	symbols: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, FmpQuoteData>> {
	const results = new Map<string, FmpQuoteData>();
	if (symbols.length === 0) return results;

	// Starter tier doesn't have /batch-quote — use individual /quote calls
	// The rate limiter handles throttling (300 req/min)
	for (const s of symbols) {
		const quote = await fmpQuote(s.symbol, s.exchange);
		if (quote) {
			results.set(s.symbol, quote);
		}
	}

	log.info({ requested: symbols.length, fetched: results.size }, "FMP batch quote complete");
	return results;
}

// ---------------------------------------------------------------------------
// Historical EOD
// ---------------------------------------------------------------------------

export async function fmpHistorical(
	symbol: string,
	exchange: string,
	days = 90,
): Promise<FmpHistoricalBar[] | null> {
	// LSE/AIM: route through IBKR (FMP Starter doesn't support .L historical)
	if (isLseOrAim(exchange)) {
		const { ibkrHistorical } = await import("../broker/market-data.ts");
		return ibkrHistorical(symbol, exchange, days);
	}

	const fmpSym = toFmpSymbol(symbol, exchange);
	const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const to = new Date().toISOString().slice(0, 10);

	const data = await fmpFetch<
		Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>
	>(`/historical-price-eod/full`, { symbol: fmpSym, from, to });

	if (!data || data.length === 0) {
		log.warn({ symbol, exchange }, "No historical data from FMP");
		return null;
	}

	// FMP returns newest-first; reverse to oldest-first
	return data
		.map((bar) => ({
			date: bar.date,
			open: bar.open,
			high: bar.high,
			low: bar.low,
			close: bar.close,
			volume: bar.volume,
		}))
		.reverse();
}

// ---------------------------------------------------------------------------
// FX rate
// ---------------------------------------------------------------------------

export async function fmpFxRate(from: string, to: string): Promise<number | null> {
	// FMP serves FX rates via the regular /quote endpoint with symbol like "GBPUSD"
	const data = await fmpFetch<Array<{ symbol: string; price: number }>>(`/quote`, {
		symbol: `${from}${to}`,
	});

	if (!data || data.length === 0) {
		log.warn({ from, to }, "No FX data from FMP");
		return null;
	}

	const rate = data[0]!.price;
	return rate != null && rate > 0 ? rate : null;
}

// ---------------------------------------------------------------------------
// Symbol validation with in-memory cache (24h TTL, max 1000 entries)
// ---------------------------------------------------------------------------

interface CacheEntry {
	valid: boolean;
	expiresAt: number;
}

const VALIDATION_TTL_MS = 24 * 60 * 60 * 1000;
const VALIDATION_MAX_ENTRIES = 1000;
const validationCache = new Map<string, CacheEntry>();

export function _clearValidationCache(): void {
	validationCache.clear();
}

export function _resetValidationCache(): void {
	validationCache.clear();
}

export async function fmpValidateSymbol(symbol: string, exchange: string): Promise<boolean> {
	const fmpSym = toFmpSymbol(symbol, exchange);
	const cacheKey = `${fmpSym}:${exchange}`;
	const now = Date.now();

	// Check cache
	const cached = validationCache.get(cacheKey);
	if (cached && cached.expiresAt > now) {
		return cached.valid;
	}

	// Evict expired entries, then enforce max size
	if (validationCache.size >= VALIDATION_MAX_ENTRIES) {
		for (const [key, entry] of validationCache) {
			if (entry.expiresAt <= now) {
				validationCache.delete(key);
			}
		}
		// If still too large, remove oldest entries
		if (validationCache.size >= VALIDATION_MAX_ENTRIES) {
			const toRemove = validationCache.size - VALIDATION_MAX_ENTRIES + 1;
			let removed = 0;
			for (const key of validationCache.keys()) {
				if (removed >= toRemove) break;
				validationCache.delete(key);
				removed++;
			}
		}
	}

	try {
		const data = await fmpFetch<
			Array<{
				symbol: string;
				companyName: string;
				exchange: string;
				isActivelyTrading?: boolean;
			}>
		>(`/profile`, { symbol: fmpSym });

		if (!data || data.length === 0) {
			const valid = false;
			validationCache.set(cacheKey, { valid, expiresAt: now + VALIDATION_TTL_MS });
			return valid;
		}

		if (data[0]!.isActivelyTrading === false) {
			log.info(
				{ symbol, exchange },
				"fmpValidateSymbol: rejecting symbol with isActivelyTrading=false",
			);
			validationCache.set(cacheKey, { valid: false, expiresAt: now + VALIDATION_TTL_MS });
			return false;
		}

		validationCache.set(cacheKey, { valid: true, expiresAt: now + VALIDATION_TTL_MS });
		return true;
	} catch {
		// Fail closed — treat network errors as invalid
		validationCache.set(cacheKey, { valid: false, expiresAt: now + VALIDATION_TTL_MS });
		return false;
	}
}

const EXCHANGE_NORMALIZATION: Record<string, "NASDAQ" | "NYSE" | "LSE"> = {
	"NASDAQ Global Select": "NASDAQ",
	"NASDAQ Global Market": "NASDAQ",
	"NASDAQ Capital Market": "NASDAQ",
	NASDAQ: "NASDAQ",
	"New York Stock Exchange": "NYSE",
	"NYSE American": "NYSE",
	"NYSE Arca": "NYSE",
	NYSE: "NYSE",
	"London Stock Exchange": "LSE",
	LSE: "LSE",
};

export function normalizeFmpExchange(raw: string): "NASDAQ" | "NYSE" | "LSE" | null {
	return EXCHANGE_NORMALIZATION[raw] ?? null;
}

interface ExchangeResolverDeps {
	fetch?: (path: string, params: Record<string, string>) => Promise<unknown>;
}

const exchangeCache = new Map<
	string,
	{ exchange: "NASDAQ" | "NYSE" | "LSE" | null; expiresAt: number }
>();
const EXCHANGE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export function _resetExchangeResolverCache(): void {
	exchangeCache.clear();
}

export async function fmpResolveExchange(
	symbol: string,
	deps: ExchangeResolverDeps = {},
): Promise<"NASDAQ" | "NYSE" | "LSE" | null> {
	const now = Date.now();
	const cached = exchangeCache.get(symbol);
	if (cached && cached.expiresAt > now) return cached.exchange;

	const fetcher =
		deps.fetch ??
		((path, params) =>
			fmpFetch<Array<{ symbol: string; exchange: string; isActivelyTrading?: boolean }>>(
				path,
				params,
			));

	try {
		const data = (await fetcher("/profile", { symbol })) as Array<{
			symbol: string;
			exchange: string;
			isActivelyTrading?: boolean;
		}>;
		if (!data || data.length === 0) {
			exchangeCache.set(symbol, { exchange: null, expiresAt: now + EXCHANGE_TTL_MS });
			return null;
		}
		const normalized = normalizeFmpExchange(data[0]!.exchange);
		exchangeCache.set(symbol, { exchange: normalized, expiresAt: now + EXCHANGE_TTL_MS });
		return normalized;
	} catch {
		exchangeCache.set(symbol, { exchange: null, expiresAt: now + EXCHANGE_TTL_MS });
		return null;
	}
}
