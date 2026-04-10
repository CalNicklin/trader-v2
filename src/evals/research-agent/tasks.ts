// src/evals/research-agent/tasks.ts

import type { ResearchInput } from "../../news/research-agent.ts";
import type { EvalTask } from "../types.ts";
import corpus from "./fixtures/lse-corpus.json" with { type: "json" };

export interface ResearchReference {
	minSymbols: number;
	expectedSymbols: string[];
	expectedDirections: Record<string, "long" | "short" | "avoid">;
	expectedSentimentRange: Record<string, [number, number]>;
	isMultiParty: boolean;
	// New fields (Phase 3 research-agent refactor)
	whitelist?: Array<{ symbol: string; exchange: string }>;
	primaryExchange?: string;
	/** Symbols that must appear in the output (LSE attribution preservation). */
	requiredSymbols?: string[];
	/** Symbols that must NOT appear (deprecated-ticker rejection). */
	forbiddenSymbols?: string[];
}

export const researchAgentTasks: EvalTask<ResearchInput, ResearchReference>[] = [
	{
		id: "ra-001",
		name: "Broadcom-Google partnership (secondary beneficiary)",
		input: {
			headline: "Broadcom and Google seal five-year AI chip partnership",
			source: "finnhub",
			symbols: ["GOOGL"],
			classification: {
				sentiment: 0.2,
				confidence: 0.7,
				tradeable: true,
				eventType: "partnership",
				urgency: "low",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["AVGO", "GOOGL"],
			expectedDirections: { AVGO: "long", GOOGL: "long" },
			expectedSentimentRange: { AVGO: [0.5, 1.0], GOOGL: [0.1, 0.5] },
			isMultiParty: true,
			whitelist: [
				{ symbol: "AVGO", exchange: "NASDAQ" },
				{ symbol: "GOOGL", exchange: "NASDAQ" },
				{ symbol: "AAPL", exchange: "NASDAQ" },
				{ symbol: "MSFT", exchange: "NASDAQ" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: ["AVGO", "GOOGL"],
		},
		tags: ["multi-party", "partnership", "ai-chips", "category-c"],
	},
	{
		id: "ra-002",
		name: "Acquisition announcement (acquirer + target)",
		input: {
			headline: "Microsoft announces $20B acquisition of cybersecurity firm CrowdStrike",
			source: "finnhub",
			symbols: ["MSFT"],
			classification: {
				sentiment: 0.4,
				confidence: 0.8,
				tradeable: true,
				eventType: "acquisition",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["MSFT", "CRWD"],
			expectedDirections: { CRWD: "long", MSFT: "long" },
			expectedSentimentRange: { CRWD: [0.5, 1.0], MSFT: [-0.2, 0.5] },
			isMultiParty: true,
			whitelist: [
				{ symbol: "MSFT", exchange: "NASDAQ" },
				{ symbol: "CRWD", exchange: "NASDAQ" },
				{ symbol: "PANW", exchange: "NASDAQ" },
				{ symbol: "ZS", exchange: "NASDAQ" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: ["MSFT", "CRWD"],
		},
		tags: ["multi-party", "acquisition", "category-c"],
	},
	{
		id: "ra-003",
		name: "Supply chain disruption (supplier + customer)",
		input: {
			headline: "TSMC warns of 3-month production delays at Arizona fab",
			source: "finnhub",
			symbols: ["TSM"],
			classification: {
				sentiment: -0.6,
				confidence: 0.85,
				tradeable: true,
				eventType: "profit_warning",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["TSM"],
			expectedDirections: { TSM: "short" },
			expectedSentimentRange: { TSM: [-1.0, -0.3] },
			isMultiParty: true,
			whitelist: [
				{ symbol: "TSM", exchange: "NYSE" },
				{ symbol: "NVDA", exchange: "NASDAQ" },
				{ symbol: "AMD", exchange: "NASDAQ" },
				{ symbol: "INTC", exchange: "NASDAQ" },
			],
			primaryExchange: "NYSE",
			requiredSymbols: ["TSM"],
		},
		tags: ["multi-party", "supply-chain", "category-c"],
	},
	{
		id: "ra-004",
		name: "Single-symbol earnings (no secondary beneficiaries)",
		input: {
			headline: "Netflix beats Q3 subscriber estimates by 12%",
			source: "finnhub",
			symbols: ["NFLX"],
			classification: {
				sentiment: 0.7,
				confidence: 0.9,
				tradeable: true,
				eventType: "earnings_beat",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["NFLX"],
			expectedDirections: { NFLX: "long" },
			expectedSentimentRange: { NFLX: [0.5, 1.0] },
			isMultiParty: false,
			whitelist: [
				{ symbol: "NFLX", exchange: "NASDAQ" },
				{ symbol: "DIS", exchange: "NYSE" },
				{ symbol: "PARA", exchange: "NASDAQ" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: ["NFLX"],
		},
		tags: ["single-symbol", "earnings", "category-c"],
	},
	{
		id: "ra-005",
		name: "FDA approval with competitor impact",
		input: {
			headline: "FDA approves Eli Lilly weight-loss drug, seen as Wegovy competitor",
			source: "finnhub",
			symbols: ["LLY"],
			classification: {
				sentiment: 0.8,
				confidence: 0.9,
				tradeable: true,
				eventType: "fda_approval",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["LLY", "NVO"],
			expectedDirections: { LLY: "long", NVO: "short" },
			expectedSentimentRange: { LLY: [0.5, 1.0], NVO: [-0.8, -0.1] },
			isMultiParty: true,
			whitelist: [
				{ symbol: "LLY", exchange: "NYSE" },
				{ symbol: "NVO", exchange: "NYSE" },
				{ symbol: "PFE", exchange: "NYSE" },
				{ symbol: "MRK", exchange: "NYSE" },
			],
			primaryExchange: "NYSE",
			requiredSymbols: ["LLY", "NVO"],
		},
		tags: ["multi-party", "fda", "competition", "category-c"],
	},
	{
		id: "ra-006",
		name: "Sector-wide catalyst (regulation)",
		input: {
			headline: "EU announces strict new AI regulation requiring model audits by 2027",
			source: "finnhub",
			symbols: ["GOOGL"],
			classification: {
				sentiment: -0.3,
				confidence: 0.6,
				tradeable: true,
				eventType: "legal",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["GOOGL"],
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: true,
			whitelist: [
				{ symbol: "GOOGL", exchange: "NASDAQ" },
				{ symbol: "MSFT", exchange: "NASDAQ" },
				{ symbol: "META", exchange: "NASDAQ" },
				{ symbol: "AMZN", exchange: "NASDAQ" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: ["GOOGL"],
		},
		tags: ["multi-party", "regulation", "sector-wide"],
	},
	{
		id: "ra-007",
		name: "Dividend increase (single symbol, low urgency)",
		input: {
			headline: "Johnson & Johnson raises quarterly dividend by 4.2%",
			source: "finnhub",
			symbols: ["JNJ"],
			classification: {
				sentiment: 0.25,
				confidence: 0.7,
				tradeable: true,
				eventType: "dividend",
				urgency: "low",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["JNJ"],
			expectedDirections: { JNJ: "long" },
			expectedSentimentRange: { JNJ: [0.1, 0.5] },
			isMultiParty: false,
			whitelist: [
				{ symbol: "JNJ", exchange: "NYSE" },
				{ symbol: "ABT", exchange: "NYSE" },
				{ symbol: "MDT", exchange: "NYSE" },
			],
			primaryExchange: "NYSE",
			requiredSymbols: ["JNJ"],
		},
		tags: ["single-symbol", "dividend"],
	},
	{
		id: "ra-008",
		name: "Major contract win with government (defense sector)",
		input: {
			headline: "Lockheed Martin wins $15B Pentagon contract for next-gen fighter jets",
			source: "finnhub",
			symbols: ["LMT"],
			classification: {
				sentiment: 0.6,
				confidence: 0.85,
				tradeable: true,
				eventType: "other",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["LMT"],
			expectedDirections: { LMT: "long" },
			expectedSentimentRange: { LMT: [0.4, 1.0] },
			isMultiParty: false,
			whitelist: [
				{ symbol: "LMT", exchange: "NYSE" },
				{ symbol: "RTX", exchange: "NYSE" },
				{ symbol: "NOC", exchange: "NYSE" },
				{ symbol: "GD", exchange: "NYSE" },
			],
			primaryExchange: "NYSE",
			requiredSymbols: ["LMT"],
		},
		tags: ["single-symbol", "contract-win", "defense"],
	},
	{
		id: "ra-009",
		name: "Profit warning with sector contagion",
		input: {
			headline: "Intel issues surprise profit warning citing weak PC demand across industry",
			source: "finnhub",
			symbols: ["INTC"],
			classification: {
				sentiment: -0.7,
				confidence: 0.9,
				tradeable: true,
				eventType: "profit_warning",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["INTC"],
			expectedDirections: { INTC: "short" },
			expectedSentimentRange: { INTC: [-1.0, -0.4] },
			isMultiParty: true,
			whitelist: [
				{ symbol: "INTC", exchange: "NASDAQ" },
				{ symbol: "AMD", exchange: "NASDAQ" },
				{ symbol: "NVDA", exchange: "NASDAQ" },
				{ symbol: "MU", exchange: "NASDAQ" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: ["INTC"],
		},
		tags: ["multi-party", "profit-warning", "sector-contagion"],
	},
	{
		id: "ra-010",
		name: "LSE stock — merger",
		input: {
			headline: "Shell confirms merger talks with BP in all-share deal",
			source: "finnhub",
			symbols: ["SHEL"],
			classification: {
				sentiment: 0.5,
				confidence: 0.85,
				tradeable: true,
				eventType: "merger",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["SHEL", "BP"],
			expectedDirections: { SHEL: "long", BP: "long" },
			expectedSentimentRange: { SHEL: [0.2, 0.8], BP: [0.3, 1.0] },
			isMultiParty: true,
			whitelist: [
				{ symbol: "SHEL", exchange: "LSE" },
				{ symbol: "BP", exchange: "LSE" },
				{ symbol: "TTE", exchange: "LSE" },
				{ symbol: "RDSB", exchange: "LSE" },
			],
			primaryExchange: "LSE",
			requiredSymbols: ["SHEL", "BP"],
		},
		tags: ["multi-party", "merger", "lse"],
	},
	{
		id: "ra-011",
		name: "TSMC production delay — expects TSM ticker",
		input: {
			headline: "TSMC warns of 3-month chip production delays at new Arizona plant",
			source: "finnhub",
			symbols: ["TSM"],
			classification: {
				sentiment: -0.6,
				confidence: 0.85,
				tradeable: true,
				eventType: "profit_warning",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["TSM"],
			expectedDirections: { TSM: "short" },
			expectedSentimentRange: { TSM: [-1.0, -0.3] },
			isMultiParty: true,
			whitelist: [
				{ symbol: "TSM", exchange: "NYSE" },
				{ symbol: "NVDA", exchange: "NASDAQ" },
				{ symbol: "AMD", exchange: "NASDAQ" },
				{ symbol: "INTC", exchange: "NASDAQ" },
			],
			primaryExchange: "NYSE",
			requiredSymbols: ["TSM"],
		},
		tags: ["ticker-accuracy", "supply-chain"],
	},
	{
		id: "ra-012",
		name: "Samsung chip announcement — should omit non-US/LSE ticker",
		input: {
			headline: "Samsung Electronics unveils next-gen 2nm chip process for AI servers",
			source: "finnhub",
			symbols: ["005930.KS"],
			classification: {
				sentiment: 0.5,
				confidence: 0.7,
				tradeable: true,
				eventType: "other",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 0,
			expectedSymbols: [],
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: false,
			whitelist: [
				{ symbol: "NVDA", exchange: "NASDAQ" },
				{ symbol: "AMD", exchange: "NASDAQ" },
				{ symbol: "INTC", exchange: "NASDAQ" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: [],
		},
		tags: ["ticker-accuracy", "foreign-stock"],
	},
	{
		id: "ra-013",
		name: "Mobileye autonomous driving — expects MBLY ticker",
		input: {
			headline: "Mobileye secures major autonomous driving deal with Volkswagen",
			source: "finnhub",
			symbols: ["MBLY"],
			classification: {
				sentiment: 0.7,
				confidence: 0.8,
				tradeable: true,
				eventType: "other",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["MBLY"],
			expectedDirections: { MBLY: "long" },
			expectedSentimentRange: { MBLY: [0.3, 1.0] },
			isMultiParty: false,
			whitelist: [
				{ symbol: "MBLY", exchange: "NASDAQ" },
				{ symbol: "INTC", exchange: "NASDAQ" },
				{ symbol: "APTV", exchange: "NYSE" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: ["MBLY"],
		},
		tags: ["ticker-accuracy", "partnership"],
	},
	{
		id: "ra-014",
		name: "Berkshire Hathaway earnings — expects BRK-B ticker",
		input: {
			headline: "Berkshire Hathaway reports record Q4 operating earnings of $8.5B",
			source: "finnhub",
			symbols: ["BRK-B"],
			classification: {
				sentiment: 0.7,
				confidence: 0.9,
				tradeable: true,
				eventType: "earnings_beat",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["BRK-B"],
			expectedDirections: { "BRK-B": "long" },
			expectedSentimentRange: { "BRK-B": [0.3, 1.0] },
			isMultiParty: false,
			whitelist: [
				{ symbol: "BRK-B", exchange: "NYSE" },
				{ symbol: "JPM", exchange: "NYSE" },
				{ symbol: "BAC", exchange: "NYSE" },
			],
			primaryExchange: "NYSE",
			requiredSymbols: ["BRK-B"],
		},
		tags: ["ticker-accuracy", "earnings"],
	},
	{
		id: "ra-015",
		name: "VIX spike — should omit index",
		input: {
			headline: "VIX spikes to 35 as markets reel from tariff escalation",
			source: "finnhub",
			symbols: ["^VIX"],
			classification: {
				sentiment: -0.8,
				confidence: 0.7,
				tradeable: false,
				eventType: "other",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 0,
			expectedSymbols: [],
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: false,
			whitelist: [
				{ symbol: "SPY", exchange: "NYSE" },
				{ symbol: "QQQ", exchange: "NASDAQ" },
			],
			primaryExchange: "NYSE",
			requiredSymbols: [],
		},
		tags: ["ticker-accuracy", "index"],
	},
	{
		id: "ra-016",
		name: "Xilinx supply chain — should return AMD not XLNX",
		input: {
			headline: "Former Xilinx FPGA division drives AMD data center revenue surge",
			source: "finnhub",
			symbols: ["AMD"],
			classification: {
				sentiment: 0.6,
				confidence: 0.8,
				tradeable: true,
				eventType: "earnings_beat",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["AMD"],
			expectedDirections: { AMD: "long" },
			expectedSentimentRange: { AMD: [0.3, 1.0] },
			isMultiParty: false,
			whitelist: [
				{ symbol: "AMD", exchange: "NASDAQ" },
				{ symbol: "INTC", exchange: "NASDAQ" },
				{ symbol: "NVDA", exchange: "NASDAQ" },
			],
			primaryExchange: "NASDAQ",
			requiredSymbols: ["AMD"],
			forbiddenSymbols: ["XLNX"],
		},
		tags: ["ticker-accuracy", "acquired-company"],
	},
	{
		id: "ra-017",
		name: "Juniper/HPE merger — should return HPE not JNPR",
		input: {
			headline: "HPE completes $14B Juniper Networks acquisition, expanding networking portfolio",
			source: "finnhub",
			symbols: ["HPE"],
			classification: {
				sentiment: 0.4,
				confidence: 0.75,
				tradeable: true,
				eventType: "acquisition",
				urgency: "high",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["HPE"],
			expectedDirections: { HPE: "long" },
			expectedSentimentRange: { HPE: [0.1, 0.8] },
			isMultiParty: false,
			whitelist: [
				{ symbol: "HPE", exchange: "NYSE" },
				{ symbol: "CSCO", exchange: "NASDAQ" },
				{ symbol: "ANET", exchange: "NYSE" },
			],
			primaryExchange: "NYSE",
			requiredSymbols: ["HPE"],
			forbiddenSymbols: ["JNPR"],
		},
		tags: ["ticker-accuracy", "acquisition"],
	},
];

const LSE_WHITELIST: Array<{ symbol: string; exchange: string }> = [
	{ symbol: "SHEL", exchange: "LSE" },
	{ symbol: "BP.", exchange: "LSE" },
	{ symbol: "HSBA", exchange: "LSE" },
	{ symbol: "AZN", exchange: "LSE" },
	{ symbol: "VOD", exchange: "LSE" },
	{ symbol: "GSK", exchange: "LSE" },
	{ symbol: "ULVR", exchange: "LSE" },
	{ symbol: "RIO", exchange: "LSE" },
	{ symbol: "DGE", exchange: "LSE" },
	{ symbol: "LLOY", exchange: "LSE" },
];

// Category A: LSE attribution preservation (5 tasks from corpus)
for (let i = 0; i < corpus.corpus.length && i < 5; i++) {
	const entry = corpus.corpus[i]!;
	researchAgentTasks.push({
		id: `ra-lse-a-${String(i + 1).padStart(3, "0")}`,
		name: `LSE attribution: ${entry.correctPrimarySymbol}`,
		input: {
			headline: entry.headline,
			source: entry.source,
			symbols: [entry.primarySymbol],
			classification: {
				sentiment: 0,
				confidence: 0.75,
				tradeable: true,
				eventType: "generic",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: [entry.correctPrimarySymbol],
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: false,
			whitelist: LSE_WHITELIST,
			primaryExchange: "LSE",
			requiredSymbols: [entry.correctPrimarySymbol],
		},
		tags: ["lse", "attribution", "category-a"],
	});
}

// Category B: whitelist compliance distractors (5 tasks)
const categoryBTasks = [
	{
		id: "ra-lse-b-001",
		name: "Distractor: Panasonic + Shell partnership",
		headline: "Panasonic and Shell announce battery supply deal for EV charging network",
		primary: "SHEL",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
	{
		id: "ra-lse-b-002",
		name: "Distractor: Samsung + HSBC mention",
		headline: "HSBC Holdings extends credit facility to Samsung Electronics",
		primary: "HSBA",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
	{
		id: "ra-lse-b-003",
		name: "Distractor: Tesla + BP charging",
		headline: "BP plc rolls out Tesla-compatible fast chargers across UK motorways",
		primary: "BP.",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
	{
		id: "ra-lse-b-004",
		name: "Distractor: Pfizer + AstraZeneca research",
		headline: "AstraZeneca plc and Pfizer publish joint oncology trial results",
		primary: "AZN",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
	{
		id: "ra-lse-b-005",
		name: "Distractor: Apple + Vodafone deal",
		headline: "Vodafone Group plc signs distribution deal with Apple Inc for iPhone 17",
		primary: "VOD",
		tags: ["lse", "whitelist", "distractor", "category-b"],
	},
];

for (const t of categoryBTasks) {
	researchAgentTasks.push({
		id: t.id,
		name: t.name,
		input: {
			headline: t.headline,
			source: "synthetic",
			symbols: [t.primary],
			classification: {
				sentiment: 0.2,
				confidence: 0.7,
				tradeable: true,
				eventType: "partnership",
				urgency: "low",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: [t.primary],
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: false,
			whitelist: LSE_WHITELIST,
			primaryExchange: "LSE",
			requiredSymbols: [t.primary],
		},
		tags: t.tags,
	});
}

// Category D: multi-symbol LSE expansion (3 tasks)
const categoryDTasks = [
	{
		id: "ra-lse-d-001",
		headline: "Shell and BP both raise dividends as oil majors ride higher crude prices",
		primary: "SHEL",
		expected: ["SHEL", "BP."],
	},
	{
		id: "ra-lse-d-002",
		headline: "Lloyds and NatWest shares rise on expectations of higher BoE base rate",
		primary: "LLOY",
		expected: ["LLOY", "NWG"],
	},
	{
		id: "ra-lse-d-003",
		headline: "AstraZeneca and GSK face combined pricing pressure from new NHS framework",
		primary: "AZN",
		expected: ["AZN", "GSK"],
	},
];

for (const t of categoryDTasks) {
	researchAgentTasks.push({
		id: t.id,
		name: `Multi-symbol LSE: ${t.expected.join("+")}`,
		input: {
			headline: t.headline,
			source: "synthetic",
			symbols: [t.primary],
			classification: {
				sentiment: 0.3,
				confidence: 0.75,
				tradeable: true,
				eventType: "sector",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: t.expected,
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: true,
			whitelist: LSE_WHITELIST.concat([{ symbol: "NWG", exchange: "LSE" }]),
			primaryExchange: "LSE",
			requiredSymbols: t.expected,
		},
		tags: ["lse", "multi-symbol", "category-d"],
	});
}

// Category E: deprecated-ticker rejection (2 tasks)
const categoryETasks = [
	{
		id: "ra-lse-e-001",
		headline: "Royal Dutch Shell reports record buyback programme for 2026",
		primary: "SHEL",
		forbidden: ["RDSB", "RDSA"],
		required: ["SHEL"],
	},
	{
		id: "ra-lse-e-002",
		headline: "Vodafone Group plc announces €8bn sale of Italian operations",
		primary: "VOD",
		forbidden: ["VOD.L"],
		required: ["VOD"],
	},
];

for (const t of categoryETasks) {
	researchAgentTasks.push({
		id: t.id,
		name: `Deprecated rejection: ${t.required.join("+")}`,
		input: {
			headline: t.headline,
			source: "synthetic",
			symbols: [t.primary],
			classification: {
				sentiment: 0.4,
				confidence: 0.8,
				tradeable: true,
				eventType: "corporate_action",
				urgency: "medium",
			},
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: t.required,
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: false,
			whitelist: LSE_WHITELIST,
			primaryExchange: "LSE",
			requiredSymbols: t.required,
			forbiddenSymbols: t.forbidden,
		},
		tags: ["lse", "deprecated", "category-e"],
	});
}
