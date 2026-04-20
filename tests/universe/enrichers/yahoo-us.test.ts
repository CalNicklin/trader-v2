import { describe, expect, test } from "bun:test";
import { fetchYahooUsQuotes } from "../../../src/universe/enrichers/yahoo-us.ts";
import type { ConstituentRow } from "../../../src/universe/sources.ts";

describe("fetchYahooUsQuotes", () => {
	test("fetches price + 30d avg volume + firstTradeDate for each US row", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }, // should be skipped
		];
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					chart: {
						result: [
							{
								meta: {
									symbol: "AAPL",
									currency: "USD",
									regularMarketPrice: 270.23,
									firstTradeDate: 345479400, // 1980-12-12
								},
								indicators: {
									quote: [
										{
											close: [270, 271, 269, 272, 270],
											volume: [50_000_000, 52_000_000, 48_000_000, 51_000_000, 50_000_000],
										},
									],
								},
							},
						],
					},
				}),
			};
		};
		const out = await fetchYahooUsQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("chart/AAPL");
		expect(out.size).toBe(1);
		const aapl = out.get("AAPL:NASDAQ");
		expect(aapl?.priceUsd).toBe(270.23);
		expect(aapl?.avgVolume30d).toBeCloseTo(50_200_000);
		expect(aapl?.avgDollarVolumeUsd).toBeCloseTo(270.23 * 50_200_000);
		expect(aapl?.ipoDate).toBe("1980-12-12");
	});

	test("skips UK rows entirely", async () => {
		const rows: ConstituentRow[] = [{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }];
		const fetchImpl = async () => {
			throw new Error("should not be called");
		};
		const out = await fetchYahooUsQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(out.size).toBe(0);
	});

	test("gracefully skips symbols that Yahoo 404s", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "BOGUS", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const fetchImpl = async (url: string) => {
			if (url.includes("BOGUS")) {
				return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					chart: {
						result: [
							{
								meta: { symbol: "AAPL", currency: "USD", regularMarketPrice: 270 },
								indicators: { quote: [{ close: [270], volume: [50_000_000] }] },
							},
						],
					},
				}),
			};
		};
		const out = await fetchYahooUsQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(out.size).toBe(1);
		expect(out.has("AAPL:NASDAQ")).toBe(true);
		expect(out.has("BOGUS:NASDAQ")).toBe(false);
	});
});
