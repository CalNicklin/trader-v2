import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client";
import { paperTrades } from "../db/schema";

/**
 * Minimum number of closed trades required before back-half-confirmation
 * is meaningful. Matches the pre-refactor `checkWalkForward` floor.
 */
export const MIN_CLOSED_TRADES_FOR_BACK_HALF = 5;

export interface BackHalfPnlResult {
	closedTradeCount: number;
	backHalfPnl: number;
}

/**
 * Shared computation used by both the graduation gate (promote path) and
 * `checkExpectancyKill` (retire path). Selects closed paper trades ordered
 * by `createdAt`, then sums P&L over the most recent 50%.
 *
 * Callers MUST check `closedTradeCount >= MIN_CLOSED_TRADES_FOR_BACK_HALF`
 * before using `backHalfPnl` to drive a decision. A tiny back-half sample
 * is not meaningful and defeats the point of the predicate.
 */
export async function computeBackHalfPnl(strategyId: number): Promise<BackHalfPnlResult> {
	const db = getDb();
	const trades = await db
		.select({ pnl: paperTrades.pnl })
		.from(paperTrades)
		.where(and(eq(paperTrades.strategyId, strategyId), isNotNull(paperTrades.pnl)))
		.orderBy(paperTrades.createdAt);

	if (trades.length === 0) return { closedTradeCount: 0, backHalfPnl: 0 };

	const splitIdx = Math.floor(trades.length / 2);
	const backHalfPnl = trades.slice(splitIdx).reduce((sum, t) => sum + (t.pnl ?? 0), 0);
	return { closedTradeCount: trades.length, backHalfPnl };
}
