import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { newsEvents, paperTrades, strategies, tradeInsights } from "../db/schema.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { getActivePrompt } from "./prompts.ts";
import type { TradeForReview, TradeReviewResult } from "./types.ts";

const log = createChildLogger({ module: "trade-review" });

const REVIEW_COST_PER_TRADE_USD = 0.0003;

export function buildTradeReviewPrompt(trade: TradeForReview): string {
	const lines = [
		`Strategy: ${trade.strategyName}`,
		`Symbol: ${trade.symbol} (${trade.exchange})`,
		`Side: ${trade.side}`,
		`Entry: ${trade.entryPrice} → Exit: ${trade.exitPrice}`,
		`PnL: ${trade.pnl} (after ${trade.friction} friction)`,
		`Hold: ${trade.holdDays} day(s)`,
		`Signal: ${trade.signalType} — ${trade.reasoning ?? "no reasoning recorded"}`,
	];

	if (trade.newsContextAtEntry) {
		lines.push(`News at entry: ${trade.newsContextAtEntry}`);
	}

	return lines.join("\n");
}

export function parseTradeReviewResponse(text: string, tradeId: number): TradeReviewResult | null {
	try {
		const jsonStr = text
			.replace(/```json?\n?/g, "")
			.replace(/```/g, "")
			.trim();
		const parsed = JSON.parse(jsonStr);

		if (typeof parsed.outcome_quality !== "string") return null;
		if (typeof parsed.what_worked !== "string") return null;
		if (typeof parsed.what_failed !== "string") return null;
		if (!Array.isArray(parsed.pattern_tags)) return null;
		if (typeof parsed.market_context !== "string") return null;
		if (typeof parsed.confidence !== "number") return null;

		let suggestedAdj = null;
		if (parsed.suggested_parameter_adjustment != null) {
			const adj = parsed.suggested_parameter_adjustment;
			if (
				typeof adj.parameter === "string" &&
				typeof adj.direction === "string" &&
				typeof adj.reasoning === "string"
			) {
				suggestedAdj = {
					parameter: adj.parameter,
					direction: adj.direction as "increase" | "decrease" | "none",
					reasoning: adj.reasoning,
				};
			}
		}

		return {
			tradeId,
			outcomeQuality: parsed.outcome_quality,
			whatWorked: parsed.what_worked,
			whatFailed: parsed.what_failed,
			patternTags: parsed.pattern_tags.filter((t: unknown) => typeof t === "string"),
			suggestedParameterAdjustment: suggestedAdj,
			marketContext: parsed.market_context,
			confidence: Math.max(0, Math.min(1, parsed.confidence)),
		};
	} catch {
		return null;
	}
}

