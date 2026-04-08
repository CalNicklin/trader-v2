// src/evals/research-agent/graders.ts

import type { ResearchAnalysis } from "../../news/research-agent.ts";
import type { Grader } from "../types.ts";
import type { ResearchReference } from "./tasks.ts";

type RG = Grader<ResearchAnalysis[], ResearchReference>;

export const jsonShapeGrader: RG = {
	name: "json-shape",
	type: "code",
	grade: async (output) => {
		const valid = output.every(
			(a) =>
				typeof a.symbol === "string" &&
				typeof a.exchange === "string" &&
				typeof a.sentiment === "number" &&
				a.sentiment >= -1 &&
				a.sentiment <= 1 &&
				typeof a.confidence === "number" &&
				a.confidence >= 0 &&
				a.confidence <= 1 &&
				["low", "medium", "high"].includes(a.urgency) &&
				["long", "short", "avoid"].includes(a.direction) &&
				typeof a.tradeThesis === "string" &&
				a.tradeThesis.length > 0,
		);
		return {
			score: valid ? 1 : 0,
			pass: valid,
			reason: valid ? "All fields valid" : "Invalid shape",
		};
	},
};

export const minSymbolsGrader: RG = {
	name: "min-symbols",
	type: "code",
	grade: async (output, reference) => {
		const pass = output.length >= reference.minSymbols;
		return {
			score: pass ? 1 : Math.max(0, output.length / reference.minSymbols),
			pass,
			reason: pass
				? `Found ${output.length} symbols (min: ${reference.minSymbols})`
				: `Only ${output.length} symbols (expected >= ${reference.minSymbols})`,
		};
	},
};

export const expectedSymbolsGrader: RG = {
	name: "expected-symbols",
	type: "code",
	grade: async (output, reference) => {
		const outputSymbols = new Set(output.map((a) => a.symbol));
		const found = reference.expectedSymbols.filter((s) => outputSymbols.has(s));
		const score = found.length / reference.expectedSymbols.length;
		return {
			score,
			pass: score >= 0.5,
			reason: `Found ${found.length}/${reference.expectedSymbols.length} expected symbols: ${found.join(", ")}`,
		};
	},
};

export const directionGrader: RG = {
	name: "direction-accuracy",
	type: "code",
	grade: async (output, reference) => {
		const checks = Object.entries(reference.expectedDirections);
		if (checks.length === 0) return { score: 1, pass: true, reason: "No direction expectations" };

		let correct = 0;
		for (const [symbol, expected] of checks) {
			const analysis = output.find((a) => a.symbol === symbol);
			if (analysis && analysis.direction === expected) correct++;
		}
		const score = correct / checks.length;
		return {
			score,
			pass: score >= 0.5,
			reason: `Direction correct for ${correct}/${checks.length} symbols`,
		};
	},
};

export const sentimentRangeGrader: RG = {
	name: "sentiment-range",
	type: "code",
	grade: async (output, reference) => {
		const checks = Object.entries(reference.expectedSentimentRange);
		if (checks.length === 0) return { score: 1, pass: true, reason: "No sentiment expectations" };

		let inRange = 0;
		for (const [symbol, [min, max]] of checks) {
			const analysis = output.find((a) => a.symbol === symbol);
			if (analysis && analysis.sentiment >= min && analysis.sentiment <= max) inRange++;
		}
		const score = inRange / checks.length;
		return {
			score,
			pass: score >= 0.5,
			reason: `Sentiment in range for ${inRange}/${checks.length} symbols`,
		};
	},
};

export const recommendTradeGrader: RG = {
	name: "recommend-trade-threshold",
	type: "code",
	grade: async (output) => {
		const valid = output.every((a) => a.recommendTrade === a.confidence >= 0.8);
		return {
			score: valid ? 1 : 0,
			pass: valid,
			reason: valid ? "recommendTrade matches confidence threshold" : "recommendTrade mismatch",
		};
	},
};

/** Known-valid US/LSE exchange tickers for eval purposes (no live API calls) */
const KNOWN_VALID_TICKERS = new Set([
	// US mega-caps & common
	"AAPL",
	"MSFT",
	"GOOGL",
	"GOOG",
	"AMZN",
	"NVDA",
	"TSLA",
	"META",
	"JPM",
	"V",
	"JNJ",
	"WMT",
	"PG",
	"MA",
	"HD",
	"XOM",
	"AVGO",
	"COST",
	"ABBV",
	"MRK",
	"PEP",
	"KO",
	"LLY",
	"NVO",
	"CRM",
	"AMD",
	"NFLX",
	"INTC",
	"CSCO",
	"ADBE",
	"PYPL",
	"QCOM",
	"TXN",
	"AMAT",
	"MU",
	"CRWD",
	"HPE",
	"LMT",
	"BA",
	"RTX",
	"GD",
	"NOC",
	"MBLY",
	"TSM",
	"BRK-B",
	"BRK-A",
	// LSE
	"SHEL",
	"BP.",
	"HSBA",
	"AZN",
	"ULVR",
	"VOD",
	"RIO",
	"GLEN",
	"GAW",
	"FDEV",
	"TET",
	"JET2",
	"BOWL",
	"FEVR",
]);

export const tickerValidityGrader: RG = {
	name: "ticker-validity",
	type: "code",
	grade: async (output) => {
		if (output.length === 0) return { score: 1, pass: true, reason: "No symbols to validate" };

		const invalid: string[] = [];
		for (const a of output) {
			if (!KNOWN_VALID_TICKERS.has(a.symbol)) {
				invalid.push(a.symbol);
			}
		}
		const score = (output.length - invalid.length) / output.length;
		return {
			score,
			pass: invalid.length === 0,
			reason:
				invalid.length === 0
					? "All symbols are valid tickers"
					: `Invalid tickers: ${invalid.join(", ")}`,
		};
	},
};

export const allResearchGraders: RG[] = [
	jsonShapeGrader,
	minSymbolsGrader,
	expectedSymbolsGrader,
	directionGrader,
	sentimentRangeGrader,
	recommendTradeGrader,
	tickerValidityGrader,
];
