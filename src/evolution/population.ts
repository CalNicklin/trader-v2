import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { graduationEvents, paperTrades, strategies, strategyMetrics } from "../db/schema";
import { createChildLogger } from "../utils/logger";
import { hasStableEdge } from "./has-stable-edge.ts";

const log = createChildLogger({ module: "evolution:population" });

export const MAX_POPULATION = 8;
export const EXPECTANCY_KILL_SHARPE_FLOOR = -2;
export const DRAWDOWN_KILL_PCT = 15;
export const MIN_POPULATION = 3;
export const RECOVERY_SPAWN_CAP = 2;
export const DRAWDOWN_KILL_MIN_TRADES = 10;
export const MIN_TRADES_FOR_EVOLUTION = 15;

async function retireStrategy(strategyId: number, reason: string): Promise<void> {
	const db = getDb();

	await db
		.update(strategies)
		.set({
			status: "retired" as const,
			retiredAt: new Date().toISOString(),
		})
		.where(eq(strategies.id, strategyId));

	await db.insert(graduationEvents).values({
		strategyId,
		event: "killed" as const,
		evidence: JSON.stringify({ reason }),
	});

	log.warn(`Strategy ${strategyId} retired: ${reason}`);
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

		const trades = await db
			.select({ pnl: paperTrades.pnl })
			.from(paperTrades)
			.where(and(eq(paperTrades.strategyId, strategy.id), isNotNull(paperTrades.pnl)))
			.orderBy(paperTrades.createdAt);

		if (trades.length === 0) continue;
		const splitIdx = Math.floor(trades.length / 2);
		const backHalfPnl = trades.slice(splitIdx).reduce((s, t) => s + (t.pnl ?? 0), 0);

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
