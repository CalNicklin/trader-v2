// tests/monitoring/dashboard-missed.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { tradeInsights } from "../../src/db/schema.ts";
import { getLearningLoopData } from "../../src/monitoring/dashboard-data.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("getLearningLoopData includes missed opportunities", () => {
	test("counts missed opportunities in summary stats", async () => {
		const db = getDb();

		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "AVGO moved +4.2%",
			tags: JSON.stringify(["missed_opportunity", "AVGO"]),
			confidence: 0.85,
		});
		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "TSLA moved -3.1%",
			tags: JSON.stringify(["missed_opportunity", "TSLA"]),
			confidence: 0.7,
		});

		const data = await getLearningLoopData();
		expect(data.missedOpportunities).toBe(2);
	});

	test("returns 0 missed when none exist", async () => {
		const data = await getLearningLoopData();
		expect(data.missedOpportunities).toBe(0);
	});

	test("missed_opportunity insights appear in recentInsights", async () => {
		const db = getDb();
		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "AVGO moved +4.2%",
			tags: JSON.stringify(["missed_opportunity", "AVGO"]),
			confidence: 0.85,
		});

		const data = await getLearningLoopData();
		expect(data.recentInsights.length).toBe(1);
		expect(data.recentInsights[0]!.insightType).toBe("missed_opportunity");
	});
});
