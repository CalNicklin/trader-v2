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

describe("applyLiquidityFilters — UK-shaped candidates without free-float", () => {
	test("UK LSE candidate with null freeFloatUsd PASSES when other critical fields present", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const candidate = {
			symbol: "HSBA",
			exchange: "LSE",
			indexSource: "ftse_350" as const,
			marketCapUsd: null,
			avgDollarVolume: 5e9,
			price: 700,
			freeFloatUsd: null, // UK names systematically lack this
			spreadBps: 4,
			listingAgeDays: null,
		};
		const result = applyLiquidityFilters([candidate]);
		expect(result.passed).toHaveLength(1);
		expect(result.rejected).toHaveLength(0);
	});

	test("UK AIM candidate with null freeFloatUsd PASSES", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const candidate = {
			symbol: "GAW",
			exchange: "AIM",
			indexSource: "aim_allshare" as const,
			marketCapUsd: null,
			avgDollarVolume: 5e7,
			price: 10000, // 100 GBP in pence
			freeFloatUsd: null,
			spreadBps: 10,
			listingAgeDays: null,
		};
		const result = applyLiquidityFilters([candidate]);
		expect(result.passed).toHaveLength(1);
	});

	test("candidate with null price still rejects as missing_data", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const candidate = {
			symbol: "BAD",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			marketCapUsd: 1e12,
			avgDollarVolume: 1e10,
			price: null,
			freeFloatUsd: 1e11,
			spreadBps: 2,
			listingAgeDays: 5000,
		};
		const result = applyLiquidityFilters([candidate]);
		expect(result.rejected[0]?.reasons).toContain("missing_data");
	});

	test("candidate with null avgDollarVolume still rejects as missing_data", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const candidate = {
			symbol: "BAD2",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			marketCapUsd: 1e12,
			avgDollarVolume: null,
			price: 100,
			freeFloatUsd: 1e11,
			spreadBps: 2,
			listingAgeDays: 5000,
		};
		const result = applyLiquidityFilters([candidate]);
		expect(result.rejected[0]?.reasons).toContain("missing_data");
	});
});
