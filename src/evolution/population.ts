import { and, desc, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { graduationEvents, paperTrades, strategies, strategyMetrics, tradeInsights } from "../db/schema";
import { closeAllPositions } from "../paper/manager";
import { createChildLogger } from "../utils/logger";
import { computeBackHalfPnl, MIN_CLOSED_TRADES_FOR_BACK_HALF } from "./back-half-pnl";
import { hasStableEdge } from "./has-stable-edge";

const log = createChildLogger({ module: "evolution:population" });

export const MAX_POPULATION = 8;
export const EXPECTANCY_KILL_SHARPE_FLOOR = -2;
export const DRAWDOWN_KILL_PCT = 15;
export const MIN_POPULATION = 3;
export const RECOVERY_SPAWN_CAP = 2;
export const DRAWDOWN_KILL_MIN_TRADES = 10;
export const MIN_TRADES_FOR_EVOLUTION = 15;
export const CONSECUTIVE_LOSS_PAUSE = 5;
export const PAUSE_HOURS = 48;

async function retireStrategy(strategyId: number, reason: string): Promise<void> {
	const db = getDb();
	const killStart = Date.now();

	const legsClosed = await closeAllPositions(strategyId, reason);

	const killFillDurationMs = Date.now() - killStart;

	await db
		.update(strategies)
		.set({ status: "retired" as const, retiredAt: new Date().toISOString() })
		.where(eq(strategies.id, strategyId));

	await db.insert(graduationEvents).values({
		strategyId,
		event: "killed" as const,
		evidence: JSON.stringify({
			reason,
			killFillDurationMs,
			killLegsCount: legsClosed,
		}),
	});

	log.warn(
		{ strategyId, killFillDurationMs, killLegsCount: legsClosed },
		`Strategy ${strategyId} retired: ${reason}`,
	);
}

export async function checkDrawdowns(): Promise<number[]> {
	const db = getDb();

	const paperStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"))
		.all();

	const killed: number[] = [];

	for (const strategy of paperStrategies) {
		const metrics = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strategy.id))
			.get();

		if (metrics?.maxDrawdownPct != null && metrics.maxDrawdownPct > DRAWDOWN_KILL_PCT) {
			// Protect young strategies — a single bad trade on a small sample
			// can spike drawdown well past the threshold. Let them accumulate
			// enough data before enforcing the kill.
			if ((metrics.sampleSize ?? 0) < DRAWDOWN_KILL_MIN_TRADES) {
				log.info(
					{
						strategyId: strategy.id,
						drawdown: metrics.maxDrawdownPct.toFixed(2),
						sampleSize: metrics.sampleSize,
						minTrades: DRAWDOWN_KILL_MIN_TRADES,
					},
					"Drawdown exceeds kill threshold but strategy has too few trades — sparing",
				);
				continue;
			}
			await retireStrategy(
				strategy.id,
				`Max drawdown ${metrics.maxDrawdownPct.toFixed(2)}% exceeded kill threshold of ${DRAWDOWN_KILL_PCT}%`,
			);
			killed.push(strategy.id);
		}
	}

	return killed;
}

export async function checkExpectancyKill(): Promise<number[]> {
	const db = getDb();

	const paperStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"))
		.all();

	const killed: number[] = [];

	for (const strategy of paperStrategies) {
		const metrics = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strategy.id))
			.get();

		if (!metrics || metrics.sharpeRatio == null) continue;
		if (metrics.sharpeRatio >= EXPECTANCY_KILL_SHARPE_FLOOR) continue;

		const { closedTradeCount, backHalfPnl } = await computeBackHalfPnl(strategy.id);
		if (closedTradeCount < MIN_CLOSED_TRADES_FOR_BACK_HALF) continue;

		if (
			hasStableEdge(
				{ sampleSize: metrics.sampleSize, sharpeRatio: metrics.sharpeRatio, backHalfPnl },
				"retire",
			)
		) {
			await retireStrategy(
				strategy.id,
				`Expectancy kill: Sharpe ${metrics.sharpeRatio.toFixed(2)} at n=${metrics.sampleSize} with confirming back-half (${backHalfPnl.toFixed(2)})`,
			);
			killed.push(strategy.id);
		}
	}

	return killed;
}

