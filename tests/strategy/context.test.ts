import { describe, expect, test } from "bun:test";
import { buildSignalContext } from "../../src/strategy/context.ts";

describe("buildSignalContext", () => {
	test("builds context from quote and indicators", () => {
		const ctx = buildSignalContext({
			quote: {
				last: 150,
				bid: 149.5,
				ask: 150.5,
				volume: 5000000,
				avgVolume: 3000000,
				changePercent: 1.5,
				newsSentiment: 0.8,
			},
			indicators: { rsi14: 28, atr14: 3.5, volume_ratio: 1.67 },
			position: null,
		});

		expect(ctx.last).toBe(150);
		expect(ctx.rsi14).toBe(28);
		expect(ctx.atr14).toBe(3.5);
		expect(ctx.volume_ratio).toBe(1.67);
		expect(ctx.news_sentiment).toBe(0.8);
		expect(ctx.change_percent).toBe(1.5);
		expect(ctx.hold_days).toBeNull();
		expect(ctx.pnl_pct).toBeNull();
	});

	test("includes position data when position exists", () => {
		const twoDaysAgo = new Date();
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

		const ctx = buildSignalContext({
			quote: {
				last: 160,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
			},
			indicators: { rsi14: 55, atr14: 4.0, volume_ratio: null },
			position: {
				entryPrice: 150,
				openedAt: twoDaysAgo.toISOString(),
				quantity: 10,
			},
		});

		expect(ctx.hold_days).toBe(2);
		expect(ctx.pnl_pct).toBeCloseTo(6.67, 1);
	});

	test("handles null indicators gracefully", () => {
		const ctx = buildSignalContext({
			quote: {
				last: 100,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
			},
			indicators: { rsi14: null, atr14: null, volume_ratio: null },
			position: null,
		});

		expect(ctx.rsi14).toBeNull();
		expect(ctx.atr14).toBeNull();
		expect(ctx.volume_ratio).toBeNull();
	});
});
