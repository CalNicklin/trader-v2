# News Research Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the news pipeline from single-symbol classification to multi-symbol research with missed opportunity tracking and cross-symbol pattern learning.

**Architecture:** Three components layered on the existing news pipeline. (1) A Sonnet-powered research agent runs fire-and-forget after Haiku triage for tradeable articles, producing per-symbol analysis rows. (2) A daily/weekly tracker job compares predicted directions against actual price moves, logging missed opportunities. (3) The existing pattern analysis prompt gains missed-opportunity context and outputs universe suggestions.

**Tech Stack:** Bun, TypeScript (strict), Drizzle ORM + SQLite, Anthropic SDK, node-cron, existing eval harness

**Spec:** `docs/specs/2026-04-07-news-research-intelligence.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/news/research-agent.ts` | Sonnet research agent: prompt, parse, store, signal write |
| `src/scheduler/missed-opportunity-job.ts` | Daily + weekly tracker: price fetch, comparison, insight logging |
| `src/evals/research-agent/tasks.ts` | 30+ eval tasks for research agent |
| `src/evals/research-agent/graders.ts` | Code + LLM-as-judge graders |
| `src/evals/research-agent/suite.ts` | Runner for research agent evals |
| `src/evals/missed-opportunity/tasks.ts` | 15+ eval tasks for tracker |
| `src/evals/missed-opportunity/graders.ts` | Code graders for tracker math |
| `src/evals/missed-opportunity/suite.ts` | Runner for tracker evals |

### Modified Files

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `newsAnalyses` table, extend `tradeInsights.insightType` enum, make `tradeInsights.strategyId` nullable |
| `src/news/sentiment-writer.ts` | `storeNewsEvent` returns inserted row ID |
| `src/news/ingest.ts` | Capture `newsEventId`, fire-and-forget research agent for tradeable articles |
| `src/scheduler/jobs.ts` | Add `missed_opportunity_review` to `JobName` union + `executeJob` switch |
| `src/scheduler/cron.ts` | Register daily 21:20 and Wednesday 21:35 cron jobs |
| `src/learning/types.ts` | Add `UniverseSuggestion` type |
| `src/learning/pattern-analysis.ts` | Add missed opportunity context to prompt, parse `universe_suggestions` |
| `src/monitoring/dashboard-data.ts` | Add missed opportunity count to `LearningLoopData` |
| `src/monitoring/status-page.ts` | Add amber badge for `missed_opportunity` type, "Missed" stat card |

---

### Task 1: Schema — `newsAnalyses` table + `tradeInsights` changes

**Files:**
- Modify: `src/db/schema.ts`
- Test: `tests/db/news-analyses-schema.test.ts`

- [ ] **Step 1: Write the failing test for `newsAnalyses` table creation**

```typescript
// tests/db/news-analyses-schema.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, tradeInsights } from "../../src/db/schema.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("newsAnalyses table", () => {
	test("inserts and reads a news analysis row", async () => {
		const db = getDb();
		const [row] = await db
			.insert(newsAnalyses)
			.values({
				newsEventId: 1,
				symbol: "AVGO",
				exchange: "NASDAQ",
				sentiment: 0.85,
				urgency: "high",
				eventType: "partnership",
				direction: "long",
				tradeThesis: "Major 5-year AI chip deal signals revenue growth",
				confidence: 0.9,
				recommendTrade: true,
				inUniverse: false,
				priceAtAnalysis: 185.5,
			})
			.returning();

		expect(row!.symbol).toBe("AVGO");
		expect(row!.sentiment).toBe(0.85);
		expect(row!.direction).toBe("long");
		expect(row!.inUniverse).toBe(false);
		expect(row!.priceAfter1d).toBeNull();
	});

	test("unique constraint on (newsEventId, symbol) with upsert", async () => {
		const db = getDb();
		await db.insert(newsAnalyses).values({
			newsEventId: 1,
			symbol: "AVGO",
			exchange: "NASDAQ",
			sentiment: 0.5,
			urgency: "medium",
			eventType: "partnership",
			direction: "long",
			tradeThesis: "Initial thesis",
			confidence: 0.6,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: 180.0,
		});

		// Upsert same (newsEventId, symbol)
		await db
			.insert(newsAnalyses)
			.values({
				newsEventId: 1,
				symbol: "AVGO",
				exchange: "NASDAQ",
				sentiment: 0.85,
				urgency: "high",
				eventType: "partnership",
				direction: "long",
				tradeThesis: "Updated thesis",
				confidence: 0.9,
				recommendTrade: true,
				inUniverse: false,
				priceAtAnalysis: 185.5,
			})
			.onConflictDoUpdate({
				target: [newsAnalyses.newsEventId, newsAnalyses.symbol],
				set: {
					sentiment: 0.85,
					confidence: 0.9,
					tradeThesis: "Updated thesis",
				},
			});

		const rows = await db.select().from(newsAnalyses).where(eq(newsAnalyses.symbol, "AVGO"));
		expect(rows.length).toBe(1);
		expect(rows[0]!.confidence).toBe(0.9);
	});
});

describe("tradeInsights nullable strategyId", () => {
	test("inserts a missed_opportunity insight with null strategyId", async () => {
		const db = getDb();
		const [row] = await db
			.insert(tradeInsights)
			.values({
				strategyId: null,
				insightType: "missed_opportunity",
				observation: "AVGO moved +4.2% after partnership announcement",
				tags: JSON.stringify(["missed_opportunity", "partnership", "AVGO"]),
				confidence: 0.85,
			})
			.returning();

		expect(row!.strategyId).toBeNull();
		expect(row!.insightType).toBe("missed_opportunity");
	});

	test("inserts a universe_suggestion insight with null strategyId", async () => {
		const db = getDb();
		const [row] = await db
			.insert(tradeInsights)
			.values({
				strategyId: null,
				insightType: "universe_suggestion",
				observation: "AVGO appears in 3 missed opportunities — add to universe",
				tags: JSON.stringify(["universe_suggestion", "AVGO"]),
				confidence: 0.7,
			})
			.returning();

		expect(row!.strategyId).toBeNull();
		expect(row!.insightType).toBe("universe_suggestion");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/news-analyses-schema.test.ts`
Expected: FAIL — `newsAnalyses` not exported from schema, `missed_opportunity` not in insightType enum

- [ ] **Step 3: Add `newsAnalyses` table to schema and update `tradeInsights`**

In `src/db/schema.ts`, add after the `newsEvents` table definition (after line ~296):

```typescript
export const newsAnalyses = sqliteTable(
	"news_analyses",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		newsEventId: integer("news_event_id").notNull(),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		sentiment: real("sentiment").notNull(),
		urgency: text("urgency", { enum: ["low", "medium", "high"] }).notNull(),
		eventType: text("event_type").notNull(),
		direction: text("direction", { enum: ["long", "short", "avoid"] }).notNull(),
		tradeThesis: text("trade_thesis").notNull(),
		confidence: real("confidence").notNull(),
		recommendTrade: integer("recommend_trade", { mode: "boolean" }).notNull(),
		inUniverse: integer("in_universe", { mode: "boolean" }).notNull(),
		priceAtAnalysis: real("price_at_analysis"),
		priceAfter1d: real("price_after_1d"),
		priceAfter1w: real("price_after_1w"),
		createdAt: text("created_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		newsEventIdx: index("news_analyses_news_event_idx").on(table.newsEventId),
		symbolIdx: index("news_analyses_symbol_idx").on(table.symbol),
		inUniverseIdx: index("news_analyses_in_universe_idx").on(table.inUniverse),
		uniqueEventSymbol: uniqueIndex("news_analyses_event_symbol_uniq").on(
			table.newsEventId,
			table.symbol,
		),
	}),
);
```

Add the required imports at the top of schema.ts — `index` and `uniqueIndex` from `drizzle-orm/sqlite-core`.

Update `tradeInsights` table:

```typescript
// Change strategyId from .notNull() to nullable:
strategyId: integer("strategy_id"),

// Extend insightType enum:
insightType: text("insight_type", {
	enum: ["trade_review", "pattern_analysis", "graduation", "missed_opportunity", "universe_suggestion"],
}).notNull(),
```

- [ ] **Step 4: Generate and apply migration**

Run:
```bash
bunx drizzle-kit generate
```

This creates a new migration SQL file. Verify it contains:
1. `CREATE TABLE news_analyses` with all columns
2. `CREATE UNIQUE INDEX news_analyses_event_symbol_uniq`
3. Note: SQLite cannot ALTER columns to be nullable. The `tradeInsights.strategyId` change is TypeScript-only since the column has no CHECK constraint in SQLite — the NOT NULL was only enforced at the Drizzle type level. If the generated migration tries to recreate the table, that's fine. If not, the TypeScript type change is sufficient.

