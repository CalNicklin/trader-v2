import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { quotesCache } from "../../src/db/schema.ts";
import { resetConfigForTesting } from "../../src/config.ts";

describe("pruneDeadSymbols", () => {
	beforeEach(() => {
		closeDb();
		resetConfigForTesting();
		process.env.DB_PATH = ":memory:";
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("deletes symbols with null price older than 7 days", async () => {
		const db = getDb();
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

		// Insert a dead symbol (null last, old updatedAt)
		await db.insert(quotesCache).values({
			symbol: "SAMSUNG",
			exchange: "NYSE",
			last: null,
			updatedAt: eightDaysAgo,
		});

		// Insert a valid symbol (has price)
		await db.insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 185.5,
			updatedAt: eightDaysAgo,
		});

		// Insert a recent null-price symbol (should NOT be pruned)
		await db.insert(quotesCache).values({
			symbol: "NEWSTOCK",
			exchange: "NASDAQ",
			last: null,
			updatedAt: new Date().toISOString(),
		});

		const { pruneDeadSymbols } = await import("../../src/scheduler/quote-refresh.ts");
		const pruned = await pruneDeadSymbols();

		expect(pruned).toBe(1);

		const remaining = await db.select({ symbol: quotesCache.symbol }).from(quotesCache);
		expect(remaining.map((r) => r.symbol).sort()).toEqual(["AAPL", "NEWSTOCK"]);
	});
});
