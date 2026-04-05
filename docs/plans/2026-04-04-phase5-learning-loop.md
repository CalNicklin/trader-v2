# Phase 5: Learning Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the self-evolving learning loop — daily trade reviews, pattern analysis, graduation reasoning, and meta-evolution of review prompts — so the system learns from outcomes and feeds insights into strategy evolution.

**Architecture:** Three Haiku-powered review components (trade review, pattern analysis, graduation reasoning) write structured insights to a `trade_insights` table. Versioned prompts live in `learning_loop_config`. The evolution cycle reads insights when proposing mutations. A meta-evolution layer tracks which insights led to improvements and tunes the review prompts over time.

**Tech Stack:** Bun, TypeScript, Drizzle ORM (SQLite), @anthropic-ai/sdk (Haiku), node-cron

---

## File Structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` | Add `tradeInsights` and `learningLoopConfig` tables |
| `src/learning/types.ts` | Type definitions for trade review, pattern analysis, insights |
| `src/learning/trade-review.ts` | Daily Haiku trade review — produces per-trade insights |
| `src/learning/pattern-analysis.ts` | 2x/week pattern analysis across trade clusters |
| `src/learning/graduation-review.ts` | Haiku qualitative review before graduation |
| `src/learning/prompts.ts` | Default prompt templates and prompt loader from DB |
| `src/learning/meta-evolution.ts` | Track insight hit rates, propose prompt tweaks |
| `src/scheduler/trade-review-job.ts` | Scheduler job wrapper for daily trade review |
| `src/scheduler/pattern-analysis-job.ts` | Scheduler job wrapper for pattern analysis |
| `tests/learning/trade-review.test.ts` | Tests for trade review prompt + parsing |
| `tests/learning/pattern-analysis.test.ts` | Tests for pattern analysis prompt + parsing |
| `tests/learning/graduation-review.test.ts` | Tests for graduation reasoning |
| `tests/learning/prompts.test.ts` | Tests for prompt loading and versioning |
| `tests/learning/meta-evolution.test.ts` | Tests for hit rate tracking |

---

### Task 1: Database Schema — Add `tradeInsights` and `learningLoopConfig` Tables

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add `tradeInsights` table to schema**

Add after the `strategyMutations` table block in `src/db/schema.ts`:

```typescript
// ── Learning Loop ────────────────────────────��─────────────────────────────

export const tradeInsights = sqliteTable("trade_insights", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	strategyId: integer("strategy_id").notNull(),
	tradeId: integer("trade_id"),
	insightType: text("insight_type", {
		enum: ["trade_review", "pattern_analysis", "graduation"],
	}).notNull(),
	tags: text("tags"), // JSON: string[]
	observation: text("observation").notNull(),
	suggestedAction: text("suggested_action"), // JSON: { parameter, direction, reasoning }
	confidence: real("confidence"),
	promptVersion: integer("prompt_version"),
	ledToImprovement: integer("led_to_improvement", { mode: "boolean" }),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});

export const learningLoopConfig = sqliteTable("learning_loop_config", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	configType: text("config_type", {
		enum: ["trade_review", "pattern_analysis", "graduation"],
	}).notNull(),
	promptVersion: integer("prompt_version").notNull().default(1),
	promptText: text("prompt_text").notNull(),
	active: integer("active", { mode: "boolean" }).notNull().default(true),
	hitRate: real("hit_rate"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	retiredAt: text("retired_at"),
});
```

- [ ] **Step 2: Generate migration**

Run: `bunx drizzle-kit generate`
Expected: New migration file in `drizzle/migrations/`

- [ ] **Step 3: Verify migration applies**

Run: `bun test tests/db/schema.test.ts`
Expected: PASS (existing schema tests still pass — migration is additive)

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts drizzle/migrations/
git commit -m "feat: add trade_insights and learning_loop_config tables"
```

---

### Task 2: Learning Loop Types

**Files:**
- Create: `src/learning/types.ts`

- [ ] **Step 1: Create types file**

```typescript
export interface TradeForReview {
	tradeId: number;
	strategyId: number;
	strategyName: string;
	symbol: string;
	exchange: string;
	side: "BUY" | "SELL";
	quantity: number;
	entryPrice: number;
	exitPrice: number;
	pnl: number;
	friction: number;
	holdDays: number;
	signalType: string;
	reasoning: string | null;
	newsContextAtEntry: string | null;
}

export interface TradeReviewResult {
	tradeId: number;
	outcomeQuality: string;
	whatWorked: string;
	whatFailed: string;
	patternTags: string[];
	suggestedParameterAdjustment: {
		parameter: string;
		direction: "increase" | "decrease" | "none";
		reasoning: string;
	} | null;
	marketContext: string;
	confidence: number;
}

export interface PatternObservation {
	strategyId: number;
	patternType: string;
	observation: string;
	affectedSymbols: string[];
	tags: string[];
	suggestedAction: {
		parameter: string;
		direction: "increase" | "decrease" | "none";
		reasoning: string;
	} | null;
	confidence: number;
}

export interface PatternAnalysisResult {
	observations: PatternObservation[];
	timestamp: string;
}

