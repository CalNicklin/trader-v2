import { beforeEach, describe, expect, test } from "bun:test";

describe("news ingest orchestrator", () => {
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

	test("processArticle stores event and writes sentiment for classified headline", async () => {
		const { processArticle } = await import("../../src/news/ingest.ts");
		const { newsEvents, quotesCache } = await import("../../src/db/schema.ts");
		const { and, eq } = await import("drizzle-orm");

		// Mock: provide a fake classifier that returns a canned result
		const result = await processArticle(
			{
				headline: "Apple beats earnings estimates",
				symbols: ["AAPL"],
				url: "https://example.com",
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: 123,
			},
			"NASDAQ",
			async () => ({
				tradeable: true,
				sentiment: 0.8,
				confidence: 0.9,
				eventType: "earnings_beat",
				urgency: "high" as const,
			}),
		);

		expect(result).toBe("classified");

		const events = await db.select().from(newsEvents);
		expect(events).toHaveLength(1);
		expect(events[0]!.tradeable).toBe(true);

		const [quote] = await db
			.select()
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, "AAPL"), eq(quotesCache.exchange, "NASDAQ")));
		expect(quote!.newsSentiment).toBeCloseTo(0.8);
	});

	test("processArticle skips blocked headlines", async () => {
		const { processArticle } = await import("../../src/news/ingest.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		const result = await processArticle(
			{
				headline: "Analyst reiterates Buy rating on Apple",
				symbols: ["AAPL"],
				url: null,
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: 456,
			},
			"NASDAQ",
			async () => null, // should not be called
		);

		expect(result).toBe("filtered");

		// Filtered headlines are still stored but without classification
		const events = await db.select().from(newsEvents);
		expect(events).toHaveLength(1);
		expect(events[0]!.classifiedAt).toBeNull();
	});

	test("deduplicates headlines already in news_events", async () => {
		const { isHeadlineSeen } = await import("../../src/news/ingest.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		// Insert existing headline
		await db.insert(newsEvents).values({
			source: "finnhub",
			headline: "Apple beats earnings estimates",
			symbols: JSON.stringify(["AAPL"]),
		});

		const seen = await isHeadlineSeen("Apple beats earnings estimates");
		expect(seen).toBe(true);

		const notSeen = await isHeadlineSeen("Brand new headline");
		expect(notSeen).toBe(false);
	});
});
