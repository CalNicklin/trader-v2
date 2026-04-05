import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { getOpenPositions } from "../paper/manager.ts";
import { runGuardian } from "../risk/guardian.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "risk-guardian-job" });

/**
 * Compute the current portfolio value by summing virtual balances
 * and open position values across all active strategies.
 */
async function computePortfolioState() {
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
 * Run the risk guardian check. Called every 10 minutes during market hours.
 * Reads portfolio state, calls the pure guardian checks, and persists flags.
 */
export async function runRiskGuardianJob(): Promise<void> {
	const portfolioValue = await computePortfolioState();

	// For now, daily/weekly PnL are approximated from portfolio value vs stored state.
	// The guardian's runGuardian will read persisted daily_pnl and weekly_pnl from risk_state.
	// We pass 0 here as the guardian reads the actual values from the DB.
	// TODO: Compute real daily/weekly PnL from trade history when snapshots are available.
	const verdict = await runGuardian(portfolioValue, 0, 0);

	if (!verdict.canTrade || verdict.reduceSizes) {
		log.warn({ verdict }, "Risk guardian flagged issues");
	} else {
		log.debug({ portfolioValue }, "Risk guardian: all clear");
	}
}
