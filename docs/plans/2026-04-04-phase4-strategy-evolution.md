# Phase 4: Strategy Evolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the autonomous parameter evolution system that proposes, spawns, and tournaments strategy variants — turning the paper lab into a self-improving engine.

**Architecture:** Weekly Sonnet call reviews all strategy performance data, proposes 1-2 parameter variants per top performer. Variants are spawned as new paper strategies and compete against parents. After 30+ trades each, a statistical tournament determines the winner (loser retires). Population capped at 8 paper strategies with a 15% drawdown kill switch. All mutations tracked in `strategy_mutations` for lineage analysis.

**Tech Stack:** Bun, TypeScript (strict), Drizzle ORM (SQLite), Anthropic SDK (Sonnet for evolution, Haiku for nothing — evolution is the one Sonnet job), Biome (tab indentation)

**Scope:** Track 1 only (autonomous parameter evolution). Track 2 (code evolution / PR creation) is deferred to a future phase.

---

## File Structure

```
src/evolution/
  types.ts            # Shared types (StrategyPerformance, MutationProposal, etc.)
  analyzer.ts         # Aggregates strategy performance data from DB
  prompt.ts           # Builds Sonnet system/user prompts, parses JSON response
  validator.ts        # Clamps parameters, enforces max-5, checks diversity
  spawner.ts          # Creates child strategies + records mutations in DB
  population.ts       # Population cap, drawdown kills, worst-performer culling
  tournament.ts       # Parent vs child statistical comparison after 30+ trades
  index.ts            # runEvolutionCycle() orchestrator

src/scheduler/
  evolution-job.ts    # Scheduler job wrapper

src/evals/evolution/
  tasks.ts            # 25+ eval tasks for evolution prompt quality
  graders.ts          # Code graders for mutation shape, parameter validity
  suite.ts            # Evolution eval suite runner

tests/evolution/
  analyzer.test.ts
  validator.test.ts
  spawner.test.ts
  population.test.ts
  tournament.test.ts
  prompt.test.ts

tests/evals/
  evolution-graders.test.ts
```

---

## Task 1: Types & Performance Analyzer

Aggregates all strategy data from the DB into a typed `PerformanceLandscape` — the input Sonnet needs to make evolution decisions.

**Files:**
- Create: `src/evolution/types.ts`
- Create: `src/evolution/analyzer.ts`
- Create: `tests/evolution/analyzer.test.ts`

### Step 1: Write the types

- [ ] **Step 1.1: Create types.ts**

```typescript
// src/evolution/types.ts

export interface StrategyPerformance {
	id: number;
	name: string;
	status: string;
	generation: number;
	parentStrategyId: number | null;
	createdBy: string;
	parameters: Record<string, number>;
	signals: SignalDef;
	universe: string[];
	metrics: MetricsSummary | null;
	recentTrades: TradeSummary[];
	virtualBalance: number;
}

export interface SignalDef {
	entry_long?: string;
	entry_short?: string;
	exit?: string;
}

export interface MetricsSummary {
	sampleSize: number;
	winRate: number | null;
	expectancy: number | null;
	profitFactor: number | null;
	sharpeRatio: number | null;
	sortinoRatio: number | null;
	maxDrawdownPct: number | null;
	calmarRatio: number | null;
	consistencyScore: number | null;
}

export interface TradeSummary {
	symbol: string;
	side: string;
	pnl: number | null;
	createdAt: string;
}

export interface PerformanceLandscape {
	strategies: StrategyPerformance[];
	activePaperCount: number;
	timestamp: string;
}

export interface MutationProposal {
	parentId: number;
	type: "parameter_tweak" | "new_variant";
	name: string;
	description: string;
	parameters: Record<string, number>;
	signals?: SignalDef;
	universe?: string[];
	reasoning: string;
}

export interface ValidatedMutation {
	parentId: number;
	type: "parameter_tweak" | "new_variant";
	name: string;
	description: string;
	parameters: Record<string, number>;
	signals: SignalDef;
	universe: string[];
	parameterDiff: Record<string, { from: number; to: number }>;
}

export interface TournamentResult {
	parentId: number;
	childId: number;
	parentSharpe: number;
	childSharpe: number;
	winnerId: number;
	loserId: number;
	reason: string;
}
```

- [ ] **Step 1.2: Commit types**

```bash
git add src/evolution/types.ts
git commit -m "feat: add evolution types (StrategyPerformance, MutationProposal, TournamentResult)"
```

### Step 2: Write analyzer tests

- [ ] **Step 2.1: Write failing tests for analyzer**

```typescript
// tests/evolution/analyzer.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { getDb } from "../../src/db/client";
import { strategies, strategyMetrics, paperTrades } from "../../src/db/schema";
import { getStrategyPerformance, getPerformanceLandscape } from "../../src/evolution/analyzer";

describe("analyzer", () => {
	beforeEach(() => {
		const db = getDb();
		db.delete(paperTrades).run();
		db.delete(strategyMetrics).run();
		db.delete(strategies).run();
	});

	test("getStrategyPerformance returns null for missing strategy", async () => {
		const result = await getStrategyPerformance(999);
		expect(result).toBeNull();
	});

	test("getStrategyPerformance returns full performance data", async () => {
		const db = getDb();
		const [strat] = db
			.insert(strategies)
			.values({
				name: "test_v1",
				description: "test",
				parameters: JSON.stringify({ hold_days: 3, position_size_pct: 10 }),
				signals: JSON.stringify({ entry_long: "rsi14 < 30", exit: "hold_days >= 3" }),
				universe: JSON.stringify(["AAPL", "MSFT"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		db.insert(strategyMetrics).values({
			strategyId: strat.id,
			sampleSize: 35,
			winRate: 0.6,
			expectancy: 12.5,
			profitFactor: 1.8,
			sharpeRatio: 1.2,
			sortinoRatio: 1.5,
			maxDrawdownPct: 8.5,
			calmarRatio: 2.0,
			consistencyScore: 3,
		}).run();

		const result = await getStrategyPerformance(strat.id);
		expect(result).not.toBeNull();
		expect(result!.name).toBe("test_v1");
		expect(result!.parameters).toEqual({ hold_days: 3, position_size_pct: 10 });
		expect(result!.metrics!.sampleSize).toBe(35);
		expect(result!.metrics!.sharpeRatio).toBe(1.2);
		expect(result!.universe).toEqual(["AAPL", "MSFT"]);
	});

	test("getPerformanceLandscape includes only non-retired strategies", async () => {
		const db = getDb();
		db.insert(strategies).values([
			{
				name: "active_v1",
				description: "active",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			},
			{
				name: "retired_v1",
				description: "retired",
				parameters: "{}",
				status: "retired" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
				retiredAt: new Date().toISOString(),
			},
		]).run();

		const landscape = await getPerformanceLandscape();
		expect(landscape.strategies.length).toBe(1);
		expect(landscape.strategies[0].name).toBe("active_v1");
		expect(landscape.activePaperCount).toBe(1);
	});

	test("getStrategyPerformance includes recent trades", async () => {
		const db = getDb();
		const [strat] = db
			.insert(strategies)
			.values({
				name: "test_v1",
				description: "test",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		db.insert(paperTrades).values([
			{
				strategyId: strat.id,
				symbol: "AAPL",
				exchange: "US",
				side: "long" as const,
				quantity: 10,
				price: 150,
				pnl: 25.0,
				fees: 1.0,
				signalType: "entry_long",
			},
			{
				strategyId: strat.id,
				symbol: "MSFT",
				exchange: "US",
				side: "long" as const,
				quantity: 5,
				price: 300,
				pnl: -10.0,
				fees: 1.0,
				signalType: "exit",
			},
		]).run();

		const result = await getStrategyPerformance(strat.id);
		expect(result!.recentTrades.length).toBe(2);
		expect(result!.recentTrades[0].pnl).toBe(25.0);
	});
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test tests/evolution/analyzer.test.ts`
Expected: FAIL — module `../../src/evolution/analyzer` not found

### Step 3: Implement analyzer

- [ ] **Step 3.1: Write analyzer.ts**

```typescript
// src/evolution/analyzer.ts
import { eq, ne } from "drizzle-orm";
import { getDb } from "../db/client";
import { strategies, strategyMetrics, paperTrades } from "../db/schema";
import type {
	StrategyPerformance,
	MetricsSummary,
	TradeSummary,
	PerformanceLandscape,
} from "./types";

export async function getStrategyPerformance(
	strategyId: number,
): Promise<StrategyPerformance | null> {
	const db = getDb();

	const strat = db.select().from(strategies).where(eq(strategies.id, strategyId)).get();
	if (!strat) return null;

	const metricsRow = db
		.select()
		.from(strategyMetrics)
		.where(eq(strategyMetrics.strategyId, strategyId))
		.get();

	const trades = db
		.select({
			symbol: paperTrades.symbol,
			side: paperTrades.side,
			pnl: paperTrades.pnl,
			createdAt: paperTrades.createdAt,
		})
		.from(paperTrades)
		.where(eq(paperTrades.strategyId, strategyId))
		.all();

	const metrics: MetricsSummary | null = metricsRow
		? {
				sampleSize: metricsRow.sampleSize,
				winRate: metricsRow.winRate,
				expectancy: metricsRow.expectancy,
				profitFactor: metricsRow.profitFactor,
				sharpeRatio: metricsRow.sharpeRatio,
				sortinoRatio: metricsRow.sortinoRatio,
				maxDrawdownPct: metricsRow.maxDrawdownPct,
				calmarRatio: metricsRow.calmarRatio,
				consistencyScore: metricsRow.consistencyScore,
			}
		: null;

	const recentTrades: TradeSummary[] = trades.map((t) => ({
		symbol: t.symbol,
		side: t.side,
		pnl: t.pnl,
		createdAt: t.createdAt,
	}));

	return {
		id: strat.id,
		name: strat.name,
		status: strat.status,
		generation: strat.generation,
		parentStrategyId: strat.parentStrategyId,
		createdBy: strat.createdBy,
		parameters: JSON.parse(strat.parameters),
		signals: strat.signals ? JSON.parse(strat.signals) : {},
		universe: strat.universe ? JSON.parse(strat.universe) : [],
		metrics,
		recentTrades,
		virtualBalance: strat.virtualBalance,
	};
}

export async function getPerformanceLandscape(): Promise<PerformanceLandscape> {
	const db = getDb();

	const allStrategies = db
		.select()
		.from(strategies)
		.where(ne(strategies.status, "retired"))
		.all();

	const performances: StrategyPerformance[] = [];
	for (const strat of allStrategies) {
		const perf = await getStrategyPerformance(strat.id);
		if (perf) performances.push(perf);
	}

	const activePaperCount = performances.filter((s) => s.status === "paper").length;

	return {
		strategies: performances,
		activePaperCount,
		timestamp: new Date().toISOString(),
	};
}
```

- [ ] **Step 3.2: Run tests to verify they pass**

Run: `bun test tests/evolution/analyzer.test.ts`
Expected: 4 tests pass

- [ ] **Step 3.3: Commit**

```bash
git add src/evolution/analyzer.ts tests/evolution/analyzer.test.ts
git commit -m "feat: add performance analyzer for strategy evolution"
```

---

## Task 2: Evolution Prompt Builder & Response Parser

Builds the Sonnet prompt with the full performance landscape and parses the structured JSON response into typed `MutationProposal[]`.

**Files:**
- Create: `src/evolution/prompt.ts`
- Create: `tests/evolution/prompt.test.ts`

### Step 1: Write failing tests

- [ ] **Step 1.1: Write tests for prompt builder and response parser**

