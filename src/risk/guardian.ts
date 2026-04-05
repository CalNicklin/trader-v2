// src/risk/guardian.ts
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { riskState } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { type GuardianVerdict, runGuardianChecks } from "./guardian-checks.ts";

const log = createChildLogger({ module: "guardian" });

/**
 * Read a risk_state key, returning null if not found.
 */
async function getRiskStateValue(key: string): Promise<string | null> {
	const db = getDb();
	const [row] = await db
		.select({ value: riskState.value })
		.from(riskState)
		.where(eq(riskState.key, key))
		.limit(1);
	return row?.value ?? null;
}

/**
 * Upsert a risk_state key/value.
 */
async function setRiskStateValue(key: string, value: string): Promise<void> {
	const db = getDb();
	await db
		.insert(riskState)
		.values({ key, value })
		.onConflictDoUpdate({
			target: riskState.key,
			set: { value, updatedAt: new Date().toISOString() },
		});
}

/**
 * Run the portfolio-level guardian. Called every 60s during market hours.
 *
 * 1. Read current state from DB
 * 2. Call pure guardian check functions
 * 3. Write back any state changes (halt flags, etc.)
 * 4. Return verdict for the scheduler to act on
 */
export async function runGuardian(
	currentPortfolioValue: number,
	dailyPnl: number,
	weeklyPnl: number,
): Promise<GuardianVerdict> {
	// Read persisted state
	const peakBalanceStr = await getRiskStateValue("peak_balance");
	const accountBalanceStr = await getRiskStateValue("account_balance");

	const peakBalance = peakBalanceStr ? Number.parseFloat(peakBalanceStr) : currentPortfolioValue;
	const accountBalance = accountBalanceStr
		? Number.parseFloat(accountBalanceStr)
		: currentPortfolioValue;

	// Update peak balance if we have a new high
	if (currentPortfolioValue > peakBalance) {
		await setRiskStateValue("peak_balance", currentPortfolioValue.toString());
	}

	// Run pure checks
	const verdict = runGuardianChecks({
		accountBalance,
		peakBalance: Math.max(peakBalance, currentPortfolioValue),
		dailyPnl,
		weeklyPnl,
		currentPortfolioValue,
	});

	// Persist state flags
	if (!verdict.canTrade && verdict.requiresManualRestart) {
		await setRiskStateValue("circuit_breaker_tripped", "true");
		log.error({ verdict }, "CIRCUIT BREAKER TRIPPED — manual restart required");

		// Send alert email
		try {
			const { sendEmail } = await import("../reporting/email.ts");
			await sendEmail({
				subject: "CIRCUIT BREAKER TRIPPED — Trader v2",
				html: `<h2 style="color:red">Circuit Breaker Tripped</h2>
<p>Max drawdown exceeded 10% — all trading halted.</p>
<p><strong>Manual restart required.</strong></p>
<pre>${JSON.stringify(verdict, null, 2)}</pre>
<p>Time: ${new Date().toISOString()}</p>`,
			});
		} catch (emailErr) {
			log.error({ emailErr }, "Failed to send circuit breaker alert email");
		}
	}

	if (!verdict.canTrade) {
		await setRiskStateValue("daily_halt_active", "true");
		log.warn({ verdict }, "Daily trading halt activated");
	}

	if (verdict.reduceSizes) {
		await setRiskStateValue("weekly_drawdown_active", "true");
		log.warn({ verdict }, "Weekly drawdown — position sizes reduced 50%");
	}

	return verdict;
}

/**
 * Check if trading is currently halted (reads persisted flags).
 */
export async function isTradingHalted(): Promise<{
	halted: boolean;
	requiresManualRestart: boolean;
	reason?: string;
}> {
	const circuitBreaker = await getRiskStateValue("circuit_breaker_tripped");
	if (circuitBreaker === "true") {
		return {
			halted: true,
			requiresManualRestart: true,
			reason: "Circuit breaker tripped — manual restart required",
		};
	}

	const dailyHalt = await getRiskStateValue("daily_halt_active");
	if (dailyHalt === "true") {
		return {
			halted: true,
			requiresManualRestart: false,
			reason: "Daily loss halt active",
		};
	}

	return { halted: false, requiresManualRestart: false };
}

/**
 * Check if weekly drawdown size reduction is active.
 */
export async function isWeeklyDrawdownActive(): Promise<boolean> {
	const value = await getRiskStateValue("weekly_drawdown_active");
	return value === "true";
}

/**
 * Manually reset the circuit breaker. Only called by human operator.
 */
export async function resetCircuitBreaker(): Promise<void> {
	await setRiskStateValue("circuit_breaker_tripped", "false");
	log.info("Circuit breaker manually reset");
}

/**
 * Reset daily flags. Called at market open each day.
 */
export async function resetDailyState(): Promise<void> {
	await setRiskStateValue("daily_halt_active", "false");
	await setRiskStateValue("daily_pnl", "0");
	log.info("Daily risk state reset");
}

/**
 * Reset weekly flags. Called Monday at market open.
 */
export async function resetWeeklyState(): Promise<void> {
	await setRiskStateValue("weekly_drawdown_active", "false");
	await setRiskStateValue("weekly_pnl", "0");
	log.info("Weekly risk state reset");
}
