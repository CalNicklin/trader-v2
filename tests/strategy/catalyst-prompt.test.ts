import { describe, expect, test } from "bun:test";
import type { StrategyPerformance } from "../../src/evolution/types.ts";
import { buildCatalystPrompt } from "../../src/strategy/catalyst-prompt.ts";

const baseStrategy: StrategyPerformance = {
	id: 42,
	name: "trend_follower",
	status: "active",
	generation: 3,
	parentStrategyId: null,
	createdBy: "evolution",
	parameters: { threshold: 0.5 },
	signals: { entry_long: "rsi14<30", entry_short: "rsi14>70", exit: "pnl_pct>0.05" },
	universe: ["XYZ:NASDAQ", "ABC:NASDAQ"],
	metrics: {
		sampleSize: 50,
		winRate: 0.55,
		expectancy: 0.02,
		profitFactor: 1.4,
		sharpeRatio: 1.2,
		sortinoRatio: 1.5,
		maxDrawdownPct: 0.08,
		calmarRatio: 0.9,
		consistencyScore: 0.7,
	},
	recentTrades: [],
	virtualBalance: 10000,
	insightSummary: [],
	suggestedActions: [],
};

const news = {
	headline: "XYZ Corp profit warning: cuts FY guidance 20%",
	sentiment: -0.8,
	urgency: "high" as const,
	eventType: "profit_warning",
};

describe("buildCatalystPrompt", () => {
	test("prompt includes symbol, news, and strategy details", () => {
		const prompt = buildCatalystPrompt("XYZ", [baseStrategy], news);
		expect(prompt).toContain("XYZ");
		expect(prompt).toContain("profit warning");
		expect(prompt).toContain("trend_follower");
		expect(prompt).toContain("rsi14<30");
	});

	test("prompt asks for JSON output with decisions array scoped to this symbol", () => {
		const prompt = buildCatalystPrompt("XYZ", [baseStrategy], news);
		expect(prompt.toLowerCase()).toContain("json");
		expect(prompt).toContain('"decisions"');
	});

	test("prompt includes multiple strategies when passed", () => {
		const other: StrategyPerformance = { ...baseStrategy, id: 99, name: "mean_reverter" };
		const prompt = buildCatalystPrompt("XYZ", [baseStrategy, other], news);
		expect(prompt).toContain("trend_follower");
		expect(prompt).toContain("mean_reverter");
	});

	test("prompt notes catalyst urgency clearly", () => {
		const prompt = buildCatalystPrompt("XYZ", [baseStrategy], news);
		expect(prompt.toLowerCase()).toContain("high");
		expect(prompt.toLowerCase()).toContain("catalyst");
	});

	test("prompt flags whether symbol is in each strategy's universe", () => {
		const inUniverse: StrategyPerformance = { ...baseStrategy, universe: ["XYZ:NASDAQ"] };
		const notInUniverse: StrategyPerformance = {
			...baseStrategy,
			id: 7,
			name: "other",
			universe: ["AAPL:NASDAQ"],
		};
		const prompt = buildCatalystPrompt("XYZ", [inUniverse, notInUniverse], news);
		expect(prompt).toContain("YES");
		expect(prompt).toContain("NO");
	});

	test("prompt handles strategies with null metrics gracefully", () => {
		const noMetrics: StrategyPerformance = { ...baseStrategy, metrics: null };
		const prompt = buildCatalystPrompt("XYZ", [noMetrics], news);
		expect(prompt).toContain("No metrics yet");
	});
});
