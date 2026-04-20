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

	test("US candidate with injected profile enricher produces full FilterCandidate", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, {
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () =>
				new Map([
					[
						"AAPL:NASDAQ",
						{
							symbol: "AAPL",
							exchange: "NASDAQ",
							sharesOutstanding: 14_681_140_000,
							priceUsd: 270.23,
							marketCapUsd: 14_681_140_000 * 270.23,
							avgVolume30d: 50_000_000,
							avgDollarVolumeUsd: 270.23 * 50_000_000,
							ipoDate: "1980-12-12",
						},
					],
				]),
		});
		expect(result[0]?.marketCapUsd).toBeCloseTo(14_681_140_000 * 270.23);
		expect(result[0]?.price).toBe(270.23);
		expect(result[0]?.avgDollarVolume).toBeCloseTo(270.23 * 50_000_000);
		expect(result[0]?.freeFloatUsd).toBeCloseTo(14_681_140_000 * 270.23);
		expect(result[0]?.listingAgeDays).toBeGreaterThan(10_000);
	});

	test("US candidate: quotes_cache price takes priority over US profile price", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
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

		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];

		const result = await enrichWithMetrics(rows, {
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () =>
				new Map([
					[
						"AAPL:NASDAQ",
						{
							symbol: "AAPL",
							exchange: "NASDAQ",
							sharesOutstanding: 15e9,
							priceUsd: 210, // profile price — should be overridden by quotes_cache
							marketCapUsd: 3e12,
							avgVolume30d: 50_000_000,
							avgDollarVolumeUsd: 210 * 50_000_000,
							ipoDate: "1980-12-12",
						},
					],
				]),
		});

		// quotes_cache last (200) wins over usProfile priceUsd (210)
		expect(result[0]?.price).toBe(200);
		expect(result[0]?.marketCapUsd).toBe(3e12);
		expect(result[0]?.freeFloatUsd).toBeCloseTo(15e9 * 210, -3);
		expect(result[0]?.listingAgeDays).toBeGreaterThan(10_000);
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

		const rows: ConstituentRow[] = [{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }];

		const result = await enrichWithMetrics(rows, {
			// Disable Yahoo enrichment for this test so we can verify the
			// quotes_cache-only fallback path.
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () => new Map(),
		});

		expect(result[0]?.marketCapUsd).toBeNull();
		expect(result[0]?.freeFloatUsd).toBeNull();
		expect(result[0]?.listingAgeDays).toBeNull();
		expect(result[0]?.price).toBe(700);
		// quotes_cache-only path: computes in native units. This is incorrect
		// for UK (pence × shares, not USD), but when Yahoo enrichment is
		// available the correct FX-converted value is used instead.
		expect(result[0]?.avgDollarVolume).toBe(10_000_000 * 700);
	});

	test("UK candidate with Yahoo enrichment uses FX-converted avg dollar volume", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");

		const rows: ConstituentRow[] = [{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }];
		const result = await enrichWithMetrics(rows, {
			usProfileEnricher: async () => new Map(),
			yahooUkEnricher: async () =>
				new Map([
					[
						"HSBA:LSE",
						{
							symbol: "HSBA",
							exchange: "LSE",
							priceGbpPence: 1348,
							avgVolume30d: 30_000_000,
							avgDollarVolumeUsd: 543_123_456, // pre-computed with FX
						},
					],
				]),
		});

		expect(result[0]?.price).toBe(1348); // pence, matches quotes_cache convention
		expect(result[0]?.avgDollarVolume).toBe(543_123_456); // USD, FX-correct
	});

	test("US candidate with no profile enricher data leaves profile fields null", async () => {
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

		const rows: ConstituentRow[] = [
			{ symbol: "NEWCO", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, {
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () => new Map(),
		});

		expect(result[0]?.marketCapUsd).toBeNull();
		expect(result[0]?.freeFloatUsd).toBeNull();
		expect(result[0]?.listingAgeDays).toBeNull();
		expect(result[0]?.price).toBe(50);
	});

	test("US candidate with enricher failure falls back gracefully to quotes_cache", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "MSFT",
			exchange: "NASDAQ",
			last: 400,
			avgVolume: 25_000_000,
			updatedAt: new Date().toISOString(),
		});

		const rows: ConstituentRow[] = [
			{ symbol: "MSFT", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, {
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () => {
				throw new Error("EDGAR unavailable");
			},
		});

		// Safe wrapper catches the error; profile fields null, price from quotes_cache
		expect(result[0]?.marketCapUsd).toBeNull();
		expect(result[0]?.freeFloatUsd).toBeNull();
		expect(result[0]?.price).toBe(400);
	});

	test("freeFloatUsd uses sharesOutstanding × priceUsd from US profile", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");

		const rows: ConstituentRow[] = [
			{ symbol: "OBSCURE", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, {
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () =>
				new Map([
					[
						"OBSCURE:NASDAQ",
						{
							symbol: "OBSCURE",
							exchange: "NASDAQ",
							sharesOutstanding: 50_000_000,
							priceUsd: 10,
							marketCapUsd: 5e8,
							avgVolume30d: 2_000_000,
							avgDollarVolumeUsd: 20_000_000,
							ipoDate: "2015-01-01",
						},
					],
				]),
		});

		// sharesOutstanding × priceUsd = 50M × 10 = 500M
		expect(result[0]?.freeFloatUsd).toBe(5e8);
	});

	test("US row: spreadBps is null even when quotes_cache has bid/ask (stale artefact)", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		// Stale bid/ask left over from pre-FMP-removal era. Spread here is
		// ~74 bps, which would falsely reject NFLX under MAX_SPREAD_BPS=25.
		await getDb().insert(quotesCache).values({
			symbol: "NFLX",
			exchange: "NASDAQ",
			last: 94.71,
			avgVolume: 40_000_000,
			bid: 98.76,
			ask: 99.5,
			updatedAt: new Date().toISOString(),
		});

		const rows: ConstituentRow[] = [
			{ symbol: "NFLX", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, {
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () => new Map(),
		});

		expect(result[0]?.spreadBps).toBeNull();
	});

	test("UK row: spreadBps computed from fresh quotes_cache bid/ask (IBKR)", async () => {
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

		const rows: ConstituentRow[] = [{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }];
		const result = await enrichWithMetrics(rows, {
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () => new Map(),
		});

		// (701 - 699) / 700 * 10000 = ~28.57 bps
		expect(result[0]?.spreadBps).toBeCloseTo(28.57, 1);
	});

	test("UK row: crossed market (bid > ask) yields spreadBps null, not negative", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "VOD",
			exchange: "LSE",
			last: 75,
			avgVolume: 20_000_000,
			bid: 75.5,
			ask: 75.2,
			updatedAt: new Date().toISOString(),
		});

		const rows: ConstituentRow[] = [{ symbol: "VOD", exchange: "LSE", indexSource: "ftse_350" }];
		const result = await enrichWithMetrics(rows, {
			yahooUkEnricher: async () => new Map(),
			usProfileEnricher: async () => new Map(),
		});

		expect(result[0]?.spreadBps).toBeNull();
	});
});
