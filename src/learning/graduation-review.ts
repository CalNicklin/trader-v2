import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { tradeInsights } from "../db/schema.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { getActivePrompt } from "./prompts.ts";
import type { GraduationReviewInput, GraduationReviewResult } from "./types.ts";

const log = createChildLogger({ module: "graduation-review" });

const GRADUATION_REVIEW_COST_USD = 0.0005;

export function buildGraduationPrompt(input: GraduationReviewInput): string {
	const lines = [
		`Strategy: ${input.strategyName} (id: ${input.strategyId})`,
		``,
		`Metrics:`,
		`  Sample size: ${input.metrics.sampleSize}`,
		`  Win rate: ${input.metrics.winRate != null ? `${(input.metrics.winRate * 100).toFixed(1)}%` : "N/A"}`,
		`  Expectancy: ${input.metrics.expectancy ?? "N/A"}`,
		`  Profit factor: ${input.metrics.profitFactor ?? "N/A"}`,
		`  Sharpe ratio: ${input.metrics.sharpeRatio ?? "N/A"}`,
		`  Max drawdown: ${input.metrics.maxDrawdownPct != null ? `${(input.metrics.maxDrawdownPct * 100).toFixed(1)}%` : "N/A"}`,
		`  Consistency: ${input.metrics.consistencyScore ?? "N/A"}/4 profitable weeks`,
		``,
		`Recent trades (last ${input.recentTrades.length}):`,
	];

	for (const trade of input.recentTrades) {
		lines.push(
			`  ${trade.symbol} ${trade.side} | PnL: ${trade.pnl ?? "open"} | ${trade.createdAt}`,
		);
	}

	if (input.patternInsights.length > 0) {
		lines.push(``, `Pattern insights from learning loop:`);
		for (const insight of input.patternInsights) {
			lines.push(`  - ${insight}`);
		}
	}

	return lines.join("\n");
}

export function parseGraduationResponse(text: string): GraduationReviewResult | null {
	try {
		const jsonStr = text
			.replace(/```json?\n?/g, "")
			.replace(/```/g, "")
			.trim();
		const parsed = JSON.parse(jsonStr);

		const validRecs = ["graduate", "hold", "concerns"];
		if (!validRecs.includes(parsed.recommendation)) return null;
		if (typeof parsed.confidence !== "number") return null;
		if (typeof parsed.reasoning !== "string") return null;

		return {
			recommendation: parsed.recommendation as "graduate" | "hold" | "concerns",
			confidence: Math.max(0, Math.min(1, parsed.confidence)),
			reasoning: parsed.reasoning,
			riskFlags: Array.isArray(parsed.risk_flags)
				? parsed.risk_flags.filter((f: unknown) => typeof f === "string")
				: [],
			suggestedConditions:
				typeof parsed.suggested_conditions === "string" ? parsed.suggested_conditions : "",
		};
	} catch {
		return null;
	}
}

export async function getPatternInsightsForStrategy(strategyId: number): Promise<string[]> {
	const db = getDb();
	const insights = await db
		.select({ observation: tradeInsights.observation, tags: tradeInsights.tags })
		.from(tradeInsights)
		.where(
			and(
				eq(tradeInsights.strategyId, strategyId),
				eq(tradeInsights.insightType, "pattern_analysis"),
			),
		);

	return insights.map((i) => i.observation);
}

export async function reviewForGraduation(
	input: GraduationReviewInput,
): Promise<GraduationReviewResult | null> {
	const config = getConfig();

	if (!(await canAffordCall(GRADUATION_REVIEW_COST_USD))) {
		log.warn("Skipping graduation review — daily budget exceeded");
		return null;
	}

	const { promptText, promptVersion } = await getActivePrompt("graduation");
	const userMessage = buildGraduationPrompt(input);

	try {
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const response = await withRetry(
			() =>
				client.messages.create({
					model: config.CLAUDE_MODEL_FAST,
					max_tokens: 300,
					system: promptText,
					messages: [{ role: "user", content: userMessage }],
				}),
			`graduation-review-${input.strategyId}`,
			{ maxAttempts: 2, baseDelayMs: 1000 },
		);

		const text = response.content[0]?.type === "text" ? response.content[0].text : "";
		await recordUsage(
			"graduation_review",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

		const result = parseGraduationResponse(text);
		if (!result) {
			log.warn(
				{ strategyId: input.strategyId, response: text },
				"Failed to parse graduation review",
			);
			return null;
		}

		// Store insight
		const db = getDb();
		await db.insert(tradeInsights).values({
			strategyId: input.strategyId,
			insightType: "graduation",
			tags: JSON.stringify(result.riskFlags),
			observation: `${result.recommendation}: ${result.reasoning}`,
			confidence: result.confidence,
			promptVersion,
		});

		log.info(
			{
				strategyId: input.strategyId,
				recommendation: result.recommendation,
				confidence: result.confidence,
			},
			"Graduation review complete",
		);

		return result;
	} catch (error) {
		log.error({ strategyId: input.strategyId, error }, "Graduation review API call failed");
		return null;
	}
}
