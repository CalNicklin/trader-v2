// src/risk/guardian-checks.ts
import {
	DAILY_LOSS_HALT_PCT,
	MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT,
	WEEKLY_DRAWDOWN_LIMIT_PCT,
} from "./constants.ts";

export interface GuardianState {
	accountBalance: number;
	peakBalance: number;
	dailyPnl: number;
	weeklyPnl: number;
	currentPortfolioValue: number;
}

interface DailyCheckResult {
	halt: boolean;
	action?: "daily_halt";
	reason?: string;
}

interface WeeklyCheckResult {
	halt: boolean;
	reduceSizes: boolean;
	action?: "weekly_size_reduction";
	reason?: string;
}

interface CircuitBreakerResult {
	halt: boolean;
	requiresManualRestart: boolean;
	action?: "circuit_breaker";
	reason?: string;
}

export interface GuardianVerdict {
	canTrade: boolean;
	reduceSizes: boolean;
	requiresManualRestart: boolean;
	reasons: string[];
}

export function checkDailyLossHalt(accountBalance: number, dailyPnl: number): DailyCheckResult {
	if (accountBalance <= 0) {
		return { halt: true, action: "daily_halt", reason: "Account balance is zero or negative" };
	}

	const lossPct = Math.abs(dailyPnl) / accountBalance;

	if (dailyPnl < 0 && lossPct >= DAILY_LOSS_HALT_PCT) {
		return {
			halt: true,
			action: "daily_halt",
			reason: `Daily loss ${(lossPct * 100).toFixed(1)}% >= ${(DAILY_LOSS_HALT_PCT * 100).toFixed(0)}% halt threshold`,
		};
	}

	return { halt: false };
}

export function checkWeeklyDrawdown(accountBalance: number, weeklyPnl: number): WeeklyCheckResult {
	if (accountBalance <= 0) {
		return {
			halt: false,
			reduceSizes: true,
			action: "weekly_size_reduction",
			reason: "Account balance is zero or negative",
		};
	}

	const lossPct = Math.abs(weeklyPnl) / accountBalance;

	if (weeklyPnl < 0 && lossPct >= WEEKLY_DRAWDOWN_LIMIT_PCT) {
		return {
			halt: false,
			reduceSizes: true,
			action: "weekly_size_reduction",
			reason: `Weekly drawdown ${(lossPct * 100).toFixed(1)}% >= ${(WEEKLY_DRAWDOWN_LIMIT_PCT * 100).toFixed(0)}% — reducing position sizes by 50%`,
		};
	}

	return { halt: false, reduceSizes: false };
}

export function checkCircuitBreaker(
	peakBalance: number,
	currentPortfolioValue: number,
): CircuitBreakerResult {
	if (peakBalance <= 0) {
		return {
			halt: true,
			requiresManualRestart: true,
			action: "circuit_breaker",
			reason: "Peak balance is zero or negative",
		};
	}

	const drawdownPct = (peakBalance - currentPortfolioValue) / peakBalance;

	if (drawdownPct >= MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT) {
		return {
			halt: true,
			requiresManualRestart: true,
			action: "circuit_breaker",
			reason: `Max drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT * 100).toFixed(0)}% circuit breaker — FULL STOP, manual restart required`,
		};
	}

	return { halt: false, requiresManualRestart: false };
}

export function runGuardianChecks(state: GuardianState): GuardianVerdict {
	const reasons: string[] = [];
	let canTrade = true;
	let reduceSizes = false;
	let requiresManualRestart = false;

	// Circuit breaker (most severe — check first)
	const cb = checkCircuitBreaker(state.peakBalance, state.currentPortfolioValue);
	if (cb.halt) {
		canTrade = false;
		requiresManualRestart = true;
		if (cb.reason) reasons.push(cb.reason);
	}

	// Daily loss halt
	const daily = checkDailyLossHalt(state.accountBalance, state.dailyPnl);
	if (daily.halt) {
		canTrade = false;
		if (daily.reason) reasons.push(daily.reason);
	}

	// Weekly drawdown (size reduction, not halt)
	const weekly = checkWeeklyDrawdown(state.accountBalance, state.weeklyPnl);
	if (weekly.reduceSizes) {
		reduceSizes = true;
		if (weekly.reason) reasons.push(weekly.reason);
	}

	return { canTrade, reduceSizes, requiresManualRestart, reasons };
}
