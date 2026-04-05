import { describe, expect, test } from "bun:test";

describe("trailing-stops", () => {
	test("computeTrailingStopUpdate updates high water mark", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		const result = computeTrailingStopUpdate(
			{
				id: 1,
				symbol: "AAPL",
				quantity: 10,
				highWaterMark: 150,
				trailingStopPrice: 140,
				atr14: 5,
				currentPrice: 160,
			},
			2,
		);
		expect(result).not.toBeNull();
		expect(result!.highWaterMark).toBe(160);
		// trailingStop = 160 - 5*2 = 150, which is > existing 140
		expect(result!.trailingStopPrice).toBe(150);
		expect(result!.triggered).toBe(false);
	});

	test("computeTrailingStopUpdate never lowers existing stop", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		const result = computeTrailingStopUpdate(
			{
				id: 1,
				symbol: "AAPL",
				quantity: 10,
				highWaterMark: 170,
				trailingStopPrice: 160,
				atr14: 10,
				currentPrice: 165,
			},
			2,
		);
		expect(result).not.toBeNull();
		// recalculated: 170 - 10*2 = 150, but existing stop is 160 — keep 160
		expect(result!.trailingStopPrice).toBe(160);
	});

	test("computeTrailingStopUpdate triggers when price <= stop", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		const result = computeTrailingStopUpdate(
			{
				id: 1,
				symbol: "AAPL",
				quantity: 10,
				highWaterMark: 160,
				trailingStopPrice: 150,
				atr14: 5,
				currentPrice: 148,
			},
			2,
		);
		expect(result).not.toBeNull();
		expect(result!.triggered).toBe(true);
	});

	test("computeTrailingStopUpdate returns null when data missing", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		expect(
			computeTrailingStopUpdate(
				{
					id: 1,
					symbol: "AAPL",
					quantity: 10,
					highWaterMark: null,
					trailingStopPrice: null,
					atr14: 5,
					currentPrice: 100,
				},
				2,
			),
		).toBeNull();

		expect(
			computeTrailingStopUpdate(
				{
					id: 1,
					symbol: "AAPL",
					quantity: 10,
					highWaterMark: 100,
					trailingStopPrice: null,
					atr14: null,
					currentPrice: 100,
				},
				2,
			),
		).toBeNull();

		expect(
			computeTrailingStopUpdate(
				{
					id: 1,
					symbol: "AAPL",
					quantity: 10,
					highWaterMark: 100,
					trailingStopPrice: null,
					atr14: 5,
					currentPrice: null,
				},
				2,
			),
		).toBeNull();
	});

	test("computeTrailingStopUpdate does not trigger at zero price", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		const result = computeTrailingStopUpdate(
			{
				id: 1,
				symbol: "AAPL",
				quantity: 10,
				highWaterMark: 100,
				trailingStopPrice: 90,
				atr14: 5,
				currentPrice: 0,
			},
			2,
		);
		expect(result).not.toBeNull();
		// currentPrice=0, stop=90, but triggered requires currentPrice > 0
		expect(result!.triggered).toBe(false);
	});
});
