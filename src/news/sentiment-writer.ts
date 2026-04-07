import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsEvents, quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { ClassificationSignals } from "./classifier.ts";

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

export interface SignalWriteInput {
	sentiment: number;
	earningsSurprise: number;
	guidanceChange: number;
	managementTone: number;
	regulatoryRisk: number;
	acquisitionLikelihood: number;
	catalystType: string;
	expectedMoveDuration: string;
}

/**
 * Write all signal fields to quotes_cache for a symbol.
 * Creates the cache row if it doesn't exist.
 * Does NOT overwrite price data — uses upsert to avoid race conditions.
 */
export async function writeSignals(
	symbol: string,
	exchange: string,
	signals: SignalWriteInput,
): Promise<void> {
	const db = getDb();
	await db
		.insert(quotesCache)
		.values({
			symbol,
			exchange,
			newsSentiment: signals.sentiment,
			newsEarningsSurprise: signals.earningsSurprise,
			newsGuidanceChange: signals.guidanceChange,
			newsManagementTone: signals.managementTone,
			newsRegulatoryRisk: signals.regulatoryRisk,
			newsAcquisitionLikelihood: signals.acquisitionLikelihood,
			newsCatalystType: signals.catalystType,
			newsExpectedMoveDuration: signals.expectedMoveDuration,
		})
		.onConflictDoUpdate({
			target: [quotesCache.symbol, quotesCache.exchange],
			set: {
				newsSentiment: signals.sentiment,
				newsEarningsSurprise: signals.earningsSurprise,
				newsGuidanceChange: signals.guidanceChange,
				newsManagementTone: signals.managementTone,
				newsRegulatoryRisk: signals.regulatoryRisk,
				newsAcquisitionLikelihood: signals.acquisitionLikelihood,
				newsCatalystType: signals.catalystType,
				newsExpectedMoveDuration: signals.expectedMoveDuration,
				updatedAt: new Date().toISOString(),
			},
		});

	log.debug({ symbol, exchange }, "Signals written to cache");
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
	signals: ClassificationSignals | null;
}

/**
 * Store a classified news event in the news_events table.
 * Returns the inserted row's ID.
 */
export async function storeNewsEvent(input: NewsEventInput): Promise<number> {
	const db = getDb();

	// Capture price at classification time for the primary symbol
	let priceAtClassification: number | null = null;
	if (input.sentiment != null && input.symbols.length > 0) {
		const primarySymbol = input.symbols[0]!;
		const [cached] = await db
			.select({ last: quotesCache.last })
			.from(quotesCache)
			.where(eq(quotesCache.symbol, primarySymbol))
			.limit(1);
		priceAtClassification = cached?.last ?? null;
	}

	const [inserted] = await db
		.insert(newsEvents)
		.values({
			source: input.source,
			headline: input.headline,
			url: input.url,
			symbols: JSON.stringify(input.symbols),
			sentiment: input.sentiment,
			confidence: input.confidence,
			tradeable: input.tradeable,
			eventType: input.eventType,
			urgency: input.urgency,
			earningsSurprise: input.signals?.earningsSurprise ?? null,
			guidanceChange: input.signals?.guidanceChange ?? null,
			managementTone: input.signals?.managementTone ?? null,
			regulatoryRisk: input.signals?.regulatoryRisk ?? null,
			acquisitionLikelihood: input.signals?.acquisitionLikelihood ?? null,
			catalystType: input.signals?.catalystType ?? null,
			expectedMoveDuration: input.signals?.expectedMoveDuration ?? null,
			classifiedAt: input.sentiment != null ? new Date().toISOString() : null,
			priceAtClassification,
		})
		.returning({ id: newsEvents.id });

	return inserted!.id;
}
