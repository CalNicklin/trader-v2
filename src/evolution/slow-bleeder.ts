import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { graduationEvents, strategies, strategyMetrics } from "../db/schema";
import { createChildLogger } from "../utils/logger";
import {
	getMechanismFailureStats,
	MECHANISM_FAILURE_MIN_REVIEWS,
	MECHANISM_FAILURE_RATE_THRESHOLD,
} from "./mechanism-failure";

const log = createChildLogger({ module: "evolution:slow-bleeder" });

/**
 * Slow-bleeder soft-demote gate (TRA-13).
 *
 * Strategy 1 bleeds ~£28/trade with individual losses <£70 — the 15% DD
 * circuit breaker never trips via slow bleed, so without this gate a
 * structurally-broken strategy grinds capital indefinitely.
 *
 * Four conjunctive criteria (all must hold):
 *   1. sampleSize ≥ 8                   — enough trades for signal
 *   2. sharpeRatio ≤ -2                  — genuinely bad risk-adjusted P&L
 *   3. winRate ≤ 0.35                    — not just unlucky on sizing
 *   4. mechanism-failure evidence         — tag-coupled per insight #6
 *
 * Demotes to `paused` (reversible) rather than retired. Resuming is a
 * manual / evolution-loop action. Escalation to kill after +5 more paper
 * trades is tracked separately.
 */

export const SLOW_BLEEDER_MIN_SAMPLE = 8;
export const SLOW_BLEEDER_MAX_SHARPE = -2;
export const SLOW_BLEEDER_MAX_WIN_RATE = 0.35;

function meetsStatsCriteria(metrics: {
	sampleSize: number;
	winRate: number | null;
	sharpeRatio: number | null;
}): boolean {
	if (metrics.sampleSize < SLOW_BLEEDER_MIN_SAMPLE) return false;
	if (metrics.sharpeRatio == null || metrics.sharpeRatio > SLOW_BLEEDER_MAX_SHARPE) return false;
	if (metrics.winRate == null || metrics.winRate > SLOW_BLEEDER_MAX_WIN_RATE) return false;
	return true;
}

export async function checkSlowBleederPause(): Promise<number[]> {
	const db = getDb();

	const paperStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"))
		.all();

	const paused: number[] = [];

	for (const strategy of paperStrategies) {
		const [metrics] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strategy.id));

		if (!metrics) continue;

		if (
			!meetsStatsCriteria({
				sampleSize: metrics.sampleSize,
				winRate: metrics.winRate,
				sharpeRatio: metrics.sharpeRatio,
			})
		) {
			continue;
		}

		const tagStats = await getMechanismFailureStats(strategy.id);
		const tagCoupled =
			tagStats.totalReviews >= MECHANISM_FAILURE_MIN_REVIEWS &&
			tagStats.failureRate >= MECHANISM_FAILURE_RATE_THRESHOLD;

		if (!tagCoupled) continue;

		await db
			.update(strategies)
			.set({ status: "paused" as const })
			.where(eq(strategies.id, strategy.id));

		await db.insert(graduationEvents).values({
			strategyId: strategy.id,
			event: "paused" as const,
			fromTier: "paper",
			toTier: "paused",
			evidence: JSON.stringify({
				reason: "slow_bleeder",
				sampleSize: metrics.sampleSize,
				sharpeRatio: metrics.sharpeRatio,
				winRate: metrics.winRate,
				failureRate: tagStats.failureRate,
				reviewCount: tagStats.totalReviews,
			}),
		});

		log.warn(
			{
				strategyId: strategy.id,
				name: strategy.name,
				sampleSize: metrics.sampleSize,
				sharpeRatio: metrics.sharpeRatio,
				winRate: metrics.winRate,
				failureRate: tagStats.failureRate,
			},
			"slow_bleeder_paused",
		);
		paused.push(strategy.id);
	}

	return paused;
}
