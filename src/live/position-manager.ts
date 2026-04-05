import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { livePositions, riskState } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "position-manager" });

export interface EntryFillInput {
	symbol: string;
	exchange: string;
	strategyId: number;
	quantity: number; // negative for shorts
	avgCost: number;
	stopLossPrice: number | null;
	side: "BUY" | "SELL";
}

export interface ExitFillInput {
	symbol: string;
	exchange: string;
	exitPrice: number;
	quantity: number;
	commission: number;
}

/**
 * On BUY/entry fill: insert livePositions row.
 */
export async function onEntryFill(input: EntryFillInput): Promise<void> {
	const db = getDb();

	await db
		.insert(livePositions)
		.values({
			strategyId: input.strategyId,
			symbol: input.symbol,
			exchange: input.exchange,
			currency: input.exchange === "LSE" ? "GBP" : "USD",
			quantity: input.quantity,
			avgCost: input.avgCost,
			stopLossPrice: input.stopLossPrice,
		})
		.onConflictDoNothing(); // UNIQUE(symbol, exchange)

	log.info(
		{
			symbol: input.symbol,
			exchange: input.exchange,
			quantity: input.quantity,
			avgCost: input.avgCost,
			stopLossPrice: input.stopLossPrice,
		},
		"Position opened from fill",
	);
}

/**
 * On exit fill: compute PnL, delete position, record daily PnL contribution.
 * Returns the computed PnL.
 */
export async function onExitFill(input: ExitFillInput): Promise<number> {
	const db = getDb();

	// Find the position
	const [position] = await db
		.select()
		.from(livePositions)
		.where(and(eq(livePositions.symbol, input.symbol), eq(livePositions.exchange, input.exchange)))
		.limit(1);

	if (!position) {
		log.warn({ symbol: input.symbol }, "No position found for exit fill — orphaned exit");
		return 0;
	}

	// Compute PnL
	const isShort = position.quantity < 0;
	const pnl = isShort
		? (position.avgCost - input.exitPrice) * Math.abs(position.quantity) - input.commission
		: (input.exitPrice - position.avgCost) * position.quantity - input.commission;

	// Delete position
	await db.delete(livePositions).where(eq(livePositions.id, position.id));

	// Record daily PnL contribution to risk_state
	await addDailyPnl(pnl);

	log.info(
		{
			symbol: input.symbol,
			exitPrice: input.exitPrice,
			entryPrice: position.avgCost,
			pnl,
			isShort,
		},
		"Position closed from fill",
	);

	return pnl;
}

/**
 * Add PnL to daily and weekly accumulators in risk_state.
 */
async function addDailyPnl(pnl: number): Promise<void> {
	const db = getDb();

	// Read current daily_pnl
	const [dailyRow] = await db
		.select({ value: riskState.value })
		.from(riskState)
		.where(eq(riskState.key, "daily_pnl"))
		.limit(1);

	const currentDaily = dailyRow ? Number.parseFloat(dailyRow.value) : 0;
	const newDaily = currentDaily + pnl;

	await db
		.insert(riskState)
		.values({ key: "daily_pnl", value: newDaily.toString() })
		.onConflictDoUpdate({
			target: riskState.key,
			set: { value: newDaily.toString(), updatedAt: new Date().toISOString() },
		});

	// Also accumulate weekly
	const [weeklyRow] = await db
		.select({ value: riskState.value })
		.from(riskState)
		.where(eq(riskState.key, "weekly_pnl"))
		.limit(1);

	const currentWeekly = weeklyRow ? Number.parseFloat(weeklyRow.value) : 0;
	const newWeekly = currentWeekly + pnl;

	await db
		.insert(riskState)
		.values({ key: "weekly_pnl", value: newWeekly.toString() })
		.onConflictDoUpdate({
			target: riskState.key,
			set: { value: newWeekly.toString(), updatedAt: new Date().toISOString() },
		});
}
