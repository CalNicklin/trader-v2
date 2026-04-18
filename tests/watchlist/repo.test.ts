import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { watchlist } from "../../src/db/schema.ts";
import {
	countActive,
	getActiveWatchlist,
	getUnenrichedRows,
	getWatchlistByExchange,
} from "../../src/watchlist/repo.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => closeDb());

function insertRow(overrides: Partial<typeof watchlist.$inferInsert> = {}) {
	const db = getDb();
	db.insert(watchlist)
		.values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			promotionReasons: "news",
			expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
			...overrides,
		})
		.run();
}

describe("getActiveWatchlist", () => {
	test("returns only non-demoted rows", () => {
		insertRow({ symbol: "AAPL" });
		insertRow({ symbol: "MSFT", demotedAt: new Date().toISOString(), demotionReason: "stale" });
		const rows = getActiveWatchlist();
		expect(rows.map((r) => r.symbol)).toEqual(["AAPL"]);
	});
});

describe("getUnenrichedRows", () => {
	test("returns rows with enrichedAt null, respects limit", () => {
		insertRow({ symbol: "A" });
		insertRow({ symbol: "B" });
		insertRow({ symbol: "C", enrichedAt: new Date().toISOString() });
		const rows = getUnenrichedRows(10);
		expect(rows.length).toBe(2);
		expect(rows.map((r) => r.symbol).sort()).toEqual(["A", "B"]);
	});

	test("excludes rows with enrichmentFailedAt set", () => {
		insertRow({ symbol: "A", enrichmentFailedAt: new Date().toISOString() });
		insertRow({ symbol: "B" });
		const rows = getUnenrichedRows(10);
		expect(rows.map((r) => r.symbol)).toEqual(["B"]);
	});
});

describe("getWatchlistByExchange", () => {
	test("filters by exchange", () => {
		insertRow({ symbol: "AAPL", exchange: "NASDAQ" });
		insertRow({ symbol: "GAW", exchange: "LSE" });
		const us = getWatchlistByExchange("NASDAQ");
		expect(us.map((r) => r.symbol)).toEqual(["AAPL"]);
	});
});

describe("countActive", () => {
	test("counts only active rows", () => {
		insertRow({ symbol: "A" });
		insertRow({ symbol: "B" });
		insertRow({ symbol: "C", demotedAt: new Date().toISOString(), demotionReason: "stale" });
		expect(countActive()).toBe(2);
	});
});