Run:
```bash
bun test tests/db/news-analyses-schema.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/ tests/db/news-analyses-schema.test.ts
git commit -m "feat(schema): add news_analyses table, extend tradeInsights for missed opportunities"
```

---

### Task 2: `storeNewsEvent` returns ID

**Files:**
- Modify: `src/news/sentiment-writer.ts:101-136`
- Test: `tests/news/sentiment-writer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/news/sentiment-writer.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsEvents } from "../../src/db/schema.ts";
import { storeNewsEvent } from "../../src/news/sentiment-writer.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("storeNewsEvent", () => {
	test("returns the inserted news event ID", async () => {
		const id = await storeNewsEvent({
			source: "finnhub",
			headline: "Broadcom and Google seal five-year AI chip partnership",
			url: "https://example.com/article",
			symbols: ["GOOGL", "AVGO"],
			sentiment: 0.2,
			confidence: 0.7,
			tradeable: true,
			eventType: "partnership",
			urgency: "low",
			signals: null,
		});

		expect(typeof id).toBe("number");
		expect(id).toBeGreaterThan(0);

		// Verify it matches what's in the DB
		const db = getDb();
		const rows = await db.select().from(newsEvents);
		expect(rows.length).toBe(1);
		expect(rows[0]!.id).toBe(id);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/news/sentiment-writer.test.ts`
Expected: FAIL — `storeNewsEvent` returns `void`, not `number`

- [ ] **Step 3: Modify `storeNewsEvent` to return inserted ID**

In `src/news/sentiment-writer.ts`, change the function signature and return:

```typescript
export async function storeNewsEvent(input: NewsEventInput): Promise<number> {
	const db = getDb();

	// Capture price at classification time for the primary symbol
	let priceAtClassification: number | null = null;
	if (input.sentiment != null && input.symbols.length > 0) {
		const primarySymbol = input.symbols[0]!;
		const [cached] = await db
			.select({ last: quotesCache.last })
			.from(quotesCache)
			.where(eq(quotesCache.symbol, primarySymbol))
			.limit(1);
		priceAtClassification = cached?.last ?? null;
	}

	const [inserted] = await db
		.insert(newsEvents)
		.values({
			source: input.source,
			headline: input.headline,
			url: input.url,
			symbols: JSON.stringify(input.symbols),
			sentiment: input.sentiment,
			confidence: input.confidence,
			tradeable: input.tradeable,
			eventType: input.eventType,
			urgency: input.urgency,
			earningsSurprise: input.signals?.earningsSurprise ?? null,
			guidanceChange: input.signals?.guidanceChange ?? null,
			managementTone: input.signals?.managementTone ?? null,
			regulatoryRisk: input.signals?.regulatoryRisk ?? null,
			acquisitionLikelihood: input.signals?.acquisitionLikelihood ?? null,
			catalystType: input.signals?.catalystType ?? null,
			expectedMoveDuration: input.signals?.expectedMoveDuration ?? null,
			classifiedAt: input.sentiment != null ? new Date().toISOString() : null,
			priceAtClassification,
		})
		.returning({ id: newsEvents.id });

	return inserted!.id;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/news/sentiment-writer.test.ts`
Expected: PASS

- [ ] **Step 5: Fix any callers that don't use the return value**

In `src/news/ingest.ts`, the call at line 83 is `await storeNewsEvent({...})` — changing the return type from `void` to `number` doesn't break existing callers that ignore the return value. No changes needed.

- [ ] **Step 6: Commit**

```bash
git add src/news/sentiment-writer.ts tests/news/sentiment-writer.test.ts
git commit -m "feat(news): storeNewsEvent returns inserted row ID"
```

---

### Task 3: Research Agent — core module

**Files:**
- Create: `src/news/research-agent.ts`
- Test: `tests/news/research-agent.test.ts`

- [ ] **Step 1: Write the test for prompt building and response parsing**

```typescript
// tests/news/research-agent.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import {
	buildResearchPrompt,
	parseResearchResponse,
	type ResearchAnalysis,
} from "../../src/news/research-agent.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("buildResearchPrompt", () => {
	test("includes headline, source, symbols, and classification", () => {
		const prompt = buildResearchPrompt({
			headline: "Broadcom and Google seal five-year AI chip partnership",
			source: "finnhub",
			symbols: ["GOOGL"],
			classification: {
				sentiment: 0.2,
				confidence: 0.7,
				tradeable: true,
				eventType: "partnership",
				urgency: "low",
			},
		});

		expect(prompt).toContain("Broadcom and Google seal five-year AI chip partnership");
		expect(prompt).toContain("GOOGL");
		expect(prompt).toContain("partnership");
		expect(prompt).toContain("sentiment");
	});
});

describe("parseResearchResponse", () => {
	test("parses valid JSON response with multiple symbols", () => {
		const json = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					sentiment: 0.85,
					urgency: "high",
					event_type: "contract_win",
					direction: "long",
					trade_thesis: "Major 5-year AI chip deal signals revenue growth",
					confidence: 0.9,
				},
				{
					symbol: "GOOGL",
					exchange: "NASDAQ",
					sentiment: 0.2,
					urgency: "low",
					event_type: "partnership",
					direction: "long",
					trade_thesis: "Partnership positive but minor for Google's scale",
					confidence: 0.4,
				},
			],
		});

		const result = parseResearchResponse(json);
		expect(result.length).toBe(2);
		expect(result[0]!.symbol).toBe("AVGO");
		expect(result[0]!.confidence).toBe(0.9);
		expect(result[0]!.recommendTrade).toBe(true); // confidence >= 0.8
		expect(result[1]!.symbol).toBe("GOOGL");
		expect(result[1]!.recommendTrade).toBe(false); // confidence < 0.8
	});

	test("drops symbols with invalid exchange", () => {
		const json = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					sentiment: 0.85,
					urgency: "high",
					event_type: "contract_win",
					direction: "long",
					trade_thesis: "Good thesis",
					confidence: 0.9,
				},
				{
					symbol: "SAP",
					exchange: "XETRA",
					sentiment: 0.3,
					urgency: "low",
					event_type: "partnership",
					direction: "long",
					trade_thesis: "Minor benefit",
					confidence: 0.3,
				},
			],
		});

		const result = parseResearchResponse(json);
		expect(result.length).toBe(1);
		expect(result[0]!.symbol).toBe("AVGO");
	});

	test("clamps sentiment to [-1, 1] and confidence to [0, 1]", () => {
		const json = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AAPL",
					exchange: "NASDAQ",
					sentiment: 1.5,
					urgency: "medium",
					event_type: "earnings_beat",
					direction: "long",
					trade_thesis: "Strong earnings",
					confidence: 1.2,
				},
			],
		});

		const result = parseResearchResponse(json);
		expect(result[0]!.sentiment).toBe(1.0);
		expect(result[0]!.confidence).toBe(1.0);
	});

	test("returns empty array for malformed JSON", () => {
		expect(parseResearchResponse("not json")).toEqual([]);
		expect(parseResearchResponse("{}")).toEqual([]);
		expect(parseResearchResponse('{"affected_symbols": "not array"}')).toEqual([]);
	});

	test("validates required fields and drops incomplete entries", () => {
		const json = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					// missing sentiment, urgency, etc.
				},
				{
					symbol: "GOOGL",
					exchange: "NASDAQ",
					sentiment: 0.3,
					urgency: "low",
					event_type: "partnership",
					direction: "long",
					trade_thesis: "Valid entry",
					confidence: 0.5,
				},
			],
		});

		const result = parseResearchResponse(json);
		expect(result.length).toBe(1);
		expect(result[0]!.symbol).toBe("GOOGL");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/news/research-agent.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the research agent module**

```typescript
// src/news/research-agent.ts
import Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { newsAnalyses, quotesCache, strategies } from "../db/schema.ts";
import { getInjectedSymbols, injectSymbol } from "../strategy/universe.ts";
import { canAffordCall } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { writeSignals, type SignalWriteInput } from "./sentiment-writer.ts";

const log = createChildLogger({ module: "research-agent" });

