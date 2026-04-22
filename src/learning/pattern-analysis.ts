import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, gte } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { investableUniverse, paperTrades, strategies, tradeInsights } from "../db/schema.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { markLedToPromotion, writeCatalystEvent } from "../watchlist/catalyst-events.ts";
import {
	FEEDBACK_INSIGHT_THRESHOLD,
	FEEDBACK_INSIGHT_WINDOW_DAYS,
	FEEDBACK_MIN_CONFIDENCE,
} from "../watchlist/constants.ts";
import { promoteToWatchlist } from "../watchlist/promote.ts";
import { getActivePrompt } from "./prompts.ts";
import type { PatternObservation, UniverseSuggestion } from "./types.ts";

const log = createChildLogger({ module: "pattern-analysis" });

const ANALYSIS_COST_USD = 0.001;

interface StrategyTradeCluster {
	strategyId: number;
	strategyName: string;
	trades: Array<{
		symbol: string;
		side: string;
		pnl: number;
		holdDays: number;
		signalType: string;
		patternTags: string[];
	}>;
}

export function buildPatternAnalysisPrompt(clusters: StrategyTradeCluster[]): string {
	const lines: string[] = [];

	for (const cluster of clusters) {
		lines.push(`\n--- Strategy: ${cluster.strategyName} (id: ${cluster.strategyId}) ---`);
		lines.push(`Trades (${cluster.trades.length}):`);

		for (const trade of cluster.trades) {
			const tags = trade.patternTags.length > 0 ? ` [tags: ${trade.patternTags.join(", ")}]` : "";
			lines.push(
				`  ${trade.symbol} ${trade.side} | PnL: ${trade.pnl} | Hold: ${trade.holdDays}d | Signal: ${trade.signalType}${tags}`,
			);
		}
	}

	return lines.join("\n");
}

export function parsePatternAnalysisResponse(text: string): PatternObservation[] {
	try {
		const jsonStr = text
			.replace(/```json?\n?/g, "")
			.replace(/```/g, "")
			.trim();
		const parsed = JSON.parse(jsonStr);

		if (!Array.isArray(parsed)) return [];

		return parsed
			.filter(
				(obs: Record<string, unknown>) =>
					typeof obs.strategy_id === "number" &&
					typeof obs.pattern_type === "string" &&
					typeof obs.observation === "string" &&
					typeof obs.confidence === "number",
			)
			.map((obs: Record<string, unknown>) => ({
				strategyId: obs.strategy_id as number,
				patternType: obs.pattern_type as string,
				observation: obs.observation as string,
				affectedSymbols: Array.isArray(obs.affected_symbols)
					? (obs.affected_symbols as string[])
					: [],
				tags: Array.isArray(obs.tags)
					? (obs.tags as unknown[]).filter((t): t is string => typeof t === "string")
					: [],
				suggestedAction: (() => {
					if (obs.suggested_action == null) return null;
					const act = obs.suggested_action as Record<string, unknown>;
					const validDirections = ["increase", "decrease", "none"];
					if (
						typeof act.parameter !== "string" ||
						typeof act.direction !== "string" ||
						!validDirections.includes(act.direction) ||
						typeof act.reasoning !== "string"
					)
						return null;
					return {
						parameter: act.parameter,
						direction: act.direction as "increase" | "decrease" | "none",
						reasoning: act.reasoning,
					};
				})(),
				confidence: Math.max(0, Math.min(1, obs.confidence as number)),
			}));
	} catch {
		return [];
	}
}

