// tests/scheduler/missed-opportunity-job.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, quotesCache, tradeInsights } from "../../src/db/schema.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

function hoursAgo(hours: number): string {
	return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe("runDailyMissedOpportunityReview", () => {
	test("logs missed opportunity for out-of-universe symbol with >2% move in predicted direction", async () => {
		const db = getDb();

		// Insert a news analysis from 30 hours ago, not in universe, predicted long
		await db.insert(newsAnalyses).values({
			newsEventId: 1,
			symbol: "AVGO",
			exchange: "NASDAQ",
			sentiment: 0.85,
			urgency: "high",
			eventType: "contract_win",
			direction: "long",
			tradeThesis: "Major AI chip deal",
			confidence: 0.7,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: 100.0,
			createdAt: hoursAgo(30),
		});

		// Insert current price in quotes_cache showing +5% move
		await db
			.insert(quotesCache)
			.values({ symbol: "AVGO", exchange: "NASDAQ", last: 105.0 })
			.onConflictDoNothing();

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		// Check priceAfter1d was updated
		const [analysis] = await db.select().from(newsAnalyses).where(eq(newsAnalyses.symbol, "AVGO"));
		expect(analysis!.priceAfter1d).toBeCloseTo(105.0, 1);

		// Check missed opportunity was logged
		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(1);
		expect(insights[0]!.strategyId).toBeNull();
		expect(insights[0]!.observation).toContain("AVGO");
		expect(insights[0]!.observation).toContain("5.0%");
	});

	test("does NOT log missed opportunity for symbol that was in universe", async () => {
		const db = getDb();

		await db.insert(newsAnalyses).values({
			newsEventId: 2,
			symbol: "AAPL",
			exchange: "NASDAQ",
			sentiment: 0.6,
			urgency: "high",
			eventType: "earnings_beat",
			direction: "long",
			tradeThesis: "Strong earnings",
			confidence: 0.9,
			recommendTrade: true,
			inUniverse: true, // WAS in universe
			priceAtAnalysis: 150.0,
			createdAt: hoursAgo(30),
		});

		await db
			.insert(quotesCache)
			.values({ symbol: "AAPL", exchange: "NASDAQ", last: 157.5 })
			.onConflictDoNothing();

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		// priceAfter1d should still be updated
		const [analysis] = await db.select().from(newsAnalyses).where(eq(newsAnalyses.symbol, "AAPL"));
		expect(analysis!.priceAfter1d).toBeCloseTo(157.5, 1);

		// But NO missed opportunity insight
		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(0);
	});

	test("does NOT log missed opportunity for <2% move", async () => {
		const db = getDb();

		await db.insert(newsAnalyses).values({
			newsEventId: 3,
			symbol: "MSFT",
			exchange: "NASDAQ",
			sentiment: 0.5,
			urgency: "medium",
			eventType: "partnership",
			direction: "long",
			tradeThesis: "Minor partnership",
			confidence: 0.5,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: 400.0,
			createdAt: hoursAgo(30),
		});

		await db
			.insert(quotesCache)
			.values({ symbol: "MSFT", exchange: "NASDAQ", last: 404.0 })
			.onConflictDoNothing();

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(0);
	});

	test("skips rows where priceAtAnalysis is null", async () => {
		const db = getDb();

		await db.insert(newsAnalyses).values({
			newsEventId: 4,
			symbol: "UNKNOWN",
			exchange: "NASDAQ",
			sentiment: 0.8,
			urgency: "high",
			eventType: "contract_win",
			direction: "long",
			tradeThesis: "New symbol",
			confidence: 0.6,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: null, // no price available
			createdAt: hoursAgo(30),
		});

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		// priceAfter1d should remain null
		const [analysis] = await db
			.select()
			.from(newsAnalyses)
			.where(eq(newsAnalyses.symbol, "UNKNOWN"));
		expect(analysis!.priceAfter1d).toBeNull();
	});

	test("handles short direction correctly — negative move is a hit", async () => {
		const db = getDb();

		await db.insert(newsAnalyses).values({
			newsEventId: 5,
			symbol: "BAD",
			exchange: "NYSE",
			sentiment: -0.7,
			urgency: "high",
			eventType: "profit_warning",
			direction: "short",
			tradeThesis: "Profit warning = downside",
			confidence: 0.75,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: 50.0,
			createdAt: hoursAgo(30),
		});

		await db
			.insert(quotesCache)
			.values({ symbol: "BAD", exchange: "NYSE", last: 47.0 })
			.onConflictDoNothing();

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(1);
		expect(insights[0]!.observation).toContain("BAD");
	});
});
