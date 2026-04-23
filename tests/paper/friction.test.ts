import { describe, expect, test } from "bun:test";

describe("effective one-way friction (TRA-15)", () => {
	test("MAX_ONE_WAY_FRICTION_BPS defaults to 75", async () => {
		const { MAX_ONE_WAY_FRICTION_BPS } = await import("../../src/paper/friction.ts");
		expect(MAX_ONE_WAY_FRICTION_BPS).toBe(75);
	});

	test("LSE BUY at healthy notional returns base 60 bps (stamp + rate)", async () => {
		const { getEffectiveOneWayFrictionBps } = await import("../../src/paper/friction.ts");
		// £1,330 notional — commission floor (£1 = 7.5 bps here) is below rate
		expect(getEffectiveOneWayFrictionBps("LSE", "BUY", 1330)).toBeCloseTo(60, 0);
	});

	test("LSE BUY at tiny notional gets the commission-floor boost", async () => {
		const { getEffectiveOneWayFrictionBps } = await import("../../src/paper/friction.ts");
		// £50 notional — £1 commission floor = 200 bps, dominates the 60 bps rate
		expect(getEffectiveOneWayFrictionBps("LSE", "BUY", 50)).toBeCloseTo(200, 0);
	});

	test("NASDAQ at tiny notional also hits commission floor", async () => {
		const { getEffectiveOneWayFrictionBps } = await import("../../src/paper/friction.ts");
		// $20 notional — $1 commission = 500 bps
		expect(getEffectiveOneWayFrictionBps("NASDAQ", "BUY", 20)).toBeCloseTo(500, 0);
	});

	test("exceedsEdgeBudget — rejects 1-share HSBA (tiny notional)", async () => {
		const { exceedsEdgeBudget } = await import("../../src/paper/friction.ts");
		// Single HSBA share at ~1000p = £10 notional, £1 commission = 1000 bps
		expect(exceedsEdgeBudget("LSE", "BUY", 10)).toBe(true);
	});

	test("exceedsEdgeBudget — allows healthy LSE notional", async () => {
		const { exceedsEdgeBudget } = await import("../../src/paper/friction.ts");
		expect(exceedsEdgeBudget("LSE", "BUY", 1330)).toBe(false);
	});

	test("exceedsEdgeBudget — allows NASDAQ at $500 notional", async () => {
		const { exceedsEdgeBudget } = await import("../../src/paper/friction.ts");
		// 20 bps rate + 20 bps floor ($1/$500) = max(20,20) = 20 bps
		expect(exceedsEdgeBudget("NASDAQ", "BUY", 500)).toBe(false);
	});

	test("exceedsEdgeBudget — rejects when aggregate crosses 75 bps", async () => {
		const { exceedsEdgeBudget } = await import("../../src/paper/friction.ts");
		// $100 notional on NASDAQ — $1 floor = 100 bps > 75
		expect(exceedsEdgeBudget("NASDAQ", "BUY", 100)).toBe(true);
	});
});

describe("position-sizer — TRA-15 friction gate", () => {
	test("rejects entry when effective friction exceeds 75 bps", async () => {
		const { calcAtrPositionSize } = await import("../../src/risk/position-sizer.ts");
		// accountBalance 1000, ~9 HSBA shares at £10 = £90 notional
		// — clears MIN_POSITION_VALUE (£50) but £1 commission = 111 bps > 75 bps gate.
		const result = calcAtrPositionSize({
			accountBalance: 400,
			price: 10,
			atr14: 0.2,
			side: "BUY",
			exchange: "LSE",
		});
		expect(result.skipped).toBe(true);
		expect(result.skipReason).toMatch(/FRICTION_EXCEEDS_EDGE_BUDGET/);
	});

	test("accepts entry at healthy notional on LSE", async () => {
		const { calcAtrPositionSize } = await import("../../src/risk/position-sizer.ts");
		const result = calcAtrPositionSize({
			accountBalance: 100_000,
			price: 10,
			atr14: 0.2,
			side: "BUY",
			exchange: "LSE",
		});
		expect(result.skipped).toBe(false);
	});
});
