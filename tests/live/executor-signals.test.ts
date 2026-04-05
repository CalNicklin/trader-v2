import { describe, expect, test } from "bun:test";

// Test the buildLiveSignalContext helper we'll create.
import { buildLiveSignalContext } from "../../src/live/executor.ts";

describe("buildLiveSignalContext", () => {
	test("builds context from quote and indicators (no position)", () => {
		const ctx = buildLiveSignalContext(
			{
				last: 150,
				bid: 149.5,
				ask: 150.5,
				changePercent: -2.5,
				volume: null,
				avgVolume: null,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			{ rsi14: 25, atr14: 3.5, volume_ratio: 1.2 },
			null,
		);
		expect(ctx.last).toBe(150);
		expect(ctx.rsi14).toBe(25);
		expect(ctx.change_percent).toBe(-2.5);
		expect(ctx.hold_days).toBeNull();
		expect(ctx.pnl_pct).toBeNull();
	});

	test("builds context with position data for exit signals", () => {
		const openedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = buildLiveSignalContext(
			{
				last: 160,
				bid: 159.5,
				ask: 160.5,
				changePercent: 1.0,
				volume: null,
				avgVolume: null,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			{ rsi14: 72, atr14: 4.0, volume_ratio: 0.8 },
			{ entryPrice: 150, openedAt, quantity: 10 },
		);
		expect(ctx.hold_days).toBe(3);
		expect(ctx.pnl_pct).toBeCloseTo(6.67, 1);
	});
});
