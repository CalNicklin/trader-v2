import { describe, expect, test } from "bun:test";

describe("graduation review", () => {
	test("buildGraduationPrompt includes metrics and trades", async () => {
		const { buildGraduationPrompt } = await import("../../src/learning/graduation-review.ts");

		const prompt = buildGraduationPrompt({
			strategyId: 1,
			strategyName: "news_sentiment_mr_v1",
			metrics: {
				sampleSize: 35,
				winRate: 0.6,
				expectancy: 25.0,
				profitFactor: 1.8,
				sharpeRatio: 0.8,
				maxDrawdownPct: 0.1,
				consistencyScore: 3,
			},
			recentTrades: [
				{ symbol: "AAPL", side: "BUY", pnl: 50, createdAt: "2026-04-01" },
				{ symbol: "MSFT", side: "SELL", pnl: -20, createdAt: "2026-04-02" },
			],
			patternInsights: ["stop_too_tight appears 5 times", "strong in low-VIX"],
		});

		expect(prompt).toContain("news_sentiment_mr_v1");
		expect(prompt).toContain("35");
		expect(prompt).toContain("0.8"); // sharpe
		expect(prompt).toContain("stop_too_tight");
	});

	test("parseGraduationResponse extracts valid result", async () => {
		const { parseGraduationResponse } = await import("../../src/learning/graduation-review.ts");

		const json = JSON.stringify({
			recommendation: "graduate",
			confidence: 0.8,
			reasoning: "Edge appears real, distributed across symbols",
			risk_flags: ["stop_distance_may_need_widening"],
			suggested_conditions: "Monitor first 10 live trades for slippage",
		});

		const result = parseGraduationResponse(json);
		expect(result).not.toBeNull();
		expect(result!.recommendation).toBe("graduate");
		expect(result!.confidence).toBeCloseTo(0.8);
		expect(result!.riskFlags).toContain("stop_distance_may_need_widening");
	});

	test("parseGraduationResponse returns null for invalid recommendation", async () => {
		const { parseGraduationResponse } = await import("../../src/learning/graduation-review.ts");

		const json = JSON.stringify({
			recommendation: "maybe",
			confidence: 0.5,
			reasoning: "Not sure",
			risk_flags: [],
			suggested_conditions: "",
		});

		expect(parseGraduationResponse(json)).toBeNull();
	});
});
