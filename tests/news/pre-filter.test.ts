import { describe, expect, test } from "bun:test";

describe("keyword pre-filter", () => {
	test("passes headlines with tradeable keywords", async () => {
		const { shouldClassify } = await import("../../src/news/pre-filter.ts");

		expect(shouldClassify("Apple beats earnings estimates with record Q4 revenue")).toBe(true);
		expect(shouldClassify("FDA approves Pfizer's new cancer treatment")).toBe(true);
		expect(shouldClassify("Microsoft announces $60B stock buyback program")).toBe(true);
		expect(shouldClassify("BP issues profit warning ahead of quarterly results")).toBe(true);
		expect(shouldClassify("Tesla to acquire robotics startup for $2.1B")).toBe(true);
	});

	test("blocks routine/noise headlines", async () => {
		const { shouldClassify } = await import("../../src/news/pre-filter.ts");

		expect(shouldClassify("Analyst reiterates Buy rating on Apple")).toBe(false);
		expect(shouldClassify("Company appoints new board member")).toBe(false);
		expect(shouldClassify("Annual ESG report published")).toBe(false);
		expect(shouldClassify("Routine filing submitted to SEC")).toBe(false);
	});

	test("passes headlines with no matching keywords (defaults to classify)", async () => {
		const { shouldClassify } = await import("../../src/news/pre-filter.ts");

		// Ambiguous headlines should pass through to Haiku for classification
		expect(shouldClassify("Major development at Apple headquarters")).toBe(true);
	});

	test("is case-insensitive", async () => {
		const { shouldClassify } = await import("../../src/news/pre-filter.ts");

		expect(shouldClassify("APPLE BEATS EARNINGS ESTIMATES")).toBe(true);
		expect(shouldClassify("analyst REITERATES buy rating")).toBe(false);
	});
});
