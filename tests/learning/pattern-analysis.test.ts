import { describe, expect, test } from "bun:test";

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
