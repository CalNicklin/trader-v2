import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
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

// TRA-41: per-region cap eviction. Sweep can be scoped to a subset of
// exchanges with its own cap, so UK and US compete only against same-region
// peers (no timezone bias from `lastCatalystAt`).
describe("runDemotionSweep — per-region scope (TRA-41)", () => {
	function insertLseRow(symbol: string, ageMin: number) {
		getDb()
			.insert(investableUniverse)
			.values({
				symbol,
				exchange: "LSE",
				indexSource: "ftse_350",
				active: true,
				lastRefreshed: new Date().toISOString(),
			})
			.run();
		insertWatchlist({
			symbol,
			exchange: "LSE",
			lastCatalystAt: new Date(Date.now() - ageMin * 60_000).toISOString(),
		});
	}

	test("UK-scope: caps LSE+AIM rows independently, leaves US rows alone", async () => {
		// 35 LSE rows + 50 NASDAQ rows, all young enough to survive rules.
		for (let i = 0; i < 35; i++) {
			insertLseRow(`UK${i.toString().padStart(3, "0")}`, i);
		}
		for (let i = 0; i < 50; i++) {
			const sym = `US${i.toString().padStart(3, "0")}`;
			insertUniverseRow(sym);
			insertWatchlist({
				symbol: sym,
				lastCatalystAt: new Date(Date.now() - i * 60_000).toISOString(),
			});
		}

		const result = await runDemotionSweep(new Date(), {
			exchanges: ["LSE", "AIM"],
			cap: 30,
		});

		expect(result.demoted).toBe(5);
		expect(result.byReason.cap_eviction).toBe(5);

		const liveLse = getDb()
			.select()
			.from(watchlist)
			.where(and(isNull(watchlist.demotedAt), eq(watchlist.exchange, "LSE")))
			.all().length;
		const liveUs = getDb()
			.select()
			.from(watchlist)
			.where(and(isNull(watchlist.demotedAt), eq(watchlist.exchange, "NASDAQ")))
			.all().length;
		expect(liveLse).toBe(30);
		expect(liveUs).toBe(50);
	});

	test("UK-scope: cap-evicts the oldest LSE rows, not the newest", async () => {
		for (let i = 0; i < 35; i++) {
			insertLseRow(`UK${i.toString().padStart(3, "0")}`, i);
		}
		await runDemotionSweep(new Date(), { exchanges: ["LSE", "AIM"], cap: 30 });

		const evicted = getDb()
			.select()
			.from(watchlist)
			.where(eq(watchlist.demotionReason, "cap_eviction"))
			.all();
		const evictedSyms = evicted.map((r) => r.symbol).sort();
		// Oldest = highest age = highest index (UK030..UK034).
		expect(evictedSyms).toEqual(["UK030", "UK031", "UK032", "UK033", "UK034"]);
	});

	test("US-scope: leaves LSE/AIM rows untouched", async () => {
		for (let i = 0; i < 5; i++) {
			insertLseRow(`UK${i}`, i);
		}
		for (let i = 0; i < 130; i++) {
			const sym = `US${i.toString().padStart(3, "0")}`;
			insertUniverseRow(sym);
			insertWatchlist({
				symbol: sym,
				lastCatalystAt: new Date(Date.now() - i * 60_000).toISOString(),
			});
		}

		const result = await runDemotionSweep(new Date(), {
			exchanges: ["NASDAQ", "NYSE"],
			cap: 120,
		});

		expect(result.demoted).toBe(10);
		const liveLse = getDb()
			.select()
			.from(watchlist)
			.where(and(isNull(watchlist.demotedAt), eq(watchlist.exchange, "LSE")))
			.all().length;
		expect(liveLse).toBe(5);
	});

	test("UK-scope: rule-based demotions still fire on stale LSE rows", async () => {
		insertLseRow("STALE", 100 * 60); // 100h old (> 72h staleness)
		insertLseRow("FRESH", 1);

		const result = await runDemotionSweep(new Date(), {
			exchanges: ["LSE", "AIM"],
			cap: 30,
		});

		expect(result.byReason.stale).toBe(1);
		const stale = getDb().select().from(watchlist).where(eq(watchlist.symbol, "STALE")).get();
		expect(stale?.demotionReason).toBe("stale");
	});

	test("scoped sweep does not run rule-based demotions on out-of-scope exchanges", async () => {
		// NASDAQ row is stale (> 72h) but UK-scoped sweep should not touch it.
		insertUniverseRow("NSTALE");
		insertWatchlist({
			symbol: "NSTALE",
			exchange: "NASDAQ",
			lastCatalystAt: new Date(Date.now() - 100 * 3600_000).toISOString(),
		});
		insertLseRow("UK001", 1);

		await runDemotionSweep(new Date(), { exchanges: ["LSE", "AIM"], cap: 30 });

		const nstale = getDb().select().from(watchlist).where(eq(watchlist.symbol, "NSTALE")).get();
		expect(nstale?.demotedAt).toBeNull();
	});
});