export async function getRecentTradeClusters(lookbackDays = 7): Promise<StrategyTradeCluster[]> {
	const db = getDb();
	const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

	const allStrategies = await db
		.select({ id: strategies.id, name: strategies.name })
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	const clusters: StrategyTradeCluster[] = [];

	for (const strategy of allStrategies) {
		const trades = await db
			.select()
			.from(paperTrades)
			.where(and(eq(paperTrades.strategyId, strategy.id), gte(paperTrades.createdAt, since)))
			.orderBy(desc(paperTrades.createdAt));

		if (trades.length < 3) continue; // skip strategies with insufficient data

		// Fetch pattern tags from prior trade reviews.
		// TRA-39: exclude quarantined (pre-TRA-37) trade_review rows — their
		// direction labels were inverted by the buggy reviewer prompt and
		// would bias the pattern clusters fed to the pattern-analysis LLM.
		const insights = await db
			.select({ tradeId: tradeInsights.tradeId, tags: tradeInsights.tags })
			.from(tradeInsights)
			.where(
				and(
					eq(tradeInsights.strategyId, strategy.id),
					eq(tradeInsights.insightType, "trade_review"),
					eq(tradeInsights.quarantined, 0),
				),
			);

		const tagsByTradeId = new Map<number, string[]>();
		for (const insight of insights) {
			if (insight.tradeId != null && insight.tags) {
				try {
					tagsByTradeId.set(insight.tradeId, JSON.parse(insight.tags));
				} catch {
					tagsByTradeId.set(insight.tradeId, []);
				}
			}
		}

		clusters.push({
			strategyId: strategy.id,
			strategyName: strategy.name,
			trades: trades.map((t) => ({
				symbol: t.symbol,
				side: t.side,
				pnl: t.pnl ?? 0,
				holdDays: 1,
				signalType: t.signalType,
				patternTags: tagsByTradeId.get(t.id) ?? [],
			})),
		});
	}

	return clusters;
}

const VALID_SUGGESTION_EXCHANGES = new Set(["NASDAQ", "NYSE", "LSE"]);

export async function getMissedOpportunityContext(lookbackDays = 14): Promise<string[]> {
	const db = getDb();
	const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

	const rows = await db
		.select({ observation: tradeInsights.observation, tags: tradeInsights.tags })
		.from(tradeInsights)
		.where(
			and(eq(tradeInsights.insightType, "missed_opportunity"), gte(tradeInsights.createdAt, since)),
		)
		.orderBy(desc(tradeInsights.createdAt))
		.limit(20);

	return rows.map((r) => r.observation);
}

export function parseUniverseSuggestions(text: string): UniverseSuggestion[] {
	try {
		const cleaned = text
			.replace(/```json?\n?/g, "")
			.replace(/```/g, "")
			.trim();
		const parsed = JSON.parse(cleaned);

		if (!parsed || !Array.isArray(parsed.universe_suggestions)) return [];

		return parsed.universe_suggestions
			.filter(
				(s: Record<string, unknown>) =>
					typeof s.symbol === "string" &&
					typeof s.exchange === "string" &&
					VALID_SUGGESTION_EXCHANGES.has(s.exchange) &&
					typeof s.reason === "string" &&
					typeof s.evidence_count === "number",
			)
			.map((s: Record<string, unknown>) => ({
				symbol: s.symbol as string,
				exchange: s.exchange as string,
				reason: s.reason as string,
				evidenceCount: s.evidence_count as number,
			}));
	} catch {
		return [];
	}
}

