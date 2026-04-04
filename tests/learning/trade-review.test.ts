import { describe, expect, test } from "bun:test";

describe("trade review", () => {
	test("buildTradeReviewPrompt includes trade details", async () => {
		const { buildTradeReviewPrompt } = await import("../../src/learning/trade-review.ts");

		const prompt = buildTradeReviewPrompt({
			tradeId: 1,
			strategyId: 1,
			strategyName: "news_sentiment_mr_v1",
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			quantity: 10,
			entryPrice: 150.0,
			exitPrice: 155.0,
			pnl: 49.5,
			friction: 0.5,
			holdDays: 2,
			signalType: "entry_long",
			reasoning: "Entry signal: news_sentiment > 0.7 AND rsi14 < 30",
			newsContextAtEntry: "Apple beats Q4 earnings estimates, raises guidance",
		});

		expect(prompt).toContain("AAPL");
		expect(prompt).toContain("150");
		expect(prompt).toContain("155");
		expect(prompt).toContain("49.5");
		expect(prompt).toContain("news_sentiment_mr_v1");
		expect(prompt).toContain("Apple beats Q4 earnings");
	});

	test("parseTradeReviewResponse extracts valid result", async () => {
		const { parseTradeReviewResponse } = await import("../../src/learning/trade-review.ts");

		const json = JSON.stringify({
			outcome_quality: "good_entry_early_exit",
			what_worked: "Sentiment signal correctly identified earnings direction",
			what_failed: "Exit triggered before full drift played out",
			pattern_tags: ["earnings_drift_truncated"],
			suggested_parameter_adjustment: {
				parameter: "hold_days",
				direction: "increase",
				reasoning: "Post-earnings drift typically extends 3-5 days",
			},
			market_context: "Low volatility, trending market",
			confidence: 0.75,
		});

		const result = parseTradeReviewResponse(json, 1);
		expect(result).not.toBeNull();
		expect(result!.tradeId).toBe(1);
		expect(result!.outcomeQuality).toBe("good_entry_early_exit");
		expect(result!.patternTags).toEqual(["earnings_drift_truncated"]);
		expect(result!.suggestedParameterAdjustment).not.toBeNull();
		expect(result!.suggestedParameterAdjustment!.direction).toBe("increase");
		expect(result!.confidence).toBeCloseTo(0.75);
	});

	test("parseTradeReviewResponse returns null for invalid JSON", async () => {
		const { parseTradeReviewResponse } = await import("../../src/learning/trade-review.ts");

		expect(parseTradeReviewResponse("not json", 1)).toBeNull();
		expect(parseTradeReviewResponse("{}", 1)).toBeNull();
	});

	test("parseTradeReviewResponse handles missing optional fields", async () => {
		const { parseTradeReviewResponse } = await import("../../src/learning/trade-review.ts");

		const json = JSON.stringify({
			outcome_quality: "clean_profit",
			what_worked: "Everything worked as expected",
			what_failed: "nothing",
			pattern_tags: [],
			suggested_parameter_adjustment: null,
			market_context: "Normal conditions",
			confidence: 0.9,
		});

		const result = parseTradeReviewResponse(json, 5);
		expect(result).not.toBeNull();
		expect(result!.suggestedParameterAdjustment).toBeNull();
		expect(result!.patternTags).toEqual([]);
	});
});
