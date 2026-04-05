import { describe, expect, test } from "bun:test";

describe("buildSignalContext", () => {
	test("includes base quote and indicator fields", async () => {
		const { buildSignalContext } = await import("../../src/strategy/context.ts");

		const ctx = buildSignalContext({
			quote: {
				last: 150,
				bid: 149.9,
				ask: 150.1,
				volume: 1000000,
				avgVolume: 800000,
				changePercent: 1.5,
				newsSentiment: 0.7,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 45, atr14: 2.5, volume_ratio: 1.2 },
			position: null,
		});

		expect(ctx.last).toBe(150);
		expect(ctx.news_sentiment).toBe(0.7);
		expect(ctx.rsi14).toBe(45);
		expect(ctx.earnings_surprise).toBeNull();
	});

	test("includes signal fields when present", async () => {
		const { buildSignalContext } = await import("../../src/strategy/context.ts");

		const ctx = buildSignalContext({
			quote: {
				last: 150,
				bid: 149.9,
				ask: 150.1,
				volume: 2000000,
				avgVolume: 800000,
				changePercent: 3.5,
				newsSentiment: 0.8,
				newsEarningsSurprise: 0.9,
				newsGuidanceChange: 0.3,
				newsManagementTone: 0.7,
				newsRegulatoryRisk: 0.0,
				newsAcquisitionLikelihood: 0.0,
				newsCatalystType: "fundamental",
				newsExpectedMoveDuration: "1-3d",
			},
			indicators: { rsi14: 55, atr14: 3.0, volume_ratio: 2.5 },
			position: null,
		});

		expect(ctx.earnings_surprise).toBeCloseTo(0.9);
		expect(ctx.guidance_change).toBeCloseTo(0.3);
		expect(ctx.management_tone).toBeCloseTo(0.7);
		expect(ctx.regulatory_risk).toBeCloseTo(0.0);
		expect(ctx.acquisition_likelihood).toBeCloseTo(0.0);
	});

	test("hold_days and pnl_pct computed from position", async () => {
		const { buildSignalContext } = await import("../../src/strategy/context.ts");

		const threeDaysAgo = new Date();
		threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

		const ctx = buildSignalContext({
			quote: {
				last: 160,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: null, atr14: null, volume_ratio: null },
			position: {
				entryPrice: 150,
				openedAt: threeDaysAgo.toISOString(),
				quantity: 10,
			},
		});

		expect(ctx.hold_days).toBe(3);
		expect(ctx.pnl_pct).toBeCloseTo(6.67, 1);
	});
});
