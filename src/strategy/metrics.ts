import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { paperTrades, strategyMetrics } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "metrics" });

/**
 * Recalculate rolling performance metrics for a strategy from its trade history.
 * Upserts into strategy_metrics table.
 */
export async function recalculateMetrics(strategyId: number): Promise<void> {
	const db = getDb();

	// Get all closed trades (trades with pnl set = exit trades)
	const trades = await db
		.select()
		.from(paperTrades)
		.where(and(eq(paperTrades.strategyId, strategyId), isNotNull(paperTrades.pnl)));

	const sampleSize = trades.length;

	if (sampleSize === 0) {
		await upsertMetrics(strategyId, {
			sampleSize: 0,
			winRate: null,
			expectancy: null,
			profitFactor: null,
			sharpeRatio: null,
			sortinoRatio: null,
			maxDrawdownPct: null,
			calmarRatio: null,
			consistencyScore: null,
		});
		return;
	}

	const pnls = trades.map((t) => t.pnl!);
	const wins = pnls.filter((p) => p > 0);
	const losses = pnls.filter((p) => p < 0);

	const winRate = wins.length / sampleSize;
	const totalPnl = pnls.reduce((sum, p) => sum + p, 0);
	const expectancy = totalPnl / sampleSize;

	const grossProfit = wins.reduce((sum, p) => sum + p, 0);
	const grossLoss = Math.abs(losses.reduce((sum, p) => sum + p, 0));
	const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

	// Sharpe ratio (annualized, assuming ~252 trading days)
	const mean = expectancy;
	const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / sampleSize;
	const stdDev = Math.sqrt(variance);
	const sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : null;

	// Sortino ratio (only penalizes downside deviation)
	const downsideReturns = pnls.filter((p) => p < 0);
	const downsideVariance =
		downsideReturns.length > 0
			? downsideReturns.reduce((sum, p) => sum + p ** 2, 0) / sampleSize
			: 0;
	const downsideDev = Math.sqrt(downsideVariance);
	const sortinoRatio = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(252) : null;

	// Max drawdown (peak-to-trough in cumulative P&L)
	let peak = 0;
	let cumPnl = 0;
	let maxDrawdown = 0;
	for (const pnl of pnls) {
		cumPnl += pnl;
		if (cumPnl > peak) peak = cumPnl;
		const drawdown = peak - cumPnl;
		if (drawdown > maxDrawdown) maxDrawdown = drawdown;
	}
	// Express as % of starting virtual balance (10000)
	const maxDrawdownPct = (maxDrawdown / 10000) * 100;

	// Calmar ratio: annualized return / max drawdown
	const annualizedReturn = totalPnl * (252 / Math.max(sampleSize, 1));
	const calmarRatio = maxDrawdownPct > 0 ? annualizedReturn / 10000 / (maxDrawdownPct / 100) : null;

	// Consistency: profitable in how many of the last 4 weeks?
	const consistencyScore = calcConsistency(trades);

	await upsertMetrics(strategyId, {
		sampleSize,
		winRate,
		expectancy,
		profitFactor,
		sharpeRatio,
		sortinoRatio,
		maxDrawdownPct,
		calmarRatio,
		consistencyScore,
	});

	log.info(
		{
			strategyId,
			sampleSize,
			winRate: winRate.toFixed(2),
			profitFactor: profitFactor.toFixed(2),
		},
		"Metrics recalculated",
	);
}

interface MetricsValues {
	sampleSize: number;
	winRate: number | null;
	expectancy: number | null;
	profitFactor: number | null;
	sharpeRatio: number | null;
	sortinoRatio: number | null;
	maxDrawdownPct: number | null;
	calmarRatio: number | null;
	consistencyScore: number | null;
}

async function upsertMetrics(strategyId: number, values: MetricsValues): Promise<void> {
	const db = getDb();
	const existing = await db
		.select()
		.from(strategyMetrics)
		.where(eq(strategyMetrics.strategyId, strategyId))
		.limit(1);

	if (existing.length > 0) {
		await db
			.update(strategyMetrics)
			.set({ ...values, updatedAt: new Date().toISOString() })
			.where(eq(strategyMetrics.strategyId, strategyId));
	} else {
		await db.insert(strategyMetrics).values({ strategyId, ...values });
	}
}

function calcConsistency(trades: Array<{ pnl: number | null; createdAt: string }>): number {
	const now = new Date();
	let profitableWeeks = 0;

	for (let week = 0; week < 4; week++) {
		const weekStart = new Date(now);
		weekStart.setDate(weekStart.getDate() - (week + 1) * 7);
		const weekEnd = new Date(now);
		weekEnd.setDate(weekEnd.getDate() - week * 7);

		const weekTrades = trades.filter((t) => {
			const d = new Date(t.createdAt);
			return d >= weekStart && d < weekEnd;
		});

		if (weekTrades.length === 0) continue;
		const weekPnl = weekTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
		if (weekPnl > 0) profitableWeeks++;
	}

	return profitableWeeks;
}
