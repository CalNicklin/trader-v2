// src/news/research-agent.ts
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { fmpValidateSymbol } from "../data/fmp.ts";
import { getDb } from "../db/client.ts";
import { newsAnalyses, quotesCache, strategies } from "../db/schema.ts";
import { getInjectedSymbols, injectSymbol } from "../strategy/universe.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { writeSignals } from "./sentiment-writer.ts";

const log = createChildLogger({ module: "research-agent" });

const RESEARCH_COST_USD = 0.003; // Sonnet: ~500 input + 400 output tokens
const CONFIDENCE_THRESHOLD = 0.7;
const INJECTION_TTL_24H = 24 * 60 * 60 * 1000;
const VALID_EXCHANGES = new Set(["NASDAQ", "NYSE", "LSE"]);
const VALID_URGENCIES = new Set(["low", "medium", "high"]);
const VALID_DIRECTIONS = new Set(["long", "short", "avoid"]);

export interface ResearchInput {
	headline: string;
	source: string;
	symbols: string[];
	classification: {
		sentiment: number;
		confidence: number;
		tradeable: boolean;
		eventType: string;
		urgency: string;
	};
}

export interface ResearchAnalysis {
	symbol: string;
	exchange: string;
	sentiment: number;
	urgency: "low" | "medium" | "high";
	eventType: string;
	direction: "long" | "short" | "avoid";
	tradeThesis: string;
	confidence: number;
	recommendTrade: boolean;
}

export function buildResearchPrompt(
	input: ResearchInput,
	ctx: {
		whitelist: Array<{ symbol: string; exchange: string }>;
		primaryExchange: string;
	},
): string {
	const primarySymbol = input.symbols[0] ?? "unknown";
	const whitelistLines = ctx.whitelist
		.map((w) => `- ${w.symbol} (exchange: ${w.exchange})`)
		.join("\n");

	return `You are a financial research analyst. Analyse this news headline and identify ALL materially affected publicly-traded symbols — not just the one originally classified.

## Headline
"${input.headline}"

## Source
${input.source}

## Symbols mentioned
${input.symbols.join(", ")}

## Initial classification (for the primary symbol ${primarySymbol})
- Sentiment: ${input.classification.sentiment}
- Confidence: ${input.classification.confidence}
- Event type: ${input.classification.eventType}
- Urgency: ${input.classification.urgency}

## Tradeable universe
You may ONLY return symbols from this whitelist. Any symbol not in this list
will be dropped. The whitelist is shown one entry per line as
"- TICKER (exchange: VENUE)". In your output, put TICKER alone in the symbol
field and VENUE alone in the exchange field — never join them together.

<whitelist>
${whitelistLines}
</whitelist>

## Primary attribution
This headline was matched to ticker "${primarySymbol}" on exchange "${ctx.primaryExchange}"
by the upstream news matcher. Unless the headline is entirely unrelated to that
company, you MUST include an entry with symbol="${primarySymbol}" and
exchange="${ctx.primaryExchange}" in your output, with your independent sentiment
assessment. If the headline IS unrelated, return an empty array.

## Your task
Identify every publicly-traded symbol materially affected by this news. For each, provide:
- symbol: bare ticker only, e.g. "AVGO", "AZN", "BP." — NEVER "AZN:LSE" or "AZN.L"
- exchange: one of "NASDAQ", "NYSE", "LSE" — as a separate field
- sentiment: -1.0 to 1.0 (from this symbol's perspective)
- urgency: low, medium, or high
- event_type: what this event means for THIS symbol
- direction: long, short, or avoid
- trade_thesis: one sentence explaining the trade case
- confidence: 0 to 1

Include the originally-classified symbol with your independent assessment. Look for:
- Direct parties (buyer/seller, partners) named in the headline
- Supply chain effects when the dependency is concrete and material
- Sector peers ONLY when the headline describes a sector-wide trigger (e.g. broad regulation, market-wide shock) or explicitly names them
- M&A targets or acquirers named in the headline

Be conservative. Do not add speculative sector-contagion symbols. If a narrow event (a single fab, a single product, a single subsidiary) does not clearly translate into a material impact on a peer, OMIT that peer rather than guess. A shorter list of high-confidence symbols is better than a longer list with weak theses.

Return only valid exchange tickers as traded on NASDAQ, NYSE, or LSE. Use the ticker symbol, not the company name (e.g. TSM not TSMC, MBLY not MOBILEYE, BRK-B not BRK.B). If unsure of the exact ticker, omit the symbol rather than guess.

Respond with JSON only, no markdown. Example shape (one entry shown):
{"affected_symbols": [
  {"symbol": "AZN", "exchange": "LSE", "sentiment": 0.4, "urgency": "medium", "event_type": "earnings_beat", "direction": "long", "trade_thesis": "...", "confidence": 0.75}
]}`;
}

