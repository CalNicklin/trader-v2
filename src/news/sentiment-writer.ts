import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsEvents, quotesCache } from "../db/schema.ts";
import type { ClassificationSignals } from "./classifier.ts";

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
