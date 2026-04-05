// tests/risk/demotion.test.ts
import { describe, expect, test } from "bun:test";
import {
	type BehavioralComparison,
	checkBehavioralDivergence,
	checkKillCriteria,
	checkTwoStrikeDemotion,
	type DemotionEvent,
	type StrategyLiveStats,
} from "../../src/risk/demotion.ts";

describe("risk/demotion", () => {
	describe("checkTwoStrikeDemotion", () => {
		const now = new Date("2026-04-04T12:00:00Z");

		test("first strike: reduces capital to 50%", () => {
			const result = checkTwoStrikeDemotion([], now);
			expect(result.action).toBe("first_strike");
			expect(result.capitalMultiplier).toBe(0.5);
		});

		test("second strike within 30 days: demote", () => {
			const events: DemotionEvent[] = [{ date: new Date("2026-03-20T12:00:00Z"), type: "strike" }];
			const result = checkTwoStrikeDemotion(events, now);
			expect(result.action).toBe("demote");
		});

		test("second strike outside 30 days: treated as first strike", () => {
			const events: DemotionEvent[] = [{ date: new Date("2026-02-01T12:00:00Z"), type: "strike" }];
			const result = checkTwoStrikeDemotion(events, now);
			expect(result.action).toBe("first_strike");
			expect(result.capitalMultiplier).toBe(0.5);
		});

		test("already demoted twice: kill", () => {
			const events: DemotionEvent[] = [
				{ date: new Date("2026-03-10T12:00:00Z"), type: "demotion" },
				{ date: new Date("2026-03-25T12:00:00Z"), type: "demotion" },
			];
			const result = checkTwoStrikeDemotion(events, now);
			expect(result.action).toBe("kill");
		});
	});

	describe("checkKillCriteria", () => {
		test("no kill when all metrics healthy", () => {
			const stats: StrategyLiveStats = {
				liveTradeCount: 30,
				totalPnl: 50,
				currentLossStreak: 2,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 1,
				demotionCount: 0,
				demotionDates: [],
			};
			const result = checkKillCriteria(stats, new Date());
			expect(result.shouldKill).toBe(false);
		});

		test("kill when loss streak > 3 SD", () => {
			const stats: StrategyLiveStats = {
				liveTradeCount: 50,
				totalPnl: -100,
				currentLossStreak: 10,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 2,
				demotionCount: 0,
				demotionDates: [],
			};
			// 10 > 3 + (3 * 2) = 9 -> kill
			const result = checkKillCriteria(stats, new Date());
			expect(result.shouldKill).toBe(true);
			expect(result.reason).toContain("Loss streak");
		});

		test("kill when not profitable after 60 live trades", () => {
			const stats: StrategyLiveStats = {
				liveTradeCount: 60,
				totalPnl: -10,
				currentLossStreak: 1,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 1,
				demotionCount: 0,
				demotionDates: [],
			};
			const result = checkKillCriteria(stats, new Date());
			expect(result.shouldKill).toBe(true);
			expect(result.reason).toContain("60");
		});

		test("no kill at 59 trades even if unprofitable", () => {
			const stats: StrategyLiveStats = {
				liveTradeCount: 59,
				totalPnl: -10,
				currentLossStreak: 1,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 1,
				demotionCount: 0,
				demotionDates: [],
			};
			const result = checkKillCriteria(stats, new Date());
			expect(result.shouldKill).toBe(false);
		});

		test("kill when demoted twice within 60 days", () => {
			const now = new Date("2026-04-04T12:00:00Z");
			const stats: StrategyLiveStats = {
				liveTradeCount: 30,
				totalPnl: 10,
				currentLossStreak: 0,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 1,
				demotionCount: 2,
				demotionDates: [new Date("2026-02-15T12:00:00Z"), new Date("2026-03-20T12:00:00Z")],
			};
			const result = checkKillCriteria(stats, now);
			expect(result.shouldKill).toBe(true);
			expect(result.reason).toContain("Demoted twice");
		});
	});

	describe("checkBehavioralDivergence", () => {
		test("no divergence when within 20% threshold", () => {
			const comparison: BehavioralComparison = {
				paperAvgSlippage: 0.1,
				liveAvgSlippage: 0.11,
				paperFillRate: 0.95,
				liveFillRate: 0.9,
				paperAvgFriction: 0.002,
				liveAvgFriction: 0.0022,
			};
			const result = checkBehavioralDivergence(comparison);
			expect(result.diverged).toBe(false);
		});

		test("flags divergence when slippage deviates > 20%", () => {
			const comparison: BehavioralComparison = {
				paperAvgSlippage: 0.1,
				liveAvgSlippage: 0.15, // 50% higher
				paperFillRate: 0.95,
				liveFillRate: 0.9,
				paperAvgFriction: 0.002,
				liveAvgFriction: 0.002,
			};
			const result = checkBehavioralDivergence(comparison);
			expect(result.diverged).toBe(true);
			expect(result.reasons.length).toBeGreaterThan(0);
		});

		test("flags divergence when fill rate deviates > 20%", () => {
			const comparison: BehavioralComparison = {
				paperAvgSlippage: 0.1,
				liveAvgSlippage: 0.1,
				paperFillRate: 0.95,
				liveFillRate: 0.7, // 26% lower
				paperAvgFriction: 0.002,
				liveAvgFriction: 0.002,
			};
			const result = checkBehavioralDivergence(comparison);
			expect(result.diverged).toBe(true);
		});

		test("handles zero paper values gracefully", () => {
			const comparison: BehavioralComparison = {
				paperAvgSlippage: 0,
				liveAvgSlippage: 0.01,
				paperFillRate: 0,
				liveFillRate: 0.5,
				paperAvgFriction: 0,
				liveAvgFriction: 0.001,
			};
			const result = checkBehavioralDivergence(comparison);
			expect(result).toBeDefined();
		});
	});
});
