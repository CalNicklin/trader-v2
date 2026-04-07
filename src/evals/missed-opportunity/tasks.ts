// src/evals/missed-opportunity/tasks.ts
import type { EvalTask } from "../types.ts";

export interface TrackerInput {
	analyses: Array<{
		symbol: string;
		exchange: string;
		direction: "long" | "short" | "avoid";
		priceAtAnalysis: number | null;
		inUniverse: boolean;
		confidence: number;
		eventType: string;
		tradeThesis: string;
	}>;
	currentPrices: Record<string, number>;
}

export interface TrackerReference {
	expectedMissedSymbols: string[];
	expectedNotMissedSymbols: string[];
}

export const trackerTasks: EvalTask<TrackerInput, TrackerReference>[] = [
	{
		id: "mot-001",
		name: "Clear missed opportunity — long prediction, >2% up",
		input: {
			analyses: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					direction: "long",
					priceAtAnalysis: 100,
					inUniverse: false,
					confidence: 0.7,
					eventType: "contract_win",
					tradeThesis: "Major deal",
				},
			],
			currentPrices: { AVGO: 105 },
		},
		reference: { expectedMissedSymbols: ["AVGO"], expectedNotMissedSymbols: [] },
		tags: ["true-miss", "long"],
	},
	{
		id: "mot-002",
		name: "Clear missed opportunity — short prediction, >2% down",
		input: {
			analyses: [
				{
					symbol: "BAD",
					exchange: "NYSE",
					direction: "short",
					priceAtAnalysis: 50,
					inUniverse: false,
					confidence: 0.75,
					eventType: "profit_warning",
					tradeThesis: "Profit warning",
				},
			],
			currentPrices: { BAD: 47 },
		},
		reference: { expectedMissedSymbols: ["BAD"], expectedNotMissedSymbols: [] },
		tags: ["true-miss", "short"],
	},
	{
		id: "mot-003",
		name: "Near miss — <2% move, should NOT log",
		input: {
			analyses: [
				{
					symbol: "MSFT",
					exchange: "NASDAQ",
					direction: "long",
					priceAtAnalysis: 400,
					inUniverse: false,
					confidence: 0.6,
					eventType: "partnership",
					tradeThesis: "Minor deal",
				},
			],
			currentPrices: { MSFT: 404 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["MSFT"] },
		tags: ["near-miss", "below-threshold"],
	},
	{
		id: "mot-004",
		name: "Wrong direction — long predicted but price went down",
		input: {
			analyses: [
				{
					symbol: "FAIL",
					exchange: "NASDAQ",
					direction: "long",
					priceAtAnalysis: 100,
					inUniverse: false,
					confidence: 0.8,
					eventType: "partnership",
					tradeThesis: "Expected up",
				},
			],
			currentPrices: { FAIL: 95 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["FAIL"] },
		tags: ["wrong-direction"],
	},
	{
		id: "mot-005",
		name: "In universe — should NOT log even with >2% move",
		input: {
			analyses: [
				{
					symbol: "AAPL",
					exchange: "NASDAQ",
					direction: "long",
					priceAtAnalysis: 150,
					inUniverse: true,
					confidence: 0.9,
					eventType: "earnings_beat",
					tradeThesis: "Strong earnings",
				},
			],
			currentPrices: { AAPL: 160 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["AAPL"] },
		tags: ["in-universe", "should-not-log"],
	},
	{
		id: "mot-006",
		name: "Null priceAtAnalysis — should be skipped entirely",
		input: {
			analyses: [
				{
					symbol: "NEW",
					exchange: "NASDAQ",
					direction: "long",
					priceAtAnalysis: null,
					inUniverse: false,
					confidence: 0.6,
					eventType: "contract_win",
					tradeThesis: "New symbol",
				},
			],
			currentPrices: { NEW: 200 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["NEW"] },
		tags: ["null-price", "skip"],
	},
	{
		id: "mot-007",
		name: "Avoid direction — should NOT log regardless of move",
		input: {
			analyses: [
				{
					symbol: "AVOID",
					exchange: "NYSE",
					direction: "avoid",
					priceAtAnalysis: 100,
					inUniverse: false,
					confidence: 0.3,
					eventType: "other",
					tradeThesis: "Unclear",
				},
			],
			currentPrices: { AVOID: 110 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["AVOID"] },
		tags: ["avoid-direction"],
	},
	{
		id: "mot-008",
		name: "Multiple symbols — mixed outcomes",
		input: {
			analyses: [
				{
					symbol: "WIN",
					exchange: "NASDAQ",
					direction: "long",
					priceAtAnalysis: 100,
					inUniverse: false,
					confidence: 0.8,
					eventType: "earnings_beat",
					tradeThesis: "Beat earnings",
				},
				{
					symbol: "LOSE",
					exchange: "NASDAQ",
					direction: "long",
					priceAtAnalysis: 100,
					inUniverse: false,
					confidence: 0.5,
					eventType: "partnership",
					tradeThesis: "Minor",
				},
				{
					symbol: "INUNI",
					exchange: "NASDAQ",
					direction: "long",
					priceAtAnalysis: 100,
					inUniverse: true,
					confidence: 0.9,
					eventType: "earnings_beat",
					tradeThesis: "Already tracked",
				},
			],
			currentPrices: { WIN: 106, LOSE: 98, INUNI: 110 },
		},
		reference: {
			expectedMissedSymbols: ["WIN"],
			expectedNotMissedSymbols: ["LOSE", "INUNI"],
		},
		tags: ["multi-symbol", "mixed"],
	},
];
