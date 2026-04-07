import { eq } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { getQuoteFromCache } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import type { QuoteFields } from "../strategy/context.ts";
import { evaluateAllStrategies } from "../strategy/evaluator.ts";
import { runGraduationGate } from "../strategy/graduation.ts";
import { getIndicators } from "../strategy/historical.ts";
import { recalculateMetrics } from "../strategy/metrics.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "strategy-eval-job" });

export function filterUniverseByExchanges(
	universe: string[],
	exchanges?: Exchange[],
): string[] {
	if (!exchanges || exchanges.length === 0) return universe;

	const exchangeSet = new Set(exchanges);
	return universe.filter((spec) => {
		const exchange = spec.includes(":") ? spec.split(":")[1]! : "NASDAQ";
		return exchangeSet.has(exchange as Exchange);
	});
}

export async function runStrategyEvaluation(options?: {
	exchanges?: Exchange[];
	allowNewEntries?: boolean;
}): Promise<void> {
	await evaluateAllStrategies(async (symbol, exchange) => {
		const cached = await getQuoteFromCache(symbol, exchange);
		if (!cached || cached.last == null) return null;

		const indicators = await getIndicators(symbol, exchange);

		const quote: QuoteFields = {
			last: cached.last,
			bid: cached.bid,
			ask: cached.ask,
			volume: cached.volume,
			avgVolume: cached.avgVolume,
			changePercent: cached.changePercent,
			newsSentiment: cached.newsSentiment,
			newsEarningsSurprise: cached.newsEarningsSurprise,
			newsGuidanceChange: cached.newsGuidanceChange,
			newsManagementTone: cached.newsManagementTone,
			newsRegulatoryRisk: cached.newsRegulatoryRisk,
			newsAcquisitionLikelihood: cached.newsAcquisitionLikelihood,
			newsCatalystType: cached.newsCatalystType,
			newsExpectedMoveDuration: cached.newsExpectedMoveDuration,
		};

		return { quote, indicators };
	});

	// After evaluation, recalculate metrics for all paper strategies
	const db = getDb();
	const paperStrategies = await db
		.select({ id: strategies.id })
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	for (const strat of paperStrategies) {
		await recalculateMetrics(strat.id);
		await runGraduationGate(strat.id);
	}

	log.info(
		{ exchanges: options?.exchanges ?? "all" },
		"Strategy evaluation cycle complete",
	);
}
