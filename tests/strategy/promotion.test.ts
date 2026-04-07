import { describe, expect, test } from "bun:test";
import {
	checkMetricDegradation,
	checkPromotionEligibility,
	computeLiveMetrics,
} from "../../src/strategy/promotion";

describe("computeLiveMetrics", () => {
	test("computes win rate, expectancy, sharpe, and profit factor from trades", () => {
		const trades = [
			{ pnl: 100, fillPrice: 150 },
			{ pnl: -50, fillPrice: 200 },
			{ pnl: 80, fillPrice: 160 },
			{ pnl: 120, fillPrice: 140 },
			{ pnl: -30, fillPrice: 180 },
		];
		const result = computeLiveMetrics(trades);
		expect(result.sampleSize).toBe(5);
		expect(result.winRate).toBeCloseTo(0.6, 2);
		expect(result.expectancy).toBeCloseTo(44, 0); // (100+80+120-50-30)/5 = 44
		expect(result.profitFactor).toBeCloseTo(300 / 80, 1); // gross profit / gross loss
	});

	test("returns null metrics for empty trades", () => {
		const result = computeLiveMetrics([]);
		expect(result.sampleSize).toBe(0);
		expect(result.winRate).toBeNull();
	});
});

describe("checkMetricDegradation", () => {
	test("passes when live metrics are within 20% of paper", () => {
		const paper = { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 };
		const live = { sharpeRatio: 0.85, winRate: 0.52, profitFactor: 1.7 };
		const result = checkMetricDegradation(paper, live, 0.2);
		expect(result.degraded).toBe(false);
		expect(result.reasons).toHaveLength(0);
	});

	test("fails when Sharpe degrades more than 20%", () => {
		const paper = { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 };
		const live = { sharpeRatio: 0.7, winRate: 0.55, profitFactor: 1.8 };
		const result = checkMetricDegradation(paper, live, 0.2);
		expect(result.degraded).toBe(true);
		expect(result.reasons.length).toBeGreaterThan(0);
		expect(result.reasons[0]).toContain("Sharpe");
	});

	test("fails when win rate degrades more than 20%", () => {
		const paper = { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 };
		const live = { sharpeRatio: 0.9, winRate: 0.4, profitFactor: 1.8 };
		const result = checkMetricDegradation(paper, live, 0.2);
		expect(result.degraded).toBe(true);
		expect(result.reasons[0]).toContain("Win rate");
	});

	test("handles null paper metrics gracefully (skips comparison)", () => {
		const paper = { sharpeRatio: null, winRate: 0.6, profitFactor: null };
		const live = { sharpeRatio: 0.5, winRate: 0.55, profitFactor: 1.5 };
		const result = checkMetricDegradation(paper, live, 0.2);
		expect(result.degraded).toBe(false);
	});
});

describe("checkPromotionEligibility", () => {
	test("probation → active: eligible with 30+ trades and metrics within tolerance", () => {
		const result = checkPromotionEligibility({
			currentTier: "probation",
			liveTradeCount: 35,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.9,
			liveExpectancy: 10,
			recentDemotionCount: 0,
			diverged: false,
		});
		expect(result.eligible).toBe(true);
		expect(result.nextTier).toBe("active");
	});

	test("probation → active: not eligible with <30 trades", () => {
		const result = checkPromotionEligibility({
			currentTier: "probation",
			liveTradeCount: 20,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.9,
			liveExpectancy: 10,
			recentDemotionCount: 0,
			diverged: false,
		});
		expect(result.eligible).toBe(false);
	});

	test("probation → active: blocked by active demotion strike", () => {
		const result = checkPromotionEligibility({
			currentTier: "probation",
			liveTradeCount: 40,
			hasActiveStrikes: true,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.9,
			liveExpectancy: 10,
			recentDemotionCount: 0,
			diverged: false,
		});
		expect(result.eligible).toBe(false);
	});

	test("probation → active: blocked by behavioral divergence", () => {
		const result = checkPromotionEligibility({
			currentTier: "probation",
			liveTradeCount: 40,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.9,
			liveExpectancy: 10,
			recentDemotionCount: 0,
			diverged: true,
		});
		expect(result.eligible).toBe(false);
	});

	test("active → core: eligible with 100+ trades and sustained edge", () => {
		const result = checkPromotionEligibility({
			currentTier: "active",
			liveTradeCount: 110,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.6,
			liveExpectancy: 15,
			recentDemotionCount: 0,
			diverged: false,
		});
		expect(result.eligible).toBe(true);
		expect(result.nextTier).toBe("core");
	});

	test("active → core: not eligible with Sharpe < 0.5", () => {
		const result = checkPromotionEligibility({
			currentTier: "active",
			liveTradeCount: 110,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.4, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.4,
			liveExpectancy: 5,
			recentDemotionCount: 0,
			diverged: false,
		});
		expect(result.eligible).toBe(false);
	});

	test("active → core: blocked by recent demotion", () => {
		const result = checkPromotionEligibility({
			currentTier: "active",
			liveTradeCount: 110,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.7,
			liveExpectancy: 15,
			recentDemotionCount: 1,
			diverged: false,
		});
		expect(result.eligible).toBe(false);
	});

	test("active → core: blocked by behavioral divergence", () => {
		const result = checkPromotionEligibility({
			currentTier: "active",
			liveTradeCount: 110,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.7,
			liveExpectancy: 15,
			recentDemotionCount: 0,
			diverged: true,
		});
		expect(result.eligible).toBe(false);
	});

	test("active → core: not eligible with expectancy = 0", () => {
		const result = checkPromotionEligibility({
			currentTier: "active",
			liveTradeCount: 110,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.7,
			liveExpectancy: 0,
			recentDemotionCount: 0,
			diverged: false,
		});
		expect(result.eligible).toBe(false);
	});

	test("core tier returns not eligible (already at top)", () => {
		const result = checkPromotionEligibility({
			currentTier: "core",
			liveTradeCount: 200,
			hasActiveStrikes: false,
			paperMetrics: { sharpeRatio: 1.0, winRate: 0.6, profitFactor: 2.0 },
			liveMetrics: { sharpeRatio: 0.9, winRate: 0.55, profitFactor: 1.8 },
			liveSharpe: 0.9,
			liveExpectancy: 20,
			recentDemotionCount: 0,
			diverged: false,
		});
		expect(result.eligible).toBe(false);
	});
});
