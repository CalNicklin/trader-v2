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

describe("upsertProfiles + getProfile", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("upsertProfiles inserts new rows", async () => {
		const { upsertProfiles, getProfile } = await import("../../src/universe/profile-fetcher.ts");

		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: "2026-04-17T00:00:00.000Z",
			},
		]);

		const result = await getProfile("AAPL", "NASDAQ");
		expect(result?.symbol).toBe("AAPL");
		expect(result?.marketCapUsd).toBe(3e12);
	});

	test("upsertProfiles updates existing rows on conflict", async () => {
		const { upsertProfiles, getProfile } = await import("../../src/universe/profile-fetcher.ts");

		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: "2026-04-01T00:00:00.000Z",
			},
		]);

		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3.1e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: "2026-04-17T00:00:00.000Z",
			},
		]);

		const result = await getProfile("AAPL", "NASDAQ");
		expect(result?.marketCapUsd).toBe(3.1e12);
		expect(result?.fetchedAt).toBe("2026-04-17T00:00:00.000Z");
	});

	test("getProfile returns null for unknown symbol", async () => {
		const { getProfile } = await import("../../src/universe/profile-fetcher.ts");
		const result = await getProfile("GHOST", "NASDAQ");
		expect(result).toBeNull();
	});

	test("PROFILE_CACHE_TTL_DAYS is 30", async () => {
		const { PROFILE_CACHE_TTL_DAYS } = await import("../../src/universe/profile-fetcher.ts");
		expect(PROFILE_CACHE_TTL_DAYS).toBe(30);
	});
});

describe("getProfiles (bulk)", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("returns empty map for empty input", async () => {
		const { getProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const result = await getProfiles([]);
		expect(result.size).toBe(0);
	});

	test("returns map keyed by symbol:exchange for multiple cached rows", async () => {
		const { upsertProfiles, getProfiles } = await import("../../src/universe/profile-fetcher.ts");
		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: new Date().toISOString(),
			},
			{
				symbol: "MSFT",
				exchange: "NASDAQ",
				marketCapUsd: 2.8e12,
				sharesOutstanding: 7.4e9,
				freeFloatShares: 7.3e9,
				ipoDate: "1986-03-13",
				fetchedAt: new Date().toISOString(),
			},
		]);

		const result = await getProfiles([
			{ symbol: "AAPL", exchange: "NASDAQ" },
			{ symbol: "MSFT", exchange: "NASDAQ" },
			{ symbol: "GHOST", exchange: "NASDAQ" },
		]);

		expect(result.size).toBe(2);
		expect(result.get("AAPL:NASDAQ")?.marketCapUsd).toBe(3e12);
		expect(result.get("MSFT:NASDAQ")?.marketCapUsd).toBe(2.8e12);
		expect(result.has("GHOST:NASDAQ")).toBe(false);
	});
});