export interface GraduationReviewInput {
	strategyId: number;
	strategyName: string;
	metrics: {
		sampleSize: number;
		winRate: number | null;
		expectancy: number | null;
		profitFactor: number | null;
		sharpeRatio: number | null;
		maxDrawdownPct: number | null;
		consistencyScore: number | null;
	};
	recentTrades: Array<{
		symbol: string;
		side: string;
		pnl: number | null;
		createdAt: string;
	}>;
	patternInsights: string[];
}

export interface GraduationReviewResult {
	recommendation: "graduate" | "hold" | "concerns";
	confidence: number;
	reasoning: string;
	riskFlags: string[];
	suggestedConditions: string;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/learning/types.ts
git commit -m "feat: add learning loop type definitions"
```

---

### Task 3: Default Prompt Templates and Prompt Loader

**Files:**
- Create: `src/learning/prompts.ts`
- Test: `tests/learning/prompts.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("learning loop prompts", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { learningLoopConfig } = await import("../../src/db/schema.ts");
		await db.delete(learningLoopConfig);
	});

	test("getActivePrompt returns default when no DB entry exists", async () => {
		const { getActivePrompt } = await import("../../src/learning/prompts.ts");

		const prompt = await getActivePrompt("trade_review");
		expect(prompt.promptText).toContain("financial trade reviewer");
		expect(prompt.promptVersion).toBe(0);
	});

	test("getActivePrompt returns DB entry when one exists", async () => {
		const { learningLoopConfig } = await import("../../src/db/schema.ts");
		const { getActivePrompt } = await import("../../src/learning/prompts.ts");

		await db.insert(learningLoopConfig).values({
			configType: "trade_review",
			promptVersion: 2,
			promptText: "Custom prompt v2",
			active: true,
		});

		const prompt = await getActivePrompt("trade_review");
		expect(prompt.promptText).toBe("Custom prompt v2");
		expect(prompt.promptVersion).toBe(2);
	});

	test("getActivePrompt ignores inactive entries", async () => {
		const { learningLoopConfig } = await import("../../src/db/schema.ts");
		const { getActivePrompt } = await import("../../src/learning/prompts.ts");

		await db.insert(learningLoopConfig).values({
			configType: "trade_review",
			promptVersion: 3,
			promptText: "Retired prompt",
			active: false,
			retiredAt: new Date().toISOString(),
		});

		const prompt = await getActivePrompt("trade_review");
		expect(prompt.promptVersion).toBe(0); // falls back to default
	});

	test("DEFAULT_PROMPTS has entries for all three config types", async () => {
		const { DEFAULT_PROMPTS } = await import("../../src/learning/prompts.ts");

		expect(DEFAULT_PROMPTS.trade_review).toBeDefined();
		expect(DEFAULT_PROMPTS.pattern_analysis).toBeDefined();
		expect(DEFAULT_PROMPTS.graduation).toBeDefined();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/learning/prompts.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement prompts.ts**

```typescript
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { learningLoopConfig } from "../db/schema.ts";

type ConfigType = "trade_review" | "pattern_analysis" | "graduation";

export const DEFAULT_PROMPTS: Record<ConfigType, string> = {
	trade_review: `You are a financial trade reviewer for an autonomous trading system.

Analyze the completed trade and return a JSON object with these fields:
- outcome_quality: string — brief label (e.g., "good_entry_early_exit", "bad_signal_correct_stop", "profitable_as_expected")
- what_worked: string — what the strategy got right
- what_failed: string — what could be improved (or "nothing" if trade was clean)
- pattern_tags: string[] — 1-3 reusable tags for recurring patterns (e.g., "stop_too_tight", "earnings_drift_truncated", "regime_mismatch")
- suggested_parameter_adjustment: object | null — { parameter: string, direction: "increase"|"decrease"|"none", reasoning: string }
- market_context: string — relevant market conditions during the trade
- confidence: number — 0.0 to 1.0, how confident in this analysis

Focus on actionable insights. Avoid generic observations. If the trade was straightforward, say so briefly.

Return ONLY the JSON object, no other text.`,

	pattern_analysis: `You are a pattern analyst for an autonomous trading system.

You are given a batch of recent trades grouped by strategy. Identify recurring patterns, failure modes, and regime observations.

For each observation, return a JSON object in an array:
- strategy_id: number
- pattern_type: string — one of: "recurring_failure", "regime_sensitivity", "cross_strategy", "edge_decay", "timing_pattern", "universe_issue"
- observation: string — what you found
- affected_symbols: string[] — which symbols are involved
- tags: string[] — 1-3 reusable pattern tags
- suggested_action: object | null — { parameter: string, direction: "increase"|"decrease"|"none", reasoning: string }
- confidence: number — 0.0 to 1.0

Return ONLY a JSON array of observation objects.
Focus on patterns that appear 3+ times. Ignore one-off events.`,

	graduation: `You are a graduation reviewer for an autonomous trading system.

A strategy has passed the statistical criteria for promotion to live trading. Your job is to assess whether the edge appears real and durable.

Answer these questions:
1. Is this edge regime-dependent? (e.g., only works in bull markets)
2. Are wins concentrated in a few large trades or distributed?
3. Does the universe still make sense?
4. Are there pattern tags suggesting systematic weaknesses?
5. Would this strategy survive a regime change?

Return a JSON object:
- recommendation: "graduate" | "hold" | "concerns"
- confidence: number — 0.0 to 1.0
- reasoning: string — 2-3 sentence explanation
- risk_flags: string[] — any concerns
- suggested_conditions: string — monitoring conditions for first live trades

Return ONLY the JSON object, no other text.`,
};

export interface ActivePrompt {
	promptText: string;
	promptVersion: number;
}

export async function getActivePrompt(configType: ConfigType): Promise<ActivePrompt> {
	const db = getDb();

	const rows = await db
		.select()
		.from(learningLoopConfig)
		.where(
			and(
				eq(learningLoopConfig.configType, configType),
				eq(learningLoopConfig.active, true),
			),
		)
		.orderBy(desc(learningLoopConfig.promptVersion))
		.limit(1);

	if (rows.length > 0) {
		return {
			promptText: rows[0]!.promptText,
			promptVersion: rows[0]!.promptVersion,
		};
	}

	return {
		promptText: DEFAULT_PROMPTS[configType],
		promptVersion: 0,
	};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/learning/prompts.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/learning/prompts.ts tests/learning/prompts.test.ts
git commit -m "feat: add learning loop prompt templates and DB-backed loader"
```

---

### Task 4: Daily Trade Review

**Files:**
- Create: `src/learning/trade-review.ts`
- Test: `tests/learning/trade-review.test.ts`

- [ ] **Step 1: Write failing tests for prompt building and response parsing**

```typescript
import { describe, expect, test } from "bun:test";

describe("trade review", () => {
	test("buildTradeReviewPrompt includes trade details", async () => {
		const { buildTradeReviewPrompt } = await import("../../src/learning/trade-review.ts");

		const prompt = buildTradeReviewPrompt({
			tradeId: 1,
			strategyId: 1,
			strategyName: "news_sentiment_mr_v1",
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			quantity: 10,
			entryPrice: 150.0,
			exitPrice: 155.0,
			pnl: 49.5,
			friction: 0.5,
			holdDays: 2,
			signalType: "entry_long",
			reasoning: "Entry signal: news_sentiment > 0.7 AND rsi14 < 30",
			newsContextAtEntry: "Apple beats Q4 earnings estimates, raises guidance",
		});

		expect(prompt).toContain("AAPL");
		expect(prompt).toContain("150");
		expect(prompt).toContain("155");
		expect(prompt).toContain("49.5");
		expect(prompt).toContain("news_sentiment_mr_v1");
		expect(prompt).toContain("Apple beats Q4 earnings");
	});

	test("parseTradeReviewResponse extracts valid result", async () => {
		const { parseTradeReviewResponse } = await import("../../src/learning/trade-review.ts");

		const json = JSON.stringify({
			outcome_quality: "good_entry_early_exit",
			what_worked: "Sentiment signal correctly identified earnings direction",
			what_failed: "Exit triggered before full drift played out",
			pattern_tags: ["earnings_drift_truncated"],
			suggested_parameter_adjustment: {
				parameter: "hold_days",
				direction: "increase",
				reasoning: "Post-earnings drift typically extends 3-5 days",
			},
			market_context: "Low volatility, trending market",
			confidence: 0.75,
		});

		const result = parseTradeReviewResponse(json, 1);
		expect(result).not.toBeNull();
		expect(result!.tradeId).toBe(1);
		expect(result!.outcomeQuality).toBe("good_entry_early_exit");
		expect(result!.patternTags).toEqual(["earnings_drift_truncated"]);
		expect(result!.suggestedParameterAdjustment).not.toBeNull();
		expect(result!.suggestedParameterAdjustment!.direction).toBe("increase");
		expect(result!.confidence).toBeCloseTo(0.75);
	});

	test("parseTradeReviewResponse returns null for invalid JSON", async () => {
		const { parseTradeReviewResponse } = await import("../../src/learning/trade-review.ts");

		expect(parseTradeReviewResponse("not json", 1)).toBeNull();
		expect(parseTradeReviewResponse("{}", 1)).toBeNull();
	});

	test("parseTradeReviewResponse handles missing optional fields", async () => {
		const { parseTradeReviewResponse } = await import("../../src/learning/trade-review.ts");

		const json = JSON.stringify({
			outcome_quality: "clean_profit",
			what_worked: "Everything worked as expected",
			what_failed: "nothing",
			pattern_tags: [],
			suggested_parameter_adjustment: null,
			market_context: "Normal conditions",
			confidence: 0.9,
		});

		const result = parseTradeReviewResponse(json, 5);
		expect(result).not.toBeNull();
		expect(result!.suggestedParameterAdjustment).toBeNull();
		expect(result!.patternTags).toEqual([]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/learning/trade-review.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement trade-review.ts**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { paperTrades, strategies, tradeInsights, newsEvents } from "../db/schema.ts";
import { getConfig } from "../config.ts";
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

export function parseTradeReviewResponse(
	text: string,
	tradeId: number,
): TradeReviewResult | null {
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
					and(
						gte(newsEvents.createdAt, windowStart.toISOString()),
						eq(newsEvents.tradeable, true),
					),
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

export async function reviewTrade(
	trade: TradeForReview,
): Promise<TradeReviewResult | null> {
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
		await recordUsage(
			"trade_review",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/learning/trade-review.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/learning/trade-review.ts tests/learning/trade-review.test.ts
git commit -m "feat: add daily trade review with Haiku classification"
```

---

### Task 5: Pattern Analysis

**Files:**
- Create: `src/learning/pattern-analysis.ts`
- Test: `tests/learning/pattern-analysis.test.ts`

- [ ] **Step 1: Write failing tests for prompt building and response parsing**

```typescript
import { describe, expect, test } from "bun:test";

describe("pattern analysis", () => {
	test("buildPatternAnalysisPrompt includes strategy trade data", async () => {
		const { buildPatternAnalysisPrompt } = await import(
			"../../src/learning/pattern-analysis.ts"
		);

		const prompt = buildPatternAnalysisPrompt([
			{
				strategyId: 1,
				strategyName: "news_sentiment_mr_v1",
				trades: [
					{
						symbol: "AAPL",
						side: "BUY",
						pnl: 50,
						holdDays: 2,
						signalType: "entry_long",
						patternTags: ["stop_too_tight"],
					},
					{
						symbol: "AAPL",
						side: "BUY",
						pnl: -20,
						holdDays: 1,
						signalType: "entry_long",
						patternTags: ["stop_too_tight"],
					},
				],
			},
		]);

		expect(prompt).toContain("news_sentiment_mr_v1");
		expect(prompt).toContain("AAPL");
		expect(prompt).toContain("stop_too_tight");
	});

	test("parsePatternAnalysisResponse extracts valid observations", async () => {
		const { parsePatternAnalysisResponse } = await import(
			"../../src/learning/pattern-analysis.ts"
		);

		const json = JSON.stringify([
			{
				strategy_id: 1,
				pattern_type: "recurring_failure",
				observation: "Stop losses triggering too early on post-earnings moves",
				affected_symbols: ["AAPL", "MSFT"],
				tags: ["stop_too_tight", "earnings_drift"],
				suggested_action: {
					parameter: "trailing_stop_multiplier",
					direction: "increase",
					reasoning: "ATR-based stops too tight for earnings volatility",
				},
				confidence: 0.8,
			},
		]);

		const result = parsePatternAnalysisResponse(json);
		expect(result).toHaveLength(1);
		expect(result[0]!.strategyId).toBe(1);
		expect(result[0]!.patternType).toBe("recurring_failure");
		expect(result[0]!.tags).toContain("stop_too_tight");
		expect(result[0]!.suggestedAction).not.toBeNull();
	});

	test("parsePatternAnalysisResponse returns empty array for invalid JSON", async () => {
		const { parsePatternAnalysisResponse } = await import(
			"../../src/learning/pattern-analysis.ts"
		);

		expect(parsePatternAnalysisResponse("not json")).toEqual([]);
		expect(parsePatternAnalysisResponse("{}")).toEqual([]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/learning/pattern-analysis.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement pattern-analysis.ts**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte, desc } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import {
	paperTrades,
	strategies,
	tradeInsights,
} from "../db/schema.ts";
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
	lookbackDays: number = 7,
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
				and(
					eq(paperTrades.strategyId, strategy.id),
					gte(paperTrades.createdAt, since),
				),
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
			trades: trades.map((t) => {
				const entryDate = new Date(t.createdAt);
				return {
					symbol: t.symbol,
					side: t.side,
					pnl: t.pnl ?? 0,
					holdDays: 1,
					signalType: t.signalType,
					patternTags: tagsByTradeId.get(t.id) ?? [],
				};
			}),
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/learning/pattern-analysis.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/learning/pattern-analysis.ts tests/learning/pattern-analysis.test.ts
git commit -m "feat: add pattern analysis with trade cluster review"
```

---

### Task 6: Graduation Reasoning Review

**Files:**
- Create: `src/learning/graduation-review.ts`
- Test: `tests/learning/graduation-review.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, expect, test } from "bun:test";

describe("graduation review", () => {
	test("buildGraduationPrompt includes metrics and trades", async () => {
		const { buildGraduationPrompt } = await import(
			"../../src/learning/graduation-review.ts"
		);

		const prompt = buildGraduationPrompt({
			strategyId: 1,
			strategyName: "news_sentiment_mr_v1",
			metrics: {
				sampleSize: 35,
				winRate: 0.6,
				expectancy: 25.0,
				profitFactor: 1.8,
				sharpeRatio: 0.8,
				maxDrawdownPct: 0.1,
				consistencyScore: 3,
			},
			recentTrades: [
				{ symbol: "AAPL", side: "BUY", pnl: 50, createdAt: "2026-04-01" },
				{ symbol: "MSFT", side: "SELL", pnl: -20, createdAt: "2026-04-02" },
			],
			patternInsights: ["stop_too_tight appears 5 times", "strong in low-VIX"],
		});

		expect(prompt).toContain("news_sentiment_mr_v1");
		expect(prompt).toContain("35");
		expect(prompt).toContain("0.8"); // sharpe
		expect(prompt).toContain("stop_too_tight");
	});

	test("parseGraduationResponse extracts valid result", async () => {
		const { parseGraduationResponse } = await import(
			"../../src/learning/graduation-review.ts"
		);

		const json = JSON.stringify({
			recommendation: "graduate",
			confidence: 0.8,
			reasoning: "Edge appears real, distributed across symbols",
			risk_flags: ["stop_distance_may_need_widening"],
			suggested_conditions: "Monitor first 10 live trades for slippage",
		});

		const result = parseGraduationResponse(json);
		expect(result).not.toBeNull();
		expect(result!.recommendation).toBe("graduate");
		expect(result!.confidence).toBeCloseTo(0.8);
		expect(result!.riskFlags).toContain("stop_distance_may_need_widening");
	});

	test("parseGraduationResponse returns null for invalid recommendation", async () => {
		const { parseGraduationResponse } = await import(
			"../../src/learning/graduation-review.ts"
		);

		const json = JSON.stringify({
			recommendation: "maybe",
			confidence: 0.5,
			reasoning: "Not sure",
			risk_flags: [],
			suggested_conditions: "",
		});

		expect(parseGraduationResponse(json)).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/learning/graduation-review.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement graduation-review.ts**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { tradeInsights } from "../db/schema.ts";
import { getConfig } from "../config.ts";
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
		`  Win rate: ${input.metrics.winRate != null ? (input.metrics.winRate * 100).toFixed(1) + "%" : "N/A"}`,
		`  Expectancy: ${input.metrics.expectancy ?? "N/A"}`,
		`  Profit factor: ${input.metrics.profitFactor ?? "N/A"}`,
		`  Sharpe ratio: ${input.metrics.sharpeRatio ?? "N/A"}`,
		`  Max drawdown: ${input.metrics.maxDrawdownPct != null ? (input.metrics.maxDrawdownPct * 100).toFixed(1) + "%" : "N/A"}`,
		`  Consistency: ${input.metrics.consistencyScore ?? "N/A"}/4 profitable weeks`,
		``,
		`Recent trades (last ${input.recentTrades.length}):`,
	];

	for (const trade of input.recentTrades) {
		lines.push(`  ${trade.symbol} ${trade.side} | PnL: ${trade.pnl ?? "open"} | ${trade.createdAt}`);
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
				typeof parsed.suggested_conditions === "string"
					? parsed.suggested_conditions
					: "",
		};
	} catch {
		return null;
	}
}

export async function getPatternInsightsForStrategy(
	strategyId: number,
): Promise<string[]> {
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
			log.warn({ strategyId: input.strategyId, response: text }, "Failed to parse graduation review");
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/learning/graduation-review.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/learning/graduation-review.ts tests/learning/graduation-review.test.ts
git commit -m "feat: add graduation reasoning review with Haiku"
```

---

### Task 7: Meta-Evolution — Track Insight Hit Rates

**Files:**
- Create: `src/learning/meta-evolution.ts`
- Test: `tests/learning/meta-evolution.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("meta-evolution", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { tradeInsights, learningLoopConfig } = await import("../../src/db/schema.ts");
		await db.delete(tradeInsights);
		await db.delete(learningLoopConfig);
	});

	test("computeHitRates returns 0 when no insights exist", async () => {
		const { computeHitRates } = await import("../../src/learning/meta-evolution.ts");

		const rates = await computeHitRates();
		expect(rates.trade_review).toBe(0);
		expect(rates.pattern_analysis).toBe(0);
	});

	test("computeHitRates returns correct rate when insights exist", async () => {
		const { tradeInsights } = await import("../../src/db/schema.ts");
		const { computeHitRates } = await import("../../src/learning/meta-evolution.ts");

		// 3 insights, 1 led to improvement
		await db.insert(tradeInsights).values([
			{
				strategyId: 1,
				insightType: "trade_review" as const,
				tags: "[]",
				observation: "test 1",
				ledToImprovement: true,
			},
			{
				strategyId: 1,
				insightType: "trade_review" as const,
				tags: "[]",
				observation: "test 2",
				ledToImprovement: false,
			},
			{
				strategyId: 1,
				insightType: "trade_review" as const,
				tags: "[]",
				observation: "test 3",
				ledToImprovement: false,
			},
		]);

		const rates = await computeHitRates();
		expect(rates.trade_review).toBeCloseTo(1 / 3, 2);
	});

	test("updatePromptHitRate writes hit rate to config row", async () => {
		const { learningLoopConfig } = await import("../../src/db/schema.ts");
		const { updatePromptHitRate } = await import("../../src/learning/meta-evolution.ts");

		await db.insert(learningLoopConfig).values({
			configType: "trade_review" as const,
			promptVersion: 1,
			promptText: "test prompt",
			active: true,
		});

		await updatePromptHitRate("trade_review", 0.33);

		const rows = await db.select().from(learningLoopConfig);
		expect(rows[0]!.hitRate).toBeCloseTo(0.33, 2);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/learning/meta-evolution.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement meta-evolution.ts**

```typescript
import { eq, and, sql, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { tradeInsights, learningLoopConfig } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "meta-evolution" });

type ConfigType = "trade_review" | "pattern_analysis" | "graduation";

export async function computeHitRates(): Promise<Record<ConfigType, number>> {
	const db = getDb();
	const rates: Record<ConfigType, number> = {
		trade_review: 0,
		pattern_analysis: 0,
		graduation: 0,
	};

	for (const configType of ["trade_review", "pattern_analysis", "graduation"] as const) {
		const total = await db
			.select({ count: sql<number>`count(*)` })
			.from(tradeInsights)
			.where(
				and(
					eq(tradeInsights.insightType, configType),
					isNotNull(tradeInsights.ledToImprovement),
				),
			);

		const improved = await db
			.select({ count: sql<number>`count(*)` })
			.from(tradeInsights)
			.where(
				and(
					eq(tradeInsights.insightType, configType),
					eq(tradeInsights.ledToImprovement, true),
				),
			);

		const totalCount = total[0]?.count ?? 0;
		const improvedCount = improved[0]?.count ?? 0;

		rates[configType] = totalCount > 0 ? improvedCount / totalCount : 0;
	}

	return rates;
}

export async function updatePromptHitRate(
	configType: ConfigType,
	hitRate: number,
): Promise<void> {
	const db = getDb();
	await db
		.update(learningLoopConfig)
		.set({ hitRate })
		.where(
			and(
				eq(learningLoopConfig.configType, configType),
				eq(learningLoopConfig.active, true),
			),
		);
}

export async function runMetaEvolutionUpdate(): Promise<void> {
	const rates = await computeHitRates();

	for (const [configType, rate] of Object.entries(rates) as [ConfigType, number][]) {
		await updatePromptHitRate(configType, rate);
		log.info({ configType, hitRate: rate }, "Updated prompt hit rate");
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/learning/meta-evolution.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/learning/meta-evolution.ts tests/learning/meta-evolution.test.ts
git commit -m "feat: add meta-evolution hit rate tracking for learning loop"
```

---

### Task 8: Wire Scheduler Jobs

**Files:**
- Create: `src/scheduler/trade-review-job.ts`
- Create: `src/scheduler/pattern-analysis-job.ts`
- Modify: `src/scheduler/jobs.ts`
- Modify: `src/scheduler/cron.ts`

- [ ] **Step 1: Create trade-review-job.ts**

```typescript
import { createChildLogger } from "../utils/logger.ts";
import { runDailyTradeReview } from "../learning/trade-review.ts";

const log = createChildLogger({ module: "trade-review-job" });

export async function runTradeReviewJob(): Promise<void> {
	const result = await runDailyTradeReview();
	log.info(
		{ reviewed: result.reviewed, skippedBudget: result.skippedBudget },
		"Daily trade review complete",
	);
}
```

- [ ] **Step 2: Create pattern-analysis-job.ts**

```typescript
import { createChildLogger } from "../utils/logger.ts";
import { runPatternAnalysis } from "../learning/pattern-analysis.ts";
import { runMetaEvolutionUpdate } from "../learning/meta-evolution.ts";

const log = createChildLogger({ module: "pattern-analysis-job" });

export async function runPatternAnalysisJob(): Promise<void> {
	const result = await runPatternAnalysis();
	log.info(
		{ observations: result.observations, skippedBudget: result.skippedBudget },
		"Pattern analysis complete",
	);

	// Run meta-evolution update alongside pattern analysis
	await runMetaEvolutionUpdate();
	log.info("Meta-evolution hit rates updated");
}
```

- [ ] **Step 3: Update jobs.ts — replace stubs with real imports**

In `src/scheduler/jobs.ts`, replace the `trade_review` and `pattern_analysis` stub cases with:

```typescript
case "trade_review": {
	const { runTradeReviewJob } = await import("./trade-review-job.ts");
	await runTradeReviewJob();
	break;
}
case "pattern_analysis": {
	const { runPatternAnalysisJob } = await import("./pattern-analysis-job.ts");
	await runPatternAnalysisJob();
	break;
}
```

- [ ] **Step 4: Update cron.ts — add trade_review and pattern_analysis schedules**

Add these cron entries to the `startScheduler()` function in `src/scheduler/cron.ts`:

```typescript
// Daily trade review — 21:15 weekdays (after daily summary at 21:05)
cron.schedule("15 21 * * 1-5", () => runJob("trade_review"), { timezone });

// Pattern analysis — Tuesday and Friday at 21:30
cron.schedule("30 21 * * 2,5", () => runJob("pattern_analysis"), { timezone });
```

- [ ] **Step 5: Run all tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/trade-review-job.ts src/scheduler/pattern-analysis-job.ts src/scheduler/jobs.ts src/scheduler/cron.ts
git commit -m "feat: wire learning loop jobs into scheduler"
```

---

### Task 9: Integrate Graduation Review into Graduation Gate

**Files:**
- Modify: `src/strategy/graduation.ts`

- [ ] **Step 1: Read current graduation.ts**

Read `src/strategy/graduation.ts` to understand the current interface.

- [ ] **Step 2: Add graduation review call after statistical gate passes**

After the existing statistical checks pass and before returning the graduation result, add:

```typescript
import { reviewForGraduation, getPatternInsightsForStrategy } from "../learning/graduation-review.ts";
```

At the point where all statistical criteria pass, add:

```typescript
// Qualitative review gate
const patternInsights = await getPatternInsightsForStrategy(strategyId);
const qualReview = await reviewForGraduation({
	strategyId,
	strategyName: strategy.name,
	metrics: {
		sampleSize: metrics.sampleSize,
		winRate: metrics.winRate,
		expectancy: metrics.expectancy,
		profitFactor: metrics.profitFactor,
		sharpeRatio: metrics.sharpeRatio,
		maxDrawdownPct: metrics.maxDrawdownPct,
		consistencyScore: metrics.consistencyScore,
	},
	recentTrades,
	patternInsights,
});

if (qualReview && qualReview.recommendation === "concerns") {
	return {
		eligible: false,
		reason: `Graduation review flagged concerns: ${qualReview.reasoning}`,
		riskFlags: qualReview.riskFlags,
	};
}

if (qualReview && qualReview.recommendation === "hold") {
	return {
		eligible: false,
		reason: `Graduation review recommends hold: ${qualReview.reasoning}`,
		riskFlags: qualReview.riskFlags,
	};
}
```

Note: If the Haiku call fails (returns null), graduation proceeds based on statistical criteria alone — the qualitative gate is additive, not blocking on API failure.

- [ ] **Step 3: Run graduation tests**

Run: `bun test tests/strategy/graduation.test.ts`
Expected: PASS (existing tests should still pass — the review call will return null in tests due to no API key, so graduation proceeds on stats alone)

- [ ] **Step 4: Commit**

```bash
git add src/strategy/graduation.ts
git commit -m "feat: add Haiku qualitative review to graduation gate"
```

---

### Task 10: Feed Insights to Evolution System

**Files:**
- Modify: `src/evolution/analyzer.ts`
- Modify: `src/evolution/prompt.ts`

- [ ] **Step 1: Add insight summary to PerformanceLandscape**

In `src/evolution/types.ts`, add to the `StrategyPerformance` interface:

```typescript
insightSummary: string[];
```

- [ ] **Step 2: Update analyzer to fetch insights**

In `src/evolution/analyzer.ts`, in the `getStrategyPerformance()` function, after fetching recent trades, add:

```typescript
import { tradeInsights } from "../db/schema.ts";
import { and, eq, desc } from "drizzle-orm";
```

Then fetch recent insights:

```typescript
const insights = await db
	.select({ observation: tradeInsights.observation, confidence: tradeInsights.confidence })
	.from(tradeInsights)
	.where(eq(tradeInsights.strategyId, strategyId))
	.orderBy(desc(tradeInsights.createdAt))
	.limit(10);

const insightSummary = insights
	.filter((i) => (i.confidence ?? 0) >= 0.5)
	.map((i) => i.observation);
```

Add `insightSummary` to the returned object.

- [ ] **Step 3: Update evolution prompt to include insights**

In `src/evolution/prompt.ts`, in the strategy block section of `buildEvolutionPrompt()`, add after the metrics section:

```typescript
if (strategy.insightSummary.length > 0) {
	lines.push(`Learning loop insights:`);
	for (const insight of strategy.insightSummary.slice(0, 5)) {
		lines.push(`  - ${insight}`);
	}
}
```

- [ ] **Step 4: Run evolution tests**

Run: `bun test tests/evolution/`
Expected: PASS (insightSummary defaults to empty array)

- [ ] **Step 5: Commit**

```bash
git add src/evolution/types.ts src/evolution/analyzer.ts src/evolution/prompt.ts
git commit -m "feat: feed learning loop insights into evolution prompt"
```

---

### Task 11: Learning Loop Evals

**Files:**
- Create: `src/evals/learning/suite.ts`
- Create: `src/evals/learning/tasks.ts`
- Create: `src/evals/learning/graders.ts`

- [ ] **Step 1: Create eval tasks for trade review**

```typescript
// src/evals/learning/tasks.ts
import type { EvalTask } from "../types.ts";

interface TradeReviewInput {
	tradePrompt: string;
}

interface TradeReviewReference {
	expectedTags: string[];
	expectedQuality: string;
	shouldSuggestAdjustment: boolean;
}

export const tradeReviewTasks: EvalTask<TradeReviewInput, TradeReviewReference>[] = [
	{
		id: "tr-001",
		name: "Profitable earnings trade with early exit",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: AAPL (NASDAQ)
Side: BUY
Entry: 150.00 → Exit: 155.00
PnL: 49.50 (after 0.50 friction)
Hold: 1 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 30
News at entry: Apple beats Q4 earnings, raises guidance by 15%`,
		},
		reference: {
			expectedTags: ["earnings_drift_truncated", "early_exit"],
			expectedQuality: "good_entry_early_exit",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "earnings", "profitable"],
	},
	{
		id: "tr-002",
		name: "Loss on gap fade that was fundamental",
		input: {
			tradePrompt: `Strategy: gap_fade_v1
Symbol: TSLA (NASDAQ)
Side: SELL
Entry: 250.00 → Exit: 265.00
PnL: -150.00 (after 0.60 friction)
Hold: 1 day(s)
Signal: entry_short — Entry signal: change_percent > 2 AND news_sentiment < 0.3
News at entry: Tesla announces new Gigafactory in India, production to begin 2027`,
		},
		reference: {
			expectedTags: ["fundamental_gap", "filter_failure"],
			expectedQuality: "bad_signal",
			shouldSuggestAdjustment: true,
		},
		tags: ["trade_review", "gap_fade", "loss"],
	},
	{
		id: "tr-003",
		name: "Clean profitable trade no issues",
		input: {
			tradePrompt: `Strategy: news_sentiment_mr_v1
Symbol: MSFT (NASDAQ)
Side: BUY
Entry: 400.00 → Exit: 412.00
PnL: 118.00 (after 2.00 friction)
Hold: 3 day(s)
Signal: entry_long — Entry signal: news_sentiment > 0.7 AND rsi14 < 30
News at entry: Microsoft cloud revenue surges 30%, beats estimates`,
		},
		reference: {
			expectedTags: [],
			expectedQuality: "clean_profit",
			shouldSuggestAdjustment: false,
		},
		tags: ["trade_review", "clean", "profitable"],
	},
];
```

- [ ] **Step 2: Create graders**

```typescript
// src/evals/learning/graders.ts
import type { Grader, GradeResult } from "../types.ts";
import { parseTradeReviewResponse } from "../../learning/trade-review.ts";

