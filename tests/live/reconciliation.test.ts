import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { resetConfigForTesting } from "../../src/config.ts";
import { closeDb, getDb } from "../../src/db/client.ts";
import { livePositions } from "../../src/db/schema.ts";
import { reconcilePositions } from "../../src/live/reconciliation.ts";

process.env.DB_PATH = ":memory:";

describe("reconcilePositions", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("inserts orphaned IBKR positions not in DB", async () => {
		const db = getDb();
		const result = await reconcilePositions([
			{
				accountId: "DU123",
				symbol: "AAPL",
				exchange: "NASDAQ",
				currency: "USD",
				quantity: 10,
				avgCost: 150,
			},
		]);

		expect(result.inserted).toBe(1);
		expect(result.deleted).toBe(0);

		const positions = await db.select().from(livePositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.symbol).toBe("AAPL");
	});

	test("deletes phantom DB positions not in IBKR", async () => {
		const db = getDb();
		await db.insert(livePositions).values({
			symbol: "TSLA",
			exchange: "NASDAQ",
			currency: "USD",
			quantity: 5,
			avgCost: 200,
		});

		const result = await reconcilePositions([]); // No IBKR positions

		expect(result.deleted).toBe(1);
		expect(result.inserted).toBe(0);

		const positions = await db.select().from(livePositions);
		expect(positions).toHaveLength(0);
	});

	test("no changes when positions match", async () => {
		const db = getDb();
		await db.insert(livePositions).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			currency: "USD",
			quantity: 10,
			avgCost: 150,
		});

		const result = await reconcilePositions([
			{
				accountId: "DU123",
				symbol: "AAPL",
				exchange: "NASDAQ",
				currency: "USD",
				quantity: 10,
				avgCost: 150,
			},
		]);

		expect(result.inserted).toBe(0);
		expect(result.deleted).toBe(0);
	});
});
