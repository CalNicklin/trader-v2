import { desc, eq, ne } from "drizzle-orm";
import { getDb } from "../db/client";
import { paperTrades, strategies, strategyMetrics, tradeInsights } from "../db/schema";
import { createChildLogger } from "../utils/logger";
import type {
	MetricsSummary,
	PerformanceLandscape,
	SignalDef,
	StrategyPerformance,
	TradeSummary,
} from "./types";

const log = createChildLogger({ module: "evolution:analyzer" });

const RECENT_TRADES_LIMIT = 20;

export async function getStrategyPerformance(
	strategyId: number,
): Promise<StrategyPerformance | null> {
	const db = getDb();

	const strategy = await db.select().from(strategies).where(eq(strategies.id, strategyId)).get();
	if (!strategy) {
		return null;
	}

	const metrics = await db
		.select()
		.from(strategyMetrics)
		.where(eq(strategyMetrics.strategyId, strategyId))
		.get();

	const trades = await db
		.select()
		.from(paperTrades)
		.where(eq(paperTrades.strategyId, strategyId))
		.orderBy(desc(paperTrades.createdAt))
		.limit(RECENT_TRADES_LIMIT)
		.all();

	const parameters: Record<string, number> = strategy.parameters
		? (JSON.parse(strategy.parameters) as Record<string, number>)
		: {};

	const signals: SignalDef = strategy.signals ? (JSON.parse(strategy.signals) as SignalDef) : {};

	const universe: string[] = strategy.universe ? (JSON.parse(strategy.universe) as string[]) : [];

	const metricsSummary: MetricsSummary | null = metrics
		? {
				sampleSize: metrics.sampleSize,
				winRate: metrics.winRate,
				expectancy: metrics.expectancy,
				profitFactor: metrics.profitFactor,
				sharpeRatio: metrics.sharpeRatio,
				sortinoRatio: metrics.sortinoRatio,
				maxDrawdownPct: metrics.maxDrawdownPct,
				calmarRatio: metrics.calmarRatio,
				consistencyScore: metrics.consistencyScore,
			}
		: null;

	const recentTrades: TradeSummary[] = trades.map((t) => ({
		symbol: t.symbol,
		side: t.side,
		pnl: t.pnl,
		createdAt: t.createdAt,
	}));

	const insights = await db
		.select({ observation: tradeInsights.observation, confidence: tradeInsights.confidence })
		.from(tradeInsights)
		.where(eq(tradeInsights.strategyId, strategyId))
		.orderBy(desc(tradeInsights.createdAt))
		.limit(10);

	const insightSummary = insights
		.filter((i) => (i.confidence ?? 0) >= 0.5)
		.map((i) => i.observation);

	return {
		id: strategy.id,
		name: strategy.name,
		status: strategy.status,
		generation: strategy.generation,
		parentStrategyId: strategy.parentStrategyId,
		createdBy: strategy.createdBy ?? "seed",
		parameters,
		signals,
		universe,
		metrics: metricsSummary,
		recentTrades,
		virtualBalance: strategy.virtualBalance,
		insightSummary,
	};
}

export async function getPerformanceLandscape(): Promise<PerformanceLandscape> {
	const db = getDb();

	const nonRetired = await db
		.select()
		.from(strategies)
		.where(ne(strategies.status, "retired"))
		.all();

	// N+1 is acceptable here — population cap of 8 means max 24 queries
	const performances = await Promise.all(nonRetired.map((s) => getStrategyPerformance(s.id)));

	const validPerformances = performances.filter((p): p is StrategyPerformance => p !== null);

	const activePaperCount = validPerformances.filter((p) => p.status === "paper").length;

	log.info(`Landscape built: ${validPerformances.length} strategies, ${activePaperCount} paper`);

	return {
		strategies: validPerformances,
		activePaperCount,
		timestamp: new Date().toISOString(),
	};
}