export async function getTodaysClosedTrades(): Promise<TradeForReview[]> {
	const db = getDb();
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);

	const exitTrades = await db
		.select()
		.from(paperTrades)
		.where(
			and(
				eq(paperTrades.signalType, "exit"),
				gte(paperTrades.createdAt, todayStart.toISOString()),
				isNotNull(paperTrades.pnl),
			),
		);

	const result: TradeForReview[] = [];

	for (const trade of exitTrades) {
		const strategyRow = await db
			.select({ name: strategies.name })
			.from(strategies)
			.where(eq(strategies.id, trade.strategyId))
			.limit(1);

		// Find matching entry trade for this position
		const entryTrades = await db
			.select()
			.from(paperTrades)
			.where(
				and(
					eq(paperTrades.strategyId, trade.strategyId),
					eq(paperTrades.symbol, trade.symbol),
					eq(paperTrades.exchange, trade.exchange),
				),
			);
		const entryTrade = entryTrades.find(
			(t) => t.signalType === "entry_long" || t.signalType === "entry_short",
		);

		const entryPrice = entryTrade?.price ?? trade.price;
		const entryDate = entryTrade?.createdAt ?? trade.createdAt;
		const holdDays = Math.max(
			1,
			Math.floor(
				(new Date(trade.createdAt).getTime() - new Date(entryDate).getTime()) /
					(1000 * 60 * 60 * 24),
			),
		);

		// Find news context around entry time
		let newsContext: string | null = null;
		if (entryTrade) {
			const entryTime = new Date(entryTrade.createdAt);
			const windowStart = new Date(entryTime.getTime() - 24 * 60 * 60 * 1000);
			const recentNews = await db
				.select({ headline: newsEvents.headline })
				.from(newsEvents)
				.where(
					and(gte(newsEvents.createdAt, windowStart.toISOString()), eq(newsEvents.tradeable, true)),
				)
				.limit(3);
			if (recentNews.length > 0) {
				newsContext = recentNews.map((n) => n.headline).join("; ");
			}
		}

		result.push({
			tradeId: trade.id,
			strategyId: trade.strategyId,
			strategyName: strategyRow[0]?.name ?? "unknown",
			symbol: trade.symbol,
			exchange: trade.exchange,
			side: trade.side as "BUY" | "SELL",
			quantity: trade.quantity,
			entryPrice,
			exitPrice: trade.price,
			pnl: trade.pnl ?? 0,
			friction: trade.friction,
			holdDays,
			signalType: trade.signalType,
			reasoning: entryTrade?.reasoning ?? null,
			newsContextAtEntry: newsContext,
		});
	}

	return result;
}

export async function reviewTrade(trade: TradeForReview): Promise<TradeReviewResult | null> {
	const config = getConfig();

	if (!(await canAffordCall(REVIEW_COST_PER_TRADE_USD))) {
		log.warn("Skipping trade review — daily budget exceeded");
		return null;
	}

	const { promptText, promptVersion } = await getActivePrompt("trade_review");
	const userMessage = buildTradeReviewPrompt(trade);

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
			`trade-review-${trade.symbol}`,
			{ maxAttempts: 2, baseDelayMs: 1000 },
		);

		const text = response.content[0]?.type === "text" ? response.content[0].text : "";
		await recordUsage("trade_review", response.usage.input_tokens, response.usage.output_tokens);

		const result = parseTradeReviewResponse(text, trade.tradeId);
		if (!result) {
			log.warn({ tradeId: trade.tradeId, response: text }, "Failed to parse trade review");
			return null;
		}

		// Store insight
		const db = getDb();
		await db.insert(tradeInsights).values({
			strategyId: trade.strategyId,
			tradeId: trade.tradeId,
			insightType: "trade_review",
			tags: JSON.stringify(result.patternTags),
			observation: `${result.outcomeQuality}: ${result.whatWorked}. ${result.whatFailed}`,
			suggestedAction: result.suggestedParameterAdjustment
				? JSON.stringify(result.suggestedParameterAdjustment)
				: null,
			confidence: result.confidence,
			promptVersion,
		});

		return result;
	} catch (error) {
		log.error({ tradeId: trade.tradeId, error }, "Trade review API call failed");
		return null;
	}
}

export async function runDailyTradeReview(): Promise<{
	reviewed: number;
	skippedBudget: boolean;
}> {
	const trades = await getTodaysClosedTrades();
	log.info({ tradeCount: trades.length }, "Starting daily trade review");

	if (trades.length === 0) {
		return { reviewed: 0, skippedBudget: false };
	}

	let reviewed = 0;
	for (const trade of trades) {
		const result = await reviewTrade(trade);
		if (result) {
			reviewed++;
			log.info(
				{
					tradeId: trade.tradeId,
					symbol: trade.symbol,
					tags: result.patternTags,
					quality: result.outcomeQuality,
				},
				"Trade reviewed",
			);
		} else {
			// If budget exceeded, stop reviewing
			if (!(await canAffordCall(REVIEW_COST_PER_TRADE_USD))) {
				log.warn("Stopping trade review — budget exceeded");
				return { reviewed, skippedBudget: true };
			}
		}
	}

	return { reviewed, skippedBudget: false };
}
