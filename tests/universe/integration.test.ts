import { beforeEach, describe, expect, test } from "bun:test";

describe("universe — end-to-end integration", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("refresh -> snapshot -> delta -> health reports consistent state", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { runDailyDeltaCheck } = await import("../../src/universe/delta.ts");
		const { getUniverseHealth } = await import("../../src/monitoring/health.ts");

		const candidates = [
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				marketCapUsd: 3e12,
				avgDollarVolume: 1e10,
				price: 200,
				freeFloatUsd: 2e12,
				spreadBps: 2,
				listingAgeDays: 10000,
			},
			{
				symbol: "HSBA",
				exchange: "LSE",
				indexSource: "ftse_350" as const,
				marketCapUsd: 150e9,
				avgDollarVolume: 5e8,
				price: 700,
				freeFloatUsd: 100e9,
				spreadBps: 4,
				listingAgeDays: 10000,
			},
		];

		// Initial refresh
		const r1 = await refreshInvestableUniverse({
			fetchCandidates: async () => candidates,
			snapshotDate: "2026-04-17",
		});
		expect(r1.added).toBe(2);

		// Delta check flags one as halted
		const d1 = await runDailyDeltaCheck({
			checker: async () => [{ symbol: "AAPL", exchange: "NASDAQ", reason: "halted" }],
			snapshotDate: "2026-04-17",
		});
		expect(d1.demoted).toBe(1);

		// Health reports 1 active
		const h = await getUniverseHealth();
		expect(h.activeCount).toBe(1);
		expect(h.bySource.russell_1000).toBe(0);
		expect(h.bySource.ftse_350).toBe(1);
	});

	test("full pipeline: US+UK candidates with quote data flow through refresh, get filtered, land in universe", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { upsertProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const { getUniverseHealth } = await import("../../src/monitoring/health.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		// Seed quote data for both US and UK symbols
		await getDb()
			.insert(quotesCache)
			.values([
				{
					symbol: "AAPL",
					exchange: "NASDAQ",
					last: 200,
					avgVolume: 50_000_000,
					bid: 199.9,
					ask: 200.1,
					updatedAt: new Date().toISOString(),
				},
				{
					symbol: "HSBA",
					exchange: "LSE",
					last: 700,
					avgVolume: 10_000_000,
					bid: 699.5,
					ask: 700.5,
					updatedAt: new Date().toISOString(),
				},
			]);

		// Seed a fresh profile for AAPL so we don't need to mock fetch
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

		const fetchCandidates = async () =>
			enrichWithMetrics([
				{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" as const },
				{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" as const },
			]);

		const result = await refreshInvestableUniverse({
			fetchCandidates,
			snapshotDate: "2026-04-17",
		});

		expect(result.added).toBe(2);
		expect(result.rejected).toBe(0);

		const health = await getUniverseHealth();
		expect(health.activeCount).toBe(2);
		expect(health.bySource.russell_1000).toBe(1);
		expect(health.bySource.ftse_350).toBe(1);
	});
});
