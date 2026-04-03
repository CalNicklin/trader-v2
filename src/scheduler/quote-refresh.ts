import { refreshQuote } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "quote-refresh" });

/** Refresh quotes for all symbols currently in the cache */
export async function refreshQuotesForAllCached(): Promise<void> {
	const db = getDb();
	const cached = await db
		.select({ symbol: quotesCache.symbol, exchange: quotesCache.exchange })
		.from(quotesCache);

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

	log.info({ total: cached.length, refreshed }, "Quote refresh complete");
}
