import { describe, expect, test } from "bun:test";
import { fetchYahooUkQuotes } from "../../../src/universe/enrichers/yahoo-uk.ts";
import type { ConstituentRow } from "../../../src/universe/sources.ts";

describe("fetchYahooUkQuotes", () => {
	test("filters out US rows, fetches Yahoo for UK rows only", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" },
			{ symbol: "GAW", exchange: "AIM", indexSource: "aim_allshare" },
		];
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			const symbol = url.match(/chart\/([^?]+)/)?.[1] ?? "?";
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					chart: {
						result: [
							{
								meta: {
									symbol,
									currency: "GBp",
									regularMarketPrice: 1000, // pence
								},
								indicators: {
									quote: [
										{
											close: [999, 1000, 1001, 1000, 1002],
											volume: [1_000_000, 1_200_000, 1_100_000, 1_300_000, 1_200_000],
										},
									],
								},
							},
						],
					},
				}),
			};
		};
		const fxImpl = async () => 1.35;

		const out = await fetchYahooUkQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			fetchFxImpl: fxImpl,
		});

		// Two UK rows → two Yahoo calls (AAPL is US, skipped)
		expect(calls.length).toBe(2);
		expect(calls[0]).toContain("HSBA.L");
		expect(calls[1]).toContain("GAW.L");
		expect(out.size).toBe(2);

		const hsba = out.get("HSBA:LSE");
		expect(hsba?.priceGbpPence).toBe(1000);
		expect(hsba?.avgVolume30d).toBeCloseTo(1_160_000); // avg of the 5 volumes
		// avgDollarVolumeUsd = avgVolume × (price/100) × FX = 1_160_000 × 10 × 1.35 = 15_660_000
		expect(hsba?.avgDollarVolumeUsd).toBeCloseTo(15_660_000);
	});

	test("gracefully skips symbols that Yahoo 404s (no partial crash)", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" },
			{ symbol: "BOGUS", exchange: "LSE", indexSource: "ftse_350" },
		];
		const fetchImpl = async (url: string) => {
			if (url.includes("BOGUS")) {
				return {
					ok: false,
					status: 404,
					statusText: "Not Found",
					json: async () => ({}),
				};
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					chart: {
						result: [
							{
								meta: { symbol: "HSBA.L", currency: "GBp", regularMarketPrice: 1348 },
								indicators: {
									quote: [{ close: [1348], volume: [30_000_000] }],
								},
							},
						],
					},
				}),
			};
		};
		const out = await fetchYahooUkQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			fetchFxImpl: async () => 1.35,
		});
		expect(out.size).toBe(1);
		expect(out.has("HSBA:LSE")).toBe(true);
		expect(out.has("BOGUS:LSE")).toBe(false);
	});

	test("handles trailing-dot UK EPICs correctly (BP → BP.L)", async () => {
		const rows: ConstituentRow[] = [{ symbol: "BP", exchange: "LSE", indexSource: "ftse_350" }];
		let seenUrl = "";
		const fetchImpl = async (url: string) => {
			seenUrl = url;
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					chart: {
						result: [
							{
								meta: { symbol: "BP.L", currency: "GBp", regularMarketPrice: 558 },
								indicators: {
									quote: [{ close: [558], volume: [66_000_000] }],
								},
							},
						],
					},
				}),
			};
		};
		const out = await fetchYahooUkQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
			fetchFxImpl: async () => 1.35,
		});
		expect(seenUrl).toContain("chart/BP.L");
		expect(out.size).toBe(1);
	});

	test("returns empty map when no UK rows", async () => {
		const fetchImpl = async () => {
			throw new Error("should not be called");
		};
		const out = await fetchYahooUkQuotes(
			[{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" }],
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
		);
		expect(out.size).toBe(0);
	});
});
