// tests/db/news-analyses-schema.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, tradeInsights } from "../../src/db/schema.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("newsAnalyses table", () => {
	test("inserts and reads a news analysis row", async () => {
		const db = getDb();
		const [row] = await db
			.insert(newsAnalyses)
			.values({
				newsEventId: 1,
				symbol: "AVGO",
				exchange: "NASDAQ",
				sentiment: 0.85,
				urgency: "high",
				eventType: "partnership",
				direction: "long",
				tradeThesis: "Major 5-year AI chip deal signals revenue growth",
				confidence: 0.9,
				recommendTrade: true,
				inUniverse: false,
				priceAtAnalysis: 185.5,
			})
			.returning();

		expect(row!.symbol).toBe("AVGO");
		expect(row!.sentiment).toBe(0.85);
		expect(row!.direction).toBe("long");
		expect(row!.inUniverse).toBe(false);
		expect(row!.priceAfter1d).toBeNull();
	});

	test("unique constraint on (newsEventId, symbol) with upsert", async () => {
		const db = getDb();
		await db.insert(newsAnalyses).values({
			newsEventId: 1,
			symbol: "AVGO",
			exchange: "NASDAQ",
			sentiment: 0.5,
			urgency: "medium",
			eventType: "partnership",
			direction: "long",
			tradeThesis: "Initial thesis",
			confidence: 0.6,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: 180.0,
		});

		// Upsert same (newsEventId, symbol)
		await db
			.insert(newsAnalyses)
			.values({
				newsEventId: 1,
				symbol: "AVGO",
				exchange: "NASDAQ",
				sentiment: 0.85,
				urgency: "high",
				eventType: "partnership",
				direction: "long",
				tradeThesis: "Updated thesis",
				confidence: 0.9,
				recommendTrade: true,
				inUniverse: false,
				priceAtAnalysis: 185.5,
			})
			.onConflictDoUpdate({
				target: [newsAnalyses.newsEventId, newsAnalyses.symbol],
				set: {
					sentiment: 0.85,
					confidence: 0.9,
					tradeThesis: "Updated thesis",
				},
			});

		const rows = await db.select().from(newsAnalyses).where(eq(newsAnalyses.symbol, "AVGO"));
		expect(rows.length).toBe(1);
		expect(rows[0]!.confidence).toBe(0.9);
	});
});

describe("tradeInsights nullable strategyId", () => {
	test("inserts a missed_opportunity insight with null strategyId", async () => {
		const db = getDb();
		const [row] = await db
			.insert(tradeInsights)
			.values({
				strategyId: null,
				insightType: "missed_opportunity",
				observation: "AVGO moved +4.2% after partnership announcement",
				tags: JSON.stringify(["missed_opportunity", "partnership", "AVGO"]),
				confidence: 0.85,
			})
			.returning();

		expect(row!.strategyId).toBeNull();
		expect(row!.insightType).toBe("missed_opportunity");
	});

	test("inserts a universe_suggestion insight with null strategyId", async () => {
		const db = getDb();
		const [row] = await db
			.insert(tradeInsights)
			.values({
				strategyId: null,
				insightType: "universe_suggestion",
				observation: "AVGO appears in 3 missed opportunities — add to universe",
				tags: JSON.stringify(["universe_suggestion", "AVGO"]),
				confidence: 0.7,
			})
			.returning();

		expect(row!.strategyId).toBeNull();
		expect(row!.insightType).toBe("universe_suggestion");
	});
});