```typescript
// tests/evolution/prompt.test.ts
import { describe, expect, test } from "bun:test";
import {
	buildEvolutionPrompt,
	parseEvolutionResponse,
} from "../../src/evolution/prompt";
import type { PerformanceLandscape } from "../../src/evolution/types";

const MOCK_LANDSCAPE: PerformanceLandscape = {
	strategies: [
		{
			id: 1,
			name: "news_sentiment_mr_v1",
			status: "paper",
			generation: 1,
			parentStrategyId: null,
			createdBy: "seed",
			parameters: { sentiment_threshold: 0.7, rsi_oversold: 30, hold_days: 3, position_size_pct: 10 },
			signals: { entry_long: "news_sentiment > 0.7 AND rsi14 < 30", exit: "hold_days >= 3" },
			universe: ["AAPL", "MSFT"],
			metrics: {
				sampleSize: 45,
				winRate: 0.55,
				expectancy: 8.2,
				profitFactor: 1.4,
				sharpeRatio: 0.9,
				sortinoRatio: 1.1,
				maxDrawdownPct: 7.5,
				calmarRatio: 1.5,
				consistencyScore: 3,
			},
			recentTrades: [],
			virtualBalance: 10000,
		},
	],
	activePaperCount: 1,
	timestamp: "2026-04-04T12:00:00Z",
};

describe("buildEvolutionPrompt", () => {
	test("returns system and user messages", () => {
		const { system, user } = buildEvolutionPrompt(MOCK_LANDSCAPE);
		expect(system).toContain("strategy evolution");
		expect(user).toContain("news_sentiment_mr_v1");
		expect(user).toContain("0.9"); // sharpe
	});

	test("includes population cap info", () => {
		const { user } = buildEvolutionPrompt(MOCK_LANDSCAPE);
		expect(user).toContain("1 / 8"); // activePaperCount / MAX_POPULATION
	});
});

describe("parseEvolutionResponse", () => {
	test("parses valid JSON array of proposals", () => {
		const raw = JSON.stringify([
			{
				parentId: 1,
				type: "parameter_tweak",
				name: "news_sentiment_mr_v2",
				description: "Lower sentiment threshold to capture more signals",
				parameters: { sentiment_threshold: 0.5, rsi_oversold: 25, hold_days: 3, position_size_pct: 10 },
				reasoning: "Current threshold too restrictive, missing trades",
			},
		]);

		const proposals = parseEvolutionResponse(raw);
		expect(proposals.length).toBe(1);
		expect(proposals[0].parentId).toBe(1);
		expect(proposals[0].type).toBe("parameter_tweak");
		expect(proposals[0].parameters.sentiment_threshold).toBe(0.5);
	});

	test("extracts JSON from markdown code block", () => {
		const raw = `Here are my proposals:\n\`\`\`json\n[{"parentId":1,"type":"parameter_tweak","name":"v2","description":"tweak","parameters":{"hold_days":5},"reasoning":"test"}]\n\`\`\``;
		const proposals = parseEvolutionResponse(raw);
		expect(proposals.length).toBe(1);
	});

	test("returns empty array for invalid JSON", () => {
		const proposals = parseEvolutionResponse("not json at all");
		expect(proposals).toEqual([]);
	});

	test("filters out proposals with missing required fields", () => {
		const raw = JSON.stringify([
			{ parentId: 1, type: "parameter_tweak", name: "v2", description: "ok", parameters: { x: 1 }, reasoning: "ok" },
			{ parentId: 1, type: "parameter_tweak", name: "v3" }, // missing fields
		]);
		const proposals = parseEvolutionResponse(raw);
		expect(proposals.length).toBe(1);
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/evolution/prompt.test.ts`
Expected: FAIL — module not found

### Step 2: Implement prompt builder

- [ ] **Step 2.1: Write prompt.ts**

```typescript
// src/evolution/prompt.ts
import type { PerformanceLandscape, MutationProposal } from "./types";
import { MAX_POPULATION } from "./population";

const SYSTEM_PROMPT = `You are a quantitative strategy evolution engine. Your job is to propose parameter mutations for trading strategies based on their performance data.

Rules:
- Propose 1-2 parameter variants per top-performing strategy
- You may also propose entirely new strategies if you see gaps in the portfolio
- Mutation type "parameter_tweak" changes parameters of an existing strategy
- Mutation type "new_variant" creates a new strategy inspired by a parent but with different signals
- Every parameter must be a number (no strings, no booleans)
- Max 5 parameters per strategy (overfitting prevention)
- Common parameters and their valid ranges:
  - position_size_pct: 2-25
  - stop_loss_pct: 1-10
  - hold_days: 1-20
  - sentiment_threshold / tone_score_min: 0.1-0.95
  - rsi_oversold: 15-45, rsi_overbought: 55-85
  - gap_threshold_pct / exit_target_pct: 0.5-10
  - volume_ratio thresholds: 1.0-5.0
  - surprise_threshold: 0.1-0.9

Respond with ONLY a JSON array of mutation proposals. No commentary outside the JSON.

Each proposal must have these fields:
{
  "parentId": <number - strategy ID to derive from>,
  "type": "parameter_tweak" | "new_variant",
  "name": "<string - unique strategy name with version suffix>",
  "description": "<string - what changed and why>",
  "parameters": { <string: number pairs> },
  "signals": { "entry_long"?: "<expression>", "entry_short"?: "<expression>", "exit"?: "<expression>" },
  "universe": ["<SYMBOL>" or "<SYMBOL:EXCHANGE>"],
  "reasoning": "<string - why this mutation might improve performance>"
}

For parameter_tweak: signals and universe are optional (inherit from parent if omitted).
For new_variant: signals and universe are required.`;

export function buildEvolutionPrompt(landscape: PerformanceLandscape): {
	system: string;
	user: string;
} {
	const strategyBlocks = landscape.strategies.map((s) => {
		const metricsStr = s.metrics
			? [
					`  Sample: ${s.metrics.sampleSize} trades`,
					`  Win rate: ${s.metrics.winRate !== null ? (s.metrics.winRate * 100).toFixed(1) + "%" : "N/A"}`,
					`  Expectancy: ${s.metrics.expectancy !== null ? s.metrics.expectancy.toFixed(2) : "N/A"}`,
					`  Profit factor: ${s.metrics.profitFactor !== null ? s.metrics.profitFactor.toFixed(2) : "N/A"}`,
					`  Sharpe: ${s.metrics.sharpeRatio !== null ? s.metrics.sharpeRatio.toFixed(2) : "N/A"}`,
					`  Sortino: ${s.metrics.sortinoRatio !== null ? s.metrics.sortinoRatio.toFixed(2) : "N/A"}`,
					`  Max drawdown: ${s.metrics.maxDrawdownPct !== null ? s.metrics.maxDrawdownPct.toFixed(1) + "%" : "N/A"}`,
					`  Consistency: ${s.metrics.consistencyScore ?? "N/A"}/4 weeks`,
				].join("\n")
			: "  No metrics yet (insufficient trades)";

		return [
			`Strategy: ${s.name} (ID: ${s.id})`,
			`  Status: ${s.status} | Generation: ${s.generation} | Created by: ${s.createdBy}`,
			`  Parent: ${s.parentStrategyId ?? "none (seed)"}`,
			`  Parameters: ${JSON.stringify(s.parameters)}`,
			`  Signals: ${JSON.stringify(s.signals)}`,
			`  Universe: ${JSON.stringify(s.universe)}`,
			`  Virtual balance: ${s.virtualBalance}`,
			`  Metrics:`,
			metricsStr,
		].join("\n");
	});

	const user = [
		`Current portfolio — ${landscape.activePaperCount} / ${MAX_POPULATION} paper slots used:`,
		"",
		strategyBlocks.join("\n\n"),
		"",
		`Propose mutations to improve this portfolio. Focus on strategies with 30+ trades. Prioritise strategies with positive expectancy but room for improvement (Sharpe < 1.5). If population slots are available, consider a new_variant that covers a gap.`,
	].join("\n");

	return { system: SYSTEM_PROMPT, user };
}

export function parseEvolutionResponse(raw: string): MutationProposal[] {
	// Try to extract JSON from markdown code block first
	const codeBlockMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	const jsonStr = codeBlockMatch ? codeBlockMatch[1].trim() : raw.trim();

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		return [];
	}

	if (!Array.isArray(parsed)) return [];

	const required = ["parentId", "type", "name", "description", "parameters", "reasoning"];

	return parsed.filter((item): item is MutationProposal => {
		if (typeof item !== "object" || item === null) return false;
		for (const key of required) {
			if (!(key in item)) return false;
		}
		if (item.type !== "parameter_tweak" && item.type !== "new_variant") return false;
		if (typeof item.parameters !== "object" || item.parameters === null) return false;
		return true;
	});
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/evolution/prompt.test.ts`
Expected: 5 tests pass

Note: `MAX_POPULATION` is imported from `population.ts` which doesn't exist yet. Either create a minimal `population.ts` exporting `export const MAX_POPULATION = 8;` first, or inline the constant and refactor in Task 5. Prefer creating the minimal export now.

- [ ] **Step 2.3: Create minimal population.ts constant**

```typescript
// src/evolution/population.ts (minimal — full implementation in Task 5)
export const MAX_POPULATION = 8;
```

- [ ] **Step 2.4: Run tests again to confirm**

Run: `bun test tests/evolution/prompt.test.ts`
Expected: 5 tests pass

- [ ] **Step 2.5: Commit**

```bash
git add src/evolution/prompt.ts src/evolution/population.ts tests/evolution/prompt.test.ts
git commit -m "feat: add evolution prompt builder and response parser"
```

---

## Task 3: Mutation Validator

Enforces all safety rails: parameter clamping, max 5 parameters, population cap check, diversity enforcement (no near-duplicate mutations).

**Files:**
- Create: `src/evolution/validator.ts`
- Create: `tests/evolution/validator.test.ts`

### Step 1: Write failing tests

- [ ] **Step 1.1: Write validator tests**

```typescript
// tests/evolution/validator.test.ts
import { describe, expect, test } from "bun:test";
import {
	validateMutation,
	clampParameters,
	PARAMETER_RANGES,
} from "../../src/evolution/validator";
import type { MutationProposal, StrategyPerformance } from "../../src/evolution/types";

const PARENT: StrategyPerformance = {
	id: 1,
	name: "news_sentiment_mr_v1",
	status: "paper",
	generation: 1,
	parentStrategyId: null,
	createdBy: "seed",
	parameters: { sentiment_threshold: 0.7, rsi_oversold: 30, hold_days: 3, position_size_pct: 10 },
	signals: { entry_long: "news_sentiment > 0.7 AND rsi14 < 30", exit: "hold_days >= 3" },
	universe: ["AAPL", "MSFT"],
	metrics: null,
	recentTrades: [],
	virtualBalance: 10000,
};

describe("clampParameters", () => {
	test("clamps known parameters to their ranges", () => {
		const clamped = clampParameters({
			position_size_pct: 50, // over max 25
			hold_days: 0, // under min 1
			sentiment_threshold: 0.5, // within range
		});
		expect(clamped.position_size_pct).toBe(25);
		expect(clamped.hold_days).toBe(1);
		expect(clamped.sentiment_threshold).toBe(0.5);
	});

	test("passes through unknown parameters unchanged", () => {
		const clamped = clampParameters({ custom_param: 42 });
		expect(clamped.custom_param).toBe(42);
	});
});

describe("validateMutation", () => {
	test("accepts valid parameter_tweak", () => {
		const proposal: MutationProposal = {
			parentId: 1,
			type: "parameter_tweak",
			name: "news_sentiment_mr_v2",
			description: "Lower threshold",
			parameters: { sentiment_threshold: 0.5, rsi_oversold: 25, hold_days: 3, position_size_pct: 10 },
			reasoning: "test",
		};
		const result = validateMutation(proposal, PARENT, []);
		expect(result.valid).toBe(true);
		expect(result.mutation!.parameterDiff.sentiment_threshold).toEqual({ from: 0.7, to: 0.5 });
	});

	test("rejects mutation with more than 5 parameters", () => {
		const proposal: MutationProposal = {
			parentId: 1,
			type: "parameter_tweak",
			name: "overfit_v1",
			description: "Too many params",
			parameters: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
			reasoning: "test",
		};
		const result = validateMutation(proposal, PARENT, []);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain("5 parameters");
	});

	test("rejects near-duplicate of existing strategy", () => {
		const proposal: MutationProposal = {
			parentId: 1,
			type: "parameter_tweak",
			name: "news_sentiment_mr_v2",
			description: "Tiny change",
			parameters: { sentiment_threshold: 0.7, rsi_oversold: 30, hold_days: 3, position_size_pct: 10 },
			reasoning: "test",
		};
		const result = validateMutation(proposal, PARENT, [PARENT]);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain("duplicate");
	});

	test("clamps out-of-range parameters during validation", () => {
		const proposal: MutationProposal = {
			parentId: 1,
			type: "parameter_tweak",
			name: "clamped_v1",
			description: "Has out-of-range values",
			parameters: { hold_days: 100, position_size_pct: 0.5 },
			reasoning: "test",
		};
		const result = validateMutation(proposal, PARENT, []);
		expect(result.valid).toBe(true);
		expect(result.mutation!.parameters.hold_days).toBe(20); // clamped
		expect(result.mutation!.parameters.position_size_pct).toBe(2); // clamped
	});

	test("new_variant requires signals", () => {
		const proposal: MutationProposal = {
			parentId: 1,
			type: "new_variant",
			name: "new_strat_v1",
			description: "New approach",
			parameters: { hold_days: 5 },
			reasoning: "test",
		};
		const result = validateMutation(proposal, PARENT, []);
		expect(result.valid).toBe(false);
		expect(result.reason).toContain("signals");
	});

	test("new_variant with signals is accepted", () => {
		const proposal: MutationProposal = {
			parentId: 1,
			type: "new_variant",
			name: "new_strat_v1",
			description: "New approach",
			parameters: { hold_days: 5, position_size_pct: 10 },
			signals: { entry_long: "rsi14 < 25", exit: "hold_days >= 5" },
			universe: ["AAPL"],
			reasoning: "test",
		};
		const result = validateMutation(proposal, PARENT, []);
		expect(result.valid).toBe(true);
		expect(result.mutation!.signals.entry_long).toBe("rsi14 < 25");
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/evolution/validator.test.ts`
Expected: FAIL — module not found

### Step 2: Implement validator

- [ ] **Step 2.1: Write validator.ts**

```typescript
// src/evolution/validator.ts
import type {
	MutationProposal,
	ValidatedMutation,
	StrategyPerformance,
} from "./types";

export const MAX_PARAMETERS = 5;

/** Hard-clamped ranges per the spec. Unknown parameters pass through. */
export const PARAMETER_RANGES: Record<string, { min: number; max: number }> = {
	position_size_pct: { min: 2, max: 25 },
	stop_loss_pct: { min: 1, max: 10 },
	hold_days: { min: 1, max: 20 },
	hold_bars: { min: 1, max: 20 },
	sentiment_threshold: { min: 0.1, max: 0.95 },
	tone_score_min: { min: 0.2, max: 0.9 },
	rsi_oversold: { min: 15, max: 45 },
	rsi_overbought: { min: 55, max: 85 },
	gap_threshold_pct: { min: 0.5, max: 5 },
	exit_target_pct: { min: 0.5, max: 10 },
	surprise_threshold: { min: 0.1, max: 0.9 },
};

export function clampParameters(
	params: Record<string, number>,
): Record<string, number> {
	const clamped: Record<string, number> = {};
	for (const [key, value] of Object.entries(params)) {
		const range = PARAMETER_RANGES[key];
		if (range) {
			clamped[key] = Math.min(range.max, Math.max(range.min, value));
		} else {
			clamped[key] = value;
		}
	}
	return clamped;
}

/** Returns the max relative change between two parameter sets (0-1 scale). */
function parameterDistance(
	a: Record<string, number>,
	b: Record<string, number>,
): number {
	const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
	if (allKeys.size === 0) return 0;

	let maxDelta = 0;
	for (const key of allKeys) {
		const va = a[key] ?? 0;
		const vb = b[key] ?? 0;
		const denom = Math.max(Math.abs(va), Math.abs(vb), 1);
		maxDelta = Math.max(maxDelta, Math.abs(va - vb) / denom);
	}
	return maxDelta;
}

const MIN_DIVERSITY_DISTANCE = 0.05;

export function validateMutation(
	proposal: MutationProposal,
	parent: StrategyPerformance,
	existingStrategies: StrategyPerformance[],
): { valid: true; mutation: ValidatedMutation } | { valid: false; reason: string } {
	// Clamp parameters
	const clamped = clampParameters(proposal.parameters);

	// Max 5 parameters
	if (Object.keys(clamped).length > MAX_PARAMETERS) {
		return { valid: false, reason: `Exceeds ${MAX_PARAMETERS} parameters (has ${Object.keys(clamped).length})` };
	}

	// new_variant requires signals
	if (proposal.type === "new_variant" && !proposal.signals) {
		return { valid: false, reason: "new_variant must include signals" };
	}

	// Diversity check: no near-duplicate of any existing strategy
	for (const existing of existingStrategies) {
		const distance = parameterDistance(clamped, existing.parameters);
		if (distance < MIN_DIVERSITY_DISTANCE) {
			return {
				valid: false,
				reason: `Near-duplicate of ${existing.name} (distance: ${distance.toFixed(3)})`,
			};
		}
	}

	// Build parameter diff
	const parameterDiff: Record<string, { from: number; to: number }> = {};
	const parentParams = parent.parameters;
	for (const key of new Set([...Object.keys(clamped), ...Object.keys(parentParams)])) {
		if (clamped[key] !== parentParams[key]) {
			parameterDiff[key] = { from: parentParams[key] ?? 0, to: clamped[key] ?? 0 };
		}
	}

	const mutation: ValidatedMutation = {
		parentId: proposal.parentId,
		type: proposal.type,
		name: proposal.name,
		description: proposal.description,
		parameters: clamped,
		signals: proposal.signals ?? parent.signals,
		universe: proposal.universe ?? parent.universe,
		parameterDiff,
	};

	return { valid: true, mutation };
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/evolution/validator.test.ts`
Expected: 7 tests pass

- [ ] **Step 2.3: Commit**

```bash
git add src/evolution/validator.ts tests/evolution/validator.test.ts
git commit -m "feat: add mutation validator with parameter clamping and diversity checks"
```

---

## Task 4: Strategy Spawner

Creates a child strategy in the DB from a validated mutation and records the lineage in `strategy_mutations`.

**Files:**
- Create: `src/evolution/spawner.ts`
- Create: `tests/evolution/spawner.test.ts`

### Step 1: Write failing tests

- [ ] **Step 1.1: Write spawner tests**

```typescript
// tests/evolution/spawner.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { getDb } from "../../src/db/client";
import { strategies, strategyMutations } from "../../src/db/schema";
import { spawnChild } from "../../src/evolution/spawner";
import { eq } from "drizzle-orm";
import type { ValidatedMutation } from "../../src/evolution/types";

describe("spawnChild", () => {
	beforeEach(() => {
		const db = getDb();
		db.delete(strategyMutations).run();
		db.delete(strategies).run();
	});

	test("creates child strategy with correct fields", async () => {
		const db = getDb();
		const [parent] = db
			.insert(strategies)
			.values({
				name: "parent_v1",
				description: "parent",
				parameters: JSON.stringify({ hold_days: 3 }),
				signals: JSON.stringify({ entry_long: "rsi14 < 30" }),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		const mutation: ValidatedMutation = {
			parentId: parent.id,
			type: "parameter_tweak",
			name: "parent_v2",
			description: "Tweaked hold days",
			parameters: { hold_days: 5 },
			signals: { entry_long: "rsi14 < 30" },
			universe: ["AAPL"],
			parameterDiff: { hold_days: { from: 3, to: 5 } },
		};

		const childId = await spawnChild(mutation);
		const child = db.select().from(strategies).where(eq(strategies.id, childId)).get();

		expect(child).not.toBeNull();
		expect(child!.name).toBe("parent_v2");
		expect(child!.parentStrategyId).toBe(parent.id);
		expect(child!.generation).toBe(2); // parent.generation + 1
		expect(child!.createdBy).toBe("evolution");
		expect(child!.status).toBe("paper");
		expect(JSON.parse(child!.parameters)).toEqual({ hold_days: 5 });
	});

	test("records mutation in strategy_mutations table", async () => {
		const db = getDb();
		const [parent] = db
			.insert(strategies)
			.values({
				name: "parent_v1",
				description: "parent",
				parameters: JSON.stringify({ hold_days: 3 }),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		const mutation: ValidatedMutation = {
			parentId: parent.id,
			type: "parameter_tweak",
			name: "parent_v2",
			description: "tweak",
			parameters: { hold_days: 5 },
			signals: {},
			universe: [],
			parameterDiff: { hold_days: { from: 3, to: 5 } },
		};

		const childId = await spawnChild(mutation);
		const record = db
			.select()
			.from(strategyMutations)
			.where(eq(strategyMutations.childId, childId))
			.get();

		expect(record).not.toBeNull();
		expect(record!.parentId).toBe(parent.id);
		expect(record!.mutationType).toBe("parameter_tweak");
		expect(JSON.parse(record!.parameterDiff!)).toEqual({ hold_days: { from: 3, to: 5 } });
		expect(record!.parentSharpe).toBeNull(); // filled later by tournament
	});

	test("inherits parent virtualBalance", async () => {
		const db = getDb();
		const [parent] = db
			.insert(strategies)
			.values({
				name: "rich_v1",
				description: "rich parent",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 50000,
				generation: 3,
				createdBy: "evolution",
			})
			.returning();

		const mutation: ValidatedMutation = {
			parentId: parent.id,
			type: "new_variant",
			name: "rich_v2",
			description: "new variant",
			parameters: { hold_days: 2 },
			signals: { entry_long: "rsi14 < 20" },
			universe: ["MSFT"],
			parameterDiff: {},
		};

		const childId = await spawnChild(mutation);
		const child = db.select().from(strategies).where(eq(strategies.id, childId)).get();
		expect(child!.virtualBalance).toBe(50000);
		expect(child!.generation).toBe(4); // parent gen 3 + 1
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/evolution/spawner.test.ts`
Expected: FAIL — module not found

### Step 2: Implement spawner

- [ ] **Step 2.1: Write spawner.ts**

```typescript
// src/evolution/spawner.ts
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { strategies, strategyMutations } from "../db/schema";
import type { ValidatedMutation } from "./types";

export async function spawnChild(mutation: ValidatedMutation): Promise<number> {
	const db = getDb();

	const parent = db
		.select()
		.from(strategies)
		.where(eq(strategies.id, mutation.parentId))
		.get();
	if (!parent) throw new Error(`Parent strategy ${mutation.parentId} not found`);

	const [child] = db
		.insert(strategies)
		.values({
			name: mutation.name,
			description: mutation.description,
			parameters: JSON.stringify(mutation.parameters),
			signals: JSON.stringify(mutation.signals),
			universe: JSON.stringify(mutation.universe),
			status: "paper" as const,
			virtualBalance: parent.virtualBalance,
			parentStrategyId: parent.id,
			generation: parent.generation + 1,
			createdBy: "evolution",
		})
		.returning();

	db.insert(strategyMutations).values({
		parentId: parent.id,
		childId: child.id,
		mutationType: mutation.type as "parameter_tweak" | "new_variant" | "code_change",
		parameterDiff: JSON.stringify(mutation.parameterDiff),
	}).run();

	return child.id;
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/evolution/spawner.test.ts`
Expected: 3 tests pass

- [ ] **Step 2.3: Commit**

```bash
git add src/evolution/spawner.ts tests/evolution/spawner.test.ts
git commit -m "feat: add strategy spawner with lineage tracking"
```

---

## Task 5: Population Manager & Drawdown Monitor

Enforces the 8-strategy population cap, culls worst performers when over capacity, and kills any paper strategy with >15% drawdown.

**Files:**
- Modify: `src/evolution/population.ts` (expand from the minimal constant)
- Create: `tests/evolution/population.test.ts`

### Step 1: Write failing tests

- [ ] **Step 1.1: Write population tests**

```typescript
// tests/evolution/population.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { getDb } from "../../src/db/client";
import { strategies, strategyMetrics, graduationEvents } from "../../src/db/schema";
import { enforcePopulationCap, checkDrawdowns, MAX_POPULATION, DRAWDOWN_KILL_PCT } from "../../src/evolution/population";

function insertStrategy(name: string, status: "paper" | "retired" = "paper") {
	const db = getDb();
	const [s] = db
		.insert(strategies)
		.values({
			name,
			description: name,
			parameters: "{}",
			status: status as const,
			virtualBalance: 10000,
			generation: 1,
			createdBy: "seed",
		})
		.returning();
	return s;
}

function insertMetrics(strategyId: number, sharpe: number | null, drawdown: number | null) {
	const db = getDb();
	db.insert(strategyMetrics).values({
		strategyId,
		sampleSize: 30,
		sharpeRatio: sharpe,
		maxDrawdownPct: drawdown,
	}).run();
}

describe("checkDrawdowns", () => {
	beforeEach(() => {
		const db = getDb();
		db.delete(graduationEvents).run();
		db.delete(strategyMetrics).run();
		db.delete(strategies).run();
	});

	test("retires paper strategy exceeding 15% drawdown", async () => {
		const s = insertStrategy("bad_v1");
		insertMetrics(s.id, -0.5, 18.0); // 18% drawdown > 15% limit

		const killed = await checkDrawdowns();
		expect(killed.length).toBe(1);
		expect(killed[0]).toBe(s.id);

		const db = getDb();
		const updated = db.select().from(strategies).where(require("drizzle-orm").eq(strategies.id, s.id)).get();
		expect(updated!.status).toBe("retired");
		expect(updated!.retiredAt).not.toBeNull();
	});

	test("does not retire strategy under 15% drawdown", async () => {
		const s = insertStrategy("ok_v1");
		insertMetrics(s.id, 0.5, 10.0); // 10% < 15%

		const killed = await checkDrawdowns();
		expect(killed.length).toBe(0);
	});

	test("only checks paper strategies", async () => {
		const s = insertStrategy("retired_v1", "retired");
		insertMetrics(s.id, -1.0, 20.0);

		const killed = await checkDrawdowns();
		expect(killed.length).toBe(0);
	});
});

describe("enforcePopulationCap", () => {
	beforeEach(() => {
		const db = getDb();
		db.delete(graduationEvents).run();
		db.delete(strategyMetrics).run();
		db.delete(strategies).run();
	});

	test("does nothing when under cap", async () => {
		insertStrategy("s1");
		insertStrategy("s2");
		const culled = await enforcePopulationCap();
		expect(culled.length).toBe(0);
	});

	test("culls worst performer when at cap", async () => {
		// Create MAX_POPULATION + 1 strategies
		const ids: number[] = [];
		for (let i = 0; i <= MAX_POPULATION; i++) {
			const s = insertStrategy(`s${i}`);
			ids.push(s.id);
			insertMetrics(s.id, i * 0.1, 5.0); // ascending Sharpe
		}

		const culled = await enforcePopulationCap();
		expect(culled.length).toBe(1);
		expect(culled[0]).toBe(ids[0]); // worst Sharpe (0.0) gets culled
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/evolution/population.test.ts`
Expected: FAIL — functions not exported from population.ts

### Step 2: Implement population manager

- [ ] **Step 2.1: Expand population.ts**

```typescript
// src/evolution/population.ts
import { eq, and } from "drizzle-orm";
import { getDb } from "../db/client";
import { strategies, strategyMetrics, graduationEvents } from "../db/schema";
import { log } from "../utils/logger";

export const MAX_POPULATION = 8;
export const DRAWDOWN_KILL_PCT = 15;

/** Retire a strategy and record a graduation event. */
async function retireStrategy(strategyId: number, reason: string): Promise<void> {
	const db = getDb();
	db.update(strategies)
		.set({ status: "retired" as const, retiredAt: new Date().toISOString() })
		.where(eq(strategies.id, strategyId))
		.run();

	db.insert(graduationEvents).values({
		strategyId,
		event: "killed" as const,
		evidence: JSON.stringify({ reason }),
	}).run();

	log("WARN", "evolution", `Retired strategy ${strategyId}: ${reason}`);
}

/** Kill any paper strategy with drawdown > 15%. Returns IDs of killed strategies. */
export async function checkDrawdowns(): Promise<number[]> {
	const db = getDb();

	const paperStrategies = db
		.select({ id: strategies.id })
		.from(strategies)
		.where(eq(strategies.status, "paper"))
		.all();

	const killed: number[] = [];

	for (const { id } of paperStrategies) {
		const metrics = db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, id))
			.get();

		if (metrics?.maxDrawdownPct != null && metrics.maxDrawdownPct > DRAWDOWN_KILL_PCT) {
			await retireStrategy(id, `Drawdown ${metrics.maxDrawdownPct.toFixed(1)}% exceeds ${DRAWDOWN_KILL_PCT}% limit`);
			killed.push(id);
		}
	}

	return killed;
}

/** If paper population exceeds cap, cull the worst performer by Sharpe. Returns IDs culled. */
export async function enforcePopulationCap(): Promise<number[]> {
	const db = getDb();

	const paperStrategies = db
		.select({ id: strategies.id })
		.from(strategies)
		.where(eq(strategies.status, "paper"))
		.all();

	if (paperStrategies.length <= MAX_POPULATION) return [];

	// Rank by Sharpe (null Sharpe = -Infinity, worst)
	const ranked: Array<{ id: number; sharpe: number }> = [];
	for (const { id } of paperStrategies) {
		const metrics = db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, id))
			.get();
		ranked.push({ id, sharpe: metrics?.sharpeRatio ?? -Infinity });
	}

	ranked.sort((a, b) => a.sharpe - b.sharpe); // worst first

	const excess = paperStrategies.length - MAX_POPULATION;
	const culled: number[] = [];

	for (let i = 0; i < excess; i++) {
		await retireStrategy(ranked[i].id, `Population cap (${MAX_POPULATION}) exceeded, worst Sharpe: ${ranked[i].sharpe}`);
		culled.push(ranked[i].id);
	}

	return culled;
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/evolution/population.test.ts`
Expected: 4 tests pass

- [ ] **Step 2.3: Commit**

```bash
git add src/evolution/population.ts tests/evolution/population.test.ts
git commit -m "feat: add population manager with drawdown kills and cap enforcement"
```

---

## Task 6: Tournament Comparator

After both parent and child have 30+ trades, statistically compare them. Winner continues, loser retires. Updates `strategy_mutations` with final Sharpe values.

**Files:**
- Create: `src/evolution/tournament.ts`
- Create: `tests/evolution/tournament.test.ts`

### Step 1: Write failing tests

- [ ] **Step 1.1: Write tournament tests**

```typescript
// tests/evolution/tournament.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { getDb } from "../../src/db/client";
import { strategies, strategyMetrics, strategyMutations, graduationEvents } from "../../src/db/schema";
import { runTournaments } from "../../src/evolution/tournament";
import { eq } from "drizzle-orm";

function insertStrategy(
	name: string,
	opts: { parentId?: number; generation?: number } = {},
) {
	const db = getDb();
	const [s] = db
		.insert(strategies)
		.values({
			name,
			description: name,
			parameters: "{}",
			status: "paper" as const,
			virtualBalance: 10000,
			generation: opts.generation ?? 1,
			parentStrategyId: opts.parentId ?? null,
			createdBy: opts.parentId ? "evolution" : "seed",
		})
		.returning();
	return s;
}

function insertMetrics(strategyId: number, sampleSize: number, sharpe: number) {
	const db = getDb();
	db.insert(strategyMetrics)
		.values({ strategyId, sampleSize, sharpeRatio: sharpe })
		.onConflictDoUpdate({
			target: strategyMetrics.strategyId,
			set: { sampleSize, sharpeRatio: sharpe },
		})
		.run();
}

function insertMutation(parentId: number, childId: number) {
	const db = getDb();
	db.insert(strategyMutations).values({
		parentId,
		childId,
		mutationType: "parameter_tweak" as const,
	}).run();
}

describe("runTournaments", () => {
	beforeEach(() => {
		const db = getDb();
		db.delete(graduationEvents).run();
		db.delete(strategyMutations).run();
		db.delete(strategyMetrics).run();
		db.delete(strategies).run();
	});

	test("child wins when higher Sharpe, parent retires", async () => {
		const parent = insertStrategy("parent_v1");
		const child = insertStrategy("child_v2", { parentId: parent.id, generation: 2 });
		insertMetrics(parent.id, 35, 0.8);
		insertMetrics(child.id, 35, 1.2);
		insertMutation(parent.id, child.id);

		const results = await runTournaments();
		expect(results.length).toBe(1);
		expect(results[0].winnerId).toBe(child.id);
		expect(results[0].loserId).toBe(parent.id);

		const db = getDb();
		const parentRow = db.select().from(strategies).where(eq(strategies.id, parent.id)).get();
		expect(parentRow!.status).toBe("retired");

		// Check mutation record updated with Sharpe values
		const mutRecord = db.select().from(strategyMutations).where(eq(strategyMutations.childId, child.id)).get();
		expect(mutRecord!.parentSharpe).toBe(0.8);
		expect(mutRecord!.childSharpe).toBe(1.2);
	});

	test("parent wins when higher Sharpe, child retires", async () => {
		const parent = insertStrategy("parent_v1");
		const child = insertStrategy("child_v2", { parentId: parent.id, generation: 2 });
		insertMetrics(parent.id, 40, 1.5);
		insertMetrics(child.id, 35, 0.3);
		insertMutation(parent.id, child.id);

		const results = await runTournaments();
		expect(results.length).toBe(1);
		expect(results[0].winnerId).toBe(parent.id);

		const db = getDb();
		const childRow = db.select().from(strategies).where(eq(strategies.id, child.id)).get();
		expect(childRow!.status).toBe("retired");
	});

	test("skips pairs where either has fewer than 30 trades", async () => {
		const parent = insertStrategy("parent_v1");
		const child = insertStrategy("child_v2", { parentId: parent.id, generation: 2 });
		insertMetrics(parent.id, 35, 1.0);
		insertMetrics(child.id, 20, 0.9); // only 20 trades
		insertMutation(parent.id, child.id);

		const results = await runTournaments();
		expect(results.length).toBe(0); // not ready
	});

	test("skips pairs where one is already retired", async () => {
		const parent = insertStrategy("parent_v1");
		const child = insertStrategy("child_v2", { parentId: parent.id, generation: 2 });
		insertMetrics(parent.id, 35, 1.0);
		insertMetrics(child.id, 35, 1.2);
		insertMutation(parent.id, child.id);

		// Manually retire parent
		const db = getDb();
		db.update(strategies).set({ status: "retired" as const }).where(eq(strategies.id, parent.id)).run();

		const results = await runTournaments();
		expect(results.length).toBe(0); // already resolved
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/evolution/tournament.test.ts`
Expected: FAIL — module not found

### Step 2: Implement tournament

- [ ] **Step 2.1: Write tournament.ts**

```typescript
// src/evolution/tournament.ts
import { eq, and, ne } from "drizzle-orm";
import { getDb } from "../db/client";
import { strategies, strategyMetrics, strategyMutations, graduationEvents } from "../db/schema";
import { log } from "../utils/logger";
import type { TournamentResult } from "./types";

const MIN_TRADES_FOR_TOURNAMENT = 30;

export async function runTournaments(): Promise<TournamentResult[]> {
	const db = getDb();
	const results: TournamentResult[] = [];

	// Find all mutation pairs where both parent and child are still active (not retired)
	const mutations = db.select().from(strategyMutations).all();

	for (const mutation of mutations) {
		// Skip if already resolved (either has Sharpe filled in)
		if (mutation.parentSharpe != null || mutation.childSharpe != null) continue;

		const parent = db.select().from(strategies).where(eq(strategies.id, mutation.parentId)).get();
		const child = db.select().from(strategies).where(eq(strategies.id, mutation.childId)).get();

		if (!parent || !child) continue;

		// Both must be non-retired
		if (parent.status === "retired" || child.status === "retired") continue;

		const parentMetrics = db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, parent.id))
			.get();
		const childMetrics = db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, child.id))
			.get();

		// Both need 30+ trades
		if (!parentMetrics || parentMetrics.sampleSize < MIN_TRADES_FOR_TOURNAMENT) continue;
		if (!childMetrics || childMetrics.sampleSize < MIN_TRADES_FOR_TOURNAMENT) continue;

		const parentSharpe = parentMetrics.sharpeRatio ?? -Infinity;
		const childSharpe = childMetrics.sharpeRatio ?? -Infinity;

		const childWins = childSharpe > parentSharpe;
		const winnerId = childWins ? child.id : parent.id;
		const loserId = childWins ? parent.id : child.id;
		const reason = childWins
			? `Child Sharpe ${childSharpe.toFixed(2)} > parent Sharpe ${parentSharpe.toFixed(2)}`
			: `Parent Sharpe ${parentSharpe.toFixed(2)} >= child Sharpe ${childSharpe.toFixed(2)}`;

		// Retire loser
		db.update(strategies)
			.set({ status: "retired" as const, retiredAt: new Date().toISOString() })
			.where(eq(strategies.id, loserId))
			.run();

		db.insert(graduationEvents).values({
			strategyId: loserId,
			event: "killed" as const,
			evidence: JSON.stringify({ tournament: true, reason }),
		}).run();

		// Record Sharpe values on mutation record
		db.update(strategyMutations)
			.set({
				parentSharpe: parentMetrics.sharpeRatio,
				childSharpe: childMetrics.sharpeRatio,
			})
			.where(eq(strategyMutations.id, mutation.id))
			.run();

		log("INFO", "evolution", `Tournament: ${reason}. Winner: strategy ${winnerId}, loser: strategy ${loserId} retired`);

		results.push({
			parentId: parent.id,
			childId: child.id,
			parentSharpe: parentMetrics.sharpeRatio ?? 0,
			childSharpe: childMetrics.sharpeRatio ?? 0,
			winnerId,
			loserId,
			reason,
		});
	}

	return results;
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/evolution/tournament.test.ts`
Expected: 4 tests pass

- [ ] **Step 2.3: Commit**

```bash
git add src/evolution/tournament.ts tests/evolution/tournament.test.ts
git commit -m "feat: add tournament comparator for parent vs child strategies"
```

---

## Task 7: Evolution Job & Scheduler Wiring

Orchestrates the full weekly evolution cycle: drawdown checks -> tournaments -> population cap -> Sonnet evolution call -> validate -> spawn children. Wires into the scheduler.

**Files:**
- Create: `src/evolution/index.ts`
- Create: `src/scheduler/evolution-job.ts`
- Modify: `src/scheduler/jobs.ts` (implement "strategy_evolution" case)
- Modify: `src/scheduler/cron.ts` (add weekly cron)

### Step 1: Write the orchestrator

- [ ] **Step 1.1: Write index.ts**

```typescript
// src/evolution/index.ts
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { canAffordCall } from "../utils/budget";
import { recordUsage } from "../utils/token-tracker";
import { withRetry } from "../utils/retry";
import { log } from "../utils/logger";
import { getPerformanceLandscape } from "./analyzer";
import { buildEvolutionPrompt, parseEvolutionResponse } from "./prompt";
import { validateMutation } from "./validator";
import { spawnChild } from "./spawner";
import { checkDrawdowns, enforcePopulationCap, MAX_POPULATION } from "./population";
import { runTournaments } from "./tournament";
import type { StrategyPerformance } from "./types";

const ESTIMATED_EVOLUTION_COST = 0.05; // ~2000 input tokens + 500 output @ Sonnet pricing

export async function runEvolutionCycle(): Promise<{
	drawdownKills: number[];
	tournaments: number;
	populationCulls: number[];
	spawned: number[];
	skippedReason?: string;
}> {
	// Step 1: Kill strategies exceeding drawdown limit
	const drawdownKills = await checkDrawdowns();
	if (drawdownKills.length > 0) {
		log("INFO", "evolution", `Drawdown check killed ${drawdownKills.length} strategies`);
	}

	// Step 2: Run tournaments for mature parent/child pairs
	const tournamentResults = await runTournaments();
	if (tournamentResults.length > 0) {
		log("INFO", "evolution", `${tournamentResults.length} tournaments resolved`);
	}

	// Step 3: Enforce population cap
	const populationCulls = await enforcePopulationCap();

	// Step 4: Get current landscape
	const landscape = await getPerformanceLandscape();

	// Skip Sonnet call if no strategies have enough data
	const mature = landscape.strategies.filter(
		(s) => s.status === "paper" && s.metrics && s.metrics.sampleSize >= 30,
	);
	if (mature.length === 0) {
		log("INFO", "evolution", "No paper strategies with 30+ trades — skipping evolution call");
		return {
			drawdownKills,
			tournaments: tournamentResults.length,
			populationCulls,
			spawned: [],
			skippedReason: "No mature strategies",
		};
	}

	// Skip if at population cap
	if (landscape.activePaperCount >= MAX_POPULATION) {
		log("INFO", "evolution", "Population at cap — skipping evolution call");
		return {
			drawdownKills,
			tournaments: tournamentResults.length,
			populationCulls,
			spawned: [],
			skippedReason: "Population at cap",
		};
	}

	// Step 5: Budget check
	if (!(await canAffordCall(ESTIMATED_EVOLUTION_COST))) {
		log("WARN", "evolution", "Budget exceeded — skipping evolution call");
		return {
			drawdownKills,
			tournaments: tournamentResults.length,
			populationCulls,
			spawned: [],
			skippedReason: "Budget exceeded",
		};
	}

	// Step 6: Call Sonnet
	const config = getConfig();
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
	const { system, user } = buildEvolutionPrompt(landscape);

	const response = await withRetry(
		async () =>
			client.messages.create({
				model: config.CLAUDE_MODEL,
				max_tokens: 1024,
				system,
				messages: [{ role: "user", content: user }],
			}),
		"strategy-evolution",
		{ maxAttempts: 2, baseDelayMs: 2000 },
	);

	const text = response.content[0]?.type === "text" ? response.content[0].text : "";
	await recordUsage(
		"strategy_evolution",
		response.usage.input_tokens,
		response.usage.output_tokens,
	);

	// Step 7: Parse and validate proposals
	const proposals = parseEvolutionResponse(text);
	log("INFO", "evolution", `Sonnet proposed ${proposals.length} mutations`);

	const existingStrategies = landscape.strategies;
	const spawned: number[] = [];
	const slotsAvailable = MAX_POPULATION - landscape.activePaperCount;

	for (const proposal of proposals) {
		if (spawned.length >= slotsAvailable) {
			log("INFO", "evolution", "Population cap reached — stopping spawning");
			break;
		}

		const parent = existingStrategies.find((s) => s.id === proposal.parentId);
		if (!parent) {
			log("WARN", "evolution", `Parent ${proposal.parentId} not found — skipping proposal`);
			continue;
		}

		const result = validateMutation(proposal, parent, existingStrategies);
		if (!result.valid) {
			log("WARN", "evolution", `Rejected mutation "${proposal.name}": ${result.reason}`);
			continue;
		}

		const childId = await spawnChild(result.mutation);
		spawned.push(childId);
		log("INFO", "evolution", `Spawned strategy ${result.mutation.name} (ID: ${childId}) from parent ${parent.name}`);
	}

	return {
		drawdownKills,
		tournaments: tournamentResults.length,
		populationCulls,
		spawned,
	};
}
```

- [ ] **Step 1.2: Commit orchestrator**

```bash
git add src/evolution/index.ts
git commit -m "feat: add evolution cycle orchestrator"
```

### Step 2: Wire into scheduler

- [ ] **Step 2.1: Create evolution-job.ts**

```typescript
// src/scheduler/evolution-job.ts
import { runEvolutionCycle } from "../evolution/index";
import { log } from "../utils/logger";

export async function runEvolutionJob(): Promise<void> {
	log("INFO", "scheduler", "Starting weekly evolution cycle");

	const result = await runEvolutionCycle();

	const summary = [
		`Drawdown kills: ${result.drawdownKills.length}`,
		`Tournaments resolved: ${result.tournaments}`,
		`Population culls: ${result.populationCulls.length}`,
		`New strategies spawned: ${result.spawned.length}`,
		result.skippedReason ? `Skipped evolution call: ${result.skippedReason}` : null,
	]
		.filter(Boolean)
		.join(", ");

	log("INFO", "scheduler", `Evolution cycle complete: ${summary}`);
}
```

- [ ] **Step 2.2: Add strategy_evolution case to jobs.ts**

In `src/scheduler/jobs.ts`, find the stubbed `strategy_evolution` case and replace with:

```typescript
case "strategy_evolution": {
	const { runEvolutionJob } = await import("./evolution-job");
	await runEvolutionJob();
	break;
}
```

- [ ] **Step 2.3: Add weekly cron schedule to cron.ts**

In `src/scheduler/cron.ts`, add the evolution cron. Schedule: **Sunday 18:00 London time** (after the trading week, before Monday).

```typescript
// Strategy evolution — weekly on Sunday at 18:00
registerJob("0 18 * * 0", "strategy_evolution");
```

- [ ] **Step 2.4: Run full test suite**

Run: `bun test --preload ./tests/preload.ts`
Expected: all tests pass

- [ ] **Step 2.5: Commit**

```bash
git add src/scheduler/evolution-job.ts src/scheduler/jobs.ts src/scheduler/cron.ts
git commit -m "feat: wire evolution cycle into scheduler (weekly Sunday 18:00)"
```

---

## Task 8: Evolution Evals

Eval suite for the Sonnet evolution call. Tests whether the model proposes sensible mutations given various performance landscapes. Uses code graders for JSON shape, parameter validity, and diversity — no LLM-as-judge needed for this domain.

**Files:**
- Create: `src/evals/evolution/tasks.ts`
- Create: `src/evals/evolution/graders.ts`
- Create: `src/evals/evolution/suite.ts`
- Create: `tests/evals/evolution-graders.test.ts`
- Modify: `src/evals/run.ts` (add "evolution" suite)
- Modify: `package.json` (add `eval:evolution` script)

### Step 1: Write eval tasks

- [ ] **Step 1.1: Create 25 eval tasks**

```typescript
// src/evals/evolution/tasks.ts
import type { EvalTask } from "../types";
import type { PerformanceLandscape } from "../../evolution/types";
import type { MutationProposal } from "../../evolution/types";

export interface EvolutionInput {
	landscape: PerformanceLandscape;
	description: string;
}

export interface EvolutionReference {
	minProposals: number;
	maxProposals: number;
	/** If set, at least one proposal must target this parent ID */
	expectedParentId?: number;
	/** If set, all proposals must have this type */
	expectedType?: "parameter_tweak" | "new_variant";
	/** If true, expect model to propose new_variant (gap-filling) */
	expectsNewVariant?: boolean;
	/** Parameters that should NOT be outside these ranges */
	parameterConstraints?: Record<string, { min: number; max: number }>;
}

export const EVOLUTION_TASKS: EvalTask<EvolutionInput, EvolutionReference>[] = [
	// === BASIC MUTATION PROPOSALS ===
	{
		id: "evo-001",
		name: "Single strong strategy — propose tweaks",
		input: {
			description: "One mature strategy with positive Sharpe, room to improve",
			landscape: {
				strategies: [
					{
						id: 1, name: "news_sentiment_mr_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { sentiment_threshold: 0.7, rsi_oversold: 30, hold_days: 3, position_size_pct: 10 },
						signals: { entry_long: "news_sentiment > 0.7 AND rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL", "MSFT", "GOOGL"],
						metrics: { sampleSize: 45, winRate: 0.55, expectancy: 8.2, profitFactor: 1.4, sharpeRatio: 0.9, sortinoRatio: 1.1, maxDrawdownPct: 7.5, calmarRatio: 1.5, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3, expectedParentId: 1 },
		tags: ["basic", "parameter_tweak"],
	},
	{
		id: "evo-002",
		name: "Two strategies — focus on best performer",
		input: {
			description: "Two strategies, one strong and one weak",
			landscape: {
				strategies: [
					{
						id: 1, name: "strong_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 3, position_size_pct: 10 },
						signals: { entry_long: "rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL"],
						metrics: { sampleSize: 50, winRate: 0.6, expectancy: 15.0, profitFactor: 1.8, sharpeRatio: 1.3, sortinoRatio: 1.5, maxDrawdownPct: 5.0, calmarRatio: 3.0, consistencyScore: 4 },
						recentTrades: [], virtualBalance: 10000,
					},
					{
						id: 2, name: "weak_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 5, position_size_pct: 8 },
						signals: { entry_long: "volume_ratio > 2", exit: "hold_days >= 5" },
						universe: ["MSFT"],
						metrics: { sampleSize: 40, winRate: 0.35, expectancy: -5.0, profitFactor: 0.7, sharpeRatio: -0.3, sortinoRatio: -0.2, maxDrawdownPct: 12.0, calmarRatio: -0.5, consistencyScore: 1 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 2, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 4, expectedParentId: 1 },
		tags: ["basic", "selection"],
	},
	{
		id: "evo-003",
		name: "All strategies immature — propose nothing or cautious",
		input: {
			description: "Strategies with fewer than 30 trades",
			landscape: {
				strategies: [
					{
						id: 1, name: "new_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 3 },
						signals: { entry_long: "rsi14 < 30" },
						universe: ["AAPL"],
						metrics: { sampleSize: 12, winRate: 0.5, expectancy: 2.0, profitFactor: 1.1, sharpeRatio: 0.3, sortinoRatio: 0.4, maxDrawdownPct: 3.0, calmarRatio: 1.0, consistencyScore: 2 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 0, maxProposals: 2 },
		tags: ["edge_case", "immature"],
	},
	// === GAP FILLING ===
	{
		id: "evo-004",
		name: "Single approach — suggest diversification",
		input: {
			description: "All strategies use same signal type, should suggest a new variant",
			landscape: {
				strategies: [
					{
						id: 1, name: "rsi_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { rsi_oversold: 30, hold_days: 3, position_size_pct: 10 },
						signals: { entry_long: "rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL", "MSFT"],
						metrics: { sampleSize: 60, winRate: 0.55, expectancy: 10.0, profitFactor: 1.5, sharpeRatio: 1.0, sortinoRatio: 1.2, maxDrawdownPct: 8.0, calmarRatio: 1.8, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
					{
						id: 2, name: "rsi_v2", status: "paper", generation: 2,
						parentStrategyId: 1, createdBy: "evolution",
						parameters: { rsi_oversold: 25, hold_days: 4, position_size_pct: 10 },
						signals: { entry_long: "rsi14 < 25", exit: "hold_days >= 4" },
						universe: ["AAPL", "MSFT"],
						metrics: { sampleSize: 45, winRate: 0.52, expectancy: 8.0, profitFactor: 1.3, sharpeRatio: 0.8, sortinoRatio: 1.0, maxDrawdownPct: 9.0, calmarRatio: 1.2, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 2, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 4, expectsNewVariant: true },
		tags: ["gap_filling", "diversity"],
	},
	// === PARAMETER CONSTRAINTS ===
	{
		id: "evo-005",
		name: "Proposals must respect parameter ranges",
		input: {
			description: "Strategy with room to tune, parameters should stay in valid ranges",
			landscape: {
				strategies: [
					{
						id: 1, name: "gap_fade_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { gap_threshold_pct: 2, exit_target_pct: 1, position_size_pct: 10 },
						signals: { entry_long: "change_percent < -2", exit: "pnl_pct > 1" },
						universe: ["AAPL"],
						metrics: { sampleSize: 50, winRate: 0.48, expectancy: 5.0, profitFactor: 1.2, sharpeRatio: 0.6, sortinoRatio: 0.8, maxDrawdownPct: 10.0, calmarRatio: 0.8, consistencyScore: 2 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: {
			minProposals: 1, maxProposals: 3,
			parameterConstraints: {
				gap_threshold_pct: { min: 0.5, max: 5 },
				exit_target_pct: { min: 0.5, max: 10 },
				position_size_pct: { min: 2, max: 25 },
			},
		},
		tags: ["constraints", "parameter_range"],
	},
	// === NEAR-CAPACITY POPULATION ===
	{
		id: "evo-006",
		name: "Population nearly full — propose fewer mutations",
		input: {
			description: "7 of 8 slots used, only 1 slot available",
			landscape: {
				strategies: Array.from({ length: 7 }, (_, i) => ({
					id: i + 1, name: `strat_v${i + 1}`, status: "paper" as const, generation: 1,
					parentStrategyId: null, createdBy: "seed",
					parameters: { hold_days: i + 2, position_size_pct: 10 },
					signals: { entry_long: `rsi14 < ${25 + i * 3}`, exit: "hold_days >= 3" },
					universe: ["AAPL"],
					metrics: { sampleSize: 35 + i, winRate: 0.5, expectancy: 5.0, profitFactor: 1.2, sharpeRatio: 0.5 + i * 0.1, sortinoRatio: 0.6, maxDrawdownPct: 8.0, calmarRatio: 1.0, consistencyScore: 3 },
					recentTrades: [], virtualBalance: 10000,
				})),
				activePaperCount: 7, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 0, maxProposals: 2 },
		tags: ["population", "near_cap"],
	},
	// === FULL CAPACITY ===
	{
		id: "evo-007",
		name: "Population full — should propose 0",
		input: {
			description: "All 8 slots used",
			landscape: {
				strategies: Array.from({ length: 8 }, (_, i) => ({
					id: i + 1, name: `strat_v${i + 1}`, status: "paper" as const, generation: 1,
					parentStrategyId: null, createdBy: "seed",
					parameters: { hold_days: i + 2 },
					signals: { entry_long: `rsi14 < ${25 + i * 3}` },
					universe: ["AAPL"],
					metrics: { sampleSize: 40, winRate: 0.5, expectancy: 5.0, profitFactor: 1.2, sharpeRatio: 0.8, sortinoRatio: 0.9, maxDrawdownPct: 7.0, calmarRatio: 1.0, consistencyScore: 3 },
					recentTrades: [], virtualBalance: 10000,
				})),
				activePaperCount: 8, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 0, maxProposals: 0 },
		tags: ["population", "full_cap"],
	},
	// === MULTI-GENERATION LINEAGE ===
	{
		id: "evo-008",
		name: "Third-generation strategy — continue evolution",
		input: {
			description: "Strategy at generation 3 performing well, should still evolve",
			landscape: {
				strategies: [
					{
						id: 5, name: "news_sentiment_mr_v4", status: "paper", generation: 3,
						parentStrategyId: 3, createdBy: "evolution",
						parameters: { sentiment_threshold: 0.55, rsi_oversold: 25, hold_days: 4, position_size_pct: 12 },
						signals: { entry_long: "news_sentiment > 0.55 AND rsi14 < 25", exit: "hold_days >= 4" },
						universe: ["AAPL", "MSFT", "GOOGL"],
						metrics: { sampleSize: 55, winRate: 0.62, expectancy: 18.0, profitFactor: 2.0, sharpeRatio: 1.4, sortinoRatio: 1.7, maxDrawdownPct: 6.0, calmarRatio: 3.5, consistencyScore: 4 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3, expectedParentId: 5 },
		tags: ["lineage", "multi_gen"],
	},
	// === NEGATIVE EXPECTANCY ===
	{
		id: "evo-009",
		name: "All strategies negative — propose new variant",
		input: {
			description: "All strategies losing money, model should suggest entirely new approach",
			landscape: {
				strategies: [
					{
						id: 1, name: "loser_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 3, position_size_pct: 10 },
						signals: { entry_long: "rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL"],
						metrics: { sampleSize: 50, winRate: 0.35, expectancy: -8.0, profitFactor: 0.6, sharpeRatio: -0.5, sortinoRatio: -0.4, maxDrawdownPct: 14.0, calmarRatio: -1.0, consistencyScore: 0 },
						recentTrades: [], virtualBalance: 10000,
					},
					{
						id: 2, name: "loser_v2", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { sentiment_threshold: 0.7, hold_days: 5 },
						signals: { entry_long: "news_sentiment > 0.7", exit: "hold_days >= 5" },
						universe: ["MSFT"],
						metrics: { sampleSize: 45, winRate: 0.4, expectancy: -3.0, profitFactor: 0.8, sharpeRatio: -0.2, sortinoRatio: -0.1, maxDrawdownPct: 11.0, calmarRatio: -0.3, consistencyScore: 1 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 2, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 4, expectsNewVariant: true },
		tags: ["negative", "gap_filling"],
	},
	// === UK/LSE MARKET ===
	{
		id: "evo-010",
		name: "LSE strategy — respect pence pricing",
		input: {
			description: "UK-listed strategy, model should understand LSE universe format",
			landscape: {
				strategies: [
					{
						id: 1, name: "uk_momentum_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 5, position_size_pct: 8 },
						signals: { entry_long: "change_percent > 3 AND volume_ratio > 1.5", exit: "hold_days >= 5 OR pnl_pct < -2" },
						universe: ["SHEL:LSE", "BP:LSE", "AZN:LSE"],
						metrics: { sampleSize: 38, winRate: 0.52, expectancy: 4.5, profitFactor: 1.15, sharpeRatio: 0.45, sortinoRatio: 0.5, maxDrawdownPct: 9.0, calmarRatio: 0.7, consistencyScore: 2 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3, expectedParentId: 1 },
		tags: ["uk_market", "lse"],
	},
	// === EDGE: EMPTY LANDSCAPE ===
	{
		id: "evo-011",
		name: "Empty landscape — no strategies at all",
		input: {
			description: "No strategies exist yet",
			landscape: { strategies: [], activePaperCount: 0, timestamp: "2026-04-04T12:00:00Z" },
		},
		reference: { minProposals: 0, maxProposals: 0 },
		tags: ["edge_case", "empty"],
	},
	// === PARAMETER TWEAK SPECIFICS ===
	{
		id: "evo-012",
		name: "High-Sharpe strategy — conservative tweaks",
		input: {
			description: "Strategy with Sharpe > 1.5, tweaks should be small/conservative",
			landscape: {
				strategies: [
					{
						id: 1, name: "champion_v3", status: "paper", generation: 3,
						parentStrategyId: null, createdBy: "evolution",
						parameters: { sentiment_threshold: 0.6, rsi_oversold: 28, hold_days: 4, position_size_pct: 12 },
						signals: { entry_long: "news_sentiment > 0.6 AND rsi14 < 28", exit: "hold_days >= 4 OR pnl_pct > 6" },
						universe: ["AAPL", "MSFT", "GOOGL"],
						metrics: { sampleSize: 80, winRate: 0.65, expectancy: 22.0, profitFactor: 2.5, sharpeRatio: 1.8, sortinoRatio: 2.1, maxDrawdownPct: 4.5, calmarRatio: 5.0, consistencyScore: 4 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 2, expectedParentId: 1, expectedType: "parameter_tweak" },
		tags: ["high_performer", "conservative"],
	},
	// === MAX PARAMETERS CHECK ===
	{
		id: "evo-013",
		name: "Strategy with 5 params — cannot add more",
		input: {
			description: "Already at max 5 parameters, mutation must stay at 5 or fewer",
			landscape: {
				strategies: [
					{
						id: 1, name: "five_param_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { a: 1, b: 2, c: 3, d: 4, e: 5 },
						signals: { entry_long: "rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL"],
						metrics: { sampleSize: 40, winRate: 0.5, expectancy: 5.0, profitFactor: 1.2, sharpeRatio: 0.7, sortinoRatio: 0.8, maxDrawdownPct: 8.0, calmarRatio: 1.0, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: {
			minProposals: 1, maxProposals: 3,
			parameterConstraints: {}, // validated by grader checking param count <= 5
		},
		tags: ["constraints", "max_params"],
	},
	// === MIXED MARKET STRATEGIES ===
	{
		id: "evo-014",
		name: "US and UK strategies — propose for both",
		input: {
			description: "Mix of US and UK strategies, model should consider both markets",
			landscape: {
				strategies: [
					{
						id: 1, name: "us_rsi_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { rsi_oversold: 30, hold_days: 3, position_size_pct: 10 },
						signals: { entry_long: "rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL", "MSFT"],
						metrics: { sampleSize: 50, winRate: 0.55, expectancy: 10.0, profitFactor: 1.5, sharpeRatio: 1.0, sortinoRatio: 1.2, maxDrawdownPct: 7.0, calmarRatio: 1.8, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
					{
						id: 2, name: "uk_momentum_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 5, position_size_pct: 8 },
						signals: { entry_long: "change_percent > 2", exit: "hold_days >= 5" },
						universe: ["SHEL:LSE", "BP:LSE"],
						metrics: { sampleSize: 35, winRate: 0.5, expectancy: 3.0, profitFactor: 1.1, sharpeRatio: 0.4, sortinoRatio: 0.5, maxDrawdownPct: 10.0, calmarRatio: 0.5, consistencyScore: 2 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 2, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 4 },
		tags: ["mixed_market", "multi_strategy"],
	},
	// === JUST ABOVE 30 TRADES ===
	{
		id: "evo-015",
		name: "Strategy just hit 30 trades — first evolution opportunity",
		input: {
			description: "Strategy has exactly 30 trades, first time eligible",
			landscape: {
				strategies: [
					{
						id: 1, name: "fresh_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 3, position_size_pct: 10 },
						signals: { entry_long: "rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL"],
						metrics: { sampleSize: 30, winRate: 0.53, expectancy: 6.0, profitFactor: 1.3, sharpeRatio: 0.7, sortinoRatio: 0.8, maxDrawdownPct: 6.0, calmarRatio: 1.2, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3, expectedParentId: 1 },
		tags: ["basic", "threshold"],
	},
	// === HIGH DRAWDOWN NEAR LIMIT ===
	{
		id: "evo-016",
		name: "Strategy near 15% drawdown limit — evolution should be cautious",
		input: {
			description: "Drawdown at 13%, close to kill switch, mutations should reduce risk",
			landscape: {
				strategies: [
					{
						id: 1, name: "risky_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 10, position_size_pct: 20 },
						signals: { entry_long: "rsi14 < 20", exit: "hold_days >= 10" },
						universe: ["AAPL", "TSLA"],
						metrics: { sampleSize: 40, winRate: 0.45, expectancy: 2.0, profitFactor: 1.05, sharpeRatio: 0.2, sortinoRatio: 0.3, maxDrawdownPct: 13.0, calmarRatio: 0.2, consistencyScore: 1 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: {
			minProposals: 1, maxProposals: 3,
			parameterConstraints: {
				position_size_pct: { min: 2, max: 15 }, // should not increase risk
			},
		},
		tags: ["risk", "drawdown"],
	},
	// === MANY GENERATIONS ===
	{
		id: "evo-017",
		name: "Long lineage chain — latest generation is best",
		input: {
			description: "Gen 5 strategy, Sharpe trending up across generations",
			landscape: {
				strategies: [
					{
						id: 10, name: "evolved_v6", status: "paper", generation: 5,
						parentStrategyId: 8, createdBy: "evolution",
						parameters: { sentiment_threshold: 0.45, rsi_oversold: 22, hold_days: 4, position_size_pct: 14 },
						signals: { entry_long: "news_sentiment > 0.45 AND rsi14 < 22", exit: "hold_days >= 4 OR pnl_pct > 7" },
						universe: ["AAPL", "MSFT", "GOOGL", "AMZN"],
						metrics: { sampleSize: 70, winRate: 0.67, expectancy: 25.0, profitFactor: 2.8, sharpeRatio: 2.0, sortinoRatio: 2.4, maxDrawdownPct: 3.5, calmarRatio: 7.0, consistencyScore: 4 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 2, expectedType: "parameter_tweak" },
		tags: ["lineage", "deep_gen"],
	},
	// === JSON SHAPE BASICS ===
	{
		id: "evo-018",
		name: "Response must be valid JSON array",
		input: {
			description: "Basic format test",
			landscape: {
				strategies: [
					{
						id: 1, name: "test_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 3, position_size_pct: 10 },
						signals: { entry_long: "rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL"],
						metrics: { sampleSize: 50, winRate: 0.55, expectancy: 8.0, profitFactor: 1.4, sharpeRatio: 0.8, sortinoRatio: 1.0, maxDrawdownPct: 7.0, calmarRatio: 1.3, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3 },
		tags: ["json_shape", "basic"],
	},
	// === EARNINGS-FOCUSED STRATEGY ===
	{
		id: "evo-019",
		name: "Earnings strategy — propose sentiment or timing tweaks",
		input: {
			description: "Earnings drift strategy, tweaks should focus on timing or thresholds",
			landscape: {
				strategies: [
					{
						id: 1, name: "earnings_drift_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { surprise_threshold: 0.5, tone_score_min: 0.6, hold_days: 5, position_size_pct: 8 },
						signals: { entry_long: "news_sentiment > 0.5 AND volume_ratio > 2.0", exit: "hold_days >= 5 OR pnl_pct < -3 OR pnl_pct > 8" },
						universe: ["AAPL", "MSFT", "GOOGL"],
						metrics: { sampleSize: 42, winRate: 0.57, expectancy: 12.0, profitFactor: 1.6, sharpeRatio: 1.1, sortinoRatio: 1.3, maxDrawdownPct: 6.5, calmarRatio: 2.2, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3, expectedParentId: 1 },
		tags: ["earnings", "parameter_tweak"],
	},
	// === GAP FADE STRATEGY ===
	{
		id: "evo-020",
		name: "Gap fade with mediocre performance — room to improve",
		input: {
			description: "Gap fade strategy is break-even, needs parameter tuning",
			landscape: {
				strategies: [
					{
						id: 1, name: "gap_fade_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { gap_threshold_pct: 2, exit_target_pct: 1, position_size_pct: 10 },
						signals: { entry_long: "change_percent < -2 AND news_sentiment > -0.3", exit: "hold_days >= 1 OR pnl_pct < -3 OR pnl_pct > 1" },
						universe: ["AAPL", "TSLA", "NVDA"],
						metrics: { sampleSize: 55, winRate: 0.49, expectancy: 1.0, profitFactor: 1.02, sharpeRatio: 0.15, sortinoRatio: 0.2, maxDrawdownPct: 11.0, calmarRatio: 0.15, consistencyScore: 2 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3, expectedParentId: 1 },
		tags: ["gap_fade", "underperformer"],
	},
	// === PARENT-CHILD COEXISTENCE ===
	{
		id: "evo-021",
		name: "Active parent-child pair — no duplicate mutation",
		input: {
			description: "Parent and its child variant both active, model should not duplicate the child",
			landscape: {
				strategies: [
					{
						id: 1, name: "base_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 3, position_size_pct: 10, rsi_oversold: 30 },
						signals: { entry_long: "rsi14 < 30", exit: "hold_days >= 3" },
						universe: ["AAPL"],
						metrics: { sampleSize: 50, winRate: 0.54, expectancy: 7.0, profitFactor: 1.35, sharpeRatio: 0.85, sortinoRatio: 1.0, maxDrawdownPct: 7.0, calmarRatio: 1.4, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
					{
						id: 2, name: "base_v2", status: "paper", generation: 2,
						parentStrategyId: 1, createdBy: "evolution",
						parameters: { hold_days: 5, position_size_pct: 12, rsi_oversold: 25 },
						signals: { entry_long: "rsi14 < 25", exit: "hold_days >= 5" },
						universe: ["AAPL"],
						metrics: { sampleSize: 35, winRate: 0.57, expectancy: 9.0, profitFactor: 1.5, sharpeRatio: 1.0, sortinoRatio: 1.2, maxDrawdownPct: 6.0, calmarRatio: 1.8, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 2, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3 },
		tags: ["lineage", "diversity"],
	},
	// === CONSISTENCY-FOCUSED ===
	{
		id: "evo-022",
		name: "Good Sharpe but low consistency — address weekly variance",
		input: {
			description: "Strategy profitable overall but only 1/4 weeks profitable, needs smoothing",
			landscape: {
				strategies: [
					{
						id: 1, name: "volatile_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 8, position_size_pct: 20 },
						signals: { entry_long: "rsi14 < 20 AND volume_ratio > 3", exit: "hold_days >= 8 OR pnl_pct > 10" },
						universe: ["TSLA", "NVDA"],
						metrics: { sampleSize: 40, winRate: 0.45, expectancy: 15.0, profitFactor: 1.4, sharpeRatio: 0.9, sortinoRatio: 0.7, maxDrawdownPct: 12.0, calmarRatio: 1.0, consistencyScore: 1 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3 },
		tags: ["consistency", "risk"],
	},
	// === NAME UNIQUENESS ===
	{
		id: "evo-023",
		name: "Proposed names must be unique",
		input: {
			description: "Existing strategy names that must not be reused",
			landscape: {
				strategies: [
					{
						id: 1, name: "news_sentiment_mr_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { sentiment_threshold: 0.7, hold_days: 3, position_size_pct: 10 },
						signals: { entry_long: "news_sentiment > 0.7", exit: "hold_days >= 3" },
						universe: ["AAPL"],
						metrics: { sampleSize: 50, winRate: 0.55, expectancy: 8.0, profitFactor: 1.4, sharpeRatio: 0.9, sortinoRatio: 1.0, maxDrawdownPct: 7.0, calmarRatio: 1.5, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3, expectedParentId: 1 },
		tags: ["naming", "uniqueness"],
	},
	// === UNIVERSE EXPANSION ===
	{
		id: "evo-024",
		name: "Well-performing strategy — model may suggest universe expansion",
		input: {
			description: "Strategy only trades 1 symbol but performs well, could benefit from more symbols",
			landscape: {
				strategies: [
					{
						id: 1, name: "narrow_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { rsi_oversold: 28, hold_days: 3, position_size_pct: 15 },
						signals: { entry_long: "rsi14 < 28", exit: "hold_days >= 3 OR pnl_pct > 5" },
						universe: ["AAPL"],
						metrics: { sampleSize: 60, winRate: 0.58, expectancy: 11.0, profitFactor: 1.6, sharpeRatio: 1.1, sortinoRatio: 1.3, maxDrawdownPct: 5.5, calmarRatio: 2.5, consistencyScore: 3 },
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 1, maxProposals: 3 },
		tags: ["universe", "expansion"],
	},
	// === ZERO METRICS ===
	{
		id: "evo-025",
		name: "Strategy with no metrics row — handle gracefully",
		input: {
			description: "Newly created strategy with no metrics yet",
			landscape: {
				strategies: [
					{
						id: 1, name: "brand_new_v1", status: "paper", generation: 1,
						parentStrategyId: null, createdBy: "seed",
						parameters: { hold_days: 3 },
						signals: { entry_long: "rsi14 < 30" },
						universe: ["AAPL"],
						metrics: null,
						recentTrades: [], virtualBalance: 10000,
					},
				],
				activePaperCount: 1, timestamp: "2026-04-04T12:00:00Z",
			},
		},
		reference: { minProposals: 0, maxProposals: 1 },
		tags: ["edge_case", "no_metrics"],
	},
];
```

- [ ] **Step 1.2: Commit tasks**

```bash
git add src/evals/evolution/tasks.ts
git commit -m "feat: add 25 evolution eval tasks covering basic, gap-filling, constraints, edge cases"
```

### Step 2: Write graders

- [ ] **Step 2.1: Write grader tests**

```typescript
// tests/evals/evolution-graders.test.ts
import { describe, expect, test } from "bun:test";
import {
	proposalCountGrader,
	jsonShapeGrader,
	parameterRangeGrader,
	parentTargetGrader,
	maxParametersGrader,
} from "../../src/evals/evolution/graders";
import type { MutationProposal } from "../../src/evolution/types";
import type { EvolutionReference } from "../../src/evals/evolution/tasks";

const validProposal: MutationProposal = {
	parentId: 1,
	type: "parameter_tweak",
	name: "test_v2",
	description: "tweaked",
	parameters: { hold_days: 5, position_size_pct: 10 },
	reasoning: "improving hold period",
};

describe("proposalCountGrader", () => {
	test("passes when count in range", async () => {
		const ref: EvolutionReference = { minProposals: 1, maxProposals: 3 };
		const result = await proposalCountGrader.grade([validProposal], ref);
		expect(result.pass).toBe(true);
	});

	test("fails when too few", async () => {
		const ref: EvolutionReference = { minProposals: 2, maxProposals: 3 };
		const result = await proposalCountGrader.grade([], ref);
		expect(result.pass).toBe(false);
	});

	test("fails when too many", async () => {
		const ref: EvolutionReference = { minProposals: 0, maxProposals: 0 };
		const result = await proposalCountGrader.grade([validProposal], ref);
		expect(result.pass).toBe(false);
	});
});

describe("jsonShapeGrader", () => {
	test("passes for well-shaped proposals", async () => {
		const result = await jsonShapeGrader.grade([validProposal], { minProposals: 1, maxProposals: 3 });
		expect(result.pass).toBe(true);
	});

	test("fails for proposal missing required fields", async () => {
		const bad = { parentId: 1 } as unknown as MutationProposal;
		const result = await jsonShapeGrader.grade([bad], { minProposals: 1, maxProposals: 3 });
		expect(result.pass).toBe(false);
	});
});

describe("parameterRangeGrader", () => {
	test("passes when parameters within constraints", async () => {
		const ref: EvolutionReference = {
			minProposals: 1, maxProposals: 3,
			parameterConstraints: { position_size_pct: { min: 2, max: 25 } },
		};
		const result = await parameterRangeGrader.grade([validProposal], ref);
		expect(result.pass).toBe(true);
	});

	test("fails when parameter out of range", async () => {
		const bad: MutationProposal = { ...validProposal, parameters: { position_size_pct: 50 } };
		const ref: EvolutionReference = {
			minProposals: 1, maxProposals: 3,
			parameterConstraints: { position_size_pct: { min: 2, max: 25 } },
		};
		const result = await parameterRangeGrader.grade([bad], ref);
		expect(result.pass).toBe(false);
	});

	test("passes when no constraints specified", async () => {
		const ref: EvolutionReference = { minProposals: 1, maxProposals: 3 };
		const result = await parameterRangeGrader.grade([validProposal], ref);
		expect(result.pass).toBe(true);
	});
});

describe("parentTargetGrader", () => {
	test("passes when expected parent targeted", async () => {
		const ref: EvolutionReference = { minProposals: 1, maxProposals: 3, expectedParentId: 1 };
		const result = await parentTargetGrader.grade([validProposal], ref);
		expect(result.pass).toBe(true);
	});

	test("fails when expected parent not targeted", async () => {
		const ref: EvolutionReference = { minProposals: 1, maxProposals: 3, expectedParentId: 99 };
		const result = await parentTargetGrader.grade([validProposal], ref);
		expect(result.pass).toBe(false);
	});
});

describe("maxParametersGrader", () => {
	test("passes when all proposals have 5 or fewer params", async () => {
		const result = await maxParametersGrader.grade([validProposal], { minProposals: 1, maxProposals: 3 });
		expect(result.pass).toBe(true);
	});

	test("fails when a proposal exceeds 5 params", async () => {
		const bad: MutationProposal = {
			...validProposal,
			parameters: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
		};
		const result = await maxParametersGrader.grade([bad], { minProposals: 1, maxProposals: 3 });
		expect(result.pass).toBe(false);
	});
});
```

- [ ] **Step 2.2: Write graders.ts**

```typescript
// src/evals/evolution/graders.ts
import type { Grader } from "../types";
import type { MutationProposal } from "../../evolution/types";
import type { EvolutionReference } from "./tasks";

export const proposalCountGrader: Grader<MutationProposal[], EvolutionReference> = {
	name: "proposal_count",
	type: "code",
	grade: async (output, reference) => {
		const count = output.length;
		const inRange = count >= reference.minProposals && count <= reference.maxProposals;
		return {
			score: inRange ? 1 : 0,
			pass: inRange,
			reason: inRange
				? `${count} proposals (expected ${reference.minProposals}-${reference.maxProposals})`
				: `${count} proposals outside expected range ${reference.minProposals}-${reference.maxProposals}`,
		};
	},
};

const REQUIRED_FIELDS = ["parentId", "type", "name", "description", "parameters", "reasoning"];

export const jsonShapeGrader: Grader<MutationProposal[], EvolutionReference> = {
	name: "json_shape",
	type: "code",
	grade: async (output) => {
		if (output.length === 0) return { score: 1, pass: true, reason: "No proposals to validate" };

		const invalid = output.filter((p) => {
			for (const field of REQUIRED_FIELDS) {
				if (!(field in p)) return true;
			}
			if (p.type !== "parameter_tweak" && p.type !== "new_variant") return true;
			if (typeof p.parameters !== "object" || p.parameters === null) return true;
			return false;
		});

		const allValid = invalid.length === 0;
		return {
			score: allValid ? 1 : 1 - invalid.length / output.length,
			pass: allValid,
			reason: allValid
				? "All proposals have valid shape"
				: `${invalid.length}/${output.length} proposals have invalid shape`,
		};
	},
};

export const parameterRangeGrader: Grader<MutationProposal[], EvolutionReference> = {
	name: "parameter_range",
	type: "code",
	grade: async (output, reference) => {
		if (!reference.parameterConstraints || Object.keys(reference.parameterConstraints).length === 0) {
			return { score: 1, pass: true, reason: "No parameter constraints to check" };
		}

		const violations: string[] = [];
		for (const proposal of output) {
			for (const [param, range] of Object.entries(reference.parameterConstraints)) {
				const value = proposal.parameters[param];
				if (value !== undefined && (value < range.min || value > range.max)) {
					violations.push(`${proposal.name}: ${param}=${value} outside [${range.min}, ${range.max}]`);
				}
			}
		}

		return {
			score: violations.length === 0 ? 1 : 0,
			pass: violations.length === 0,
			reason: violations.length === 0
				? "All parameters within constraints"
				: `Violations: ${violations.join("; ")}`,
		};
	},
};

export const parentTargetGrader: Grader<MutationProposal[], EvolutionReference> = {
	name: "parent_target",
	type: "code",
	grade: async (output, reference) => {
		if (!reference.expectedParentId) {
			return { score: 1, pass: true, reason: "No parent target constraint" };
		}

		const targeted = output.some((p) => p.parentId === reference.expectedParentId);
		return {
			score: targeted ? 1 : 0,
			pass: targeted,
			reason: targeted
				? `At least one proposal targets parent ${reference.expectedParentId}`
				: `No proposal targets expected parent ${reference.expectedParentId}`,
		};
	},
};

export const maxParametersGrader: Grader<MutationProposal[], EvolutionReference> = {
	name: "max_parameters",
	type: "code",
	grade: async (output) => {
		const overLimit = output.filter((p) => Object.keys(p.parameters).length > 5);
		const allOk = overLimit.length === 0;
		return {
			score: allOk ? 1 : 0,
			pass: allOk,
			reason: allOk
				? "All proposals have 5 or fewer parameters"
				: `${overLimit.length} proposals exceed 5 parameters`,
		};
	},
};

export const ALL_GRADERS = [
	proposalCountGrader,
	jsonShapeGrader,
	parameterRangeGrader,
	parentTargetGrader,
	maxParametersGrader,
];
```

- [ ] **Step 2.3: Run grader tests**

Run: `bun test tests/evals/evolution-graders.test.ts`
Expected: all tests pass

- [ ] **Step 2.4: Commit graders**

```bash
git add src/evals/evolution/graders.ts tests/evals/evolution-graders.test.ts
git commit -m "feat: add 5 code graders for evolution eval suite"
```

### Step 3: Write suite runner

- [ ] **Step 3.1: Write suite.ts**

```typescript
// src/evals/evolution/suite.ts
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config";
import { runSuite } from "../harness";
import type { SuiteOptions } from "../harness";
import { EVOLUTION_TASKS, type EvolutionInput, type EvolutionReference } from "./tasks";
import { ALL_GRADERS } from "./graders";
import { buildEvolutionPrompt, parseEvolutionResponse } from "../../evolution/prompt";
import type { MutationProposal } from "../../evolution/types";

export async function runEvolutionEvalSuite(
	options?: Partial<SuiteOptions>,
): Promise<void> {
	const config = getConfig();
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

	const taskFn = async (input: EvolutionInput): Promise<MutationProposal[]> => {
		const { system, user } = buildEvolutionPrompt(input.landscape);

		const response = await client.messages.create({
			model: config.CLAUDE_MODEL,
			max_tokens: 1024,
			system,
			messages: [{ role: "user", content: user }],
		});

		const text = response.content[0]?.type === "text" ? response.content[0].text : "";
		return parseEvolutionResponse(text);
	};

	const results = await runSuite<EvolutionInput, MutationProposal[], EvolutionReference>(
		EVOLUTION_TASKS,
		taskFn,
		ALL_GRADERS,
		{ trials: options?.trials ?? 2, suiteName: "evolution", ...options },
	);

	const { formatSuiteReport } = await import("../reporter");
	console.log(formatSuiteReport(results));
}
```

- [ ] **Step 3.2: Add "evolution" case to src/evals/run.ts**

In `src/evals/run.ts`, add the evolution suite case:

```typescript
case "evolution": {
	const { runEvolutionEvalSuite } = await import("./evolution/suite");
	await runEvolutionEvalSuite({ trials, tags });
	break;
}
```

- [ ] **Step 3.3: Add eval:evolution script to package.json**

Add to `"scripts"` in `package.json`:

```json
"eval:evolution": "bun run src/evals/run.ts evolution"
```

- [ ] **Step 3.4: Run full test suite**

Run: `bun test --preload ./tests/preload.ts`
Expected: all tests pass

- [ ] **Step 3.5: Commit**

```bash
git add src/evals/evolution/suite.ts src/evals/run.ts package.json
git commit -m "feat: add evolution eval suite with 25 tasks and 5 code graders"
```

---

## Summary

| Task | Component | Files | Tests |
|------|-----------|-------|-------|
| 1 | Types + Performance Analyzer | 2 new | 4 tests |
| 2 | Prompt Builder + Response Parser | 2 new + 1 minimal | 5 tests |
| 3 | Mutation Validator | 1 new | 7 tests |
| 4 | Strategy Spawner | 1 new | 3 tests |
| 5 | Population Manager + Drawdown Monitor | 1 modified | 4 tests |
| 6 | Tournament Comparator | 1 new | 4 tests |
| 7 | Evolution Job + Scheduler Wiring | 3 new + 2 modified | full suite |
| 8 | Evolution Evals | 3 new + 2 modified | 11 grader tests |

**Total: ~14 new files, ~38 new tests, 25 eval tasks, 5 graders**

**Weekly evolution schedule:** Sunday 18:00 London time — after the trading week ends, before Monday open. Runs drawdown check → tournaments → population cap → Sonnet evolution call → validate → spawn children.

**Cost per evolution cycle:** ~$0.05 (1 Sonnet call with ~2000 input tokens). At 4 cycles/month: ~$0.20/month.
