import { and, eq } from "drizzle-orm";
import { ibkrQuote } from "../broker/market-data.ts";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { yahooUsQuote } from "./yahoo-us.ts";

const log = createChildLogger({ module: "quotes" });

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

/** Fetch a fresh quote from Yahoo (US) or IBKR (UK) and update the cache */
export async function refreshQuote(symbol: string, exchange: string): Promise<QuoteData | null> {
	try {
		// US: Yahoo chart. UK: IBKR (connection managed by running service).
		const isUk = exchange === "LSE" || exchange === "AIM";
		const quote = isUk ? await ibkrQuote(symbol, exchange) : await yahooUsQuote(symbol, exchange);
		if (!quote || quote.last == null) {
			log.warn({ symbol, exchange }, "No quote data");
			return null;
		}
		const data: QuoteData = {
			symbol,
			exchange,
			last: quote.last,
			bid: null,
			ask: null,
			volume: quote.volume,
			avgVolume: quote.avgVolume,
			changePercent: quote.changePercent,
		};
		await upsertQuote(data);
		return data;
	} catch (error) {
		log.error({ symbol, exchange, error }, "Failed to refresh quote");
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
	}

	log.info({ requested: symbols.length, fetched: results.size }, "Quote refresh complete");
	return results;
}
