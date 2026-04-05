// tests/risk/position-sizer.test.ts
import { describe, expect, test } from "bun:test";
import { calcAtrPositionSize, calcStopLossPrice } from "../../src/risk/position-sizer.ts";

describe("risk/position-sizer", () => {
	describe("calcStopLossPrice", () => {
		test("long stop loss = price - 2x ATR", () => {
			const stop = calcStopLossPrice(100, 5, "BUY");
			expect(stop).toBe(90); // 100 - (5 * 2)
		});

		test("short stop loss = price + 1x ATR", () => {
			const stop = calcStopLossPrice(100, 5, "SELL");
			expect(stop).toBe(105); // 100 + (5 * 1)
		});

		test("long stop cannot be negative", () => {
			const stop = calcStopLossPrice(5, 10, "BUY");
			expect(stop).toBe(0.01); // floored to 0.01
		});
	});

	describe("calcAtrPositionSize", () => {
		test("basic long position sizing", () => {
			const result = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "NASDAQ",
			});

			// risk = 10000 * 0.01 = 100
			// stop_distance = 5 * 2 = 10
			// friction_per_share = 100 * 0.002 = 0.2
			// risk_per_share = 10 + 0.2 = 10.2
			// shares = 100 / 10.2 = 9.8 -> floor = 9
			// position_value = 9 * 100 = 900
			expect(result.quantity).toBe(9);
			expect(result.stopLossPrice).toBe(90); // 100 - 10
			expect(result.riskAmount).toBeCloseTo(9 * 10 + 9 * 0.2, 1); // 91.8
			expect(result.positionValue).toBe(900);
		});

		test("basic short position sizing (75% cap)", () => {
			const result = calcAtrPositionSize({
				accountBalance: 500,
				price: 50,
				atr14: 2.5,
				side: "SELL",
				exchange: "NASDAQ",
			});

			// risk = 500 * 0.01 = 5, short cap = 5 * 0.75 = 3.75
			// stop_distance = 2.5 * 1 = 2.5
			// shares = 3.75 / 2.5 = 1.5 -> floor = 1
			// position_value = 1 * 50 = 50
			expect(result.quantity).toBe(1);
			expect(result.stopLossPrice).toBe(52.5); // 50 + 2.5
		});

		test("returns zero quantity when risk budget too small", () => {
			const result = calcAtrPositionSize({
				accountBalance: 100,
				price: 200,
				atr14: 10,
				side: "BUY",
				exchange: "NASDAQ",
			});

			// risk = 100 * 0.01 = 1
			// stop_distance = 10 * 2 = 20
			// shares = 1 / 20 = 0.05 -> floor = 0
			expect(result.quantity).toBe(0);
			expect(result.skipped).toBe(true);
			expect(result.skipReason).toContain("zero");
		});

		test("accounts for friction in position value calculation", () => {
			const resultNasdaq = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "NASDAQ",
			});

			const resultLSE = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "LSE",
			});

			// LSE has higher friction (0.6% stamp duty) so effective risk per share is higher
			expect(resultNasdaq.quantity).toBeGreaterThan(0);
			expect(resultLSE.quantity).toBeGreaterThan(0);
			expect(resultLSE.friction).toBeGreaterThan(resultNasdaq.friction);
		});

		test("weekly drawdown mode reduces size by 50%", () => {
			const normal = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "NASDAQ",
			});

			const reduced = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "NASDAQ",
				weeklyDrawdownActive: true,
			});

			expect(reduced.quantity).toBeLessThanOrEqual(Math.floor(normal.quantity * 0.5));
		});

		test("returns zero when ATR is zero or null", () => {
			const result = calcAtrPositionSize({
				accountBalance: 500,
				price: 50,
				atr14: 0,
				side: "BUY",
				exchange: "NASDAQ",
			});
			expect(result.quantity).toBe(0);
			expect(result.skipped).toBe(true);
		});

		test("handles very small account balance", () => {
			const result = calcAtrPositionSize({
				accountBalance: 10,
				price: 5,
				atr14: 0.5,
				side: "BUY",
				exchange: "NASDAQ",
			});
			expect(result.quantity).toBe(0);
			expect(result.skipped).toBe(true);
		});
	});
});
