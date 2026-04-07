import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { refreshQuote } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { newsEvents, quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "quote-refresh" });

/** Return symbols from the cache, optionally scoped to specific exchanges */
export async function getSymbolsToRefresh(
	exchanges?: Exchange[],
): Promise<Array<{ symbol: string; exchange: string }>> {
	const db = getDb();
	if (exchanges && exchanges.length > 0) {
		return db
			.select({ symbol: quotesCache.symbol, exchange: quotesCache.exchange })
			.from(quotesCache)
			.where(inArray(quotesCache.exchange, exchanges));
	}
	return db
		.select({ symbol: quotesCache.symbol, exchange: quotesCache.exchange })
		.from(quotesCache);
}

/** Refresh quotes for all symbols currently in the cache */
export async function refreshQuotesForAllCached(exchanges?: Exchange[]): Promise<void> {
	const cached = await getSymbolsToRefresh(exchanges);

	if (cached.length === 0) {
		log.info("No symbols in quotes cache — nothing to refresh");
		return;
	}

	let refreshed = 0;
	for (const { symbol, exchange } of cached) {
		const result = await refreshQuote(symbol, exchange);
		if (result) refreshed++;
		await Bun.sleep(200);
	}

	await backfillSentimentPrices();
	log.info({ total: cached.length, refreshed }, "Quote refresh complete");
}

/**
 * Backfill priceAfter1d for classified news events that are >24h old
 * and haven't been backfilled yet. Piggybacks on quote refresh cycle.
 */
export async function backfillSentimentPrices(): Promise<void> {
	const db = getDb();
	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const staleEvents = await db
		.select({
			id: newsEvents.id,
			symbols: newsEvents.symbols,
		})
		.from(newsEvents)
		.where(
			and(
				isNotNull(newsEvents.priceAtClassification),
				isNull(newsEvents.priceAfter1d),
				lt(newsEvents.classifiedAt, oneDayAgo),
			),
		)
		.limit(50);

	if (staleEvents.length === 0) return;

	let filled = 0;
	for (const event of staleEvents) {
		const symbols: string[] = JSON.parse(event.symbols ?? "[]");
		const primarySymbol = symbols[0];
		if (!primarySymbol) continue;

		const [cached] = await db
			.select({ last: quotesCache.last })
			.from(quotesCache)
			.where(eq(quotesCache.symbol, primarySymbol))
			.limit(1);

		if (cached?.last != null) {
			await db
				.update(newsEvents)
				.set({ priceAfter1d: cached.last })
				.where(eq(newsEvents.id, event.id));
			filled++;
		}
	}

	if (filled > 0) {
		log.info(
			{ filled, total: staleEvents.length },
			"Backfilled priceAfter1d for sentiment validation",
		);
	}
}
