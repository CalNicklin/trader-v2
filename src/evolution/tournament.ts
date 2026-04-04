import { eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { graduationEvents, strategies, strategyMetrics, strategyMutations } from "../db/schema";
import { createChildLogger } from "../utils/logger";
import type { TournamentResult } from "./types";

const log = createChildLogger({ module: "evolution:tournament" });

export const MIN_TRADES_FOR_TOURNAMENT = 30;

export async function runTournaments(): Promise<TournamentResult[]> {
	const db = getDb();

	// 1. Fetch all strategyMutations rows where tournament not yet resolved
	const mutations = await db
		.select()
		.from(strategyMutations)
		.where(isNull(strategyMutations.parentSharpe))
		.all();

	const results: TournamentResult[] = [];

	for (const mutation of mutations) {
		// 2. Skip if childSharpe also already set (belt-and-suspenders)
		if (mutation.parentSharpe != null || mutation.childSharpe != null) {
			continue;
		}

		// 3. Fetch parent and child strategy rows
		const parent = await db
			.select()
			.from(strategies)
			.where(eq(strategies.id, mutation.parentId))
			.get();

		const child = await db
			.select()
			.from(strategies)
			.where(eq(strategies.id, mutation.childId))
			.get();

		if (!parent || !child) {
			continue;
		}

		// 4. Skip if either is retired
		if (parent.status === "retired" || child.status === "retired") {
			continue;
		}

		// 5. Fetch metrics for both — skip if either has sampleSize < 30
		const parentMetrics = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, mutation.parentId))
			.get();

		const childMetrics = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, mutation.childId))
			.get();

		if (
			!parentMetrics ||
			!childMetrics ||
			parentMetrics.sampleSize < MIN_TRADES_FOR_TOURNAMENT ||
			childMetrics.sampleSize < MIN_TRADES_FOR_TOURNAMENT
		) {
			continue;
		}

		// 6. Compare Sharpe ratios (null Sharpe = -Infinity)
		const parentSharpe = parentMetrics.sharpeRatio ?? -Infinity;
		const childSharpe = childMetrics.sharpeRatio ?? -Infinity;

		// 7. Child wins if childSharpe > parentSharpe, otherwise parent wins
		const childWins = childSharpe > parentSharpe;
		const winnerId = childWins ? mutation.childId : mutation.parentId;
		const loserId = childWins ? mutation.parentId : mutation.childId;
		const reason = childWins
			? `Child wins: Sharpe ${childSharpe.toFixed(4)} > parent Sharpe ${parentSharpe.toFixed(4)}`
			: `Parent wins: Sharpe ${parentSharpe.toFixed(4)} >= child Sharpe ${childSharpe.toFixed(4)}`;

		// 8. Retire loser: update status="retired", set retiredAt
		await db
			.update(strategies)
			.set({
				status: "retired" as const,
				retiredAt: new Date().toISOString(),
			})
			.where(eq(strategies.id, loserId));

		// 9. Insert graduationEvents row for loser (event="killed")
		await db.insert(graduationEvents).values({
			strategyId: loserId,
			event: "killed" as const,
			evidence: JSON.stringify({ reason, parentSharpe, childSharpe }),
		});

		// 10. Update strategyMutations row with parentSharpe and childSharpe
		const storedParentSharpe = parentMetrics.sharpeRatio ?? -Infinity;
		const storedChildSharpe = childMetrics.sharpeRatio ?? -Infinity;

		await db
			.update(strategyMutations)
			.set({
				parentSharpe: storedParentSharpe,
				childSharpe: storedChildSharpe,
			})
			.where(eq(strategyMutations.id, mutation.id));

		// 11. Log result
		log.info(`Tournament resolved — winner: ${winnerId}, loser: ${loserId} (retired). ${reason}`);

		results.push({
			parentId: mutation.parentId,
			childId: mutation.childId,
			parentSharpe: storedParentSharpe,
			childSharpe: storedChildSharpe,
			winnerId,
			loserId,
			reason,
		});
	}

	return results;
}
