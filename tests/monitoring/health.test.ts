import { beforeEach, describe, expect, test } from "bun:test";
import { dailySnapshots, quotesCache, strategies, tokenUsage } from "../../src/db/schema";

describe("health data collector", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
		db.delete(tokenUsage).run();
		db.delete(dailySnapshots).run();
		db.delete(strategies).run();
		db.delete(quotesCache).run();
	});

	test("returns valid health data with empty database", async () => {
		const { getHealthData } = await import("../../src/monitoring/health");
		const data = await getHealthData();
		expect(data.status).toBe("ok");
		expect(data.uptime).toBeGreaterThan(0);
		expect(data.activeStrategies).toBe(0);
		expect(data.dailyPnl).toBe(0);
		expect(data.apiSpendToday).toBeGreaterThanOrEqual(0);
		expect(data.lastQuoteTime).toBeNull();
		expect(data.timestamp).toBeDefined();
	});

	test("counts active strategies correctly", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const db = getDb();
		db.insert(strategies)
			.values([
				{
					name: "active_1",
					description: "test",
					parameters: "{}",
					status: "paper" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
				},
				{
					name: "active_2",
					description: "test",
					parameters: "{}",
					status: "paper" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
				},
				{
					name: "retired_1",
					description: "test",
					parameters: "{}",
					status: "retired" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
					retiredAt: new Date().toISOString(),
				},
			])
			.run();

		const { getHealthData } = await import("../../src/monitoring/health");
		const data = await getHealthData();
		expect(data.activeStrategies).toBe(2);
	});

	test("includes daily P&L from today's snapshot", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const db = getDb();
		const today = new Date().toISOString().split("T")[0];
		db.insert(dailySnapshots)
			.values({
				date: today!,
				portfolioValue: 10500,
				cashBalance: 5000,
				positionsValue: 5500,
				dailyPnl: 125.5,
				dailyPnlPercent: 1.21,
				totalPnl: 500,
				paperStrategiesActive: 2,
				liveStrategiesActive: 0,
				tradesCount: 5,
			})
			.run();

		const { getHealthData } = await import("../../src/monitoring/health");
		const data = await getHealthData();
		expect(data.dailyPnl).toBe(125.5);
	});

	test("reports last quote time", async () => {
		const { getDb } = await import("../../src/db/client.ts");
		const db = getDb();
		const now = new Date().toISOString();
		db.insert(quotesCache)
			.values({
				symbol: "AAPL",
				exchange: "US",
				last: 150.25,
				updatedAt: now,
			})
			.run();

		const { getHealthData } = await import("../../src/monitoring/health");
		const data = await getHealthData();
		expect(data.lastQuoteTime).toBe(now);
	});
});