interface TradeReviewOutput {
	rawResponse: string;
}

interface TradeReviewReference {
	expectedTags: string[];
	expectedQuality: string;
	shouldSuggestAdjustment: boolean;
}

export const validJsonGrader: Grader<TradeReviewOutput, TradeReviewReference> = {
	name: "valid_json",
	type: "code",
	grade: async (output, _reference) => {
		const result = parseTradeReviewResponse(output.rawResponse, 0);
		return {
			score: result ? 1 : 0,
			pass: result !== null,
			reason: result ? "Valid JSON response" : "Invalid or unparseable JSON",
		};
	},
};

export const hasPatternTagsGrader: Grader<TradeReviewOutput, TradeReviewReference> = {
	name: "has_pattern_tags",
	type: "code",
	grade: async (output, reference) => {
		const result = parseTradeReviewResponse(output.rawResponse, 0);
		if (!result) return { score: 0, pass: false, reason: "Could not parse response" };

		if (reference.expectedTags.length === 0) {
			return { score: 1, pass: true, reason: "No tags expected and none required" };
		}

		const matchedTags = reference.expectedTags.filter((tag) =>
			result.patternTags.some((rt) => rt.includes(tag) || tag.includes(rt)),
		);

		const score = matchedTags.length / reference.expectedTags.length;
		return {
			score,
			pass: score >= 0.5,
			reason: `Matched ${matchedTags.length}/${reference.expectedTags.length} expected tags`,
		};
	},
};