export function parseResearchResponse(text: string): ResearchAnalysis[] {
	try {
		const cleaned = text
			.replace(/```json?\n?/g, "")
			.replace(/```/g, "")
			.trim();
		const parsed = JSON.parse(cleaned);

		if (!parsed || !Array.isArray(parsed.affected_symbols)) return [];

		return parsed.affected_symbols
			.filter((s: Record<string, unknown>) => {
				return (
					typeof s.symbol === "string" &&
					typeof s.exchange === "string" &&
					VALID_EXCHANGES.has(s.exchange) &&
					typeof s.sentiment === "number" &&
					typeof s.urgency === "string" &&
					VALID_URGENCIES.has(s.urgency) &&
					typeof s.event_type === "string" &&
					typeof s.direction === "string" &&
					VALID_DIRECTIONS.has(s.direction) &&
					typeof s.trade_thesis === "string" &&
					typeof s.confidence === "number"
				);
			})
			.map((s: Record<string, unknown>) => {
				const confidence = Math.max(0, Math.min(1, s.confidence as number));
				return {
					symbol: s.symbol as string,
					exchange: s.exchange as string,
					sentiment: Math.max(-1, Math.min(1, s.sentiment as number)),
					urgency: s.urgency as "low" | "medium" | "high",
					eventType: s.event_type as string,
					direction: s.direction as "long" | "short" | "avoid",
					tradeThesis: s.trade_thesis as string,
					confidence,
					recommendTrade: confidence >= CONFIDENCE_THRESHOLD,
				};
			});
	} catch {
		return [];
	}
}

async function isSymbolInUniverse(symbol: string, exchange: string): Promise<boolean> {
	const db = getDb();
	// Check strategy universe JSON arrays
	const allStrategies = await db
		.select({ universe: strategies.universe })
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	for (const s of allStrategies) {
		try {
			const universe: string[] = JSON.parse(s.universe ?? "[]");
			if (universe.some((u) => u === symbol || u === `${symbol}:${exchange}`)) return true;
		} catch {}
	}

	// Check injected symbols
	const injected = await getInjectedSymbols();
	return injected.some((i) => i.symbol === symbol && i.exchange === exchange);
}

export async function buildUniverseWhitelist(): Promise<
	Array<{ symbol: string; exchange: string }>
> {
	const db = getDb();
	const rows = await db
		.select({ universe: strategies.universe })
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	const seen = new Set<string>();
	const result: Array<{ symbol: string; exchange: string }> = [];
	for (const row of rows) {
		if (!row.universe) continue;
		let list: string[];
		try {
			list = JSON.parse(row.universe);
		} catch {
			continue;
		}
		for (const spec of list) {
			const [sym, ex] = spec.includes(":") ? spec.split(":") : [spec, "NASDAQ"];
			if (!sym || !ex) continue;
			const key = `${sym}:${ex}`;
			if (seen.has(key)) continue;
			seen.add(key);
			result.push({ symbol: sym, exchange: ex });
		}
	}
	return result;
}

async function getPriceForSymbol(symbol: string, exchange: string): Promise<number | null> {
	const db = getDb();
	const [cached] = await db
		.select({ last: quotesCache.last })
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, symbol), eq(quotesCache.exchange, exchange)))
		.limit(1);

	if (cached?.last != null) return cached.last;

	// Fallback: FMP single quote for newly-discovered symbols
	try {
		const { fmpQuote } = await import("../data/fmp.ts");
		const quote = await fmpQuote(symbol, exchange);
		return quote?.last ?? null;
	} catch {
		return null;
	}
}

function isWhitelistEnforced(): boolean {
	return process.env.RESEARCH_WHITELIST_ENFORCE !== "false";
}

function filterAndPin(
	analyses: ResearchAnalysis[],
	primarySymbol: string,
	primaryExchange: string,
	whitelist: Array<{ symbol: string; exchange: string }>,
): ResearchAnalysis[] {
	if (!isWhitelistEnforced()) return analyses;

	const whitelistSet = new Set(whitelist.map((w) => `${w.symbol}:${w.exchange}`));

	const filtered: ResearchAnalysis[] = [];
	for (const a of analyses) {
		const key = `${a.symbol}:${a.exchange}`;
		if (whitelistSet.has(key)) {
			filtered.push(a);
		} else {
			log.warn(
				{ symbol: a.symbol, exchange: a.exchange },
				"Research-agent output dropped (not in whitelist)",
			);
		}
	}

	const primaryKey = `${primarySymbol}:${primaryExchange}`;
	if (!whitelistSet.has(primaryKey)) return filtered;

	const primaryPresent = filtered.some(
		(a) => a.symbol === primarySymbol && a.exchange === primaryExchange,
	);
	if (!primaryPresent) {
		log.warn(
			{ primary: primaryKey },
			"Research-agent dropped primary symbol — re-inserting with neutralised signal",
		);
		filtered.push({
			symbol: primarySymbol,
			exchange: primaryExchange,
			sentiment: 0,
			urgency: "low",
			eventType: "unclassified",
			direction: "avoid",
			tradeThesis: "Primary symbol re-attributed after LLM omission",
			confidence: 0.5,
			recommendTrade: false,
		});
	}
	return filtered;
}

