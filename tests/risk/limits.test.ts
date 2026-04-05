// tests/risk/limits.test.ts
import { describe, expect, test } from "bun:test";
import {
	checkBorrowFee,
	checkConcurrentPositions,
	checkCorrelatedExposure,
	checkMaxShortSize,
	checkRiskPerTrade,
	type PortfolioState,
} from "../../src/risk/limits.ts";

describe("risk/limits", () => {
	const _basePortfolio: PortfolioState = {
		accountBalance: 500,
		openPositions: [],
	};

	describe("checkRiskPerTrade", () => {
		test("allows trade within 1% risk", () => {
			const result = checkRiskPerTrade(500, 5);
			expect(result.allowed).toBe(true);
		});

		test("rejects trade exceeding 1% risk", () => {
			const result = checkRiskPerTrade(500, 6);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("1%");
		});

		test("allows trade at exactly 1% risk", () => {
			const result = checkRiskPerTrade(500, 5);
			expect(result.allowed).toBe(true);
		});

		test("handles zero balance", () => {
			const result = checkRiskPerTrade(0, 1);
			expect(result.allowed).toBe(false);
		});
	});

	describe("checkConcurrentPositions", () => {
		test("allows when under limit", () => {
			const result = checkConcurrentPositions(2);
			expect(result.allowed).toBe(true);
		});

		test("rejects when at limit", () => {
			const result = checkConcurrentPositions(3);
			expect(result.allowed).toBe(false);
		});

		test("rejects when over limit", () => {
			const result = checkConcurrentPositions(5);
			expect(result.allowed).toBe(false);
		});

		test("allows zero positions", () => {
			const result = checkConcurrentPositions(0);
			expect(result.allowed).toBe(true);
		});
	});

	describe("checkMaxShortSize", () => {
		test("allows short within 75% of max long size", () => {
			const result = checkMaxShortSize(500, 3.75, "SELL");
			expect(result.allowed).toBe(true);
		});

		test("rejects short exceeding 75% of max long size", () => {
			const result = checkMaxShortSize(500, 4.0, "SELL");
			expect(result.allowed).toBe(false);
		});

		test("always allows longs (not applicable)", () => {
			const result = checkMaxShortSize(500, 5, "BUY");
			expect(result.allowed).toBe(true);
		});
	});

	describe("checkCorrelatedExposure", () => {
		test("allows when under sector limit", () => {
			const result = checkCorrelatedExposure("Technology", [{ sector: "Technology" }]);
			expect(result.allowed).toBe(true);
		});

		test("rejects when at sector limit", () => {
			const result = checkCorrelatedExposure("Technology", [
				{ sector: "Technology" },
				{ sector: "Technology" },
			]);
			expect(result.allowed).toBe(false);
		});

		test("allows different sector", () => {
			const result = checkCorrelatedExposure("Healthcare", [
				{ sector: "Technology" },
				{ sector: "Technology" },
			]);
			expect(result.allowed).toBe(true);
		});

		test("allows unknown sector (no sector data)", () => {
			const result = checkCorrelatedExposure(null, [{ sector: "Technology" }]);
			expect(result.allowed).toBe(true);
		});
	});

	describe("checkBorrowFee", () => {
		test("allows borrow fee under cap", () => {
			const result = checkBorrowFee(0.04, "SELL");
			expect(result.allowed).toBe(true);
		});

		test("rejects borrow fee at cap", () => {
			const result = checkBorrowFee(0.05, "SELL");
			expect(result.allowed).toBe(false);
		});

		test("always allows longs regardless of fee", () => {
			const result = checkBorrowFee(0.1, "BUY");
			expect(result.allowed).toBe(true);
		});

		test("allows null borrow fee for shorts (assume zero)", () => {
			const result = checkBorrowFee(null, "SELL");
			expect(result.allowed).toBe(true);
		});
	});
});
