import type { EvalTask } from "../types.ts";

export interface PipelineInput {
	headline: string;
	symbol: string;
	exchange: string;
}

export interface PipelineReference {
	expectedOutcome: "filtered" | "classified" | "failed";
	expectedTradeable: boolean | null;
	sentimentMin: number;
	sentimentMax: number;
}

export interface PipelineOutput {
	pipelineResult: "duplicate" | "filtered" | "classified" | "failed";
	sentiment: number | null;
	tradeable: boolean | null;
}

export const pipelineTasks: EvalTask<PipelineInput, PipelineReference>[] = [
	// === Should classify with positive sentiment ===
	{
		id: "pipe-001",
		name: "Earnings beat → classified positive",
		input: {
			headline: "Apple crushes Q4 estimates with record iPhone sales",
			symbol: "AAPL",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: 0.4,
			sentimentMax: 1.0,
		},
		tags: ["classify", "positive"],
	},
	{
		id: "pipe-002",
		name: "FDA approval → classified positive",
		input: {
			headline: "FDA grants full approval to AstraZeneca's lung cancer drug",
			symbol: "AZN.L",
			exchange: "LSE",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: 0.5,
			sentimentMax: 1.0,
		},
		tags: ["classify", "positive", "uk"],
	},
	{
		id: "pipe-003",
		name: "Acquisition → classified positive",
		input: {
			headline: "Broadcom completes $61B acquisition of VMware",
			symbol: "AVGO",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: 0.2,
			sentimentMax: 0.8,
		},
		tags: ["classify", "positive"],
	},

	// === Should classify with negative sentiment ===
	{
		id: "pipe-004",
		name: "Profit warning → classified negative",
		input: {
			headline: "Burberry issues profit warning as luxury demand collapses",
			symbol: "BRBY.L",
			exchange: "LSE",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: -1.0,
			sentimentMax: -0.3,
		},
		tags: ["classify", "negative", "uk"],
	},
	{
		id: "pipe-005",
		name: "Earnings miss → classified negative",
		input: {
			headline: "Snap misses revenue estimates badly, shares plunge 25%",
			symbol: "SNAP",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: -1.0,
			sentimentMax: -0.4,
		},
		tags: ["classify", "negative"],
	},
	{
		id: "pipe-006",
		name: "Legal action → classified negative",
		input: {
			headline: "SEC charges Tesla with misleading investors on Autopilot safety",
			symbol: "TSLA",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: -0.9,
			sentimentMax: -0.2,
		},
		tags: ["classify", "negative"],
	},

	// === Should be filtered (blocked by pre-filter) ===
	{
		id: "pipe-007",
		name: "Analyst reiterate → filtered",
		input: {
			headline: "Analyst reiterates Outperform rating on Microsoft",
			symbol: "MSFT",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "filtered",
			expectedTradeable: null,
			sentimentMin: -1,
			sentimentMax: 1,
		},
		tags: ["filter"],
	},
	{
		id: "pipe-008",
		name: "Board appointment → filtered",
		input: {
			headline: "New board member appointed at Barclays",
			symbol: "BARC.L",
			exchange: "LSE",
		},
		reference: {
			expectedOutcome: "filtered",
			expectedTradeable: null,
			sentimentMin: -1,
			sentimentMax: 1,
		},
		tags: ["filter"],
	},
	{
		id: "pipe-009",
		name: "ESG report → filtered",
		input: {
			headline: "Annual ESG report shows improved carbon emissions",
			symbol: "BP.L",
			exchange: "LSE",
		},
		reference: {
			expectedOutcome: "filtered",
			expectedTradeable: null,
			sentimentMin: -1,
			sentimentMax: 1,
		},
		tags: ["filter"],
	},
	{
		id: "pipe-010",
		name: "Routine filing → filtered",
		input: {
			headline: "Routine filing submitted to SEC for Q3",
			symbol: "AAPL",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "filtered",
			expectedTradeable: null,
			sentimentMin: -1,
			sentimentMax: 1,
		},
		tags: ["filter"],
	},

	// === Neutral / non-tradeable but should still classify ===
	{
		id: "pipe-011",
		name: "Conference attendance → classified non-tradeable",
		input: {
			headline: "Google CEO to keynote at CES technology conference",
			symbol: "GOOGL",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: false,
			sentimentMin: -0.2,
			sentimentMax: 0.3,
		},
		tags: ["classify", "neutral"],
	},
	{
		id: "pipe-012",
		name: "Minor product update → classified non-tradeable",
		input: {
			headline: "Amazon adds new color options for Kindle Paperwhite",
			symbol: "AMZN",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: false,
			sentimentMin: -0.1,
			sentimentMax: 0.2,
		},
		tags: ["classify", "neutral"],
	},

	// === Ambiguous headlines that should classify ===
	{
		id: "pipe-013",
		name: "Breaking halted trading → classified",
		input: {
			headline: "BREAKING: Trading halted on ARM Holdings pending announcement",
			symbol: "ARM",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: -0.5,
			sentimentMax: 0.5,
		},
		tags: ["classify", "ambiguous"],
	},
	{
		id: "pipe-014",
		name: "Unrelated Apple headline → classified non-tradeable",
		input: {
			headline: "New apple variety developed by University of Minnesota researchers",
			symbol: "AAPL",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: false,
			sentimentMin: -0.1,
			sentimentMax: 0.1,
		},
		tags: ["classify", "edge"],
	},

	// === Mixed signal headlines ===
	{
		id: "pipe-015",
		name: "Beat EPS but miss revenue",
		input: {
			headline: "Uber beats earnings but ride volumes disappoint analysts",
			symbol: "UBER",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: -0.4,
			sentimentMax: 0.2,
		},
		tags: ["classify", "ambiguous"],
	},
	{
		id: "pipe-016",
		name: "Layoffs framed as efficiency",
		input: {
			headline: "Meta to cut 11,000 jobs as Zuckerberg promises 'year of efficiency'",
			symbol: "META",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: -0.5,
			sentimentMax: 0.2,
		},
		tags: ["classify", "ambiguous"],
	},

	// === UK AIM market ===
	{
		id: "pipe-017",
		name: "AIM company RNS",
		input: {
			headline: "Fevertree Drinks reports 30% revenue decline in UK market",
			symbol: "FEVR.L",
			exchange: "AIM",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: -0.9,
			sentimentMax: -0.2,
		},
		tags: ["classify", "negative", "uk"],
	},

	// === Cost control ===
	{
		id: "pipe-018",
		name: "Filtered headline should NOT call Haiku",
		input: { headline: "Routine filing submitted to SEC", symbol: "MSFT", exchange: "NASDAQ" },
		reference: {
			expectedOutcome: "filtered",
			expectedTradeable: null,
			sentimentMin: -1,
			sentimentMax: 1,
		},
		tags: ["filter", "cost"],
	},

	// === Multiple symbols ===
	{
		id: "pipe-019",
		name: "Merger affects both parties",
		input: {
			headline: "Disney announces merger with Fox entertainment division",
			symbol: "DIS",
			exchange: "NASDAQ",
		},
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: 0.1,
			sentimentMax: 0.8,
		},
		tags: ["classify", "positive"],
	},

	// === Very short headline ===
	{
		id: "pipe-020",
		name: "Minimal headline",
		input: { headline: "TSLA stock crashes", symbol: "TSLA", exchange: "NASDAQ" },
		reference: {
			expectedOutcome: "classified",
			expectedTradeable: true,
			sentimentMin: -1.0,
			sentimentMax: -0.3,
		},
		tags: ["classify", "negative", "edge"],
	},
];
