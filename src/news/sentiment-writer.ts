import { getDb } from "../db/client.ts";
import { newsEvents, quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "sentiment-writer" });

/**
 * Update the news_sentiment column in quotes_cache for a symbol.
 * Creates the cache row if it doesn't exist.
 * Does NOT overwrite price data — uses upsert to avoid race conditions.
 */
export async function writeSentiment(
	symbol: string,
	exchange: string,
	sentiment: number,
): Promise<void> {
	const db = getDb();
	await db
		.insert(quotesCache)
		.values({ symbol, exchange, newsSentiment: sentiment })
		.onConflictDoUpdate({
			target: [quotesCache.symbol, quotesCache.exchange],
			set: { newsSentiment: sentiment, updatedAt: new Date().toISOString() },
		});

	log.debug({ symbol, exchange, sentiment }, "Sentiment written to cache");
}

export interface NewsEventInput {
	source: string;
	headline: string;
	url: string | null;
	symbols: string[];
	sentiment: number | null;
	confidence: number | null;
	tradeable: boolean | null;
	eventType: string | null;
	urgency: "low" | "medium" | "high" | null;
}

/**
 * Store a classified news event in the news_events table.
 */
export async function storeNewsEvent(input: NewsEventInput): Promise<void> {
	const db = getDb();
	await db.insert(newsEvents).values({
		source: input.source,
		headline: input.headline,
		url: input.url,
		symbols: JSON.stringify(input.symbols),
		sentiment: input.sentiment,
		confidence: input.confidence,
		tradeable: input.tradeable,
		eventType: input.eventType,
		urgency: input.urgency,
		classifiedAt: input.sentiment != null ? new Date().toISOString() : null,
	});
}
