// src/evals/research-agent/graders.ts

import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";
import type { ResearchAnalysis, ResearchInput } from "../../news/research-agent.ts";
import type { Grader } from "../types.ts";
import type { ResearchReference } from "./tasks.ts";

type RG = Grader<ResearchAnalysis[], ResearchReference, ResearchInput>;

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
		if (reference.expectedSymbols.length === 0) {
			return { score: 1, pass: true, reason: "No expected symbols configured" };
		}
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
		const valid = output.every((a) => a.recommendTrade === a.confidence >= 0.7);
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
	grade: async (output, reference) => {
		if (output.length === 0) return { score: 1, pass: true, reason: "No symbols to validate" };

		const whitelistTickers = new Set((reference.whitelist ?? []).map((w) => w.symbol));
		const invalid: string[] = [];
		for (const a of output) {
			if (!KNOWN_VALID_TICKERS.has(a.symbol) && !whitelistTickers.has(a.symbol)) {
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

/**
 * Category A grader: the primary RSS-matched symbol must be present.
 * Requires `reference.requiredSymbols` with at least one entry (the primary).
 */
export const primaryPresentGrader: RG = {
	name: "primary-present",
	type: "code",
	grade: async (output, reference) => {
		const required = reference.requiredSymbols ?? [];
		if (required.length === 0) {
			return { score: 1, pass: true, reason: "no required symbols configured" };
		}
		const have = new Set(output.map((a) => a.symbol));
		const missing = required.filter((s) => !have.has(s));
		return {
			score: missing.length === 0 ? 1 : 0,
			pass: missing.length === 0,
			reason:
				missing.length === 0
					? `All required symbols present (${required.join(", ")})`
					: `Missing required: ${missing.join(", ")}`,
		};
	},
};

/**
 * Category B grader: every output symbol must be in the whitelist.
 */
export const whitelistComplianceGrader: RG = {
	name: "whitelist-compliance",
	type: "code",
	grade: async (output, reference) => {
		const whitelist = reference.whitelist ?? [];
		if (whitelist.length === 0) {
			return { score: 1, pass: true, reason: "no whitelist configured" };
		}
		const allowed = new Set(whitelist.map((w) => `${w.symbol}:${w.exchange}`));
		const violations = output
			.map((a) => `${a.symbol}:${a.exchange}`)
			.filter((key) => !allowed.has(key));
		return {
			score: violations.length === 0 ? 1 : 0,
			pass: violations.length === 0,
			reason:
				violations.length === 0
					? "All outputs in whitelist"
					: `Outside whitelist: ${violations.join(", ")}`,
		};
	},
};

/**
 * Category E grader: no forbidden (e.g. deprecated) symbols may appear,
 * and all required (current replacement) symbols must.
 */
export const negativeRejectionGrader: RG = {
	name: "negative-rejection",
	type: "code",
	grade: async (output, reference) => {
		const forbidden = reference.forbiddenSymbols ?? [];
		const required = reference.requiredSymbols ?? [];
		const have = new Set(output.map((a) => a.symbol));
		const leaked = forbidden.filter((s) => have.has(s));
		const missing = required.filter((s) => !have.has(s));
		const pass = leaked.length === 0 && missing.length === 0;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass
				? "No forbidden symbols, all required present"
				: `Leaked: [${leaked.join(", ")}]; Missing: [${missing.join(", ")}]`,
		};
	},
};

export const thesisPlausibilityJudge: RG = {
	name: "thesis-plausibility",
	type: "llm",
	grade: async (output, reference, context) => {
		// Only run when there is something to judge
		if (output.length === 0) {
			return { score: 0, pass: false, reason: "no analyses to judge" };
		}
		// Skip unless this task is a multi-party case (Category D)
		if (!reference.isMultiParty) {
			return { score: 1, pass: true, reason: "skipped (not multi-party)" };
		}

		const config = getConfig();
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const headline = context?.input?.headline ?? "unknown headline";
		const rubric = output.map((a) => `- ${a.symbol} (${a.direction}): ${a.tradeThesis}`).join("\n");

		const prompt = `You are a financial analyst grading an AI-generated research output.

Headline: "${headline}"

The AI produced these trade theses:
${rubric}

For each symbol, judge whether the thesis is PLAUSIBLE given the headline.
Be strict: a thesis is plausible only if the connection between the headline
and the symbol's trade case is evident.

Respond with JSON only:
{ "judgments": [ { "symbol": "XYZ", "plausible": true|false, "reason": "..." } ] }`;

		try {
			const resp = await client.messages.create({
				model: "claude-sonnet-4-6",
				max_tokens: 600,
				messages: [{ role: "user", content: prompt }],
			});
			const text = resp.content[0]?.type === "text" ? resp.content[0].text : "";
			const cleaned = text
				.replace(/```json?\n?/g, "")
				.replace(/```/g, "")
				.trim();
			const parsed = JSON.parse(cleaned) as {
				judgments: Array<{ symbol: string; plausible: boolean; reason: string }>;
			};
			const total = parsed.judgments.length;
			const passed = parsed.judgments.filter((j) => j.plausible).length;
			const ratio = total > 0 ? passed / total : 0;
			const pass = total > 0 && ratio >= 0.75;
			return {
				score: ratio,
				pass,
				reason: `${passed}/${total} theses plausible`,
			};
		} catch (err) {
			return { score: 0, pass: false, reason: `judge failed: ${String(err)}` };
		}
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
	primaryPresentGrader,
	whitelistComplianceGrader,
	negativeRejectionGrader,
	thesisPlausibilityJudge,
];
