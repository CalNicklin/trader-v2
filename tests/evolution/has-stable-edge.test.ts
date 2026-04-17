import { describe, expect, test } from "bun:test";
import { hasStableEdge } from "../../src/evolution/has-stable-edge.ts";

describe("hasStableEdge", () => {
	test("promote: returns false when sample size < 15", () => {
		expect(hasStableEdge({ sampleSize: 14, sharpeRatio: 2, backHalfPnl: 100 }, "promote")).toBe(
			false,
		);
	});

	test("promote: returns true when sample >= 15 and signs match (both positive)", () => {
		expect(hasStableEdge({ sampleSize: 15, sharpeRatio: 1.5, backHalfPnl: 50 }, "promote")).toBe(
			true,
		);
	});

	test("promote: returns false when back-half contradicts full-sample sign", () => {
		expect(hasStableEdge({ sampleSize: 20, sharpeRatio: 1.2, backHalfPnl: -10 }, "promote")).toBe(
			false,
		);
	});

	test("retire: returns false when sample size < 20", () => {
		expect(hasStableEdge({ sampleSize: 19, sharpeRatio: -3, backHalfPnl: -50 }, "retire")).toBe(
			false,
		);
	});

	test("retire: returns true when sample >= 20 and back-half confirms negative Sharpe", () => {
		expect(hasStableEdge({ sampleSize: 20, sharpeRatio: -3, backHalfPnl: -40 }, "retire")).toBe(
			true,
		);
	});

	test("retire: returns false if back-half shows recent recovery", () => {
		expect(hasStableEdge({ sampleSize: 25, sharpeRatio: -2, backHalfPnl: 15 }, "retire")).toBe(
			false,
		);
	});

	test("handles null Sharpe defensively (returns false for both)", () => {
		expect(hasStableEdge({ sampleSize: 20, sharpeRatio: null, backHalfPnl: 0 }, "promote")).toBe(
			false,
		);
		expect(hasStableEdge({ sampleSize: 20, sharpeRatio: null, backHalfPnl: 0 }, "retire")).toBe(
			false,
		);
	});
});
