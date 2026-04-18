import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { investableUniverse, paperPositions, watchlist } from "../../src/db/schema.ts";
import { runDemotionSweep } from "../../src/watchlist/demote.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => closeDb());

function insertWatchlist(overrides: Partial<typeof watchlist.$inferInsert> = {}) {
	const now = new Date().toISOString();
	getDb()
		.insert(watchlist)
		.values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			promotionReasons: "news",
			promotedAt: now,
			lastCatalystAt: now,
			expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
			...overrides,
		})
		.run();
}

function insertUniverseRow(symbol: string, active = true) {
	getDb()
		.insert(investableUniverse)
		.values({
			symbol,
			exchange: "NASDAQ",
			indexSource: "russell_1000",
			active,
			lastRefreshed: new Date().toISOString(),
		})
		.run();
}

describe("runDemotionSweep — individual rules", () => {
	test("rule 1: demotes row stale > 72h", async () => {
		insertUniverseRow("AAPL");
		insertWatchlist({
			symbol: "AAPL",
			lastCatalystAt: new Date(Date.now() - 100 * 3600_000).toISOString(),
		});
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(1);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.demotionReason).toBe("stale");
	});

	test("rule 2: demotes row with resolved status in research_payload", async () => {
		insertUniverseRow("AAPL");
		insertWatchlist({
			symbol: "AAPL",
			researchPayload: JSON.stringify({ status: "resolved" }),
		});
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(1);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.demotionReason).toBe("resolved");
	});

	test("rule 4: demotes row no longer in active investable_universe", async () => {
		insertUniverseRow("DELISTED", false);
		insertWatchlist({ symbol: "DELISTED" });
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(1);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "DELISTED")).get();
		expect(row?.demotionReason).toBe("universe_removed");
	});

	test("rule 7: demotes row with enrichment_failed_at > 48h old", async () => {
		insertUniverseRow("AAPL");
		insertWatchlist({
			symbol: "AAPL",
			enrichmentFailedAt: new Date(Date.now() - 60 * 3600_000).toISOString(),
		});
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(1);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.demotionReason).toBe("enrichment_failed");
	});

	test("never-demote exception: symbol with open paper position is skipped", async () => {
		insertUniverseRow("AAPL");
		insertWatchlist({
			symbol: "AAPL",
			lastCatalystAt: new Date(Date.now() - 200 * 3600_000).toISOString(),
		});
		// paperPositions has no status column; open = closedAt IS NULL (default)
		getDb()
			.insert(paperPositions)
			.values({
				strategyId: 1,
				symbol: "AAPL",
				exchange: "NASDAQ",
				quantity: 10,
				entryPrice: 150,
				// closedAt omitted = null → position is open
			})
			.run();
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(0);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.demotedAt).toBeNull();
	});
});

describe("runDemotionSweep — cap eviction", () => {
	test("demotes lowest-ranked rows when active count exceeds soft cap (150)", async () => {
		for (let i = 0; i < 152; i++) {
			const sym = `SYM${i.toString().padStart(3, "0")}`;
			insertUniverseRow(sym);
			const age = i;
			insertWatchlist({
				symbol: sym,
				lastCatalystAt: new Date(Date.now() - age * 60_000).toISOString(),
			});
		}
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBeGreaterThanOrEqual(2);
		const activeCount = getDb()
			.select()
			.from(watchlist)
			.where(isNull(watchlist.demotedAt))
			.all().length;
		expect(activeCount).toBeLessThanOrEqual(150);

		const oldest = getDb().select().from(watchlist).where(eq(watchlist.symbol, "SYM151")).get();
		expect(oldest?.demotionReason).toBe("cap_eviction");
	});
});
