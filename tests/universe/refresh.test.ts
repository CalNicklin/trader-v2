import { beforeEach, describe, expect, test } from "bun:test";
import type { FilterCandidate } from "../../src/universe/filters.ts";

describe("refreshInvestableUniverse", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("populates investable_universe with passed candidates and writes a snapshot", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse, universeSnapshots } = await import("../../src/db/schema.ts");

		const candidates: FilterCandidate[] = [
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				indexSource: "russell_1000",
				marketCapUsd: 3e12,
				avgDollarVolume: 1e10,
				price: 200,
				freeFloatUsd: 2e12,
				spreadBps: 2,
				listingAgeDays: 10000,
			},
		];

		const result = await refreshInvestableUniverse({
			fetchCandidates: async () => candidates,
			snapshotDate: "2026-04-17",
		});

		expect(result.added).toBe(1);
		expect(result.rejected).toBe(0);

		const rows = await getDb().select().from(investableUniverse).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.symbol).toBe("AAPL");

		const snaps = await getDb().select().from(universeSnapshots).all();
		expect(snaps.some((s) => s.action === "added" && s.symbol === "AAPL")).toBe(true);
	});

	test("removes symbols no longer passing filters", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		// Seed an initial entry
		await getDb()
			.insert(investableUniverse)
			.values({
				symbol: "STALE",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				active: true,
			});

		const result = await refreshInvestableUniverse({
			fetchCandidates: async () => [], // nothing passes this cycle
			snapshotDate: "2026-04-17",
		});

		expect(result.removed).toBe(1);
		const rows = await getDb()
			.select()
			.from(investableUniverse)
			.where(eq(investableUniverse.active, false))
			.all();
		expect(rows).toHaveLength(1);
	});

	test("does not remove symbols that are exempted (e.g. open positions)", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await getDb()
			.insert(investableUniverse)
			.values({
				symbol: "HOLD",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				active: true,
			});

		await refreshInvestableUniverse({
			fetchCandidates: async () => [],
			snapshotDate: "2026-04-17",
			exemptSymbols: ["HOLD:NASDAQ"],
		});

		const rows = await getDb()
			.select()
			.from(investableUniverse)
			.where(eq(investableUniverse.symbol, "HOLD"))
			.all();
		expect(rows[0]?.active).toBe(true);
	});
});
