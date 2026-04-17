import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { graduationEvents, paperTrades, strategies, strategyMetrics } from "../db/schema.ts";
import { computeBackHalfPnl, MIN_CLOSED_TRADES_FOR_BACK_HALF } from "../evolution/back-half-pnl.ts";
import { hasStableEdge, MIN_SAMPLE_PROMOTE } from "../evolution/has-stable-edge.ts";
import {
	getPatternInsightsForStrategy,
	reviewForGraduation,
} from "../learning/graduation-review.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "graduation" });

// Graduation thresholds from spec Section 4
const CRITERIA = {
	minSampleSize: MIN_SAMPLE_PROMOTE,
	minExpectancy: 0,
	minProfitFactor: 1.5,
	minSharpe: 0.7,
	maxDrawdownPct: 15,
	minConsistency: 3, // profitable in >= 3 of last 4 weeks
	maxParameters: 5,
};

export interface GraduationResult {
	passes: boolean;
	failures: string[];
}

/**
 * Check whether a strategy meets all graduation criteria.
 * Returns pass/fail with a list of failed criteria.
 */
export async function checkGraduation(strategyId: number): Promise<GraduationResult> {
	const db = getDb();
	const failures: string[] = [];

	const [metrics] = await db
		.select()
		.from(strategyMetrics)
		.where(eq(strategyMetrics.strategyId, strategyId))
		.limit(1);

	if (!metrics) {
		return { passes: false, failures: ["No metrics found"] };
	}

	// Sample size
	if (metrics.sampleSize < CRITERIA.minSampleSize) {
		failures.push(`Insufficient sample size: ${metrics.sampleSize} < ${CRITERIA.minSampleSize}`);
	}

	// Expectancy
	if (metrics.expectancy == null || metrics.expectancy <= CRITERIA.minExpectancy) {
		failures.push(`Expectancy not positive: ${metrics.expectancy ?? "null"}`);
	}

	// Profit factor
	if (metrics.profitFactor == null || metrics.profitFactor < CRITERIA.minProfitFactor) {
		failures.push(
			`Profit factor too low: ${metrics.profitFactor?.toFixed(2) ?? "null"} < ${CRITERIA.minProfitFactor}`,
		);
	}

	// Sharpe ratio
	if (metrics.sharpeRatio == null || metrics.sharpeRatio < CRITERIA.minSharpe) {
		failures.push(
			`Sharpe ratio too low: ${metrics.sharpeRatio?.toFixed(2) ?? "null"} < ${CRITERIA.minSharpe}`,
		);
	}

	// Max drawdown
	if (metrics.maxDrawdownPct != null && metrics.maxDrawdownPct > CRITERIA.maxDrawdownPct) {
		failures.push(
			`Max drawdown too high: ${metrics.maxDrawdownPct.toFixed(1)}% > ${CRITERIA.maxDrawdownPct}%`,
		);
	}

	// Consistency
	if (metrics.consistencyScore == null || metrics.consistencyScore < CRITERIA.minConsistency) {
		failures.push(
			`Consistency too low: ${metrics.consistencyScore ?? 0} < ${CRITERIA.minConsistency} profitable weeks`,
		);
	}

	// Parameter count (check from strategy definition)
	const [strat] = await db.select().from(strategies).where(eq(strategies.id, strategyId)).limit(1);

	if (strat) {
		try {
			const params = JSON.parse(strat.parameters);
			const paramCount = Object.keys(params).length;
			if (paramCount > CRITERIA.maxParameters) {
				failures.push(`Too many parameters: ${paramCount} > ${CRITERIA.maxParameters}`);
			}
		} catch {
			failures.push("Could not parse strategy parameters");
		}
	}

	// Back-half confirmation: recent 50% of closed trades must confirm full-sample Sharpe sign.
	const { closedTradeCount, backHalfPnl } = await computeBackHalfPnl(strategyId);
	if (closedTradeCount < MIN_CLOSED_TRADES_FOR_BACK_HALF) {
		failures.push(
			`hasStableEdge(promote) false — only ${closedTradeCount} closed trades, need >=${MIN_CLOSED_TRADES_FOR_BACK_HALF} to evaluate back-half`,
		);
	} else if (
		!hasStableEdge(
			{ sampleSize: metrics.sampleSize, sharpeRatio: metrics.sharpeRatio, backHalfPnl },
			"promote",
		)
	) {
		failures.push(
			"hasStableEdge(promote) false — back-half P&L does not confirm full-sample Sharpe sign",
		);
	}

	return { passes: failures.length === 0, failures };
}

/**
 * Run the graduation gate for a strategy. If it passes, promote to probation.
 * Records the event in graduation_events.
 */
export async function runGraduationGate(strategyId: number): Promise<void> {
	const db = getDb();
	const result = await checkGraduation(strategyId);

	const [strat] = await db.select().from(strategies).where(eq(strategies.id, strategyId)).limit(1);

	if (!strat || strat.status !== "paper") return;

	if (result.passes) {
		// Qualitative review gate — additive, not blocking on API failure
		const recentTradesForReview = await db
			.select({
				symbol: paperTrades.symbol,
				side: paperTrades.side,
				pnl: paperTrades.pnl,
				createdAt: paperTrades.createdAt,
			})
			.from(paperTrades)
			.where(eq(paperTrades.strategyId, strategyId))
			.orderBy(paperTrades.createdAt)
			.limit(20);

		const [metricsRow] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strategyId))
			.limit(1);

		const patternInsights = await getPatternInsightsForStrategy(strategyId);
		const qualReview = await reviewForGraduation({
			strategyId,
			strategyName: strat.name,
			metrics: {
				sampleSize: metricsRow?.sampleSize ?? 0,
				winRate: metricsRow?.winRate ?? null,
				expectancy: metricsRow?.expectancy ?? null,
				profitFactor: metricsRow?.profitFactor ?? null,
				sharpeRatio: metricsRow?.sharpeRatio ?? null,
				maxDrawdownPct: metricsRow?.maxDrawdownPct ?? null,
				consistencyScore: metricsRow?.consistencyScore ?? null,
			},
			recentTrades: recentTradesForReview,
			patternInsights,
		});

		if (qualReview && qualReview.recommendation === "concerns") {
			log.info(
				{
					strategyId,
					strategy: strat.name,
					reasoning: qualReview.reasoning,
					riskFlags: qualReview.riskFlags,
				},
				"Graduation blocked by qualitative review: concerns",
			);
			return;
		}

		if (qualReview && qualReview.recommendation === "hold") {
			log.info(
				{
					strategyId,
					strategy: strat.name,
					reasoning: qualReview.reasoning,
					riskFlags: qualReview.riskFlags,
				},
				"Graduation delayed by qualitative review: hold",
			);
			return;
		}

		await db
			.update(strategies)
			.set({ status: "probation", promotedAt: new Date().toISOString() })
			.where(eq(strategies.id, strategyId));

		await db.insert(graduationEvents).values({
			strategyId,
			event: "graduated" as const,
			fromTier: "paper",
			toTier: "probation",
			evidence: JSON.stringify(result),
		});

		log.info({ strategyId, strategy: strat.name }, "Strategy graduated to probation");
	} else {
		log.debug(
			{ strategyId, strategy: strat.name, failures: result.failures },
			"Strategy not ready for graduation",
		);
	}
}
