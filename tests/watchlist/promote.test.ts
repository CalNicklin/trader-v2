import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { investableUniverse, watchlist } from "../../src/db/schema.ts";
import { promoteToWatchlist } from "../../src/watchlist/promote.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
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
});

afterEach(() => closeDb());

function activeRow(symbol: string) {
	return getDb()
		.select()
		.from(watchlist)
		.where(and(eq(watchlist.symbol, symbol), isNull(watchlist.demotedAt)))
		.get();
}

describe("promoteToWatchlist", () => {
	test("inserts new row when symbol is in investable_universe", async () => {
		const result = await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: { headline: "Apple beats" },
			ttlHours: 72,
		});
		expect(result.status).toBe("inserted");
		const row = activeRow("AAPL");
		expect(row?.promotionReasons).toBe("news");
		expect(row?.enrichedAt).toBeNull();
	});

	test("rejects symbol NOT in investable_universe", async () => {
		const result = await promoteToWatchlist({
			symbol: "ZZZZZ",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		expect(result.status).toBe("rejected_not_in_universe");
		expect(activeRow("ZZZZZ")).toBeUndefined();
	});

	test("idempotent: second promote with same reason updates last_catalyst_at, does not duplicate", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		const firstCatalyst = activeRow("AAPL")?.lastCatalystAt;
		await new Promise((r) => setTimeout(r, 10));
		const result = await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		expect(result.status).toBe("updated");
		const row = activeRow("AAPL");
		expect(row?.promotionReasons).toBe("news");
		expect(row?.lastCatalystAt.localeCompare(firstCatalyst!)).toBeGreaterThan(0);

		const all = getDb()
			.select()
			.from(watchlist)
			.where(and(eq(watchlist.symbol, "AAPL"), isNull(watchlist.demotedAt)))
			.all();
		expect(all.length).toBe(1);
	});

	test("merges new reason into existing comma-joined list", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "earnings",
			payload: null,
			ttlHours: 72,
		});
		const row = activeRow("AAPL");
		expect(row?.promotionReasons.split(",").sort()).toEqual(["earnings", "news"]);
	});

	test("extends expires_at when new TTL pushes further out", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 24,
		});
		const firstExpires = activeRow("AAPL")?.expiresAt;
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 96,
		});
		const secondExpires = activeRow("AAPL")?.expiresAt;
		expect(secondExpires!.localeCompare(firstExpires!)).toBeGreaterThan(0);
	});

	test("does NOT shorten expires_at when new TTL is sooner", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 96,
		});
		const firstExpires = activeRow("AAPL")?.expiresAt;
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 24,
		});
		expect(activeRow("AAPL")?.expiresAt).toBe(firstExpires!);
	});

	test("reactivates a previously-demoted row as fresh insert", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		getDb()
			.update(watchlist)
			.set({ demotedAt: new Date().toISOString(), demotionReason: "stale" })
			.where(eq(watchlist.symbol, "AAPL"))
			.run();

		const result = await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		expect(result.status).toBe("inserted");
		expect(activeRow("AAPL")).toBeDefined();
	});
});
