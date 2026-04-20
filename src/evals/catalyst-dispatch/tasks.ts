import type { StrategyPerformance } from "../../evolution/types.ts";
import type { CatalystNews } from "../../strategy/catalyst-prompt.ts";
import type { EvalTask } from "../types.ts";

export interface CatalystDispatchInput {
	symbol: string;
	strategies: StrategyPerformance[];
	news: CatalystNews;
}

export interface CatalystDispatchReference {
	expectActivated: number[];
	expectSkipped: number[];
	rubric: string;
}

function momentumStrategy(id: number, name = "trend_momentum"): StrategyPerformance {
	return {
		id,
		name,
		status: "active",
		generation: 2,
		parentStrategyId: null,
		createdBy: "evolution",
		parameters: {},
		signals: {
			entry_long: "newsSentiment > 0.5 && rsi14 > 50",
			entry_short: "newsSentiment < -0.5 && rsi14 < 50",
			exit: "pnl_pct > 0.04 || pnl_pct < -0.02",
		},
		universe: ["AAPL:NASDAQ", "MSFT:NASDAQ", "NVDA:NASDAQ"],
		metrics: {
			sampleSize: 60,
			winRate: 0.58,
			expectancy: 0.03,
			profitFactor: 1.6,
			sharpeRatio: 1.3,
			sortinoRatio: 1.6,
			maxDrawdownPct: 0.07,
			calmarRatio: 1.0,
			consistencyScore: 0.72,
		},
		recentTrades: [],
		virtualBalance: 12000,
		insightSummary: [],
		suggestedActions: [],
	};
}

function meanReversionStrategy(id: number, name = "mean_reverter"): StrategyPerformance {
	return {
		...momentumStrategy(id, name),
		signals: {
			entry_long: "rsi14 < 30",
			entry_short: "rsi14 > 70",
			exit: "pnl_pct > 0.02 || pnl_pct < -0.01",
		},
	};
}

