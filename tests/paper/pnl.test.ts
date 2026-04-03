import { describe, expect, test } from "bun:test";
import { calcFriction, calcPnl, calcPositionSize } from "../../src/paper/pnl.ts";

describe("calcFriction", () => {
	test("LSE buy has stamp duty", () => {
		const friction = calcFriction(1000, "LSE", "BUY");
		expect(friction).toBeCloseTo(6.0, 2);
	});

	test("AIM has no stamp duty", () => {
		const friction = calcFriction(1000, "AIM", "BUY");
		expect(friction).toBeCloseTo(1.0, 2);
	});

	test("US has FX spread", () => {
		const friction = calcFriction(1000, "NASDAQ", "BUY");
		expect(friction).toBeCloseTo(2.0, 2);
	});
});

describe("calcPositionSize", () => {
	test("calculates quantity from balance and position_size_pct", () => {
		const result = calcPositionSize(10000, 10, 150);
		expect(result.quantity).toBe(6);
		expect(result.positionValue).toBeCloseTo(900, 0);
	});

	test("returns 0 quantity if position value below minimum", () => {
		const result = calcPositionSize(100, 10, 150);
		expect(result.quantity).toBe(0);
	});
});

describe("calcPnl", () => {
	test("profitable long trade", () => {
		const pnl = calcPnl("BUY", 10, 100, 110, 0.002, 0.002);
		expect(pnl).toBeCloseTo(95.8, 1);
	});

	test("losing long trade", () => {
		const pnl = calcPnl("BUY", 10, 100, 90, 0.002, 0.002);
		expect(pnl).toBeCloseTo(-103.8, 1);
	});

	test("profitable short trade", () => {
		const pnl = calcPnl("SELL", 10, 100, 90, 0.002, 0.002);
		expect(pnl).toBeCloseTo(96.2, 1);
	});
});
