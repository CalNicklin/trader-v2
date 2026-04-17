import { describe, expect, test } from "bun:test";
import type { FilterCandidate } from "../../src/universe/filters.ts";

const US_PASS: FilterCandidate = {
	symbol: "AAPL",
	exchange: "NASDAQ",
	indexSource: "russell_1000",
	marketCapUsd: 3_000_000_000_000,
	avgDollarVolume: 10_000_000_000,
	price: 200,
	freeFloatUsd: 2_000_000_000_000,
	spreadBps: 2,
	listingAgeDays: 10_000,
};

describe("applyLiquidityFilters", () => {
	test("accepts a healthy US mega-cap", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([US_PASS]);
		expect(result.passed).toHaveLength(1);
		expect(result.rejected).toHaveLength(0);
	});

	test("rejects on low dollar volume", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, avgDollarVolume: 100_000 }]);
		expect(result.passed).toHaveLength(0);
		expect(result.rejected[0]?.reasons).toContain("low_dollar_volume");
	});

	test("rejects on low US price", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, price: 2 }]);
		expect(result.rejected[0]?.reasons).toContain("low_price");
	});

	test("rejects on low UK price (pence floor)", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, exchange: "LSE", price: 50 }]);
		expect(result.rejected[0]?.reasons).toContain("low_price");
	});

	test("accepts UK name at 150p", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, exchange: "LSE", price: 150 }]);
		expect(result.passed).toHaveLength(1);
	});

	test("rejects on low free float", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, freeFloatUsd: 1_000_000 }]);
		expect(result.rejected[0]?.reasons).toContain("low_float");
	});

	test("rejects on wide spread", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, spreadBps: 50 }]);
		expect(result.rejected[0]?.reasons).toContain("wide_spread");
	});

	test("rejects on recent IPO (< 90 days)", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, listingAgeDays: 30 }]);
		expect(result.rejected[0]?.reasons).toContain("recent_listing");
	});

	test("gracefully handles missing metric data (rejects with missing_data)", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, avgDollarVolume: null, price: null }]);
		expect(result.rejected[0]?.reasons).toContain("missing_data");
	});

	test("accumulates multiple reasons when several filters fail", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([
			{ ...US_PASS, price: 2, spreadBps: 50, avgDollarVolume: 100 },
		]);
		expect(result.rejected[0]?.reasons.length).toBeGreaterThan(1);
	});
});