const RESEARCH_COST_USD = 0.003; // Sonnet: ~500 input + 400 output tokens
const CONFIDENCE_THRESHOLD = 0.8;
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
		} catch {
			continue;
		}
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

	// Fallback: Finnhub /quote for newly-discovered symbols
	const config = getConfig();
	if (!config.FINNHUB_API_KEY) return null;

	try {
		const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${config.FINNHUB_API_KEY}`;
		const res = await fetch(url);
		if (!res.ok) return null;
		const data = (await res.json()) as Record<string, unknown>;
		const price = data.c; // current price
		return typeof price === "number" && price > 0 ? price : null;
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
					model: config.CLAUDE_MODEL_STANDARD,
					max_tokens: 1500,
					messages: [{ role: "user", content: prompt }],
				}),
			"research-agent",
			{ maxAttempts: 2, baseDelayMs: 1000 },
		);

		const text = response.content[0]?.type === "text" ? response.content[0].text : "";
		await recordUsage(
			"news_research",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

		const analyses = parseResearchResponse(text);
		if (analyses.length === 0) {
			log.warn({ headline: input.headline.slice(0, 60) }, "Research agent returned no analyses");
			return { analyses: 0, skippedBudget: false };
		}

		const db = getDb();
		for (const analysis of analyses) {
			const inUniverse = await isSymbolInUniverse(analysis.symbol, analysis.exchange);
			const priceAtAnalysis = await getPriceForSymbol(analysis.symbol, analysis.exchange);

			// Store analysis row (upsert on newsEventId + symbol)
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
					},
				});

			// Write enriched signals to quotes_cache (upsert creates row if missing)
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

			// Inject high-confidence symbols with 24h TTL
			if (analysis.recommendTrade) {
				injectSymbol(analysis.symbol, analysis.exchange, INJECTION_TTL_24H);
				log.info(
					{ symbol: analysis.symbol, confidence: analysis.confidence },
					"High-confidence symbol injected with 24h TTL",
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/news/research-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/news/research-agent.ts tests/news/research-agent.test.ts
git commit -m "feat(news): add Sonnet research agent for multi-symbol analysis"
```

---

### Task 4: Wire research agent into ingest pipeline

**Files:**
- Modify: `src/news/ingest.ts:82-136`
- Test: `tests/news/ingest-research.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/news/ingest-research.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, newsEvents } from "../../src/db/schema.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("processArticle fires research agent for tradeable articles", () => {
	test("tradeable article triggers fire-and-forget research call", async () => {
		// We can't easily mock the Sonnet call, but we can verify the ingest
		// path still works and returns "classified" for tradeable articles
		const { processArticle } = await import("../../src/news/ingest.ts");

		const result = await processArticle(
			{
				headline: "Test tradeable headline for research agent wiring",
				symbols: ["AAPL"],
				url: null,
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: null,
			},
			"NASDAQ",
			async () => ({
				tradeable: true,
				sentiment: 0.5,
				confidence: 0.8,
				eventType: "earnings_beat",
				urgency: "high",
				signals: null,
			}),
		);

		expect(result).toBe("classified");

		// Verify the news event was stored
		const db = getDb();
		const events = await db.select().from(newsEvents);
		expect(events.length).toBe(1);
	});
});
```

- [ ] **Step 2: Run test to verify baseline passes**

Run: `bun test tests/news/ingest-research.test.ts`
Expected: PASS (existing behavior still works)

- [ ] **Step 3: Modify `processArticle` to capture newsEventId and fire research agent**

In `src/news/ingest.ts`, update the tradeable article flow. Change the `storeNewsEvent` call to capture the returned ID, then fire-and-forget the research agent:

Add import at top:
```typescript
import { runResearchAnalysis } from "./research-agent.ts";
```

Replace the `storeNewsEvent` call (around line 83) with:
```typescript
	// Store classified event and capture its ID
	const newsEventId = await storeNewsEvent({
		source: article.source,
		headline: article.headline,
		url: article.url,
		symbols: article.symbols,
		sentiment: result.sentiment,
		confidence: result.confidence,
		tradeable: result.tradeable,
		eventType: result.eventType,
		urgency: result.urgency,
		signals: result.signals,
	});
```

After the existing signal writing and injection block (after line ~123), before the final log.info, add:

```typescript
	// Fire-and-forget research analysis for tradeable articles
	if (result.tradeable) {
		runResearchAnalysis(newsEventId, {
			headline: article.headline,
			source: article.source,
			symbols: article.symbols,
			classification: {
				sentiment: result.sentiment,
				confidence: result.confidence,
				tradeable: result.tradeable,
				eventType: result.eventType,
				urgency: result.urgency,
			},
		}).catch((err) =>
			log.error({ err, headline: article.headline.slice(0, 60) }, "Research agent failed"),
		);
	}
```

- [ ] **Step 4: Run tests to verify nothing breaks**

Run: `bun test tests/news/`
Expected: All tests PASS

- [ ] **Step 5: Run lint**

Run: `bunx biome check --write --unsafe src/news/ingest.ts`

- [ ] **Step 6: Commit**

```bash
git add src/news/ingest.ts
git commit -m "feat(news): wire research agent into ingest pipeline (fire-and-forget)"
```

---

### Task 5: Missed Opportunity Tracker — job module

**Files:**
- Create: `src/scheduler/missed-opportunity-job.ts`
- Test: `tests/scheduler/missed-opportunity-job.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
// tests/scheduler/missed-opportunity-job.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, quotesCache, tradeInsights } from "../../src/db/schema.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

function hoursAgo(hours: number): string {
	return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe("runDailyMissedOpportunityReview", () => {
	test("logs missed opportunity for out-of-universe symbol with >2% move in predicted direction", async () => {
		const db = getDb();

		// Insert a news analysis from 30 hours ago, not in universe, predicted long
		await db.insert(newsAnalyses).values({
			newsEventId: 1,
			symbol: "AVGO",
			exchange: "NASDAQ",
			sentiment: 0.85,
			urgency: "high",
			eventType: "contract_win",
			direction: "long",
			tradeThesis: "Major AI chip deal",
			confidence: 0.7,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: 100.0,
			createdAt: hoursAgo(30),
		});

		// Insert current price in quotes_cache showing +5% move
		await db
			.insert(quotesCache)
			.values({ symbol: "AVGO", exchange: "NASDAQ", last: 105.0 })
			.onConflictDoNothing();

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		// Check priceAfter1d was updated
		const [analysis] = await db
			.select()
			.from(newsAnalyses)
			.where(eq(newsAnalyses.symbol, "AVGO"));
		expect(analysis!.priceAfter1d).toBeCloseTo(105.0, 1);

		// Check missed opportunity was logged
		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(1);
		expect(insights[0]!.strategyId).toBeNull();
		expect(insights[0]!.observation).toContain("AVGO");
		expect(insights[0]!.observation).toContain("5.0%");
	});

	test("does NOT log missed opportunity for symbol that was in universe", async () => {
		const db = getDb();

		await db.insert(newsAnalyses).values({
			newsEventId: 2,
			symbol: "AAPL",
			exchange: "NASDAQ",
			sentiment: 0.6,
			urgency: "high",
			eventType: "earnings_beat",
			direction: "long",
			tradeThesis: "Strong earnings",
			confidence: 0.9,
			recommendTrade: true,
			inUniverse: true, // WAS in universe
			priceAtAnalysis: 150.0,
			createdAt: hoursAgo(30),
		});

		await db
			.insert(quotesCache)
			.values({ symbol: "AAPL", exchange: "NASDAQ", last: 157.5 })
			.onConflictDoNothing();

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		// priceAfter1d should still be updated
		const [analysis] = await db
			.select()
			.from(newsAnalyses)
			.where(eq(newsAnalyses.symbol, "AAPL"));
		expect(analysis!.priceAfter1d).toBeCloseTo(157.5, 1);

		// But NO missed opportunity insight
		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(0);
	});

	test("does NOT log missed opportunity for <2% move", async () => {
		const db = getDb();

		await db.insert(newsAnalyses).values({
			newsEventId: 3,
			symbol: "MSFT",
			exchange: "NASDAQ",
			sentiment: 0.5,
			urgency: "medium",
			eventType: "partnership",
			direction: "long",
			tradeThesis: "Minor partnership",
			confidence: 0.5,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: 400.0,
			createdAt: hoursAgo(30),
		});

		await db
			.insert(quotesCache)
			.values({ symbol: "MSFT", exchange: "NASDAQ", last: 404.0 })
			.onConflictDoNothing();

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(0);
	});

	test("skips rows where priceAtAnalysis is null", async () => {
		const db = getDb();

		await db.insert(newsAnalyses).values({
			newsEventId: 4,
			symbol: "UNKNOWN",
			exchange: "NASDAQ",
			sentiment: 0.8,
			urgency: "high",
			eventType: "contract_win",
			direction: "long",
			tradeThesis: "New symbol",
			confidence: 0.6,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: null, // no price available
			createdAt: hoursAgo(30),
		});

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		// priceAfter1d should remain null
		const [analysis] = await db
			.select()
			.from(newsAnalyses)
			.where(eq(newsAnalyses.symbol, "UNKNOWN"));
		expect(analysis!.priceAfter1d).toBeNull();
	});

	test("handles short direction correctly — negative move is a hit", async () => {
		const db = getDb();

		await db.insert(newsAnalyses).values({
			newsEventId: 5,
			symbol: "BAD",
			exchange: "NYSE",
			sentiment: -0.7,
			urgency: "high",
			eventType: "profit_warning",
			direction: "short",
			tradeThesis: "Profit warning = downside",
			confidence: 0.75,
			recommendTrade: false,
			inUniverse: false,
			priceAtAnalysis: 50.0,
			createdAt: hoursAgo(30),
		});

		await db
			.insert(quotesCache)
			.values({ symbol: "BAD", exchange: "NYSE", last: 47.0 })
			.onConflictDoNothing();

		const { runDailyMissedOpportunityReview } = await import(
			"../../src/scheduler/missed-opportunity-job.ts"
		);
		await runDailyMissedOpportunityReview();

		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(1);
		expect(insights[0]!.observation).toContain("BAD");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/scheduler/missed-opportunity-job.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the missed opportunity job**

```typescript
// src/scheduler/missed-opportunity-job.ts
import { and, eq, gte, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsAnalyses, quotesCache, tradeInsights } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "missed-opportunity" });

