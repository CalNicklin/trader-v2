import type { EvalTask } from "../types.ts";

export interface ClassifierInput {
	headline: string;
	symbol: string;
}

export interface ClassifierReference {
	tradeable: boolean;
	sentimentDirection: "positive" | "negative" | "neutral";
	sentimentMin: number;
	sentimentMax: number;
	expectedEventTypes: string[];
	expectedUrgency: "low" | "medium" | "high";
}

export const classifierTasks: EvalTask<ClassifierInput, ClassifierReference>[] = [
	// === POSITIVE TRADEABLE (should trigger trades) ===
	{
		id: "cls-001",
		name: "Clear earnings beat",
		input: {
			headline: "Apple beats Q4 earnings estimates with record $124B revenue",
			symbol: "AAPL",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.5,
			sentimentMax: 1.0,
			expectedEventTypes: ["earnings_beat"],
			expectedUrgency: "high",
		},
		tags: ["positive", "earnings"],
	},
	{
		id: "cls-002",
		name: "FDA approval",
		input: {
			headline: "FDA approves Pfizer's breakthrough cancer immunotherapy drug",
			symbol: "PFE",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.6,
			sentimentMax: 1.0,
			expectedEventTypes: ["fda_approval"],
			expectedUrgency: "high",
		},
		tags: ["positive", "fda"],
	},
	{
		id: "cls-003",
		name: "Major acquisition",
		input: { headline: "Microsoft to acquire gaming studio Activision for $69B", symbol: "MSFT" },
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.2,
			sentimentMax: 0.8,
			expectedEventTypes: ["acquisition"],
			expectedUrgency: "high",
		},
		tags: ["positive", "acquisition"],
	},
	{
		id: "cls-004",
		name: "Buyback announcement",
		input: { headline: "Alphabet announces $70B stock buyback program", symbol: "GOOGL" },
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.3,
			sentimentMax: 0.8,
			expectedEventTypes: ["buyback"],
			expectedUrgency: "medium",
		},
		tags: ["positive", "buyback"],
	},
	{
		id: "cls-005",
		name: "Guidance raise",
		input: {
			headline: "NVIDIA raises full-year guidance citing explosive AI chip demand",
			symbol: "NVDA",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.5,
			sentimentMax: 1.0,
			expectedEventTypes: ["guidance_raise"],
			expectedUrgency: "high",
		},
		tags: ["positive", "guidance"],
	},
	{
		id: "cls-006",
		name: "Dividend increase",
		input: {
			headline: "JPMorgan raises quarterly dividend by 15% to $1.15 per share",
			symbol: "JPM",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.2,
			sentimentMax: 0.6,
			expectedEventTypes: ["dividend"],
			expectedUrgency: "low",
		},
		tags: ["positive", "dividend"],
	},
	{
		id: "cls-007",
		name: "Analyst upgrade",
		input: {
			headline: "Goldman Sachs upgrades Tesla to Buy with $300 price target",
			symbol: "TSLA",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.3,
			sentimentMax: 0.7,
			expectedEventTypes: ["upgrade"],
			expectedUrgency: "medium",
		},
		tags: ["positive", "upgrade"],
	},

	// === NEGATIVE TRADEABLE (should trigger short/exit) ===
	{
		id: "cls-008",
		name: "Clear earnings miss",
		input: {
			headline: "Meta misses revenue estimates as ad spending slows sharply",
			symbol: "META",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -1.0,
			sentimentMax: -0.4,
			expectedEventTypes: ["earnings_miss"],
			expectedUrgency: "high",
		},
		tags: ["negative", "earnings"],
	},
	{
		id: "cls-009",
		name: "FDA rejection",
		input: {
			headline: "FDA rejects Moderna's RSV vaccine application citing safety concerns",
			symbol: "MRNA",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -1.0,
			sentimentMax: -0.5,
			expectedEventTypes: ["fda_rejection"],
			expectedUrgency: "high",
		},
		tags: ["negative", "fda"],
	},
	{
		id: "cls-010",
		name: "Profit warning",
		input: { headline: "BP issues profit warning as oil prices tumble below $60", symbol: "BP.L" },
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -1.0,
			sentimentMax: -0.4,
			expectedEventTypes: ["profit_warning"],
			expectedUrgency: "high",
		},
		tags: ["negative", "warning"],
	},
	{
		id: "cls-011",
		name: "Guidance cut",
		input: {
			headline: "Amazon slashes Q3 guidance citing weakening consumer spending",
			symbol: "AMZN",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -1.0,
			sentimentMax: -0.4,
			expectedEventTypes: ["guidance_lower"],
			expectedUrgency: "high",
		},
		tags: ["negative", "guidance"],
	},
	{
		id: "cls-012",
		name: "Analyst downgrade",
		input: {
			headline: "Morgan Stanley downgrades Intel to Underweight on foundry delays",
			symbol: "INTC",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.7,
			sentimentMax: -0.2,
			expectedEventTypes: ["downgrade"],
			expectedUrgency: "medium",
		},
		tags: ["negative", "downgrade"],
	},
	{
		id: "cls-013",
		name: "Major legal action",
		input: { headline: "DOJ files antitrust lawsuit seeking to break up Google", symbol: "GOOGL" },
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.8,
			sentimentMax: -0.2,
			expectedEventTypes: ["legal"],
			expectedUrgency: "high",
		},
		tags: ["negative", "legal"],
	},
	{
		id: "cls-014",
		name: "Restructuring/layoffs",
		input: { headline: "Cisco announces 10,000 job cuts in major restructuring", symbol: "CSCO" },
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.6,
			sentimentMax: -0.1,
			expectedEventTypes: ["restructuring"],
			expectedUrgency: "medium",
		},
		tags: ["negative", "restructuring"],
	},

	// === NEUTRAL / LOW-IMPACT (tradeable = false or marginal) ===
	{
		id: "cls-015",
		name: "Inline earnings",
		input: { headline: "Visa reports Q2 earnings broadly in line with estimates", symbol: "V" },
		reference: {
			tradeable: false,
			sentimentDirection: "neutral",
			sentimentMin: -0.2,
			sentimentMax: 0.2,
			expectedEventTypes: ["other"],
			expectedUrgency: "low",
		},
		tags: ["neutral", "earnings"],
	},
	{
		id: "cls-016",
		name: "Conference presentation",
		input: {
			headline: "Johnson & Johnson to present at JP Morgan Healthcare Conference",
			symbol: "JNJ",
		},
		reference: {
			tradeable: false,
			sentimentDirection: "neutral",
			sentimentMin: -0.1,
			sentimentMax: 0.2,
			expectedEventTypes: ["other"],
			expectedUrgency: "low",
		},
		tags: ["neutral", "routine"],
	},
	{
		id: "cls-017",
		name: "Minor partnership",
		input: { headline: "Rolls-Royce signs maintenance deal with regional airline", symbol: "RR.L" },
		reference: {
			tradeable: false,
			sentimentDirection: "neutral",
			sentimentMin: 0.0,
			sentimentMax: 0.3,
			expectedEventTypes: ["other"],
			expectedUrgency: "low",
		},
		tags: ["neutral", "partnership"],
	},
	{
		id: "cls-018",
		name: "Product launch (incremental)",
		input: {
			headline: "Samsung releases updated Galaxy A-series mid-range phone",
			symbol: "SSNLF",
		},
		reference: {
			tradeable: false,
			sentimentDirection: "neutral",
			sentimentMin: -0.1,
			sentimentMax: 0.3,
			expectedEventTypes: ["other"],
			expectedUrgency: "low",
		},
		tags: ["neutral", "product"],
	},

	// === AMBIGUOUS / TRICKY (test nuance) ===
	{
		id: "cls-019",
		name: "Merger target (acquiree perspective)",
		input: { headline: "Broadcom reportedly in advanced talks to acquire VMware", symbol: "VMW" },
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.4,
			sentimentMax: 1.0,
			expectedEventTypes: ["merger", "acquisition"],
			expectedUrgency: "high",
		},
		tags: ["ambiguous", "merger"],
	},
	{
		id: "cls-020",
		name: "Mixed earnings (beat EPS, miss revenue)",
		input: {
			headline: "Netflix beats EPS estimates but subscriber growth disappoints",
			symbol: "NFLX",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.5,
			sentimentMax: 0.1,
			expectedEventTypes: ["earnings_miss", "earnings_beat", "other"],
			expectedUrgency: "medium",
		},
		tags: ["ambiguous", "earnings"],
	},
	{
		id: "cls-021",
		name: "Geopolitical risk",
		input: {
			headline: "US threatens new tariffs on Chinese tech imports, TSMC exposed",
			symbol: "TSM",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.7,
			sentimentMax: -0.1,
			expectedEventTypes: ["other", "legal"],
			expectedUrgency: "medium",
		},
		tags: ["ambiguous", "geopolitical"],
	},
	{
		id: "cls-022",
		name: "CEO departure (could be positive or negative)",
		input: { headline: "Boeing CEO forced out by board amid safety crisis", symbol: "BA" },
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.6,
			sentimentMax: 0.1,
			expectedEventTypes: ["restructuring", "other"],
			expectedUrgency: "high",
		},
		tags: ["ambiguous", "leadership"],
	},
	{
		id: "cls-023",
		name: "Crypto exposure (indirect impact)",
		input: {
			headline: "Bitcoin crashes 20% — Coinbase and MicroStrategy shares plunge",
			symbol: "COIN",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.9,
			sentimentMax: -0.3,
			expectedEventTypes: ["other"],
			expectedUrgency: "high",
		},
		tags: ["ambiguous", "crypto"],
	},

	// === UK MARKET SPECIFIC ===
	{
		id: "cls-024",
		name: "UK profit warning (LSE)",
		input: { headline: "Aston Martin issues third profit warning this year", symbol: "AML.L" },
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.8,
			sentimentMax: -0.3,
			expectedEventTypes: ["profit_warning"],
			expectedUrgency: "high",
		},
		tags: ["negative", "uk"],
	},
	{
		id: "cls-025",
		name: "UK takeover bid",
		input: { headline: "BHP makes £31B takeover approach for Anglo American", symbol: "AAL.L" },
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.5,
			sentimentMax: 1.0,
			expectedEventTypes: ["acquisition", "merger"],
			expectedUrgency: "high",
		},
		tags: ["positive", "uk", "acquisition"],
	},

	// === EDGE CASES ===
	{
		id: "cls-026",
		name: "Very short headline",
		input: { headline: "AAPL earnings beat", symbol: "AAPL" },
		reference: {
			tradeable: true,
			sentimentDirection: "positive",
			sentimentMin: 0.3,
			sentimentMax: 1.0,
			expectedEventTypes: ["earnings_beat"],
			expectedUrgency: "medium",
		},
		tags: ["edge-case"],
	},
	{
		id: "cls-027",
		name: "Headline with numbers only",
		input: {
			headline: "Tesla Q3 deliveries: 435,059 vehicles vs 456,000 expected",
			symbol: "TSLA",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.6,
			sentimentMax: -0.1,
			expectedEventTypes: ["earnings_miss", "other"],
			expectedUrgency: "medium",
		},
		tags: ["edge-case"],
	},
	{
		id: "cls-028",
		name: "Duplicate ticker in unrelated news",
		input: {
			headline: "New study finds Apple cider vinegar may reduce cholesterol",
			symbol: "AAPL",
		},
		reference: {
			tradeable: false,
			sentimentDirection: "neutral",
			sentimentMin: -0.1,
			sentimentMax: 0.1,
			expectedEventTypes: ["other"],
			expectedUrgency: "low",
		},
		tags: ["edge-case", "noise"],
	},
	{
		id: "cls-029",
		name: "Sarcastic/misleading headline",
		input: {
			headline: "Amazon's 'record' quarter barely keeps pace with inflation",
			symbol: "AMZN",
		},
		reference: {
			tradeable: true,
			sentimentDirection: "negative",
			sentimentMin: -0.5,
			sentimentMax: 0.0,
			expectedEventTypes: ["earnings_miss", "other"],
			expectedUrgency: "medium",
		},
		tags: ["edge-case", "tone"],
	},
	{
		id: "cls-030",
		name: "Breaking news with no detail",
		input: { headline: "BREAKING: Trading halted on NVDA pending news", symbol: "NVDA" },
		reference: {
			tradeable: true,
			sentimentDirection: "neutral",
			sentimentMin: -0.3,
			sentimentMax: 0.3,
			expectedEventTypes: ["other"],
			expectedUrgency: "high",
		},
		tags: ["edge-case", "breaking"],
	},
];
