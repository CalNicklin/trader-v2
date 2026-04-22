import { describe, expect, test } from "bun:test";
import { checkTradeRiskGate } from "../../src/risk/gate.ts";

describe("risk gate integration (live executor pattern)", () => {
	test("rejects trade when max concurrent positions exceeded", () => {
		const result = checkTradeRiskGate({
			accountBalance: 500,
			price: 100,
			atr14: 2,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 6, // Already at max (TRA-12)
			openPositionSectors: [null, null, null, null, null, null],
		});
		expect(result.allowed).toBe(false);
	});

	test("provides ATR-based quantity and stop-loss", () => {
		const result = checkTradeRiskGate({
			accountBalance: 500,
			price: 50,
			atr14: 2,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 0,
			openPositionSectors: [],
		});
		expect(result.allowed).toBe(true);
		expect(result.sizing).toBeDefined();
		expect(result.sizing!.quantity).toBeGreaterThan(0);
		expect(result.sizing!.stopLossPrice).toBeLessThan(50);
	});

	test("reduces size when weekly drawdown active", () => {
		const normal = checkTradeRiskGate({
			accountBalance: 5000,
			price: 50,
			atr14: 2,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 0,
			openPositionSectors: [],
			weeklyDrawdownActive: false,
		});
		const reduced = checkTradeRiskGate({
			accountBalance: 5000,
			price: 50,
			atr14: 2,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 0,
			openPositionSectors: [],
			weeklyDrawdownActive: true,
		});
		expect(normal.allowed).toBe(true);
		expect(reduced.allowed).toBe(true);
		expect(reduced.sizing!.quantity).toBeLessThan(normal.sizing!.quantity);
	});
});
