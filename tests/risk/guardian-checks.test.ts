// tests/risk/guardian-checks.test.ts
import { describe, expect, test } from "bun:test";
import {
	checkCircuitBreaker,
	checkDailyLossHalt,
	checkWeeklyDrawdown,
	type GuardianState,
	runGuardianChecks,
} from "../../src/risk/guardian-checks.ts";

describe("risk/guardian-checks", () => {
	describe("checkDailyLossHalt", () => {
		test("allows trading when daily loss under 3%", () => {
			const result = checkDailyLossHalt(500, -10); // -2%
			expect(result.halt).toBe(false);
		});

		test("halts trading at exactly 3% daily loss", () => {
			const result = checkDailyLossHalt(500, -15); // -3%
			expect(result.halt).toBe(true);
			expect(result.action).toBe("daily_halt");
		});

		test("halts trading when daily loss exceeds 3%", () => {
			const result = checkDailyLossHalt(500, -20); // -4%
			expect(result.halt).toBe(true);
		});

		test("allows trading when daily P&L is positive", () => {
			const result = checkDailyLossHalt(500, 10);
			expect(result.halt).toBe(false);
		});

		test("handles zero balance", () => {
			const result = checkDailyLossHalt(0, -1);
			expect(result.halt).toBe(true);
		});
	});

	describe("checkWeeklyDrawdown", () => {
		test("no action when weekly drawdown under 5%", () => {
			const result = checkWeeklyDrawdown(500, -20); // -4%
			expect(result.halt).toBe(false);
			expect(result.reduceSizes).toBe(false);
		});

		test("reduces sizes at 5% weekly drawdown", () => {
			const result = checkWeeklyDrawdown(500, -25); // -5%
			expect(result.halt).toBe(false);
			expect(result.reduceSizes).toBe(true);
			expect(result.action).toBe("weekly_size_reduction");
		});

		test("reduces sizes between 5% and 10%", () => {
			const result = checkWeeklyDrawdown(500, -40); // -8%
			expect(result.reduceSizes).toBe(true);
			expect(result.halt).toBe(false);
		});
	});

	describe("checkCircuitBreaker", () => {
		test("no action when max drawdown under 10%", () => {
			const result = checkCircuitBreaker(500, 460); // -8%
			expect(result.halt).toBe(false);
		});

		test("triggers full stop at 10% max drawdown", () => {
			const result = checkCircuitBreaker(500, 450); // -10%
			expect(result.halt).toBe(true);
			expect(result.action).toBe("circuit_breaker");
			expect(result.requiresManualRestart).toBe(true);
		});

		test("triggers full stop beyond 10%", () => {
			const result = checkCircuitBreaker(500, 400); // -20%
			expect(result.halt).toBe(true);
			expect(result.requiresManualRestart).toBe(true);
		});
	});

	describe("runGuardianChecks", () => {
		test("returns all-clear when no limits breached", () => {
			const state: GuardianState = {
				accountBalance: 500,
				peakBalance: 500,
				dailyPnl: -5,
				weeklyPnl: -10,
				currentPortfolioValue: 490,
			};
			const verdict = runGuardianChecks(state);
			expect(verdict.canTrade).toBe(true);
			expect(verdict.reduceSizes).toBe(false);
			expect(verdict.reasons).toHaveLength(0);
		});

		test("daily halt takes precedence in reasons", () => {
			const state: GuardianState = {
				accountBalance: 500,
				peakBalance: 500,
				dailyPnl: -20,
				weeklyPnl: -10,
				currentPortfolioValue: 480,
			};
			const verdict = runGuardianChecks(state);
			expect(verdict.canTrade).toBe(false);
			expect(verdict.reasons.length).toBeGreaterThan(0);
		});

		test("circuit breaker overrides everything", () => {
			const state: GuardianState = {
				accountBalance: 500,
				peakBalance: 600,
				dailyPnl: 0,
				weeklyPnl: 0,
				currentPortfolioValue: 520, // 520/600 = 13.3% below peak
			};
			const verdict = runGuardianChecks(state);
			expect(verdict.canTrade).toBe(false);
			expect(verdict.requiresManualRestart).toBe(true);
		});

		test("weekly drawdown triggers size reduction without halt", () => {
			const state: GuardianState = {
				accountBalance: 1000,
				peakBalance: 1000,
				dailyPnl: -5,
				weeklyPnl: -55,
				currentPortfolioValue: 950,
			};
			const verdict = runGuardianChecks(state);
			expect(verdict.canTrade).toBe(true);
			expect(verdict.reduceSizes).toBe(true);
		});
	});
});