export async function runPatternAnalysis(): Promise<{
	observations: number;
	skippedBudget: boolean;
}> {
	if (!(await canAffordCall(ANALYSIS_COST_USD))) {
		log.warn("Skipping pattern analysis — daily budget exceeded");
		return { observations: 0, skippedBudget: true };
	}

	const clusters = await getRecentTradeClusters();
	if (clusters.length === 0) {
		log.info("No trade clusters to analyze");
		return { observations: 0, skippedBudget: false };
	}

	const config = getConfig();
	const { promptText, promptVersion } = await getActivePrompt("pattern_analysis");
	const userMessage = buildPatternAnalysisPrompt(clusters);

	const missedOpps = await getMissedOpportunityContext();
	let fullMessage = userMessage;
	if (missedOpps.length > 0) {
		fullMessage += "\n\n--- Missed Opportunities (last 14 days) ---\n";
		fullMessage += missedOpps.map((o, i) => `${i + 1}. ${o}`).join("\n");
		fullMessage +=
			"\n\nIdentify patterns in these missed opportunities. Are there symbol relationships the system should watch? If evidence supports it, include a 'universe_suggestions' array in your response with: symbol, exchange (NASDAQ/NYSE/LSE), reason, evidence_count.";
	}

	try {
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const response = await withRetry(
			() =>
				client.messages.create({
					model: config.CLAUDE_MODEL_FAST,
					max_tokens: 1500,
					system: promptText,
					messages: [{ role: "user", content: fullMessage }],
				}),
			"pattern-analysis",
			{ maxAttempts: 2, baseDelayMs: 1000 },
		);

		const text = response.content[0]?.type === "text" ? response.content[0].text : "";
		await recordUsage(
			"pattern_analysis",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

		const observations = parsePatternAnalysisResponse(text);
		const db = getDb();

		for (const obs of observations) {
			await db.insert(tradeInsights).values({
				strategyId: obs.strategyId,
				insightType: "pattern_analysis",
				tags: JSON.stringify(obs.tags),
				observation: `[${obs.patternType}] ${obs.observation}`,
				suggestedAction: obs.suggestedAction ? JSON.stringify(obs.suggestedAction) : null,
				confidence: obs.confidence,
				promptVersion,
			});
		}

		const suggestions = parseUniverseSuggestions(text);
		for (const suggestion of suggestions) {
			await db.insert(tradeInsights).values({
				strategyId: null,
				insightType: "universe_suggestion",
				observation: `Add ${suggestion.symbol} (${suggestion.exchange}): ${suggestion.reason}`,
				tags: JSON.stringify(["universe_suggestion", suggestion.symbol]),
				confidence: Math.min(1, suggestion.evidenceCount / 5),
			});
		}

		if (suggestions.length > 0) {
			log.info(
				{ count: suggestions.length, symbols: suggestions.map((s) => s.symbol) },
				"Universe suggestions generated",
			);
		}

		log.info({ count: observations.length }, "Pattern analysis complete");

		// Feedback-driven watchlist promotions
		try {
			const fb = await checkFeedbackPromotions();
			log.info({ promoted: fb.promoted }, "Feedback watchlist promotions complete");
		} catch (err) {
			log.error({ err }, "Feedback watchlist promotions failed");
		}

		return { observations: observations.length, skippedBudget: false };
	} catch (error) {
		log.error({ error }, "Pattern analysis API call failed");
		return { observations: 0, skippedBudget: false };
	}
}

// Scans tradeInsights (insightType="missed_opportunity") from the last
// FEEDBACK_INSIGHT_WINDOW_DAYS. For each symbol (parsed from tags[2]) with
// >= FEEDBACK_INSIGHT_THRESHOLD insights at confidence >= FEEDBACK_MIN_CONFIDENCE,
// writes a catalyst event and promotes to the watchlist.
export async function checkFeedbackPromotions(): Promise<{ promoted: number }> {
	const db = getDb();
	const cutoff = new Date(Date.now() - FEEDBACK_INSIGHT_WINDOW_DAYS * 86_400_000).toISOString();

	const rows = db
		.select({ tags: tradeInsights.tags })
		.from(tradeInsights)
		.where(
			and(
				eq(tradeInsights.insightType, "missed_opportunity"),
				gte(tradeInsights.confidence, FEEDBACK_MIN_CONFIDENCE),
				gte(tradeInsights.createdAt, cutoff),
			),
		)
		.all();

	const symbolCounts = new Map<string, number>();
	for (const row of rows) {
		if (!row.tags) continue;
		let tags: unknown;
		try {
			tags = JSON.parse(row.tags);
		} catch {
			continue;
		}
		if (!Array.isArray(tags) || tags.length < 3) continue;
		const symbol = tags[2];
		if (typeof symbol !== "string" || !symbol) continue;
		symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
	}

	let promoted = 0;
	for (const [symbol, count] of symbolCounts) {
		if (count < FEEDBACK_INSIGHT_THRESHOLD) continue;

		// Resolve exchange via investable_universe (must be unique + active)
		const universeRows = db
			.select({ exchange: investableUniverse.exchange })
			.from(investableUniverse)
			.where(and(eq(investableUniverse.symbol, symbol), eq(investableUniverse.active, true)))
			.all();
		if (universeRows.length !== 1) continue; // skip ambiguous / unknown
		const exchange = universeRows[0]!.exchange;

		const eventId = writeCatalystEvent({
			symbol,
			exchange,
			eventType: "feedback",
			source: "pattern_analysis",
			payload: { insightCount: count },
		});

		const result = await promoteToWatchlist({
			symbol,
			exchange,
			reason: "feedback",
			payload: { insightCount: count },
		});

		if (result.status === "inserted" || result.status === "updated") {
			markLedToPromotion(eventId);
			promoted++;
		}
	}

	return { promoted };
}
