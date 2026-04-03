import { and, eq } from "drizzle-orm";
import YahooFinance from "yahoo-finance2";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "quotes" });

const yf = new YahooFinance();

export interface QuoteData {
	symbol: string;
	exchange: string;
	last?: number | null;
	bid?: number | null;
	ask?: number | null;
	volume?: number | null;
	avgVolume?: number | null;
	changePercent?: number | null;
}

/** Upsert a quote into the cache */
export async function upsertQuote(data: QuoteData): Promise<void> {
	const db = getDb();
	const existing = await db
		.select()
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, data.symbol), eq(quotesCache.exchange, data.exchange)))
		.limit(1);

	if (existing.length > 0) {
		await db
			.update(quotesCache)
			.set({
				last: data.last ?? existing[0]!.last,
				bid: data.bid ?? existing[0]!.bid,
				ask: data.ask ?? existing[0]!.ask,
				volume: data.volume ?? existing[0]!.volume,
				avgVolume: data.avgVolume ?? existing[0]!.avgVolume,
				changePercent: data.changePercent ?? existing[0]!.changePercent,
				updatedAt: new Date().toISOString(),
			})
			.where(and(eq(quotesCache.symbol, data.symbol), eq(quotesCache.exchange, data.exchange)));
	} else {
		await db.insert(quotesCache).values({
			symbol: data.symbol,
			exchange: data.exchange,
			last: data.last ?? null,
			bid: data.bid ?? null,
			ask: data.ask ?? null,
			volume: data.volume ?? null,
			avgVolume: data.avgVolume ?? null,
			changePercent: data.changePercent ?? null,
		});
	}
}

/** Get a quote from the cache */
export async function getQuoteFromCache(
	symbol: string,
	exchange: string,
): Promise<typeof quotesCache.$inferSelect | null> {
	const db = getDb();
	const rows = await db
		.select()
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, symbol), eq(quotesCache.exchange, exchange)))
		.limit(1);
	return rows[0] ?? null;
}

/** Map exchange to Yahoo Finance suffix */
function yahooSymbol(symbol: string, exchange: string): string {
	if (exchange === "LSE" || exchange === "AIM") return `${symbol}.L`;
	return symbol; // NASDAQ/NYSE — no suffix
}

/** Fetch a fresh quote from Yahoo Finance and update the cache */
export async function refreshQuote(symbol: string, exchange: string): Promise<QuoteData | null> {
	try {
		const yahooSym = yahooSymbol(symbol, exchange);
		const quote = await yf.quote(yahooSym);

		if (!quote || !("regularMarketPrice" in quote)) {
			log.warn({ symbol, exchange }, "No quote data from Yahoo");
			return null;
		}

		const data: QuoteData = {
			symbol,
			exchange,
			last: quote.regularMarketPrice ?? null,
			bid: "bid" in quote ? (quote.bid as number | undefined) ?? null : null,
			ask: "ask" in quote ? (quote.ask as number | undefined) ?? null : null,
			volume: quote.regularMarketVolume ?? null,
			avgVolume:
				"averageDailyVolume3Month" in quote
					? (quote.averageDailyVolume3Month as number | undefined) ?? null
					: null,
			changePercent: quote.regularMarketChangePercent ?? null,
		};

		await upsertQuote(data);
		return data;
	} catch (error) {
		log.error({ symbol, exchange, error }, "Failed to refresh quote from Yahoo");
		return null;
	}
}

/** Refresh quotes for a list of symbols */
export async function refreshQuotes(
	symbols: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, QuoteData>> {
	const results = new Map<string, QuoteData>();

	for (const { symbol, exchange } of symbols) {
		const data = await refreshQuote(symbol, exchange);
		if (data) results.set(symbol, data);
		// Small delay to avoid Yahoo rate limiting
		await Bun.sleep(200);
	}

	log.info({ requested: symbols.length, fetched: results.size }, "Quote refresh complete");
	return results;
}
