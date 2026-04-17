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
});
