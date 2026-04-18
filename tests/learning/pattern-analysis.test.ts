import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import {
	catalystEvents,
	investableUniverse,
	tradeInsights,
	watchlist,
} from "../../src/db/schema.ts";
import { checkFeedbackPromotions } from "../../src/learning/pattern-analysis.ts";

describe("pattern analysis", () => {
	test("buildPatternAnalysisPrompt includes strategy trade data", async () => {
		const { buildPatternAnalysisPrompt } = await import("../../src/learning/pattern-analysis.ts");

		const prompt = buildPatternAnalysisPrompt([
			{
				strategyId: 1,
				strategyName: "news_sentiment_mr_v1",
				trades: [
					{
						symbol: "AAPL",
						side: "BUY",
						pnl: 50,
						holdDays: 2,
						signalType: "entry_long",
						patternTags: ["stop_too_tight"],
					},
					{
						symbol: "AAPL",
						side: "BUY",
						pnl: -20,
						holdDays: 1,
						signalType: "entry_long",
						patternTags: ["stop_too_tight"],
					},
				],
			},
		]);

		expect(prompt).toContain("news_sentiment_mr_v1");
		expect(prompt).toContain("AAPL");
		expect(prompt).toContain("stop_too_tight");
	});

	test("parsePatternAnalysisResponse extracts valid observations", async () => {
		const { parsePatternAnalysisResponse } = await import("../../src/learning/pattern-analysis.ts");

		const json = JSON.stringify([
			{
				strategy_id: 1,
				pattern_type: "recurring_failure",
				observation: "Stop losses triggering too early on post-earnings moves",
				affected_symbols: ["AAPL", "MSFT"],
				tags: ["stop_too_tight", "earnings_drift"],
				suggested_action: {
					parameter: "trailing_stop_multiplier",
					direction: "increase",
					reasoning: "ATR-based stops too tight for earnings volatility",
				},
				confidence: 0.8,
			},
		]);

		const result = parsePatternAnalysisResponse(json);
		expect(result).toHaveLength(1);
		expect(result[0]!.strategyId).toBe(1);
		expect(result[0]!.patternType).toBe("recurring_failure");
		expect(result[0]!.tags).toContain("stop_too_tight");
		expect(result[0]!.suggestedAction).not.toBeNull();
	});

	test("parsePatternAnalysisResponse returns empty array for invalid JSON", async () => {
		const { parsePatternAnalysisResponse } = await import("../../src/learning/pattern-analysis.ts");

		expect(parsePatternAnalysisResponse("not json")).toEqual([]);
		expect(parsePatternAnalysisResponse("{}")).toEqual([]);
	});
});

describe("checkFeedbackPromotions", () => {
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

	function insertMissed(symbol: string, confidence: number, ageDays = 1) {
		getDb()
			.insert(tradeInsights)
			.values({
				strategyId: null,
				insightType: "missed_opportunity",
				observation: `${symbol} moved +5%`,
				tags: JSON.stringify(["missed_opportunity", "earnings_beat", symbol]),
				confidence,
				createdAt: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
			})
			.run();
	}

	test("3+ insights with confidence>=0.8 in 14d promotes with reason=feedback", async () => {
		insertMissed("AAPL", 0.85);
		insertMissed("AAPL", 0.9);
		insertMissed("AAPL", 0.82);
		const result = await checkFeedbackPromotions();
		expect(result.promoted).toBe(1);

		const rows = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).all();
		expect(rows.length).toBe(1);
		expect(rows[0]?.promotionReasons).toBe("feedback");

		const events = getDb()
			.select()
			.from(catalystEvents)
			.where(eq(catalystEvents.symbol, "AAPL"))
			.all();
		expect(events.length).toBe(1);
		expect(events[0]?.eventType).toBe("feedback");
		expect(events[0]?.ledToPromotion).toBe(true);
	});

	test("2 insights (below threshold) does not promote", async () => {
		insertMissed("AAPL", 0.85);
		insertMissed("AAPL", 0.9);
		const result = await checkFeedbackPromotions();
		expect(result.promoted).toBe(0);
		expect(getDb().select().from(watchlist).all().length).toBe(0);
	});

	test("3 insights with one below confidence threshold does not promote", async () => {
		insertMissed("AAPL", 0.85);
		insertMissed("AAPL", 0.9);
		insertMissed("AAPL", 0.7); // Below 0.8 — won't count
		const result = await checkFeedbackPromotions();
		expect(result.promoted).toBe(0);
	});

	test("insights outside 14d window are ignored", async () => {
		insertMissed("AAPL", 0.85, 20);
		insertMissed("AAPL", 0.9, 20);
		insertMissed("AAPL", 0.85, 20);
		const result = await checkFeedbackPromotions();
		expect(result.promoted).toBe(0);
	});
});
