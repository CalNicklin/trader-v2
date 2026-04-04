import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, desc } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { paperTrades, strategies, tradeInsights } from "../db/schema.ts";
import { getConfig } from "../config.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { getActivePrompt } from "./prompts.ts";
import type { PatternObservation } from "./types.ts";

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
			const tags =
				trade.patternTags.length > 0 ? ` [tags: ${trade.patternTags.join(", ")}]` : "";
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
				suggestedAction:
					obs.suggested_action != null &&
					typeof (obs.suggested_action as Record<string, unknown>).parameter === "string"
						? {
								parameter: (obs.suggested_action as Record<string, string>).parameter,
								direction: (obs.suggested_action as Record<string, string>).direction as
									| "increase"
									| "decrease"
									| "none",
								reasoning: (obs.suggested_action as Record<string, string>).reasoning,
							}
						: null,
				confidence: Math.max(0, Math.min(1, obs.confidence as number)),
			}));
	} catch {
		return [];
	}
}

export async function getRecentTradeClusters(
	lookbackDays = 7,
): Promise<StrategyTradeCluster[]> {
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
			.where(
				and(eq(paperTrades.strategyId, strategy.id), gte(paperTrades.createdAt, since)),
			)
			.orderBy(desc(paperTrades.createdAt));

		if (trades.length < 3) continue; // skip strategies with insufficient data

		// Fetch pattern tags from prior trade reviews
		const insights = await db
			.select({ tradeId: tradeInsights.tradeId, tags: tradeInsights.tags })
			.from(tradeInsights)
			.where(
				and(
					eq(tradeInsights.strategyId, strategy.id),
					eq(tradeInsights.insightType, "trade_review"),
				),
			);

		const tagsByTradeId = new Map<number, string[]>();
		for (const insight of insights) {
			if (insight.tradeId != null && insight.tags) {
				tagsByTradeId.set(insight.tradeId, JSON.parse(insight.tags));
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

	try {
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const response = await withRetry(
			() =>
				client.messages.create({
					model: config.CLAUDE_MODEL_FAST,
					max_tokens: 500,
					system: promptText,
					messages: [{ role: "user", content: userMessage }],
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

		log.info({ count: observations.length }, "Pattern analysis complete");
		return { observations: observations.length, skippedBudget: false };
	} catch (error) {
		log.error({ error }, "Pattern analysis API call failed");
		return { observations: 0, skippedBudget: false };
	}
}
