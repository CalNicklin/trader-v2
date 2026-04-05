import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsEvents } from "../db/schema.ts";
import { injectSymbol } from "../strategy/universe.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { ClassificationResult } from "./classifier.ts";
import type { NewsArticle } from "./finnhub.ts";
import { shouldClassify } from "./pre-filter.ts";
import { storeNewsEvent, writeSignals, writeSentiment } from "./sentiment-writer.ts";

const log = createChildLogger({ module: "news-ingest" });

type ClassifyFn = (headline: string, symbol: string) => Promise<ClassificationResult | null>;

/**
 * Check if a headline has already been ingested (dedup by exact headline match).
 */
export async function isHeadlineSeen(headline: string): Promise<boolean> {
	const db = getDb();
	const [existing] = await db
		.select({ id: newsEvents.id })
		.from(newsEvents)
		.where(eq(newsEvents.headline, headline))
		.limit(1);
	return existing != null;
}

/**
 * Process a single news article through the pipeline:
 * dedup → pre-filter → classify → store → write sentiment
 *
 * Returns: "duplicate" | "filtered" | "classified" | "failed"
 */
export async function processArticle(
	article: NewsArticle,
	exchange: string,
	classify: ClassifyFn,
): Promise<"duplicate" | "filtered" | "classified" | "failed"> {
	// Dedup check
	if (await isHeadlineSeen(article.headline)) return "duplicate";

	// Check pre-filter
	if (!shouldClassify(article.headline)) {
		// Store unclassified for record-keeping
		await storeNewsEvent({
			source: article.source,
			headline: article.headline,
			url: article.url,
			symbols: article.symbols,
			sentiment: null,
			confidence: null,
			tradeable: null,
			eventType: null,
			urgency: null,
			signals: null,
		});
		return "filtered";
	}

	// Classify against primary symbol only — multi-symbol articles (e.g. mergers)
	// get the same sentiment written to all symbols. Acceptable trade-off for cost.
	const primarySymbol = article.symbols[0];
	if (!primarySymbol) return "failed";

	const result = await classify(article.headline, primarySymbol);
	if (!result) {
		await storeNewsEvent({
			source: article.source,
			headline: article.headline,
			url: article.url,
			symbols: article.symbols,
			sentiment: null,
			confidence: null,
			tradeable: null,
			eventType: null,
			urgency: null,
			signals: null,
		});
		return "failed";
	}

	// Store classified event
	await storeNewsEvent({
		source: article.source,
		headline: article.headline,
		url: article.url,
		symbols: article.symbols,
		sentiment: result.sentiment,
		confidence: result.confidence,
		tradeable: result.tradeable,
		eventType: result.eventType,
		urgency: result.urgency,
		signals: result.signals,
	});

	// Write signals or sentiment to quote cache for each symbol
	for (const symbol of article.symbols) {
		if (result.signals) {
			await writeSignals(symbol, exchange, {
				sentiment: result.sentiment,
				earningsSurprise: result.signals.earningsSurprise,
				guidanceChange: result.signals.guidanceChange,
				managementTone: result.signals.managementTone,
				regulatoryRisk: result.signals.regulatoryRisk,
				acquisitionLikelihood: result.signals.acquisitionLikelihood,
				catalystType: result.signals.catalystType,
				expectedMoveDuration: result.signals.expectedMoveDuration,
			});
		} else {
			await writeSentiment(symbol, exchange, result.sentiment);
		}
	}

	// Inject high-urgency symbols into all strategy universes temporarily
	if (result.tradeable && result.urgency === "high") {
		for (const symbol of article.symbols) {
			injectSymbol(symbol, exchange);
		}
		log.info(
			{ symbols: article.symbols, urgency: result.urgency },
			"High-urgency symbols injected into universes",
		);
	}

	log.info(
		{
			headline: article.headline.slice(0, 60),
			symbols: article.symbols,
			sentiment: result.sentiment,
			tradeable: result.tradeable,
			urgency: result.urgency,
		},
		"News classified",
	);

	return "classified";
}
