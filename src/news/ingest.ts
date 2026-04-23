import { eq, inArray } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { newsEvents, strategies } from "../db/schema.ts";
import { observeAiSemiGate } from "../jobs/ai-semi-observer.ts";
import { enqueueCatalystDispatch } from "../strategy/catalyst-dispatcher.ts";
import { injectSymbol } from "../strategy/universe.ts";
import { createChildLogger } from "../utils/logger.ts";
import { type ClassificationResult, onTradeableClassification } from "./classifier.ts";
import type { NewsArticle } from "./finnhub.ts";
import { shouldClassify } from "./pre-filter.ts";
import { runResearchAnalysis } from "./research-agent.ts";
import { storeNewsEvent } from "./sentiment-writer.ts";

const log = createChildLogger({ module: "news-ingest" });

type ClassifyFn = (headline: string, symbol: string) => Promise<ClassificationResult | null>;

/**
 * True if `symbol` appears in any graduated (probation/active/core) strategy's
 * universe. Gates catalyst dispatch — we don't spend Haiku budget on symbols
 * no live strategy could act on.
 */
async function isSymbolInGraduatedUniverse(symbol: string): Promise<boolean> {
	const db = getDb();
	const grads = await db
		.select({ universe: strategies.universe })
		.from(strategies)
		.where(inArray(strategies.status, ["probation", "active", "core"]));
	for (const g of grads) {
		if (!g.universe) continue;
		try {
			const list: string[] = JSON.parse(g.universe);
			if (list.some((u) => u === symbol || u.startsWith(`${symbol}:`))) return true;
		} catch {
			// ignore malformed universe JSON
		}
	}
	return false;
}

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

	// Store classified event and capture its ID
	const newsEventId = await storeNewsEvent({
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

	// Fire-and-forget watchlist promotion per affected symbol
	for (const symbol of article.symbols) {
		onTradeableClassification({
			newsEventId,
			symbol,
			exchange,
			classification: {
				tradeable: result.tradeable,
				urgency: result.urgency,
				sentiment: result.sentiment,
				confidence: result.confidence,
			},
			headline: article.headline,
		}).catch((err) =>
			log.error(
				{ err, symbol, headline: article.headline.slice(0, 60) },
				"Watchlist promotion failed",
			),
		);
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

	// TRA-11 AI-semi observation tier — record a gate-fire if the trigger
	// symbol matches and the event is high-urgency + tradeable. Zero-size
	// observation only; never opens a position. Failures are logged and
	// swallowed inside `observeAiSemiGate`.
	for (const symbol of article.symbols) {
		void observeAiSemiGate({
			triggerSymbol: symbol,
			triggerNewsEventId: newsEventId,
			tradeable: result.tradeable,
			urgency: result.urgency,
		});
	}

	// Catalyst-triggered dispatch: fire intraday dispatch for high-urgency
	// tradeable news on a symbol any graduated strategy holds in its universe.
	if (getConfig().CATALYST_DISPATCH_ENABLED && result.tradeable && result.urgency === "high") {
		const primary = article.symbols[0];
		if (primary && (await isSymbolInGraduatedUniverse(primary))) {
			enqueueCatalystDispatch(primary, exchange, newsEventId, {
				news: {
					headline: article.headline,
					sentiment: result.sentiment,
					urgency: result.urgency,
					eventType: result.eventType,
				},
			});
		}
	}

	// Fire-and-forget research analysis for tradeable articles
	if (result.tradeable) {
		runResearchAnalysis(newsEventId, {
			headline: article.headline,
			source: article.source,
			symbols: article.symbols,
			classification: {
				sentiment: result.sentiment,
				confidence: result.confidence,
				tradeable: result.tradeable,
				eventType: result.eventType,
				urgency: result.urgency,
			},
		}).catch((err) =>
			log.error({ err, headline: article.headline.slice(0, 60) }, "Research agent failed"),
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
