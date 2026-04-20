import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { catalystEvents, investableUniverse, watchlist } from "../../src/db/schema.ts";
import { runEarningsCatalystJob } from "../../src/scheduler/earnings-catalyst-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

function seedUniverse(symbol: string, exchange: string = "NASDAQ") {
	getDb()
		.insert(investableUniverse)
		.values({
			symbol,
			exchange,
			indexSource: "russell_1000",
			active: true,
			lastRefreshed: new Date().toISOString(),
		})
		.run();
}

describe("runEarningsCatalystJob", () => {
	test("promotes symbols reporting in next 5 trading days", async () => {
		seedUniverse("AAPL");
		const today = new Date();
		const inThreeDays = new Date(today.getTime() + 3 * 86400_000).toISOString().slice(0, 10);

		const fetchImpl = async (_url: string) =>
			new Response(
				JSON.stringify({
					earningsCalendar: [{ symbol: "AAPL", date: inThreeDays, epsEstimate: 1.5 }],
				}),
			);

		const result = await runEarningsCatalystJob({
			fetchImpl,
			finnhubApiKey: "test-key",
			now: today,
		});
		expect(result.promoted).toBe(1);

		const rows = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).all();
		expect(rows.length).toBe(1);
		expect(rows[0]?.promotionReasons).toContain("earnings");

		const events = getDb().select().from(catalystEvents).all();
		expect(events[0]?.eventType).toBe("earnings");
	});

	test("skips symbols reporting beyond 5 trading days", async () => {
		seedUniverse("AAPL");
		const farFuture = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
		const fetchImpl = async (_url: string) =>
			new Response(
				JSON.stringify({
					earningsCalendar: [{ symbol: "AAPL", date: farFuture, epsEstimate: 1.5 }],
				}),
			);
		const result = await runEarningsCatalystJob({
			fetchImpl,
			finnhubApiKey: "test-key",
			now: new Date(),
		});
		expect(result.promoted).toBe(0);
	});

	test("Finnhub fetch failure logs but does not throw", async () => {
		const fetchImpl = async (_url: string): Promise<Response> => {
			throw new Error("network");
		};
		const result = await runEarningsCatalystJob({
			fetchImpl,
			finnhubApiKey: "test-key",
			now: new Date(),
		});
		expect(result.promoted).toBe(0);
		expect(result.error).toBeDefined();
	});
});
