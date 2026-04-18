import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { investableUniverse, quotesCache, watchlist } from "../../src/db/schema.ts";
import { runVolumeCatalystJob } from "../../src/scheduler/volume-catalyst-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

function seedQuote(symbol: string, exchange: string, lastVol: number, avgVol: number) {
	const now = new Date().toISOString();
	getDb()
		.insert(investableUniverse)
		.values({
			symbol,
			exchange,
			indexSource: exchange === "NASDAQ" ? "russell_1000" : "ftse_350",
			active: true,
			lastRefreshed: now,
		})
		.run();
	getDb()
		.insert(quotesCache)
		.values({
			symbol,
			exchange,
			last: 100,
			bid: 99.5,
			ask: 100.5,
			volume: lastVol,
			avgVolume: avgVol,
			updatedAt: now,
		})
		.run();
}

describe("runVolumeCatalystJob", () => {
	test("promotes US symbol with volume_ratio >= 3.0 when scope='us'", async () => {
		seedQuote("AAPL", "NASDAQ", 3_000_000, 1_000_000);
		const result = await runVolumeCatalystJob({ scope: "us", now: new Date() });
		expect(result.promoted).toBe(1);
		const rows = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).all();
		expect(rows[0]?.promotionReasons).toContain("volume");
	});

	test("skips US symbol with volume_ratio < 3.0", async () => {
		seedQuote("AAPL", "NASDAQ", 1_500_000, 1_000_000);
		const result = await runVolumeCatalystJob({ scope: "us", now: new Date() });
		expect(result.promoted).toBe(0);
	});

	test("scope='uk' only considers LSE/AIM", async () => {
		seedQuote("AAPL", "NASDAQ", 3_000_000, 1_000_000);
		seedQuote("GAW", "LSE", 3_000_000, 1_000_000);
		const result = await runVolumeCatalystJob({ scope: "uk", now: new Date() });
		expect(result.promoted).toBe(1);
		const rows = getDb().select().from(watchlist).all();
		expect(rows.map((r) => r.symbol)).toEqual(["GAW"]);
	});
});
