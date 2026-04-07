import { describe, test, expect, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "../../src/db/client";
import { quotesCache } from "../../src/db/schema";

describe("quote refresh exchange filter", () => {
	beforeEach(async () => {
		closeDb();
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		await db.insert(quotesCache).values([
			{ symbol: "VOD", exchange: "LSE", last: 100, updatedAt: new Date().toISOString() },
			{ symbol: "AAPL", exchange: "NASDAQ", last: 200, updatedAt: new Date().toISOString() },
			{ symbol: "MSFT", exchange: "NASDAQ", last: 300, updatedAt: new Date().toISOString() },
			{ symbol: "BARC", exchange: "LSE", last: 150, updatedAt: new Date().toISOString() },
		]);
	});

	test("getSymbolsToRefresh returns all symbols when no filter", async () => {
		const { getSymbolsToRefresh } = await import("../../src/scheduler/quote-refresh");
		const symbols = await getSymbolsToRefresh();
		expect(symbols.length).toBe(4);
	});

	test("getSymbolsToRefresh filters to UK exchanges only", async () => {
		const { getSymbolsToRefresh } = await import("../../src/scheduler/quote-refresh");
		const symbols = await getSymbolsToRefresh(["LSE"]);
		expect(symbols.length).toBe(2);
		expect(symbols.every((s) => s.exchange === "LSE")).toBe(true);
	});

	test("getSymbolsToRefresh filters to US exchanges only", async () => {
		const { getSymbolsToRefresh } = await import("../../src/scheduler/quote-refresh");
		const symbols = await getSymbolsToRefresh(["NASDAQ", "NYSE"]);
		expect(symbols.length).toBe(2);
		expect(symbols.every((s) => s.exchange === "NASDAQ" || s.exchange === "NYSE")).toBe(true);
	});

	test("getSymbolsToRefresh returns empty for exchange with no symbols", async () => {
		const { getSymbolsToRefresh } = await import("../../src/scheduler/quote-refresh");
		const symbols = await getSymbolsToRefresh(["NYSE"]);
		expect(symbols.length).toBe(0);
	});
});