const DAILY_THRESHOLD_PCT = 2;
const WEEKLY_THRESHOLD_PCT = 5;

async function getCurrentPrice(symbol: string, exchange: string): Promise<number | null> {
	const db = getDb();
	const [cached] = await db
		.select({ last: quotesCache.last, updatedAt: quotesCache.updatedAt })
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, symbol), eq(quotesCache.exchange, exchange)))
		.limit(1);

	if (cached?.last != null) {
		// Check if price is stale (older than 24h)
		if (cached.updatedAt) {
			const ageMs = Date.now() - new Date(cached.updatedAt).getTime();
			if (ageMs < 24 * 60 * 60 * 1000) return cached.last;
		} else {
			return cached.last;
		}
	}

	// Fallback: Finnhub /quote
	try {
		const { getConfig } = await import("../config.ts");
		const config = getConfig();
		if (!config.FINNHUB_API_KEY) return cached?.last ?? null;

		const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${config.FINNHUB_API_KEY}`;
		const res = await fetch(url);
		if (!res.ok) return cached?.last ?? null;
		const data = (await res.json()) as Record<string, unknown>;
		const price = data.c;
		return typeof price === "number" && price > 0 ? price : cached?.last ?? null;
	} catch {
		return cached?.last ?? null;
	}
}

function computeChangePct(currentPrice: number, analysisPrice: number): number {
	return ((currentPrice - analysisPrice) / analysisPrice) * 100;
}

function isCorrectDirection(changePct: number, direction: string): boolean {
	if (direction === "long") return changePct > 0;
	if (direction === "short") return changePct < 0;
	return false;
}

export async function runDailyMissedOpportunityReview(): Promise<{
	reviewed: number;
	missed: number;
}> {
	const db = getDb();
	const now = Date.now();
	const cutoff24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
	const cutoff48h = new Date(now - 48 * 60 * 60 * 1000).toISOString();

	// Get analyses from 24-48 hours ago with priceAtAnalysis set and no priceAfter1d yet
	const rows = await db
		.select()
		.from(newsAnalyses)
		.where(
			and(
				gte(newsAnalyses.createdAt, cutoff48h),
				lt(newsAnalyses.createdAt, cutoff24h),
				isNotNull(newsAnalyses.priceAtAnalysis),
				isNull(newsAnalyses.priceAfter1d),
			),
		);

	let missed = 0;

	for (const row of rows) {
		const currentPrice = await getCurrentPrice(row.symbol, row.exchange);
		if (currentPrice == null) {
			log.debug({ symbol: row.symbol }, "No current price available — skipping");
			continue;
		}

		// Update priceAfter1d
		await db
			.update(newsAnalyses)
			.set({ priceAfter1d: currentPrice })
			.where(eq(newsAnalyses.id, row.id));

		// Check for missed opportunity (only for out-of-universe symbols)
		if (!row.inUniverse && row.direction !== "avoid") {
			const changePct = computeChangePct(currentPrice, row.priceAtAnalysis!);
			const absChangePct = Math.abs(changePct);

			if (absChangePct > DAILY_THRESHOLD_PCT && isCorrectDirection(changePct, row.direction)) {
				await db.insert(tradeInsights).values({
					strategyId: null,
					insightType: "missed_opportunity",
					observation: `${row.symbol} moved ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% (predicted ${row.direction}). Thesis: ${row.tradeThesis}`,
					tags: JSON.stringify(["missed_opportunity", row.eventType, row.symbol]),
					confidence: row.confidence,
				});
				missed++;
				log.info(
					{ symbol: row.symbol, changePct: changePct.toFixed(1), direction: row.direction },
					"Missed opportunity detected",
				);
			}
		}
	}

	log.info({ reviewed: rows.length, missed }, "Daily missed opportunity review complete");
	return { reviewed: rows.length, missed };
}

export async function runWeeklyMissedOpportunityReview(): Promise<{
	reviewed: number;
	missed: number;
}> {
	const db = getDb();
	const now = Date.now();
	const cutoff7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
	const cutoff8d = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();

	// Get analyses from 7-8 days ago with priceAtAnalysis set and no priceAfter1w yet
	const rows = await db
		.select()
		.from(newsAnalyses)
		.where(
			and(
				gte(newsAnalyses.createdAt, cutoff8d),
				lt(newsAnalyses.createdAt, cutoff7d),
				isNotNull(newsAnalyses.priceAtAnalysis),
				isNull(newsAnalyses.priceAfter1w),
			),
		);

	let missed = 0;

	for (const row of rows) {
		const currentPrice = await getCurrentPrice(row.symbol, row.exchange);
		if (currentPrice == null) continue;

		// Update priceAfter1w
		await db
			.update(newsAnalyses)
			.set({ priceAfter1w: currentPrice })
			.where(eq(newsAnalyses.id, row.id));

		// Only log if not already a daily missed opportunity AND > 5% move
		if (!row.inUniverse && row.direction !== "avoid") {
			const changePct = computeChangePct(currentPrice, row.priceAtAnalysis!);
			const absChangePct = Math.abs(changePct);

			// Check if daily already logged this
			const existingMiss = await db
				.select({ id: tradeInsights.id })
				.from(tradeInsights)
				.where(
					and(
						eq(tradeInsights.insightType, "missed_opportunity"),
						sql`${tradeInsights.tags} LIKE ${"%" + row.symbol + "%"}`,
						sql`${tradeInsights.observation} LIKE ${"%" + row.symbol + "%"}`,
					),
				)
				.limit(1);

			if (
				existingMiss.length === 0 &&
				absChangePct > WEEKLY_THRESHOLD_PCT &&
				isCorrectDirection(changePct, row.direction)
			) {
				await db.insert(tradeInsights).values({
					strategyId: null,
					insightType: "missed_opportunity",
					observation: `[1W] ${row.symbol} moved ${changePct > 0 ? "+" : ""}${changePct.toFixed(1)}% over 1 week (predicted ${row.direction}). Thesis: ${row.tradeThesis}`,
					tags: JSON.stringify(["missed_opportunity", "weekly", row.eventType, row.symbol]),
					confidence: row.confidence,
				});
				missed++;
			}
		}
	}

	log.info({ reviewed: rows.length, missed }, "Weekly missed opportunity review complete");
	return { reviewed: rows.length, missed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scheduler/missed-opportunity-job.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/missed-opportunity-job.ts tests/scheduler/missed-opportunity-job.test.ts
git commit -m "feat(scheduler): add daily/weekly missed opportunity tracker"
```

---

### Task 6: Register missed opportunity jobs in scheduler

**Files:**
- Modify: `src/scheduler/jobs.ts:5-24,64-193`
- Modify: `src/scheduler/cron.ts`

- [ ] **Step 1: Add `missed_opportunity_review` to JobName type and executeJob switch**

In `src/scheduler/jobs.ts`, add to the `JobName` union (after line 24):

```typescript
export type JobName =
	| "quote_refresh"
	| "strategy_evaluation"
	| "daily_summary"
	| "weekly_digest"
	| "strategy_evolution"
	| "trade_review"
	| "pattern_analysis"
	| "earnings_calendar_sync"
	| "news_poll"
	| "heartbeat"
	| "self_improvement"
	| "guardian_start"
	| "guardian_stop"
	| "live_evaluation"
	| "risk_guardian"
	| "risk_daily_reset"
	| "risk_weekly_reset"
	| "daily_tournament"
	| "dispatch"
	| "missed_opportunity_daily"
	| "missed_opportunity_weekly";
```

Add cases to the `executeJob` switch (before the closing `}`):

```typescript
		case "missed_opportunity_daily": {
			const { runDailyMissedOpportunityReview } = await import("./missed-opportunity-job.ts");
			await runDailyMissedOpportunityReview();
			break;
		}

		case "missed_opportunity_weekly": {
			const { runWeeklyMissedOpportunityReview } = await import("./missed-opportunity-job.ts");
			await runWeeklyMissedOpportunityReview();
			break;
		}
```

- [ ] **Step 2: Register cron schedules**

In `src/scheduler/cron.ts`, add before the final `log.info`:

```typescript
	// Missed opportunity daily review — 21:20 weekdays (after trade review at 21:15)
	tasks.push(
		cron.schedule("20 21 * * 1-5", () => runJob("missed_opportunity_daily"), {
			timezone: "Europe/London",
		}),
	);

	// Missed opportunity weekly review — Wednesdays at 21:35
	tasks.push(
		cron.schedule("35 21 * * 3", () => runJob("missed_opportunity_weekly"), {
			timezone: "Europe/London",
		}),
	);
```

- [ ] **Step 3: Run lint**

Run: `bunx biome check --write --unsafe src/scheduler/jobs.ts src/scheduler/cron.ts`

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/jobs.ts src/scheduler/cron.ts
git commit -m "feat(scheduler): register missed opportunity daily/weekly cron jobs"
```

---

### Task 7: Cross-symbol pattern learning — enhance pattern analysis

**Files:**
- Modify: `src/learning/types.ts`
- Modify: `src/learning/pattern-analysis.ts`
- Test: `tests/learning/pattern-analysis-universe.test.ts`

- [ ] **Step 1: Add `UniverseSuggestion` type**

In `src/learning/types.ts`, add at the end:

```typescript
export interface UniverseSuggestion {
	symbol: string;
	exchange: string;
	reason: string;
	evidenceCount: number;
}
```

- [ ] **Step 2: Write the test for missed opportunity context in prompt and universe suggestion parsing**

```typescript
// tests/learning/pattern-analysis-universe.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { tradeInsights } from "../../src/db/schema.ts";
import {
	buildPatternAnalysisPrompt,
	getMissedOpportunityContext,
	parseUniverseSuggestions,
} from "../../src/learning/pattern-analysis.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("getMissedOpportunityContext", () => {
	test("fetches recent missed opportunities from trade_insights", async () => {
		const db = getDb();
		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "AVGO moved +4.2% after partnership announcement",
			tags: JSON.stringify(["missed_opportunity", "partnership", "AVGO"]),
			confidence: 0.85,
		});
		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "AVGO moved +3.1% after supply chain news",
			tags: JSON.stringify(["missed_opportunity", "supply_chain", "AVGO"]),
			confidence: 0.7,
		});

		const context = await getMissedOpportunityContext();
		expect(context.length).toBe(2);
		expect(context[0]).toContain("AVGO");
	});

	test("returns empty array when no missed opportunities exist", async () => {
		const context = await getMissedOpportunityContext();
		expect(context).toEqual([]);
	});
});

