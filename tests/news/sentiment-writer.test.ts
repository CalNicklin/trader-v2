import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsEvents } from "../../src/db/schema.ts";
import { storeNewsEvent } from "../../src/news/sentiment-writer.ts";

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
			signals: null,
		});

		const rows = await db.select().from(newsEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.headline).toBe("Apple beats earnings");
		expect(rows[0]!.tradeable).toBe(true);
		expect(rows[0]!.sentiment).toBeCloseTo(0.8);
		expect(rows[0]!.classifiedAt).not.toBeNull();
	});

	test("writeSignals writes all signal fields to quote cache", async () => {
		const { writeSignals } = await import("../../src/news/sentiment-writer.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await db.insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 150,
		});

		await writeSignals("AAPL", "NASDAQ", {
			sentiment: 0.8,
			earningsSurprise: 0.9,
			guidanceChange: 0.3,
			managementTone: 0.7,
			regulatoryRisk: 0.0,
			acquisitionLikelihood: 0.0,
			catalystType: "fundamental",
			expectedMoveDuration: "1-3d",
		});

		const [row] = await db
			.select()
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, "AAPL"), eq(quotesCache.exchange, "NASDAQ")));

		expect(row).not.toBeUndefined();
		expect(row!.newsSentiment).toBeCloseTo(0.8);
		expect(row!.newsEarningsSurprise).toBeCloseTo(0.9);
		expect(row!.newsGuidanceChange).toBeCloseTo(0.3);
		expect(row!.newsManagementTone).toBeCloseTo(0.7);
		expect(row!.newsRegulatoryRisk).toBeCloseTo(0.0);
		expect(row!.newsAcquisitionLikelihood).toBeCloseTo(0.0);
		expect(row!.newsCatalystType).toBe("fundamental");
		expect(row!.newsExpectedMoveDuration).toBe("1-3d");
		expect(row!.last).toBe(150); // price unchanged
	});

	test("writeSignals creates cache row if missing", async () => {
		const { writeSignals } = await import("../../src/news/sentiment-writer.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await writeSignals("NEW", "NASDAQ", {
			sentiment: -0.5,
			earningsSurprise: 0.0,
			guidanceChange: 0.0,
			managementTone: 0.3,
			regulatoryRisk: 0.8,
			acquisitionLikelihood: 0.0,
			catalystType: "other",
			expectedMoveDuration: "1-2w",
		});

		const [row] = await db
			.select()
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, "NEW"), eq(quotesCache.exchange, "NASDAQ")));

		expect(row).not.toBeUndefined();
		expect(row!.newsSentiment).toBeCloseTo(-0.5);
		expect(row!.newsRegulatoryRisk).toBeCloseTo(0.8);
		expect(row!.last).toBeNull();
	});

	test("storeNewsEvent stores signal fields in news_events table", async () => {
		const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		await storeNewsEvent({
			source: "finnhub",
			headline: "Apple beats earnings with strong guidance",
			url: "https://example.com",
			symbols: ["AAPL"],
			sentiment: 0.8,
			confidence: 0.9,
			tradeable: true,
			eventType: "earnings_beat",
			urgency: "high" as const,
			signals: {
				earningsSurprise: 0.9,
				guidanceChange: 0.6,
				managementTone: 0.7,
				regulatoryRisk: 0.0,
				acquisitionLikelihood: 0.0,
				catalystType: "fundamental",
				expectedMoveDuration: "1-3d",
			},
		});

		const rows = await db.select().from(newsEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.earningsSurprise).toBeCloseTo(0.9);
		expect(rows[0]!.guidanceChange).toBeCloseTo(0.6);
		expect(rows[0]!.managementTone).toBeCloseTo(0.7);
		expect(rows[0]!.catalystType).toBe("fundamental");
	});

	test("storeNewsEvent handles null signals", async () => {
		const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		await storeNewsEvent({
			source: "finnhub",
			headline: "Routine board appointment at XYZ Corp",
			url: null,
			symbols: ["XYZ"],
			sentiment: null,
			confidence: null,
			tradeable: null,
			eventType: null,
			urgency: null,
			signals: null,
		});

		const rows = await db.select().from(newsEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.earningsSurprise).toBeNull();
		expect(rows[0]!.catalystType).toBeNull();
	});
});

describe("storeNewsEvent returns ID", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	afterEach(() => {
		closeDb();
	});

	test("returns the inserted news event ID", async () => {
		const id = await storeNewsEvent({
			source: "finnhub",
			headline: "Broadcom and Google seal five-year AI chip partnership",
			url: "https://example.com/article",
			symbols: ["GOOGL", "AVGO"],
			sentiment: 0.2,
			confidence: 0.7,
			tradeable: true,
			eventType: "partnership",
			urgency: "low",
			signals: null,
		});

		expect(typeof id).toBe("number");
		expect(id).toBeGreaterThan(0);

		// Verify it matches what's in the DB
		const db = getDb();
		const rows = await db.select().from(newsEvents);
		expect(rows.length).toBe(1);
		expect(rows[0]!.id).toBe(id);
	});
});