export const _test_filterAndPin = filterAndPin;

export async function runResearchAnalysis(
	newsEventId: number,
	input: ResearchInput,
): Promise<{ analyses: number; skippedBudget: boolean }> {
	if (!(await canAffordCall(RESEARCH_COST_USD))) {
		log.warn("Skipping research analysis — daily budget exceeded");
		return { analyses: 0, skippedBudget: true };
	}

	const config = getConfig();
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
	const whitelist = await buildUniverseWhitelist();
	const primaryExchange = input.symbols[0]
		? (whitelist.find((w) => w.symbol === input.symbols[0])?.exchange ?? "NASDAQ")
		: "NASDAQ";
	const prompt = buildResearchPrompt(input, { whitelist, primaryExchange });

	try {
		const response = await withRetry(
			() =>
				client.messages.create({
					model: config.CLAUDE_MODEL,
					max_tokens: 1500,
					messages: [{ role: "user", content: prompt }],
				}),
			"research-agent",
			{ maxAttempts: 2, baseDelayMs: 1000 },
		);

		const text = response.content[0]?.type === "text" ? response.content[0].text : "";
		await recordUsage("news_research", response.usage.input_tokens, response.usage.output_tokens);

		const rawAnalyses = parseResearchResponse(text);
		const analyses = filterAndPin(rawAnalyses, input.symbols[0] ?? "", primaryExchange, whitelist);
		if (analyses.length === 0) {
			log.warn({ headline: input.headline.slice(0, 60) }, "Research agent returned no analyses");
			return { analyses: 0, skippedBudget: false };
		}

		const db = getDb();
		for (const analysis of analyses) {
			const inUniverse = await isSymbolInUniverse(analysis.symbol, analysis.exchange);
			const isValidTicker = await fmpValidateSymbol(analysis.symbol, analysis.exchange);
			const priceAtAnalysis = isValidTicker
				? await getPriceForSymbol(analysis.symbol, analysis.exchange)
				: null;

			// Always store analysis (for debugging/eval flywheel)
			await db
				.insert(newsAnalyses)
				.values({
					newsEventId,
					symbol: analysis.symbol,
					exchange: analysis.exchange,
					sentiment: analysis.sentiment,
					urgency: analysis.urgency,
					eventType: analysis.eventType,
					direction: analysis.direction,
					tradeThesis: analysis.tradeThesis,
					confidence: analysis.confidence,
					recommendTrade: analysis.recommendTrade,
					inUniverse,
					priceAtAnalysis,
					validatedTicker: isValidTicker,
				})
				.onConflictDoUpdate({
					target: [newsAnalyses.newsEventId, newsAnalyses.symbol],
					set: {
						sentiment: analysis.sentiment,
						urgency: analysis.urgency,
						eventType: analysis.eventType,
						direction: analysis.direction,
						tradeThesis: analysis.tradeThesis,
						confidence: analysis.confidence,
						recommendTrade: analysis.recommendTrade,
						inUniverse,
						priceAtAnalysis,
						validatedTicker: isValidTicker,
					},
				});

			// Only write to quotesCache if ticker is real
			if (isValidTicker) {
				await writeSignals(analysis.symbol, analysis.exchange, {
					sentiment: analysis.sentiment,
					earningsSurprise: 0,
					guidanceChange: 0,
					managementTone: 0,
					regulatoryRisk: 0,
					acquisitionLikelihood: 0,
					catalystType: analysis.eventType,
					expectedMoveDuration: analysis.urgency === "high" ? "1-3d" : "1-2w",
				});

				if (analysis.recommendTrade) {
					injectSymbol(analysis.symbol, analysis.exchange, INJECTION_TTL_24H);
					log.info(
						{ symbol: analysis.symbol, confidence: analysis.confidence },
						"High-confidence symbol injected with 24h TTL",
					);
				}
			} else {
				log.warn(
					{ symbol: analysis.symbol, exchange: analysis.exchange },
					"Research agent returned invalid ticker — skipped signal write",
				);
			}
		}

		log.info(
			{
				headline: input.headline.slice(0, 60),
				symbolCount: analyses.length,
				symbols: analyses.map((a) => a.symbol),
			},
			"Research analysis complete",
		);

		return { analyses: analyses.length, skippedBudget: false };
	} catch (error) {
		log.error({ error, headline: input.headline.slice(0, 60) }, "Research analysis failed");
		return { analyses: 0, skippedBudget: false };
	}
}
