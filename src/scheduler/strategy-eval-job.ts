import { eq } from "drizzle-orm";
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

export async function runStrategyEvaluation(): Promise<void> {
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

	log.info("Strategy evaluation cycle complete");
}