export const adjustmentPresenceGrader: Grader<TradeReviewOutput, TradeReviewReference> = {
	name: "adjustment_presence",
	type: "code",
	grade: async (output, reference) => {
		const result = parseTradeReviewResponse(output.rawResponse, 0);
		if (!result) return { score: 0, pass: false, reason: "Could not parse response" };

		const hasAdj = result.suggestedParameterAdjustment !== null;
		const pass = hasAdj === reference.shouldSuggestAdjustment;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass
				? "Adjustment presence matches expectation"
				: `Expected adjustment=${reference.shouldSuggestAdjustment}, got=${hasAdj}`,
		};
	},
};
```

- [ ] **Step 3: Create suite runner**

```typescript
// src/evals/learning/suite.ts
import Anthropic from "@anthropic-ai/sdk";
import type { SuiteResults } from "../types.ts";
import { runSuite } from "../harness.ts";
import { tradeReviewTasks } from "./tasks.ts";
import { validJsonGrader, hasPatternTagsGrader, adjustmentPresenceGrader } from "./graders.ts";
import { getActivePrompt } from "../../learning/prompts.ts";

interface TradeReviewOutput {
	rawResponse: string;
}

export async function runLearningEvalSuite(
	trials: number = 2,
): Promise<SuiteResults<TradeReviewOutput>> {
	const { promptText } = await getActivePrompt("trade_review");
	const client = new Anthropic();

	return runSuite<
		{ tradePrompt: string },
		{ expectedTags: string[]; expectedQuality: string; shouldSuggestAdjustment: boolean },
		TradeReviewOutput
	>({
		suiteName: "learning",
		tasks: tradeReviewTasks,
		trials,
		runner: async (task) => {
			const response = await client.messages.create({
				model: "claude-haiku-4-5-20251001",
				max_tokens: 300,
				system: promptText,
				messages: [{ role: "user", content: task.input.tradePrompt }],
			});
			const text = response.content[0]?.type === "text" ? response.content[0].text : "";
			return { rawResponse: text };
		},
		graders: [validJsonGrader, hasPatternTagsGrader, adjustmentPresenceGrader],
	});
}
```

- [ ] **Step 4: Register suite in eval runner**

In `src/evals/run.ts`, add the `learning` suite to the available suites map:

```typescript
case "learning": {
	const { runLearningEvalSuite } = await import("./learning/suite.ts");
	results = await runLearningEvalSuite(trials);
	break;
}
```

Also add `"learning"` to the `all` suite list.

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/evals/learning/ src/evals/run.ts
git commit -m "evals: add learning loop eval suite with trade review tasks and graders"
```

---

### Phase 5 Complete Checklist

- [ ] `bun test --preload ./tests/preload.ts` — all tests pass
- [ ] `bun run typecheck` — no errors
- [ ] `bun run lint` — no errors
- [ ] `trade_insights` and `learning_loop_config` tables created with migration
- [ ] Daily trade review produces structured insights from Haiku
- [ ] Pattern analysis identifies recurring patterns across trade clusters
- [ ] Graduation gate includes qualitative Haiku review
- [ ] Learning loop insights feed into evolution prompt
- [ ] Meta-evolution tracks hit rates on prompt versions
- [ ] Scheduler runs trade_review daily at 21:15, pattern_analysis Tue/Fri at 21:30
- [ ] Learning eval suite validates trade review output quality
