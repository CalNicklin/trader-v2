import { eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { riskState, strategies } from "../db/schema.ts";
import { getOpenPositions } from "../paper/manager.ts";
import { runGuardian } from "../risk/guardian.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "risk-guardian-job" });

/**
 * Compute the current portfolio value.
 * When live trading is enabled and IBKR is connected, uses real account data.
 * Otherwise, sums paper strategy virtual balances.
 */
async function computePortfolioState() {
	const config = getConfig();

	if (config.LIVE_TRADING_ENABLED) {
		try {
			const { isConnected } = await import("../broker/connection.ts");
			if (isConnected()) {
				const { getAccountSummary } = await import("../broker/account.ts");
				const summary = await getAccountSummary();
				return summary.netLiquidation;
			}
		} catch (err) {
			log.warn({ error: err }, "Failed to get IBKR account summary — falling back to paper");
		}
	}

	// Fallback: paper strategy virtual balances
	const db = getDb();
	const activeStrategies = await db.select().from(strategies).where(eq(strategies.status, "paper"));

	let totalBalance = 0;
	for (const s of activeStrategies) {
		totalBalance += s.virtualBalance;
		const positions = await getOpenPositions(s.id);
		for (const p of positions) {
			totalBalance += p.quantity * (p.currentPrice ?? p.entryPrice);
		}
	}

	return totalBalance;
}

/**
 * Read daily and weekly PnL from the risk_state table.
 * Returns 0 for either value if no row exists yet.
 */
export async function getLivePnl(): Promise<{ daily: number; weekly: number }> {
	const db = getDb();
	const rows = await db.select().from(riskState).where(eq(riskState.key, "daily_pnl"));
	const weeklyRows = await db.select().from(riskState).where(eq(riskState.key, "weekly_pnl"));

	const daily = rows[0] ? Number.parseFloat(rows[0].value) || 0 : 0;
	const weekly = weeklyRows[0] ? Number.parseFloat(weeklyRows[0].value) || 0 : 0;

	return { daily, weekly };
}

/**
 * Run the risk guardian check. Called every 10 minutes during market hours.
 * Reads portfolio state, calls the pure guardian checks, and persists flags.
 */
export async function runRiskGuardianJob(): Promise<void> {
	const portfolioValue = await computePortfolioState();
	const { daily, weekly } = await getLivePnl();

	const verdict = await runGuardian(portfolioValue, daily, weekly);

	if (!verdict.canTrade || verdict.reduceSizes) {
		log.warn({ verdict, daily, weekly }, "Risk guardian flagged issues");
	} else {
		log.debug({ portfolioValue, daily, weekly }, "Risk guardian: all clear");
	}
}
