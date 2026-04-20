import { describe, expect, test } from "bun:test";
import { yahooUsHistorical, yahooUsQuote } from "../../src/data/yahoo-us.ts";

describe("yahooUsQuote", () => {
	test("returns price, volume, avgVolume (5d), computed changePercent", async () => {
		const fetchStub = async (_url: string) => ({
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
								regularMarketPrice: 270,
								regularMarketVolume: 50_000_000,
								previousClose: 265,
							},
							indicators: {
								quote: [
									{
										close: [260, 265, 268, 271, 270],
										volume: [40_000_000, 42_000_000, 45_000_000, 50_000_000, 50_000_000],
									},
								],
							},
						},
					],
				},
			}),
		});
		const out = await yahooUsQuote("AAPL", "NASDAQ", {
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(out?.last).toBe(270);
		expect(out?.volume).toBe(50_000_000);
		expect(out?.avgVolume).toBeCloseTo(45_400_000);
		expect(out?.changePercent).toBeCloseTo(1.8867, 2);
	});

	test("returns null on 404", async () => {
		const fetchStub = async () => ({
			ok: false,
			status: 404,
			statusText: "Not Found",
			json: async () => ({}),
		});
		const out = await yahooUsQuote("BOGUS", "NASDAQ", {
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(out).toBeNull();
	});

	test("returns null when chart.error present", async () => {
		const fetchStub = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ chart: { error: { code: "Not Found", description: "no data" } } }),
		});
		const out = await yahooUsQuote("BOGUS", "NASDAQ", {
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(out).toBeNull();
	});
});

describe("yahooUsHistorical", () => {
	test("returns bars in chronological order with OHLCV", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				chart: {
					result: [
						{
							meta: { currency: "USD" },
							timestamp: [1776198000, 1776284400, 1776370800],
							indicators: {
								quote: [
									{
										open: [267, 268, 269],
										high: [270, 271, 272],
										low: [265, 266, 267],
										close: [269, 270, 271],
										volume: [40_000_000, 45_000_000, 50_000_000],
									},
								],
							},
						},
					],
				},
			}),
		});
		const out = await yahooUsHistorical("AAPL", "NASDAQ", 3, {
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(out).not.toBeNull();
		expect(out?.length).toBe(3);
		expect(out?.[0]?.open).toBe(267);
		expect(out?.[2]?.close).toBe(271);
	});

	test("skips bars where any OHLCV field is null", async () => {
		const fetchStub = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				chart: {
					result: [
						{
							meta: { currency: "USD" },
							timestamp: [1776198000, 1776284400],
							indicators: {
								quote: [
									{
										open: [267, null],
										high: [270, null],
										low: [265, null],
										close: [269, null],
										volume: [40_000_000, null],
									},
								],
							},
						},
					],
				},
			}),
		});
		const out = await yahooUsHistorical("AAPL", "NASDAQ", 2, {
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(out?.length).toBe(1);
	});

	test("returns null on 404", async () => {
		const fetchStub = async () => ({
			ok: false,
			status: 404,
			statusText: "Not Found",
			json: async () => ({}),
		});
		const out = await yahooUsHistorical("BOGUS", "NASDAQ", 30, {
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(out).toBeNull();
	});
});
