import { and, eq, gte, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { graduationEvents, liveTrades, strategies, strategyMetrics } from "../db/schema.ts";
import { type BehavioralComparison, checkBehavioralDivergence } from "../risk/demotion.ts";
import {
	type ComparableMetrics,
	checkPromotionEligibility,
	computeLiveMetrics,
} from "../strategy/promotion.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "promotion-job" });

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export async function runPromotionCheck(): Promise<{
	promoted: number;
	checked: number;
}> {
	const db = getDb();
	let promoted = 0;
	let checked = 0;

	// Fetch all strategies in promotable tiers
	const candidates = await db.select().from(strategies).where(eq(strategies.status, "probation"));

	const activeCandidates = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "active"));

	const allCandidates = [...candidates, ...activeCandidates];

	for (const strategy of allCandidates) {
		checked++;
		const tier = strategy.status as "probation" | "active";

		// Count live trades since promotion
		const sinceDate = strategy.promotedAt ?? strategy.createdAt;
		const tradesForStrategy = await db
			.select({ pnl: liveTrades.pnl, fillPrice: liveTrades.fillPrice })
			.from(liveTrades)
			.where(
				and(
					eq(liveTrades.strategyId, strategy.id),
					eq(liveTrades.status, "FILLED"),
					isNotNull(liveTrades.pnl),
					gte(liveTrades.createdAt, sinceDate),
				),
			);

		const liveMetrics = computeLiveMetrics(tradesForStrategy);

		// Get paper metrics
		const [paperRow] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strategy.id))
			.limit(1);

		const paperMetrics: ComparableMetrics = {
			sharpeRatio: paperRow?.sharpeRatio ?? null,
			winRate: paperRow?.winRate ?? null,
			profitFactor: paperRow?.profitFactor ?? null,
		};

		// Check for active demotion strikes (strike events in last 30 days)
		const thirtyDaysAgo = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
		const recentStrikes = await db
			.select()
			.from(graduationEvents)
			.where(
				and(
					eq(graduationEvents.strategyId, strategy.id),
					eq(graduationEvents.event, "demoted"),
					gte(graduationEvents.createdAt, thirtyDaysAgo),
				),
			);

		// Count demotions in last 60 days (for core eligibility)
		const sixtyDaysAgo = new Date(Date.now() - SIXTY_DAYS_MS).toISOString();
		const recentDemotions = await db
			.select()
			.from(graduationEvents)
			.where(
				and(
					eq(graduationEvents.strategyId, strategy.id),
					eq(graduationEvents.event, "demoted"),
					gte(graduationEvents.createdAt, sixtyDaysAgo),
				),
			);

		// Behavioral divergence check (use zeros for paper since we don't track slippage in paper)
		const comparison: BehavioralComparison = {
			paperAvgSlippage: 0,
			liveAvgSlippage: 0,
			paperFillRate: 1,
			liveFillRate: 1,
			paperAvgFriction: 0,
			liveAvgFriction: 0,
		};

		// Compute live friction stats if we have trades
		if (tradesForStrategy.length > 0) {
			const allLiveTrades = await db
				.select({ friction: liveTrades.friction, status: liveTrades.status })
				.from(liveTrades)
				.where(and(eq(liveTrades.strategyId, strategy.id), gte(liveTrades.createdAt, sinceDate)));
			const filled = allLiveTrades.filter((t) => t.status === "FILLED");
			const total = allLiveTrades.length;
			if (total > 0) {
				comparison.liveFillRate = filled.length / total;
				comparison.liveAvgFriction =
					filled.reduce((sum, t) => sum + (t.friction ?? 0), 0) / filled.length || 0;
			}
		}

		const divergence = checkBehavioralDivergence(comparison);

		const result = checkPromotionEligibility({
			currentTier: tier,
			liveTradeCount: liveMetrics.sampleSize,
			hasActiveStrikes: recentStrikes.length > 0,
			paperMetrics,
			liveMetrics: {
				sharpeRatio: liveMetrics.sharpeRatio,
				winRate: liveMetrics.winRate,
				profitFactor: liveMetrics.profitFactor,
			},
			liveSharpe: liveMetrics.sharpeRatio ?? 0,
			liveExpectancy: liveMetrics.expectancy ?? 0,
			recentDemotionCount: recentDemotions.length,
			diverged: divergence.diverged,
		});

		if (result.eligible && result.nextTier) {
			await db
				.update(strategies)
				.set({ status: result.nextTier, promotedAt: new Date().toISOString() })
				.where(eq(strategies.id, strategy.id));

			await db.insert(graduationEvents).values({
				strategyId: strategy.id,
				event: "promoted" as const,
				fromTier: tier,
				toTier: result.nextTier,
				evidence: JSON.stringify({
					liveTradeCount: liveMetrics.sampleSize,
					liveMetrics,
					paperMetrics,
					divergence: divergence.diverged ? divergence.reasons : null,
				}),
			});

			log.info(
				{ strategyId: strategy.id, name: strategy.name, from: tier, to: result.nextTier },
				"Strategy promoted",
			);
			promoted++;
		} else {
			log.debug(
				{ strategyId: strategy.id, name: strategy.name, tier, reasons: result.reasons },
				"Strategy not ready for promotion",
			);
		}
	}

	log.info({ checked, promoted }, "Daily promotion check complete");
	return { promoted, checked };
}