export async function enforcePopulationCap(): Promise<number[]> {
	const db = getDb();

	const paperStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"))
		.all();

	if (paperStrategies.length <= MAX_POPULATION) {
		return [];
	}

	// Fetch metrics for all paper strategies to rank by Sharpe
	const withSharpe = await Promise.all(
		paperStrategies.map(async (s) => {
			const metrics = await db
				.select()
				.from(strategyMetrics)
				.where(eq(strategyMetrics.strategyId, s.id))
				.get();
			return {
				id: s.id,
				sharpe: metrics?.sharpeRatio ?? null,
			};
		}),
	);

	// Sort ascending: null Sharpe treated as -Infinity (worst)
	withSharpe.sort((a, b) => {
		const sa = a.sharpe ?? -Infinity;
		const sb = b.sharpe ?? -Infinity;
		return sa - sb;
	});

	const excessCount = paperStrategies.length - MAX_POPULATION;
	const toCull = withSharpe.slice(0, excessCount);

	const culled: number[] = [];
	for (const { id } of toCull) {
		await retireStrategy(id, "Population cap enforced — worst Sharpe ratio culled");
		culled.push(id);
	}

	return culled;
}

async function pauseStrategy(strategyId: number, reason: string): Promise<void> {
	const db = getDb();

	await db
		.update(strategies)
		.set({ status: "paused" as const, retiredAt: new Date().toISOString() })
		.where(eq(strategies.id, strategyId));

	await db.insert(graduationEvents).values({
		strategyId,
		event: "paused" as const,
		evidence: JSON.stringify({ reason }),
	});

	log.warn({ strategyId, reason }, `Strategy ${strategyId} paused: ${reason}`);
}

export async function checkConsecutiveLossPause(): Promise<number[]> {
	const db = getDb();

	const paperStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"))
		.all();

	const paused: number[] = [];

	for (const strategy of paperStrategies) {
		// Condition A: ≥5 consecutive losing exits
		const recentTrades = await db
			.select()
			.from(paperTrades)
			.where(and(eq(paperTrades.strategyId, strategy.id), isNotNull(paperTrades.pnl)))
			.orderBy(desc(paperTrades.createdAt))
			.limit(CONSECUTIVE_LOSS_PAUSE)
			.all();

		if (
			recentTrades.length >= CONSECUTIVE_LOSS_PAUSE &&
			recentTrades.every((t) => (t.pnl ?? 0) < 0)
		) {
			await pauseStrategy(
				strategy.id,
				`${CONSECUTIVE_LOSS_PAUSE} consecutive losing trades`,
			);
			paused.push(strategy.id);
			continue;
		}

		// Condition B: single trade ≥5% of virtualBalance loss
		const recentTradesForB = await db
			.select()
			.from(paperTrades)
			.where(and(eq(paperTrades.strategyId, strategy.id), isNotNull(paperTrades.pnl)))
			.orderBy(desc(paperTrades.createdAt))
			.limit(10)
			.all();

		const threshold = -(strategy.virtualBalance * 0.05);
		const bigLoss = recentTradesForB.find((t) => (t.pnl ?? 0) < threshold);
		if (bigLoss) {
			await pauseStrategy(
				strategy.id,
				`Single trade loss ${bigLoss.pnl?.toFixed(2)} exceeds 5% of virtualBalance (${strategy.virtualBalance})`,
			);
			paused.push(strategy.id);
			continue;
		}

		// Condition C: pattern_analysis insight with filter_failure or recurring_failure tag, conf ≥ 0.85
		const insights = await db
			.select()
			.from(tradeInsights)
			.where(
				and(
					eq(tradeInsights.strategyId, strategy.id),
					eq(tradeInsights.insightType, "pattern_analysis"),
				),
			)
			.all();

		for (const insight of insights) {
			if ((insight.confidence ?? 0) < 0.85) continue;
			let tags: string[] = [];
			try {
				tags = JSON.parse(insight.tags ?? "[]");
			} catch {
				// ignore malformed tags
			}
			if (tags.includes("filter_failure") || tags.includes("recurring_failure")) {
				await pauseStrategy(
					strategy.id,
					`pattern_analysis insight with tag "${tags.find((t) => t === "filter_failure" || t === "recurring_failure")}" and confidence ${insight.confidence}`,
				);
				paused.push(strategy.id);
				break;
			}
		}
	}

	return paused;
}