export const catalystDispatchTasks: EvalTask<CatalystDispatchInput, CatalystDispatchReference>[] = [
	{
		id: "cat-001",
		name: "Earnings beat activates momentum",
		input: {
			symbol: "AAPL",
			strategies: [momentumStrategy(1)],
			news: {
				headline: "Apple smashes Q4 earnings, raises guidance",
				sentiment: 0.85,
				urgency: "high",
				eventType: "earnings_beat",
			},
		},
		reference: {
			expectActivated: [1],
			expectSkipped: [],
			rubric:
				"Strong positive earnings beat with guidance raise is a high-quality momentum catalyst; the momentum strategy should activate.",
		},
		tags: ["earnings", "positive"],
	},
	{
		id: "cat-002",
		name: "Profit warning activates momentum short side",
		input: {
			symbol: "MSFT",
			strategies: [momentumStrategy(2)],
			news: {
				headline: "Microsoft issues profit warning, cuts FY guidance 25%",
				sentiment: -0.85,
				urgency: "high",
				eventType: "profit_warning",
			},
		},
		reference: {
			expectActivated: [2],
			expectSkipped: [],
			rubric:
				"A sharp negative guidance cut is a high-quality short-side momentum catalyst; a momentum strategy with entry_short coverage should activate.",
		},
		tags: ["profit_warning", "negative"],
	},
	{
		id: "cat-003",
		name: "Regulatory win on momentum activates",
		input: {
			symbol: "NVDA",
			strategies: [momentumStrategy(3)],
			news: {
				headline: "NVIDIA wins export license for H200 to mainland China",
				sentiment: 0.7,
				urgency: "high",
				eventType: "regulatory_win",
			},
		},
		reference: {
			expectActivated: [3],
			expectSkipped: [],
			rubric:
				"Regulatory approval removing a material overhang drives catalyst moves; momentum should activate.",
		},
		tags: ["regulatory", "positive"],
	},
	{
		id: "cat-004",
		name: "Profit warning on mean-reverter skips",
		input: {
			symbol: "AAPL",
			strategies: [meanReversionStrategy(4)],
			news: {
				headline: "Apple issues profit warning, margin compression in China",
				sentiment: -0.8,
				urgency: "high",
				eventType: "profit_warning",
			},
		},
		reference: {
			expectActivated: [],
			expectSkipped: [4],
			rubric:
				"Mean-reversion strategies fade extremes. A sharp negative catalyst is likely to trend not mean-revert. A disciplined dispatcher should skip to avoid knife-catching.",
		},
		tags: ["profit_warning", "mean_revert"],
	},
	{
		id: "cat-005",
		name: "Trading halt skips all",
		input: {
			symbol: "AAPL",
			strategies: [momentumStrategy(5), meanReversionStrategy(6)],
			news: {
				headline: "Apple trading halted pending news release",
				sentiment: 0,
				urgency: "high",
				eventType: "halt",
			},
		},
		reference: {
			expectActivated: [],
			expectSkipped: [5, 6],
			rubric: "A halt means the venue is not accepting orders. All strategies should skip.",
		},
		tags: ["halt"],
	},
	{
		id: "cat-006",
		name: "Acquisition target activates",
		input: {
			symbol: "NVDA",
			strategies: [momentumStrategy(7)],
			news: {
				headline: "NVIDIA receives preliminary takeover bid — board reviewing",
				sentiment: 0.7,
				urgency: "high",
				eventType: "acquisition",
			},
		},
		reference: {
			expectActivated: [7],
			expectSkipped: [],
			rubric: "Acquisition headlines typically drive sharp gap moves; momentum should engage.",
		},
		tags: ["acquisition", "positive"],
	},
	{
		id: "cat-007",
		name: "Major antitrust action activates momentum",
		input: {
			symbol: "MSFT",
			strategies: [momentumStrategy(8)],
			news: {
				headline: "DOJ files antitrust lawsuit against Microsoft, seeks structural remedies",
				sentiment: -0.75,
				urgency: "high",
				eventType: "legal",
			},
		},
		reference: {
			expectActivated: [8],
			expectSkipped: [],
			rubric:
				"A serious antitrust action drives sustained negative moves; momentum should activate.",
		},
		tags: ["legal", "negative"],
	},
	{
		id: "cat-008",
		name: "Ambiguous vague headline — skip",
		input: {
			symbol: "AAPL",
			strategies: [momentumStrategy(9)],
			news: {
				headline: "Apple comments on consumer conditions — no specifics given",
				sentiment: 0,
				urgency: "high",
				eventType: "other",
			},
		},
		reference: {
			expectActivated: [],
			expectSkipped: [9],
			rubric:
				"A vague headline with zero sentiment and no concrete event is false-positive urgency. A disciplined dispatcher should skip.",
		},
		tags: ["vague", "noise"],
	},
	{
		id: "cat-009",
		name: "Mixed strategies — momentum activates, mean-reverter skips",
		input: {
			symbol: "NVDA",
			strategies: [momentumStrategy(10), meanReversionStrategy(11)],
			news: {
				headline: "NVIDIA blows past Q3 estimates, raises FY guidance 30%",
				sentiment: 0.9,
				urgency: "high",
				eventType: "earnings_beat",
			},
		},
		reference: {
			expectActivated: [10],
			expectSkipped: [11],
			rubric:
				"Strong earnings beat favours momentum and hurts mean-reversion. Dispatcher should selectively activate.",
		},
		tags: ["earnings", "mixed"],
	},
	{
		id: "cat-010",
		name: "Macro crash activates momentum short",
		input: {
			symbol: "AAPL",
			strategies: [momentumStrategy(12)],
			news: {
				headline: "Bitcoin falls 25% overnight on exchange insolvency — tech gap down",
				sentiment: -0.7,
				urgency: "high",
				eventType: "macro",
			},
		},
		reference: {
			expectActivated: [12],
			expectSkipped: [],
			rubric:
				"Macro-correlated crashes create sustained intraday pressure; momentum should engage the short side.",
		},
		tags: ["macro", "negative"],
	},
];
