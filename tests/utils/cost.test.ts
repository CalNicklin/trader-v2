import { describe, expect, test } from "bun:test";
import { estimateCost } from "../../src/utils/cost.ts";

describe("estimateCost", () => {
	test("calculates Haiku cost correctly", () => {
		const cost = estimateCost("news_classification", 1000, 200);
		// Haiku: (1000 * 1.0 + 200 * 5.0) / 1_000_000 = 0.002
		expect(cost).toBeCloseTo(0.002, 6);
	});

	test("calculates Sonnet cost correctly", () => {
		const cost = estimateCost("strategy_evolution", 5000, 1000);
		// Sonnet: (5000 * 3.0 + 1000 * 15.0) / 1_000_000 = 0.03
		expect(cost).toBeCloseTo(0.03, 6);
	});

	test("includes cache costs when provided", () => {
		const cost = estimateCost("news_classification", 500, 200, 300, 400);
		// Haiku: (500*1.0 + 200*5.0 + 300*1.25 + 400*0.1) / 1_000_000
		// = (500 + 1000 + 375 + 40) / 1_000_000 = 0.001915
		expect(cost).toBeCloseTo(0.001915, 6);
	});
});
