import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { investableUniverse, watchlist } from "../../src/db/schema.ts";
import { runWatchlistDemoteJob } from "../../src/scheduler/watchlist-demote-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

describe("runWatchlistDemoteJob", () => {
	test("delegates to runDemotionSweep and returns summary", async () => {
		getDb()
			.insert(investableUniverse)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				indexSource: "russell_1000",
				active: true,
				lastRefreshed: new Date().toISOString(),
			})
			.run();
		const now = new Date();
		getDb()
			.insert(watchlist)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				promotionReasons: "news",
				promotedAt: new Date(now.getTime() - 200 * 3600_000).toISOString(),
				lastCatalystAt: new Date(now.getTime() - 100 * 3600_000).toISOString(),
				expiresAt: new Date(now.getTime() + 72 * 3600_000).toISOString(),
			})
			.run();
		const result = await runWatchlistDemoteJob({ now });
		expect(result.demoted).toBe(1);
		expect(result.byReason.stale).toBe(1);
	});
});
