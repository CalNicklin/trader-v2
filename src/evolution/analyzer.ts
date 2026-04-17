import { and, desc, eq, gte, isNull, ne } from "drizzle-orm";
import { getDb } from "../db/client";
import { paperTrades, strategies, strategyMetrics, tradeInsights } from "../db/schema";
import { createChildLogger } from "../utils/logger";
import type {
	MetricsSummary,
	MissedOpportunity,
	PerformanceLandscape,
	SignalDef,
	StrategyPerformance,
	SuggestedAction,
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

	// Filter out non-numeric params (e.g. signal_polarity) when building numeric parameter map
	const parameters: Record<string, number> = strategy.parameters
		? Object.fromEntries(
				Object.entries(JSON.parse(strategy.parameters) as Record<string, unknown>).filter(
					([, v]) => typeof v === "number",
				),
			)
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
		.select({
			observation: tradeInsights.observation,
			confidence: tradeInsights.confidence,
			suggestedAction: tradeInsights.suggestedAction,
		})
		.from(tradeInsights)
		.where(eq(tradeInsights.strategyId, strategyId))
		.orderBy(desc(tradeInsights.createdAt))
		.limit(10);

	const highConfidence = insights.filter((i) => (i.confidence ?? 0) >= 0.5);

	const insightSummary = highConfidence.map((i) => i.observation);

	const suggestedActions: SuggestedAction[] = [];
	for (const insight of highConfidence) {
		if (!insight.suggestedAction) continue;
		try {
			const parsed = JSON.parse(insight.suggestedAction);
			if (
				typeof parsed.parameter === "string" &&
				typeof parsed.direction === "string" &&
				typeof parsed.reasoning === "string"
			) {
				suggestedActions.push({
					parameter: parsed.parameter,
					direction: parsed.direction,
					reasoning: parsed.reasoning,
				});
			}
		} catch {
			// Skip malformed JSON
		}
	}

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
		suggestedActions,
	};
}

const MISSED_OPPORTUNITY_LIMIT = 15;

async function getMissedOpportunities(): Promise<MissedOpportunity[]> {
	const db = getDb();
	const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

	const rows = await db
		.select({
			observation: tradeInsights.observation,
			confidence: tradeInsights.confidence,
		})
		.from(tradeInsights)
		.where(
			and(
				eq(tradeInsights.insightType, "missed_opportunity"),
				isNull(tradeInsights.strategyId),
				gte(tradeInsights.confidence, 0.8),
				gte(tradeInsights.createdAt, thirtyDaysAgo),
			),
		)
		.orderBy(desc(tradeInsights.confidence))
		.limit(MISSED_OPPORTUNITY_LIMIT);

	return rows.map((r) => {
		const symbolMatch = r.observation.match(/^(\S+)\s+moved/);
		return {
			symbol: symbolMatch?.[1] ?? "UNKNOWN",
			observation: r.observation,
			confidence: r.confidence ?? 0,
		};
	});
}

export async function getPerformanceLandscape(): Promise<PerformanceLandscape> {
	const db = getDb();

	const nonRetired = await db
		.select()
		.from(strategies)
		.where(and(ne(strategies.status, "retired"), ne(strategies.status, "paused")))
		.all();

	// N+1 is acceptable here — population cap of 8 means max 24 queries
	const [performances, missedOpportunities] = await Promise.all([
		Promise.all(nonRetired.map((s) => getStrategyPerformance(s.id))),
		getMissedOpportunities(),
	]);

	const validPerformances = performances.filter((p): p is StrategyPerformance => p !== null);

	const activePaperCount = validPerformances.filter((p) => p.status === "paper").length;

	log.info(
		`Landscape built: ${validPerformances.length} strategies, ${activePaperCount} paper, ${missedOpportunities.length} missed opportunities`,
	);

	return {
		strategies: validPerformances,
		activePaperCount,
		missedOpportunities,
		timestamp: new Date().toISOString(),
	};
}
