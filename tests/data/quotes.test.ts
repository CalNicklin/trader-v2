import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("quotes", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("upsertQuote inserts a new quote", async () => {
		const { upsertQuote } = await import("../../src/data/quotes.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await upsertQuote({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 185.5,
			bid: 185.4,
			ask: 185.6,
			volume: 50000000,
		});

		const rows = await db
			.select()
			.from(quotesCache)
			.where(eq(quotesCache.symbol, "AAPL"));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.last).toBe(185.5);
	});

	test("upsertQuote updates existing quote", async () => {
		const { upsertQuote } = await import("../../src/data/quotes.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await upsertQuote({ symbol: "AAPL", exchange: "NASDAQ", last: 185.5 });
		await upsertQuote({ symbol: "AAPL", exchange: "NASDAQ", last: 186.0 });

		const rows = await db
			.select()
			.from(quotesCache)
			.where(eq(quotesCache.symbol, "AAPL"));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.last).toBe(186.0);
	});

	test("getQuoteFromCache returns null for missing symbol", async () => {
		const { getQuoteFromCache } = await import("../../src/data/quotes.ts");
		const result = await getQuoteFromCache("ZZZZ", "NASDAQ");
		expect(result).toBeNull();
	});
});
