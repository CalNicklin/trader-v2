// tests/integration/news-research-pipeline.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, quotesCache, tradeInsights } from "../../src/db/schema.ts";
import { parseResearchResponse } from "../../src/news/research-agent.ts";
import { storeNewsEvent } from "../../src/news/sentiment-writer.ts";
import { runDailyMissedOpportunityReview } from "../../src/scheduler/missed-opportunity-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("end-to-end news research pipeline", () => {
	test("storeNewsEvent → research analysis → missed opportunity tracker", async () => {
		const db = getDb();

		// Step 1: Store a news event and get ID
		const newsEventId = await storeNewsEvent({
			source: "finnhub",
			headline: "Broadcom and Google seal five-year AI chip partnership",
			url: null,
			symbols: ["GOOGL"],
			sentiment: 0.2,
			confidence: 0.7,
			tradeable: true,
			eventType: "partnership",
			urgency: "low",
			signals: null,
		});

		expect(newsEventId).toBeGreaterThan(0);

		// Step 2: Simulate research agent response (without actual API call)
		const mockResponse = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					sentiment: 0.85,
					urgency: "high",
					event_type: "contract_win",
					direction: "long",
					trade_thesis: "Major 5-year AI chip deal signals revenue growth",
					confidence: 0.9,
				},
				{
					symbol: "GOOGL",
					exchange: "NASDAQ",
					sentiment: 0.2,
					urgency: "low",
					event_type: "partnership",
					direction: "long",
					trade_thesis: "Partnership positive but minor for Google",
					confidence: 0.4,
				},
			],
		});

		const analyses = parseResearchResponse(mockResponse);
		expect(analyses.length).toBe(2);

		// Step 3: Store analyses in DB
		const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
		for (const analysis of analyses) {
			await db.insert(newsAnalyses).values({
				newsEventId,
				symbol: analysis.symbol,
				exchange: analysis.exchange,
				sentiment: analysis.sentiment,
				urgency: analysis.urgency,
				eventType: analysis.eventType,
				direction: analysis.direction,
				tradeThesis: analysis.tradeThesis,
				confidence: analysis.confidence,
				recommendTrade: analysis.recommendTrade,
				inUniverse: analysis.symbol === "GOOGL", // GOOGL was in universe, AVGO was not
				priceAtAnalysis: analysis.symbol === "AVGO" ? 100.0 : 150.0,
				createdAt: thirtyHoursAgo,
			});
		}

		// Step 4: Add current prices to quotes_cache
		await db
			.insert(quotesCache)
			.values({ symbol: "AVGO", exchange: "NASDAQ", last: 105.0 })
			.onConflictDoUpdate({
				target: [quotesCache.symbol, quotesCache.exchange],
				set: { last: 105.0, updatedAt: new Date().toISOString() },
			});
		await db
			.insert(quotesCache)
			.values({ symbol: "GOOGL", exchange: "NASDAQ", last: 152.0 })
			.onConflictDoUpdate({
				target: [quotesCache.symbol, quotesCache.exchange],
				set: { last: 152.0, updatedAt: new Date().toISOString() },
			});

		// Step 5: Run missed opportunity tracker
		const result = await runDailyMissedOpportunityReview();
		expect(result.reviewed).toBe(2);
		expect(result.missed).toBe(1); // Only AVGO (not in universe, +5%)

		// Verify AVGO has a missed opportunity insight
		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(1);
		expect(insights[0]!.observation).toContain("AVGO");
		expect(insights[0]!.observation).toContain("5.0%");
		expect(insights[0]!.strategyId).toBeNull();

		// Verify GOOGL does NOT have a missed opportunity (was in universe)
		expect(insights[0]!.observation).not.toContain("GOOGL");
	});
});
