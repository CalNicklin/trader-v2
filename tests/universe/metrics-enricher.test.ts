import { beforeEach, describe, expect, test } from "bun:test";
import type { ConstituentRow } from "../../src/universe/sources.ts";

describe("enrichWithMetrics", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("US candidate uses cached fresh profile without fetching", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { upsertProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 200,
			avgVolume: 50_000_000,
			bid: 199.95,
			ask: 200.05,
			updatedAt: new Date().toISOString(),
		});

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
		]);

		let fetchCalled = false;
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];

		const result = await enrichWithMetrics(rows, {
			fetchImpl: async () => {
				fetchCalled = true;
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => [],
				};
			},
		});

		expect(fetchCalled).toBe(false);
		expect(result).toHaveLength(1);
		expect(result[0]?.marketCapUsd).toBe(3e12);
		expect(result[0]?.freeFloatUsd).toBeCloseTo(14.9e9 * 200, -3);
		expect(result[0]?.listingAgeDays).toBeGreaterThan(10_000);
		expect(result[0]?.price).toBe(200);
		expect(result[0]?.avgDollarVolume).toBe(50_000_000 * 200);
	});

	test("UK candidate skips profile fetch and uses quotes_cache only", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "HSBA",
			exchange: "LSE",
			last: 700,
			avgVolume: 10_000_000,
			bid: 699,
			ask: 701,
			updatedAt: new Date().toISOString(),
		});

		let fetchCalled = false;
		const rows: ConstituentRow[] = [{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }];

		const result = await enrichWithMetrics(rows, {
			fetchImpl: async () => {
				fetchCalled = true;
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => [],
				};
			},
		});

		expect(fetchCalled).toBe(false);
		expect(result[0]?.marketCapUsd).toBeNull();
		expect(result[0]?.freeFloatUsd).toBeNull();
		expect(result[0]?.listingAgeDays).toBeNull();
		expect(result[0]?.price).toBe(700);
		expect(result[0]?.avgDollarVolume).toBe(10_000_000 * 700);
	});

	test("US candidate with no cache triggers profile fetch and upserts result", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getProfile } = await import("../../src/universe/profile-fetcher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "MSFT",
			exchange: "NASDAQ",
			last: 400,
			avgVolume: 25_000_000,
			updatedAt: new Date().toISOString(),
		});

		const mockFetch = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => [
				{
					symbol: "MSFT",
					mktCap: 3e12,
					sharesOutstanding: 7.4e9,
					floatShares: 7.4e9,
					ipoDate: "1986-03-13",
				},
			],
		});

		const rows: ConstituentRow[] = [
			{ symbol: "MSFT", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, { fetchImpl: mockFetch });

		expect(result[0]?.marketCapUsd).toBe(3e12);
		const cached = await getProfile("MSFT", "NASDAQ");
		expect(cached?.marketCapUsd).toBe(3e12);
	});

	test("US candidate with stale cache AND fetch failure uses last-known-good", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { upsertProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "GOOGL",
			exchange: "NASDAQ",
			last: 150,
			avgVolume: 30_000_000,
			updatedAt: new Date().toISOString(),
		});

		const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
		await upsertProfiles([
			{
				symbol: "GOOGL",
				exchange: "NASDAQ",
				marketCapUsd: 2e12,
				sharesOutstanding: 12e9,
				freeFloatShares: 11.9e9,
				ipoDate: "2004-08-19",
				fetchedAt: thirtyOneDaysAgo,
			},
		]);

		const mockFetch = async () => ({
			ok: false,
			status: 500,
			statusText: "Server Error",
			json: async () => [],
		});

		const rows: ConstituentRow[] = [
			{ symbol: "GOOGL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];

		const result = await enrichWithMetrics(rows, { fetchImpl: mockFetch });

		expect(result[0]?.marketCapUsd).toBe(2e12);
	});

	test("US candidate with no cache AND fetch failure leaves profile fields null", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "NEWCO",
			exchange: "NASDAQ",
			last: 50,
			avgVolume: 5_000_000,
			updatedAt: new Date().toISOString(),
		});

		const mockFetch = async () => ({
			ok: false,
			status: 500,
			statusText: "Server Error",
			json: async () => [],
		});

		const rows: ConstituentRow[] = [
			{ symbol: "NEWCO", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, { fetchImpl: mockFetch });

		expect(result[0]?.marketCapUsd).toBeNull();
		expect(result[0]?.freeFloatUsd).toBeNull();
		expect(result[0]?.listingAgeDays).toBeNull();
		expect(result[0]?.price).toBe(50);
	});

	test("freeFloatUsd falls back to sharesOutstanding × price when floatShares is null", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { upsertProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "OBSCURE",
			exchange: "NASDAQ",
			last: 10,
			avgVolume: 2_000_000,
			updatedAt: new Date().toISOString(),
		});

		await upsertProfiles([
			{
				symbol: "OBSCURE",
				exchange: "NASDAQ",
				marketCapUsd: 5e8,
				sharesOutstanding: 50_000_000,
				freeFloatShares: null,
				ipoDate: "2015-01-01",
				fetchedAt: new Date().toISOString(),
			},
		]);

		const rows: ConstituentRow[] = [
			{ symbol: "OBSCURE", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, {
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => [],
			}),
		});

		// Fallback: sharesOutstanding × price = 50M × 10 = 500M
		expect(result[0]?.freeFloatUsd).toBe(5e8);
	});
});
