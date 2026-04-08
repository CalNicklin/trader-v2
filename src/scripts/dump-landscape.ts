import { desc, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import {
	graduationEvents,
	improvementProposals,
	paperTrades,
	strategies,
	strategyMetrics,
	strategyMutations,
	tradeInsights,
} from "../db/schema.ts";

async function main() {
	const db = getDb();

	// ── Strategies with metrics ────────────────────────────────────────────
	const allStrategies = await db
		.select()
		.from(strategies)
		.where(ne(strategies.status, "retired"))
		.all();

	const strategyData = [];
	for (const s of allStrategies) {
		const metrics = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, s.id))
			.get();

		const trades = await db
			.select()
			.from(paperTrades)
			.where(eq(paperTrades.strategyId, s.id))
			.orderBy(desc(paperTrades.createdAt))
			.limit(20)
			.all();

		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.strategyId, s.id))
			.orderBy(desc(tradeInsights.createdAt))
			.limit(15)
			.all();

		strategyData.push({
			id: s.id,
			name: s.name,
			status: s.status,
			generation: s.generation,
			parentStrategyId: s.parentStrategyId,
			createdBy: s.createdBy,
			parameters: s.parameters ? JSON.parse(s.parameters) : {},
			signals: s.signals ? JSON.parse(s.signals) : {},
			universe: s.universe ? JSON.parse(s.universe) : [],
			virtualBalance: s.virtualBalance,
			metrics: metrics
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
				: null,
			recentTrades: trades.map((t) => ({
				symbol: t.symbol,
				side: t.side,
				pnl: t.pnl,
				reasoning: t.reasoning,
				createdAt: t.createdAt,
			})),
			insights: insights.map((i) => ({
				type: i.insightType,
				observation: i.observation,
				suggestedAction: i.suggestedAction ? JSON.parse(i.suggestedAction) : null,
				confidence: i.confidence,
				ledToImprovement: i.ledToImprovement,
				createdAt: i.createdAt,
			})),
		});
	}

	// ── Learning loop hit rate ─────────────────────────────────────────────
	const totalInsights = await db.select({ count: sql<number>`count(*)` }).from(tradeInsights).get();

	const actedOn = await db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(eq(tradeInsights.ledToImprovement, true))
		.get();

	const unacted = await db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(isNull(tradeInsights.ledToImprovement))
		.get();

	// ── Recent mutations ──────────────────────────────────────────────────
	const mutations = await db
		.select()
		.from(strategyMutations)
		.orderBy(desc(strategyMutations.createdAt))
		.limit(20)
		.all();

	// ── Recent graduation events ──────────────────────────────────────────
	const events = await db
		.select()
		.from(graduationEvents)
		.orderBy(desc(graduationEvents.createdAt))
		.limit(20)
		.all();

	// ── Past improvement proposals ────────────────────────────────────────
	const proposals = await db
		.select()
		.from(improvementProposals)
		.orderBy(desc(improvementProposals.createdAt))
		.limit(10)
		.all();

	const output = {
		timestamp: new Date().toISOString(),
		strategies: strategyData,
		learningLoop: {
			totalInsights: totalInsights?.count ?? 0,
			actedOn: actedOn?.count ?? 0,
			unacted: unacted?.count ?? 0,
			hitRate:
				totalInsights?.count && totalInsights.count > 0
					? ((actedOn?.count ?? 0) / totalInsights.count).toFixed(3)
					: null,
		},
		recentMutations: mutations.map((m) => ({
			parentId: m.parentId,
			childId: m.childId,
			type: m.mutationType,
			parameterDiff: m.parameterDiff ? JSON.parse(m.parameterDiff) : null,
			parentSharpe: m.parentSharpe,
			childSharpe: m.childSharpe,
			createdAt: m.createdAt,
		})),
		recentEvents: events.map((e) => ({
			strategyId: e.strategyId,
			event: e.event,
			fromTier: e.fromTier,
			toTier: e.toTier,
			evidence: e.evidence ? JSON.parse(e.evidence) : null,
			createdAt: e.createdAt,
		})),
		pastProposals: proposals,
	};

	console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
