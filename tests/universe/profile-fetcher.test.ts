import { beforeEach, describe, expect, test } from "bun:test";
import type { FetchLike } from "../../src/universe/sources.ts";

describe("fetchSymbolProfiles", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
	});

	test("batches symbols up to 500 per FMP call", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const calls: string[] = [];
		const mockFetch: FetchLike = async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => [
					{
						symbol: "AAPL",
						mktCap: 3_000_000_000_000,
						sharesOutstanding: 15_000_000_000,
						floatShares: 14_900_000_000,
						ipoDate: "1980-12-12",
					},
				],
			};
		};

		const result = await fetchSymbolProfiles(["AAPL"], mockFetch);
		expect(result).toHaveLength(1);
		expect(result[0]?.symbol).toBe("AAPL");
		expect(result[0]?.marketCapUsd).toBe(3_000_000_000_000);
		expect(result[0]?.sharesOutstanding).toBe(15_000_000_000);
		expect(result[0]?.freeFloatShares).toBe(14_900_000_000);
		expect(result[0]?.ipoDate).toBe("1980-12-12");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/profile/AAPL");
	});

	test("splits >500 symbols into multiple batch calls", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const calls: string[] = [];
		const mockFetch: FetchLike = async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => [],
			};
		};

		const symbols = Array.from({ length: 750 }, (_, i) => `SYM${i}`);
		await fetchSymbolProfiles(symbols, mockFetch);
		expect(calls).toHaveLength(2);
	});

	test("returns empty array for empty input without calling FMP", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		let called = false;
		const mockFetch: FetchLike = async () => {
			called = true;
			return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		};
		const result = await fetchSymbolProfiles([], mockFetch);
		expect(result).toEqual([]);
		expect(called).toBe(false);
	});

	test("handles null floatShares by leaving freeFloatShares null", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const mockFetch: FetchLike = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => [
				{
					symbol: "OBSCURE",
					mktCap: 1e9,
					sharesOutstanding: 50_000_000,
					floatShares: null,
					ipoDate: "2010-01-01",
				},
			],
		});
		const result = await fetchSymbolProfiles(["OBSCURE"], mockFetch);
		expect(result[0]?.freeFloatShares).toBeNull();
		expect(result[0]?.sharesOutstanding).toBe(50_000_000);
	});

	test("throws on non-ok FMP response", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const mockFetch: FetchLike = async () =>
			({ ok: false, status: 500, statusText: "Server Error" }) as Awaited<ReturnType<FetchLike>>;
		await expect(fetchSymbolProfiles(["AAPL"], mockFetch)).rejects.toThrow();
	});
});