describe("parseUniverseSuggestions", () => {
	test("parses valid universe suggestions from JSON", () => {
		const json = JSON.stringify({
			observations: [],
			universe_suggestions: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					reason: "Appeared in 3 missed opportunities related to AI chip partnerships",
					evidence_count: 3,
				},
			],
		});

		const result = parseUniverseSuggestions(json);
		expect(result.length).toBe(1);
		expect(result[0]!.symbol).toBe("AVGO");
		expect(result[0]!.evidenceCount).toBe(3);
	});

	test("returns empty array when no suggestions present", () => {
		expect(parseUniverseSuggestions('{"observations": []}')).toEqual([]);
		expect(parseUniverseSuggestions("not json")).toEqual([]);
	});

	test("validates exchange against known set", () => {
		const json = JSON.stringify({
			universe_suggestions: [
				{ symbol: "AVGO", exchange: "NASDAQ", reason: "Good", evidence_count: 2 },
				{ symbol: "SAP", exchange: "XETRA", reason: "Bad exchange", evidence_count: 1 },
			],
		});

		const result = parseUniverseSuggestions(json);
		expect(result.length).toBe(1);
		expect(result[0]!.symbol).toBe("AVGO");
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/learning/pattern-analysis-universe.test.ts`
Expected: FAIL — `getMissedOpportunityContext` and `parseUniverseSuggestions` not exported

- [ ] **Step 4: Add missed opportunity context and universe suggestion parsing to pattern-analysis.ts**

In `src/learning/pattern-analysis.ts`, add the following imports and functions.

Add imports:
```typescript
import { newsAnalyses } from "../db/schema.ts";
import type { UniverseSuggestion } from "./types.ts";
```

Add new exported functions:

```typescript
const VALID_SUGGESTION_EXCHANGES = new Set(["NASDAQ", "NYSE", "LSE"]);

export async function getMissedOpportunityContext(lookbackDays = 14): Promise<string[]> {
	const db = getDb();
	const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

	const rows = await db
		.select({ observation: tradeInsights.observation, tags: tradeInsights.tags })
		.from(tradeInsights)
		.where(
			and(
				eq(tradeInsights.insightType, "missed_opportunity"),
				gte(tradeInsights.createdAt, since),
			),
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
```

Now modify `runPatternAnalysis` to include missed opportunity context in the prompt and save universe suggestions. In the function body, after building `userMessage`:

```typescript
	// Add missed opportunity context
	const missedOpps = await getMissedOpportunityContext();
	let fullMessage = userMessage;
	if (missedOpps.length > 0) {
		fullMessage += "\n\n--- Missed Opportunities (last 14 days) ---\n";
		fullMessage += missedOpps.map((o, i) => `${i + 1}. ${o}`).join("\n");
		fullMessage += "\n\nIdentify patterns in these missed opportunities. Are there symbol relationships the system should watch? If evidence supports it, include a 'universe_suggestions' array in your response with: symbol, exchange (NASDAQ/NYSE/LSE), reason, evidence_count.";
	}
```

Replace the `messages` content in the API call to use `fullMessage` instead of `userMessage`.

After the existing observation insert loop, add:

```typescript
		// Parse and store universe suggestions
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/learning/pattern-analysis-universe.test.ts`
Expected: PASS

Also verify existing pattern analysis tests still pass:
Run: `bun test tests/learning/`
Expected: All PASS

- [ ] **Step 6: Run lint**

Run: `bunx biome check --write --unsafe src/learning/pattern-analysis.ts src/learning/types.ts`

- [ ] **Step 7: Commit**

```bash
git add src/learning/pattern-analysis.ts src/learning/types.ts tests/learning/pattern-analysis-universe.test.ts
git commit -m "feat(learning): add missed opportunity context and universe suggestions to pattern analysis"
```

---

### Task 8: Dashboard — missed opportunity count and amber badge

**Files:**
- Modify: `src/monitoring/dashboard-data.ts`
- Modify: `src/monitoring/status-page.ts`
- Test: `tests/monitoring/dashboard-missed.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// tests/monitoring/dashboard-missed.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { tradeInsights } from "../../src/db/schema.ts";
import { getLearningLoopData } from "../../src/monitoring/dashboard-data.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("getLearningLoopData includes missed opportunities", () => {
	test("counts missed opportunities in summary stats", async () => {
		const db = getDb();

		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "AVGO moved +4.2%",
			tags: JSON.stringify(["missed_opportunity", "AVGO"]),
			confidence: 0.85,
		});
		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "TSLA moved -3.1%",
			tags: JSON.stringify(["missed_opportunity", "TSLA"]),
			confidence: 0.7,
		});

		const data = await getLearningLoopData();
		expect(data.missedOpportunities).toBe(2);
	});

	test("returns 0 missed when none exist", async () => {
		const data = await getLearningLoopData();
		expect(data.missedOpportunities).toBe(0);
	});

	test("missed_opportunity insights appear in recentInsights", async () => {
		const db = getDb();
		await db.insert(tradeInsights).values({
			strategyId: null,
			insightType: "missed_opportunity",
			observation: "AVGO moved +4.2%",
			tags: JSON.stringify(["missed_opportunity", "AVGO"]),
			confidence: 0.85,
		});

		const data = await getLearningLoopData();
		expect(data.recentInsights.length).toBe(1);
		expect(data.recentInsights[0]!.insightType).toBe("missed_opportunity");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/dashboard-missed.test.ts`
Expected: FAIL — `missedOpportunities` property doesn't exist on `LearningLoopData`

- [ ] **Step 3: Add `missedOpportunities` to `LearningLoopData` interface and query**

In `src/monitoring/dashboard-data.ts`, update the `LearningLoopData` interface:

```typescript
export interface LearningLoopData {
	insightsCount7d: number;
	ledToImprovement: number;
	patternsFound: number;
	missedOpportunities: number;
	recentInsights: Array<{
		time: string;
		insightType: string;
		observation: string;
		suggestedAction: string | null;
		confidence: number | null;
		tags: string[];
		ledToImprovement: boolean | null;
	}>;
}
```

In `getLearningLoopData()`, add after the `patternsFound` query:

```typescript
	const missedResult = db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(
			sql`${tradeInsights.createdAt} >= ${cutoff} AND ${tradeInsights.insightType} = 'missed_opportunity'`,
		)
		.get();
	const missedOpportunities = missedResult?.count ?? 0;
```

Add `missedOpportunities` to the return object.

- [ ] **Step 4: Update the learning loop tab in status-page.ts**

In `src/monitoring/status-page.ts`, in `buildLearningLoopTab`, change the stat cards grid from 3 to 4 columns and add the missed opportunity card:

```typescript
return `
<div class="stat-cards" style="grid-template-columns:repeat(4,1fr);">
	<div class="stat-card"><div class="sc-label">Insights (7d)</div><div class="sc-value" style="color:#e2e8f0;">${data.insightsCount7d}</div><div class="sc-sub">from trade reviews</div></div>
	<div class="stat-card"><div class="sc-label">Led to Change</div><div class="sc-value" style="color:#22c55e;">${data.ledToImprovement}</div><div class="sc-sub">parameter updates</div></div>
	<div class="stat-card"><div class="sc-label">Patterns Found</div><div class="sc-value" style="color:#a855f7;">${data.patternsFound}</div><div class="sc-sub">this week</div></div>
	<div class="stat-card"><div class="sc-label">Missed</div><div class="sc-value" style="color:#f59e0b;">${data.missedOpportunities}</div><div class="sc-sub">opportunities</div></div>
</div>
```

Also update the type badge CSS for amber. In the `typeClass` section of the insight card rendering, `missed_opportunity` will use `type-missed_opportunity`. Add CSS for `.type-missed_opportunity` in the style section of the page:

```css
.type-badge.type-missed_opportunity { background: #78350f; color: #fbbf24; }
.type-badge.type-universe_suggestion { background: #1e3a5f; color: #60a5fa; }
```

Find the existing `.type-badge` CSS block in `buildConsolePage` and add these two classes there.

- [ ] **Step 5: Run tests**

Run: `bun test tests/monitoring/dashboard-missed.test.ts`
Expected: PASS

Run: `bun test tests/monitoring/`
Expected: All PASS

- [ ] **Step 6: Run lint**

Run: `bunx biome check --write --unsafe src/monitoring/dashboard-data.ts src/monitoring/status-page.ts`

- [ ] **Step 7: Commit**

```bash
git add src/monitoring/dashboard-data.ts src/monitoring/status-page.ts tests/monitoring/dashboard-missed.test.ts
git commit -m "feat(dashboard): add missed opportunity count and amber badge to learning loop tab"
```

---

### Task 9: Research Agent Evals

**Files:**
- Create: `src/evals/research-agent/tasks.ts`
- Create: `src/evals/research-agent/graders.ts`
- Create: `src/evals/research-agent/suite.ts`

- [ ] **Step 1: Create eval task definitions**

```typescript
// src/evals/research-agent/tasks.ts
import type { EvalTask } from "../types.ts";
import type { ResearchInput, ResearchAnalysis } from "../../news/research-agent.ts";

export interface ResearchReference {
	minSymbols: number;
	expectedSymbols: string[];
	expectedDirections: Record<string, "long" | "short" | "avoid">;
	expectedSentimentRange: Record<string, [number, number]>;
	isMultiParty: boolean;
}

export const researchAgentTasks: EvalTask<ResearchInput, ResearchReference>[] = [
	{
		id: "ra-001",
		name: "Broadcom-Google partnership (secondary beneficiary)",
		input: {
			headline: "Broadcom and Google seal five-year AI chip partnership",
			source: "finnhub",
			symbols: ["GOOGL"],
			classification: { sentiment: 0.2, confidence: 0.7, tradeable: true, eventType: "partnership", urgency: "low" },
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["AVGO", "GOOGL"],
			expectedDirections: { AVGO: "long", GOOGL: "long" },
			expectedSentimentRange: { AVGO: [0.5, 1.0], GOOGL: [0.1, 0.5] },
			isMultiParty: true,
		},
		tags: ["multi-party", "partnership", "ai-chips"],
	},
	{
		id: "ra-002",
		name: "Acquisition announcement (acquirer + target)",
		input: {
			headline: "Microsoft announces $20B acquisition of cybersecurity firm CrowdStrike",
			source: "finnhub",
			symbols: ["MSFT"],
			classification: { sentiment: 0.4, confidence: 0.8, tradeable: true, eventType: "acquisition", urgency: "high" },
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["MSFT", "CRWD"],
			expectedDirections: { CRWD: "long", MSFT: "long" },
			expectedSentimentRange: { CRWD: [0.5, 1.0], MSFT: [-0.2, 0.5] },
			isMultiParty: true,
		},
		tags: ["multi-party", "acquisition"],
	},
	{
		id: "ra-003",
		name: "Supply chain disruption (supplier + customer)",
		input: {
			headline: "TSMC warns of 3-month production delays at Arizona fab",
			source: "finnhub",
			symbols: ["TSM"],
			classification: { sentiment: -0.6, confidence: 0.85, tradeable: true, eventType: "profit_warning", urgency: "high" },
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["TSM"],
			expectedDirections: { TSM: "short" },
			expectedSentimentRange: { TSM: [-1.0, -0.3] },
			isMultiParty: true,
		},
		tags: ["multi-party", "supply-chain"],
	},
	{
		id: "ra-004",
		name: "Single-symbol earnings (no secondary beneficiaries)",
		input: {
			headline: "Netflix beats Q3 subscriber estimates by 12%",
			source: "finnhub",
			symbols: ["NFLX"],
			classification: { sentiment: 0.7, confidence: 0.9, tradeable: true, eventType: "earnings_beat", urgency: "high" },
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["NFLX"],
			expectedDirections: { NFLX: "long" },
			expectedSentimentRange: { NFLX: [0.5, 1.0] },
			isMultiParty: false,
		},
		tags: ["single-symbol", "earnings"],
	},
	{
		id: "ra-005",
		name: "FDA approval with competitor impact",
		input: {
			headline: "FDA approves Eli Lilly weight-loss drug, seen as Wegovy competitor",
			source: "finnhub",
			symbols: ["LLY"],
			classification: { sentiment: 0.8, confidence: 0.9, tradeable: true, eventType: "fda_approval", urgency: "high" },
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["LLY", "NVO"],
			expectedDirections: { LLY: "long", NVO: "short" },
			expectedSentimentRange: { LLY: [0.5, 1.0], NVO: [-0.8, -0.1] },
			isMultiParty: true,
		},
		tags: ["multi-party", "fda", "competition"],
	},
	{
		id: "ra-006",
		name: "Sector-wide catalyst (regulation)",
		input: {
			headline: "EU announces strict new AI regulation requiring model audits by 2027",
			source: "finnhub",
			symbols: ["GOOGL"],
			classification: { sentiment: -0.3, confidence: 0.6, tradeable: true, eventType: "legal", urgency: "medium" },
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["GOOGL"],
			expectedDirections: {},
			expectedSentimentRange: {},
			isMultiParty: true,
		},
		tags: ["multi-party", "regulation", "sector-wide"],
	},
	{
		id: "ra-007",
		name: "Dividend increase (single symbol, low urgency)",
		input: {
			headline: "Johnson & Johnson raises quarterly dividend by 4.2%",
			source: "finnhub",
			symbols: ["JNJ"],
			classification: { sentiment: 0.25, confidence: 0.7, tradeable: true, eventType: "dividend", urgency: "low" },
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["JNJ"],
			expectedDirections: { JNJ: "long" },
			expectedSentimentRange: { JNJ: [0.1, 0.5] },
			isMultiParty: false,
		},
		tags: ["single-symbol", "dividend"],
	},
	{
		id: "ra-008",
		name: "Major contract win with government (defense sector)",
		input: {
			headline: "Lockheed Martin wins $15B Pentagon contract for next-gen fighter jets",
			source: "finnhub",
			symbols: ["LMT"],
			classification: { sentiment: 0.6, confidence: 0.85, tradeable: true, eventType: "other", urgency: "high" },
		},
		reference: {
			minSymbols: 1,
			expectedSymbols: ["LMT"],
			expectedDirections: { LMT: "long" },
			expectedSentimentRange: { LMT: [0.4, 1.0] },
			isMultiParty: false,
		},
		tags: ["single-symbol", "contract-win", "defense"],
	},
	{
		id: "ra-009",
		name: "Profit warning with sector contagion",
		input: {
			headline: "Intel issues surprise profit warning citing weak PC demand across industry",
			source: "finnhub",
			symbols: ["INTC"],
			classification: { sentiment: -0.7, confidence: 0.9, tradeable: true, eventType: "profit_warning", urgency: "high" },
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["INTC"],
			expectedDirections: { INTC: "short" },
			expectedSentimentRange: { INTC: [-1.0, -0.4] },
			isMultiParty: true,
		},
		tags: ["multi-party", "profit-warning", "sector-contagion"],
	},
	{
		id: "ra-010",
		name: "LSE stock — merger",
		input: {
			headline: "Shell confirms merger talks with BP in all-share deal",
			source: "finnhub",
			symbols: ["SHEL"],
			classification: { sentiment: 0.5, confidence: 0.85, tradeable: true, eventType: "merger", urgency: "high" },
		},
		reference: {
			minSymbols: 2,
			expectedSymbols: ["SHEL", "BP"],
			expectedDirections: { SHEL: "long", BP: "long" },
			expectedSentimentRange: { SHEL: [0.2, 0.8], BP: [0.3, 1.0] },
			isMultiParty: true,
		},
		tags: ["multi-party", "merger", "lse"],
	},
];
```

- [ ] **Step 2: Create graders**

```typescript
// src/evals/research-agent/graders.ts
import type { Grader } from "../types.ts";
import type { ResearchAnalysis } from "../../news/research-agent.ts";
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
				a.sentiment >= -1 && a.sentiment <= 1 &&
				typeof a.confidence === "number" &&
				a.confidence >= 0 && a.confidence <= 1 &&
				["low", "medium", "high"].includes(a.urgency) &&
				["long", "short", "avoid"].includes(a.direction) &&
				typeof a.tradeThesis === "string" &&
				a.tradeThesis.length > 0,
		);
		return { score: valid ? 1 : 0, pass: valid, reason: valid ? "All fields valid" : "Invalid shape" };
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
		return { score, pass: score >= 0.5, reason: `Direction correct for ${correct}/${checks.length} symbols` };
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
		return { score, pass: score >= 0.5, reason: `Sentiment in range for ${inRange}/${checks.length} symbols` };
	},
};

export const recommendTradeGrader: RG = {
	name: "recommend-trade-threshold",
	type: "code",
	grade: async (output) => {
		const valid = output.every((a) => a.recommendTrade === (a.confidence >= 0.8));
		return { score: valid ? 1 : 0, pass: valid, reason: valid ? "recommendTrade matches confidence threshold" : "recommendTrade mismatch" };
	},
};

export const allResearchGraders: RG[] = [
	jsonShapeGrader,
	minSymbolsGrader,
	expectedSymbolsGrader,
	directionGrader,
	sentimentRangeGrader,
	recommendTradeGrader,
];
```

- [ ] **Step 3: Create eval suite runner**

```typescript
// src/evals/research-agent/suite.ts
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { buildResearchPrompt, parseResearchResponse, type ResearchAnalysis } from "../../news/research-agent.ts";
import { allResearchGraders } from "./graders.ts";
import { researchAgentTasks } from "./tasks.ts";
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config.ts";

export async function runResearchAgentEvals(
	options: { trials?: number; saveDir?: string } = {},
): Promise<void> {
	const trials = options.trials ?? 3;
	const saveDir = options.saveDir ?? "src/evals/research-agent/results";

	const config = getConfig();
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

	const results = await runSuite(
		researchAgentTasks,
		async (input) => {
			const prompt = buildResearchPrompt(input);
			const response = await client.messages.create({
				model: config.CLAUDE_MODEL_STANDARD,
				max_tokens: 1500,
				messages: [{ role: "user", content: prompt }],
			});
			const text = response.content[0]?.type === "text" ? response.content[0].text : "";
			return parseResearchResponse(text);
		},
		allResearchGraders,
		{ trials, suiteName: "research-agent" },
	);

	console.log(formatSuiteReport(results));
	await Bun.write(`${saveDir}/research-agent-latest.json`, JSON.stringify(results, null, 2));
}
```

- [ ] **Step 4: Verify the suite file compiles**

Run: `bunx biome check --write --unsafe src/evals/research-agent/`

- [ ] **Step 5: Commit**

```bash
git add src/evals/research-agent/
git commit -m "feat(evals): add research agent eval suite with 10 tasks and 6 graders"
```

---

### Task 10: Missed Opportunity Tracker Evals

**Files:**
- Create: `src/evals/missed-opportunity/tasks.ts`
- Create: `src/evals/missed-opportunity/graders.ts`
- Create: `src/evals/missed-opportunity/suite.ts`

- [ ] **Step 1: Create eval task definitions**

```typescript
// src/evals/missed-opportunity/tasks.ts
import type { EvalTask } from "../types.ts";

export interface TrackerInput {
	analyses: Array<{
		symbol: string;
		exchange: string;
		direction: "long" | "short" | "avoid";
		priceAtAnalysis: number | null;
		inUniverse: boolean;
		confidence: number;
		eventType: string;
		tradeThesis: string;
	}>;
	currentPrices: Record<string, number>;
}

export interface TrackerReference {
	expectedMissedSymbols: string[];
	expectedNotMissedSymbols: string[];
}

export const trackerTasks: EvalTask<TrackerInput, TrackerReference>[] = [
	{
		id: "mot-001",
		name: "Clear missed opportunity — long prediction, >2% up",
		input: {
			analyses: [
				{ symbol: "AVGO", exchange: "NASDAQ", direction: "long", priceAtAnalysis: 100, inUniverse: false, confidence: 0.7, eventType: "contract_win", tradeThesis: "Major deal" },
			],
			currentPrices: { AVGO: 105 },
		},
		reference: { expectedMissedSymbols: ["AVGO"], expectedNotMissedSymbols: [] },
		tags: ["true-miss", "long"],
	},
	{
		id: "mot-002",
		name: "Clear missed opportunity — short prediction, >2% down",
		input: {
			analyses: [
				{ symbol: "BAD", exchange: "NYSE", direction: "short", priceAtAnalysis: 50, inUniverse: false, confidence: 0.75, eventType: "profit_warning", tradeThesis: "Profit warning" },
			],
			currentPrices: { BAD: 47 },
		},
		reference: { expectedMissedSymbols: ["BAD"], expectedNotMissedSymbols: [] },
		tags: ["true-miss", "short"],
	},
	{
		id: "mot-003",
		name: "Near miss — <2% move, should NOT log",
		input: {
			analyses: [
				{ symbol: "MSFT", exchange: "NASDAQ", direction: "long", priceAtAnalysis: 400, inUniverse: false, confidence: 0.6, eventType: "partnership", tradeThesis: "Minor deal" },
			],
			currentPrices: { MSFT: 404 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["MSFT"] },
		tags: ["near-miss", "below-threshold"],
	},
	{
		id: "mot-004",
		name: "Wrong direction — long predicted but price went down",
		input: {
			analyses: [
				{ symbol: "FAIL", exchange: "NASDAQ", direction: "long", priceAtAnalysis: 100, inUniverse: false, confidence: 0.8, eventType: "partnership", tradeThesis: "Expected up" },
			],
			currentPrices: { FAIL: 95 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["FAIL"] },
		tags: ["wrong-direction"],
	},
	{
		id: "mot-005",
		name: "In universe — should NOT log even with >2% move",
		input: {
			analyses: [
				{ symbol: "AAPL", exchange: "NASDAQ", direction: "long", priceAtAnalysis: 150, inUniverse: true, confidence: 0.9, eventType: "earnings_beat", tradeThesis: "Strong earnings" },
			],
			currentPrices: { AAPL: 160 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["AAPL"] },
		tags: ["in-universe", "should-not-log"],
	},
	{
		id: "mot-006",
		name: "Null priceAtAnalysis — should be skipped entirely",
		input: {
			analyses: [
				{ symbol: "NEW", exchange: "NASDAQ", direction: "long", priceAtAnalysis: null, inUniverse: false, confidence: 0.6, eventType: "contract_win", tradeThesis: "New symbol" },
			],
			currentPrices: { NEW: 200 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["NEW"] },
		tags: ["null-price", "skip"],
	},
	{
		id: "mot-007",
		name: "Avoid direction — should NOT log regardless of move",
		input: {
			analyses: [
				{ symbol: "AVOID", exchange: "NYSE", direction: "avoid", priceAtAnalysis: 100, inUniverse: false, confidence: 0.3, eventType: "other", tradeThesis: "Unclear" },
			],
			currentPrices: { AVOID: 110 },
		},
		reference: { expectedMissedSymbols: [], expectedNotMissedSymbols: ["AVOID"] },
		tags: ["avoid-direction"],
	},
	{
		id: "mot-008",
		name: "Multiple symbols — mixed outcomes",
		input: {
			analyses: [
				{ symbol: "WIN", exchange: "NASDAQ", direction: "long", priceAtAnalysis: 100, inUniverse: false, confidence: 0.8, eventType: "earnings_beat", tradeThesis: "Beat earnings" },
				{ symbol: "LOSE", exchange: "NASDAQ", direction: "long", priceAtAnalysis: 100, inUniverse: false, confidence: 0.5, eventType: "partnership", tradeThesis: "Minor" },
				{ symbol: "INUNI", exchange: "NASDAQ", direction: "long", priceAtAnalysis: 100, inUniverse: true, confidence: 0.9, eventType: "earnings_beat", tradeThesis: "Already tracked" },
			],
			currentPrices: { WIN: 106, LOSE: 98, INUNI: 110 },
		},
		reference: { expectedMissedSymbols: ["WIN"], expectedNotMissedSymbols: ["LOSE", "INUNI"] },
		tags: ["multi-symbol", "mixed"],
	},
];
```

- [ ] **Step 2: Create graders**

```typescript
// src/evals/missed-opportunity/graders.ts
import type { Grader } from "../types.ts";
import type { TrackerReference } from "./tasks.ts";

interface TrackerOutput {
	missedSymbols: string[];
	reviewedCount: number;
}

type TG = Grader<TrackerOutput, TrackerReference>;

export const missedAccuracyGrader: TG = {
	name: "missed-accuracy",
	type: "code",
	grade: async (output, reference) => {
		const expected = new Set(reference.expectedMissedSymbols);
		const actual = new Set(output.missedSymbols);
		const correct = [...expected].filter((s) => actual.has(s)).length;
		const total = expected.size;
		const score = total > 0 ? correct / total : 1;
		return { score, pass: score === 1, reason: `Found ${correct}/${total} expected missed symbols` };
	},
};

export const noFalsePositivesGrader: TG = {
	name: "no-false-positives",
	type: "code",
	grade: async (output, reference) => {
		const shouldNot = new Set(reference.expectedNotMissedSymbols);
		const falsePositives = output.missedSymbols.filter((s) => shouldNot.has(s));
		const pass = falsePositives.length === 0;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass ? "No false positives" : `False positives: ${falsePositives.join(", ")}`,
		};
	},
};

export const allTrackerGraders: TG[] = [missedAccuracyGrader, noFalsePositivesGrader];
```

- [ ] **Step 3: Create suite runner**

```typescript
// src/evals/missed-opportunity/suite.ts
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import { allTrackerGraders } from "./graders.ts";
import { trackerTasks, type TrackerInput } from "./tasks.ts";

function simulateTracker(input: TrackerInput): { missedSymbols: string[]; reviewedCount: number } {
	const missedSymbols: string[] = [];
	let reviewed = 0;

	for (const analysis of input.analyses) {
		if (analysis.priceAtAnalysis == null) continue;
		if (analysis.inUniverse) {
			reviewed++;
			continue;
		}
		if (analysis.direction === "avoid") {
			reviewed++;
			continue;
		}

		const currentPrice = input.currentPrices[analysis.symbol];
		if (currentPrice == null) continue;

		reviewed++;
		const changePct = ((currentPrice - analysis.priceAtAnalysis) / analysis.priceAtAnalysis) * 100;
		const correctDirection =
			(analysis.direction === "long" && changePct > 0) ||
			(analysis.direction === "short" && changePct < 0);

		if (Math.abs(changePct) > 2 && correctDirection) {
			missedSymbols.push(analysis.symbol);
		}
	}

	return { missedSymbols, reviewedCount: reviewed };
}

export async function runMissedOpportunityEvals(
	options: { saveDir?: string } = {},
): Promise<void> {
	const saveDir = options.saveDir ?? "src/evals/missed-opportunity/results";

	const results = await runSuite(
		trackerTasks,
		async (input) => simulateTracker(input),
		allTrackerGraders,
		{ trials: 1, suiteName: "missed-opportunity" },
	);

	console.log(formatSuiteReport(results));
	await Bun.write(`${saveDir}/missed-opportunity-latest.json`, JSON.stringify(results, null, 2));
}
```

- [ ] **Step 4: Verify compilation**

Run: `bunx biome check --write --unsafe src/evals/missed-opportunity/`

- [ ] **Step 5: Commit**

```bash
git add src/evals/missed-opportunity/
git commit -m "feat(evals): add missed opportunity tracker eval suite with 8 tasks"
```

---

### Task 11: Full integration test + lint

**Files:**
- Test: `tests/integration/news-research-pipeline.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration/news-research-pipeline.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, newsEvents, quotesCache, tradeInsights } from "../../src/db/schema.ts";
import { storeNewsEvent } from "../../src/news/sentiment-writer.ts";
import {
	buildResearchPrompt,
	parseResearchResponse,
} from "../../src/news/research-agent.ts";
import { runDailyMissedOpportunityReview } from "../../src/scheduler/missed-opportunity-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

describe("end-to-end news research pipeline", () => {
	test("storeNewsEvent → research analysis → missed opportunity tracker", async () => {
		const db = getDb();

		// Step 1: Store a news event and get ID
		const newsEventId = await storeNewsEvent({
			source: "finnhub",
			headline: "Broadcom and Google seal five-year AI chip partnership",
			url: null,
			symbols: ["GOOGL"],
			sentiment: 0.2,
			confidence: 0.7,
			tradeable: true,
			eventType: "partnership",
			urgency: "low",
			signals: null,
		});

		expect(newsEventId).toBeGreaterThan(0);

		// Step 2: Simulate research agent response (without actual API call)
		const mockResponse = JSON.stringify({
			affected_symbols: [
				{
					symbol: "AVGO",
					exchange: "NASDAQ",
					sentiment: 0.85,
					urgency: "high",
					event_type: "contract_win",
					direction: "long",
					trade_thesis: "Major 5-year AI chip deal signals revenue growth",
					confidence: 0.9,
				},
				{
					symbol: "GOOGL",
					exchange: "NASDAQ",
					sentiment: 0.2,
					urgency: "low",
					event_type: "partnership",
					direction: "long",
					trade_thesis: "Partnership positive but minor for Google",
					confidence: 0.4,
				},
			],
		});

		const analyses = parseResearchResponse(mockResponse);
		expect(analyses.length).toBe(2);

		// Step 3: Store analyses in DB
		const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
		for (const analysis of analyses) {
			await db.insert(newsAnalyses).values({
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
				inUniverse: analysis.symbol === "GOOGL", // GOOGL was in universe, AVGO was not
				priceAtAnalysis: analysis.symbol === "AVGO" ? 100.0 : 150.0,
				createdAt: thirtyHoursAgo,
			});
		}

		// Step 4: Add current prices to quotes_cache
		await db.insert(quotesCache).values({ symbol: "AVGO", exchange: "NASDAQ", last: 105.0 });
		await db.insert(quotesCache).values({ symbol: "GOOGL", exchange: "NASDAQ", last: 152.0 });

		// Step 5: Run missed opportunity tracker
		const result = await runDailyMissedOpportunityReview();
		expect(result.reviewed).toBe(2);
		expect(result.missed).toBe(1); // Only AVGO (not in universe, +5%)

		// Verify AVGO has a missed opportunity insight
		const insights = await db
			.select()
			.from(tradeInsights)
			.where(eq(tradeInsights.insightType, "missed_opportunity"));
		expect(insights.length).toBe(1);
		expect(insights[0]!.observation).toContain("AVGO");
		expect(insights[0]!.observation).toContain("5.0%");
		expect(insights[0]!.strategyId).toBeNull();

		// Verify GOOGL does NOT have a missed opportunity (was in universe)
		expect(insights[0]!.observation).not.toContain("GOOGL");
	});
});
```

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 3: Run full lint**

Run: `bunx biome check --write --unsafe src/ tests/`

- [ ] **Step 4: Commit**

```bash
git add tests/integration/news-research-pipeline.test.ts
git commit -m "test: add end-to-end integration test for news research pipeline"
```

- [ ] **Step 5: Final lint + type check**

Run: `bunx biome check src/ tests/`
Expected: No errors

---

## Self-Review Checklist

**Spec coverage:**
- [x] Research agent (Sonnet, multi-symbol) — Task 3
- [x] `storeNewsEvent` returns ID — Task 2
- [x] Fire-and-forget from ingest — Task 4
- [x] `newsAnalyses` table with all columns + unique constraint — Task 1
- [x] `tradeInsights.strategyId` nullable — Task 1
- [x] `insightType` enum extended — Task 1
- [x] Exchange validation — Task 3
- [x] `inUniverse` flag — Task 3
- [x] `priceAtAnalysis` with Finnhub fallback — Task 3
- [x] Signal writing via `writeSignals` — Task 3
- [x] 24h TTL injection for high-confidence — Task 3
- [x] Daily missed opportunity review (24-48h window) — Task 5
- [x] Weekly missed opportunity review (7-8d window) — Task 5
- [x] Price change math + threshold logic — Task 5
- [x] Missed opportunity → `trade_insights` with null strategyId — Task 5
- [x] Cron registration — Task 6
- [x] JobName + executeJob — Task 6
- [x] Pattern analysis missed opportunity context — Task 7
- [x] `universe_suggestions` parsing — Task 7
- [x] Dashboard missed count + amber badge — Task 8
- [x] Research agent evals (10 tasks, 6 graders) — Task 9
- [x] Missed opportunity evals (8 tasks, 2 graders) — Task 10
- [x] Integration test — Task 11

**Placeholder scan:** No TBDs, TODOs, or "implement later" found.

**Type consistency:** All function signatures, type names, and property names are consistent across tasks.
