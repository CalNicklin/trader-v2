import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

describe("sentiment writer", () => {
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

	test("writes sentiment to existing quote cache row", async () => {
		const { writeSentiment } = await import("../../src/news/sentiment-writer.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		// Insert a quote first
		await db.insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 150,
		});

		await writeSentiment("AAPL", "NASDAQ", 0.8);

		const [row] = await db
			.select()
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, "AAPL"), eq(quotesCache.exchange, "NASDAQ")));

		expect(row).not.toBeUndefined();
		expect(row!.newsSentiment).toBeCloseTo(0.8);
		expect(row!.last).toBe(150); // price unchanged
	});

	test("creates quote cache row if missing", async () => {
		const { writeSentiment } = await import("../../src/news/sentiment-writer.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await writeSentiment("NEW", "NASDAQ", -0.5);

		const [row] = await db
			.select()
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, "NEW"), eq(quotesCache.exchange, "NASDAQ")));

		expect(row).not.toBeUndefined();
		expect(row!.newsSentiment).toBeCloseTo(-0.5);
		expect(row!.last).toBeNull();
	});

	test("stores news event in news_events table", async () => {
		const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		await storeNewsEvent({
			source: "finnhub",
			headline: "Apple beats earnings",
			url: "https://example.com",
			symbols: ["AAPL"],
			sentiment: 0.8,
			confidence: 0.9,
			tradeable: true,
			eventType: "earnings_beat",
			urgency: "high" as const,
		});

		const rows = await db.select().from(newsEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.headline).toBe("Apple beats earnings");
		expect(rows[0]!.tradeable).toBe(true);
		expect(rows[0]!.sentiment).toBeCloseTo(0.8);
		expect(rows[0]!.classifiedAt).not.toBeNull();
	});
});
