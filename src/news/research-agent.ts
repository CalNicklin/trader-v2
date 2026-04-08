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

export function buildResearchPrompt(input: ResearchInput): string {
	return `You are a financial research analyst. Analyse this news headline and identify ALL materially affected publicly-traded symbols — not just the one originally classified.

## Headline
"${input.headline}"

## Source
${input.source}

## Symbols mentioned
${input.symbols.join(", ")}

## Initial classification (for the primary symbol ${input.symbols[0] ?? "unknown"})
- Sentiment: ${input.classification.sentiment}
- Confidence: ${input.classification.confidence}
- Event type: ${input.classification.eventType}
- Urgency: ${input.classification.urgency}

## Your task
Identify every publicly-traded symbol materially affected by this news. For each, provide:
- symbol: ticker (e.g., AVGO, GOOGL)
- exchange: one of NASDAQ, NYSE, LSE
- sentiment: -1.0 to 1.0 (from this symbol's perspective)
- urgency: low, medium, or high
- event_type: what this event means for THIS symbol
- direction: long, short, or avoid
- trade_thesis: one sentence explaining the trade case
- confidence: 0 to 1

Include the originally-classified symbol with your independent assessment. Look for:
- Direct parties (buyer/seller, partners)
- Supply chain effects (suppliers, customers)
- Sector peers affected by competitive dynamics
- M&A targets or acquirers

Return only valid exchange tickers as traded on NASDAQ, NYSE, or LSE. Use the ticker symbol, not the company name (e.g. TSM not TSMC, MBLY not MOBILEYE, BRK-B not BRK.B). If unsure of the exact ticker, omit the symbol rather than guess.

Respond with JSON only, no markdown:
{"affected_symbols": [...]}`;
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
	const prompt = buildResearchPrompt(input);

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

		const analyses = parseResearchResponse(text);
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
