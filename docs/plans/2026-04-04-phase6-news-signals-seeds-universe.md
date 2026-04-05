# Phase 6: Richer News Signals, Seeds & Universe Management — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the news classifier to produce event-specific signal fields (earnings_surprise, management_tone, etc.), wire them through the DB and signal context so strategies can reference them in expressions, update the earnings_drift seed to use richer signals, and add universe management with a 50-symbol cap, liquidity filter, and news-discovered symbol injection.

**Architecture:** The classifier prompt and response parser gain a `signals` sub-object with numeric scores and categorical fields. New columns on `quotes_cache` store per-symbol signal data. The `ExprContext` exposes these as flat variable names usable in strategy signal expressions. A new `universe.ts` module validates strategy universes against the cap/liquidity constraints and handles temporary symbol injection from the news bus.

**Tech Stack:** Bun, TypeScript, Drizzle ORM (SQLite), @anthropic-ai/sdk

**Spec:** `docs/specs/2026-04-03-trader-v2-design.md` — Section 3 (Strategy System: News signals as strategy variables, Universe Management)

---

## File Structure

```
src/
  news/
    classifier.ts          # Modify — expanded ClassificationResult, SYSTEM_PROMPT, parser
    sentiment-writer.ts    # Modify — write all signal fields to quotes_cache
    ingest.ts              # Modify — pass signals through pipeline, trigger symbol injection
  db/
    schema.ts              # Modify — add signal columns to quotes_cache, add news_signals columns to news_events
  strategy/
    context.ts             # Modify — expose new signal fields in ExprContext
    seed.ts                # Modify — update earnings_drift_v1 signals to use richer fields
    evaluator.ts           # Modify — apply universe cap and liquidity filter
    universe.ts            # Create — universe validation, liquidity filter, symbol injection
  evals/
    classifier/
      tasks.ts             # Modify — add signal field references
      graders.ts           # Modify — add signal shape grader
tests/
  news/
    classifier.test.ts     # Modify — test new signal fields in parser
    sentiment-writer.test.ts  # Modify — test signal field writes to quotes_cache
  strategy/
    universe.test.ts       # Create — universe management tests
    context.test.ts        # Modify or Create — test new signal fields in context
```

---

### Task 1: Expand ClassificationResult Interface and Parser

**Files:**
- Modify: `src/news/classifier.ts`
- Modify: `tests/news/classifier.test.ts`

- [ ] **Step 1: Write failing test for new signal fields in parser output**

Add to `tests/news/classifier.test.ts`:

```typescript
test("parseClassificationResponse extracts signal fields", async () => {
	const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

	const response = JSON.stringify({
		tradeable: true,
		sentiment: 0.8,
		confidence: 0.9,
		event_type: "earnings_beat",
		urgency: "high",
		signals: {
			earnings_surprise: 0.9,
			guidance_change: 0.3,
			management_tone: 0.7,
			regulatory_risk: 0.0,
			acquisition_likelihood: 0.0,
			catalyst_type: "fundamental",
			expected_move_duration: "1-3d",
		},
	});

	const result = parseClassificationResponse(response);
	expect(result).not.toBeNull();
	expect(result!.signals).toBeDefined();
	expect(result!.signals!.earningsSurprise).toBeCloseTo(0.9);
	expect(result!.signals!.guidanceChange).toBeCloseTo(0.3);
	expect(result!.signals!.managementTone).toBeCloseTo(0.7);
	expect(result!.signals!.regulatoryRisk).toBeCloseTo(0.0);
	expect(result!.signals!.acquisitionLikelihood).toBeCloseTo(0.0);
	expect(result!.signals!.catalystType).toBe("fundamental");
	expect(result!.signals!.expectedMoveDuration).toBe("1-3d");
});

test("parseClassificationResponse handles missing signals gracefully", async () => {
	const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

	const response = JSON.stringify({
		tradeable: true,
		sentiment: 0.5,
		confidence: 0.7,
		event_type: "upgrade",
		urgency: "medium",
	});

	const result = parseClassificationResponse(response);
	expect(result).not.toBeNull();
	expect(result!.signals).toBeNull();
});

test("parseClassificationResponse clamps signal scores to [0, 1]", async () => {
	const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

	const response = JSON.stringify({
		tradeable: true,
		sentiment: 0.8,
		confidence: 0.9,
		event_type: "earnings_beat",
		urgency: "high",
		signals: {
			earnings_surprise: 1.5,
			guidance_change: -0.2,
			management_tone: 0.7,
			regulatory_risk: 0.0,
			acquisition_likelihood: 0.0,
			catalyst_type: "fundamental",
			expected_move_duration: "1-3d",
		},
	});

	const result = parseClassificationResponse(response);
	expect(result).not.toBeNull();
	expect(result!.signals!.earningsSurprise).toBe(1.0);
	expect(result!.signals!.guidanceChange).toBe(0.0);
});

test("parseClassificationResponse validates catalyst_type enum", async () => {
	const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

	const response = JSON.stringify({
		tradeable: true,
		sentiment: 0.8,
		confidence: 0.9,
		event_type: "earnings_beat",
		urgency: "high",
		signals: {
			earnings_surprise: 0.9,
			guidance_change: 0.3,
			management_tone: 0.7,
			regulatory_risk: 0.0,
			acquisition_likelihood: 0.0,
			catalyst_type: "invalid_type",
			expected_move_duration: "1-3d",
		},
	});

	const result = parseClassificationResponse(response);
	expect(result).not.toBeNull();
	expect(result!.signals!.catalystType).toBe("other");
});
```

- [ ] **Step 2: Verify tests fail**

```bash
bun test --preload ./tests/preload.ts tests/news/classifier.test.ts
```

Expected: 4 new tests fail (signals property does not exist on ClassificationResult).

- [ ] **Step 3: Update ClassificationResult interface**

In `src/news/classifier.ts`, replace the `ClassificationResult` interface:

```typescript
export interface ClassificationSignals {
	earningsSurprise: number;
	guidanceChange: number;
	managementTone: number;
	regulatoryRisk: number;
	acquisitionLikelihood: number;
	catalystType: string;
	expectedMoveDuration: string;
}

export interface ClassificationResult {
	tradeable: boolean;
	sentiment: number;
	confidence: number;
	eventType: string;
	urgency: "low" | "medium" | "high";
	signals: ClassificationSignals | null;
}
```

- [ ] **Step 4: Update SYSTEM_PROMPT to request signal fields**

Replace the `SYSTEM_PROMPT` constant in `src/news/classifier.ts`:

```typescript
const SYSTEM_PROMPT = `You are a financial news classifier for an automated trading system.
Analyze the headline and return a JSON object with these fields:
- tradeable: boolean — true if this news could materially move the stock price
- sentiment: number — from -1.0 (very bearish) to 1.0 (very bullish), 0 = neutral
- confidence: number — from 0.0 to 1.0, how confident you are in the classification
- event_type: string — one of: earnings_beat, earnings_miss, guidance_raise, guidance_lower, fda_approval, fda_rejection, acquisition, merger, buyback, dividend, profit_warning, upgrade, downgrade, legal, restructuring, other
- urgency: string — one of: low, medium, high
- signals: object — event-specific signal scores (include ONLY when tradeable is true):
  - earnings_surprise: number 0-1 — strength of earnings surprise (0 if not earnings-related)
  - guidance_change: number 0-1 — magnitude of forward guidance change (0 if none)
  - management_tone: number 0-1 — confidence/optimism in management commentary (0.5 = neutral)
  - regulatory_risk: number 0-1 — regulatory threat level (0 = none)
  - acquisition_likelihood: number 0-1 — probability this leads to M&A activity (0 = none)
  - catalyst_type: string — one of: fundamental, technical, macro, sector, sentiment, other
  - expected_move_duration: string — one of: intraday, 1-3d, 1-2w, 1m+

Return ONLY the JSON object, no other text.`;
```

- [ ] **Step 5: Update parseClassificationResponse to extract signals**

Replace the `parseClassificationResponse` function in `src/news/classifier.ts`:

```typescript
const VALID_CATALYST_TYPES = new Set([
	"fundamental",
	"technical",
	"macro",
	"sector",
	"sentiment",
	"other",
]);

const VALID_MOVE_DURATIONS = new Set(["intraday", "1-3d", "1-2w", "1m+"]);

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}

function parseSignals(raw: unknown): ClassificationSignals | null {
	if (raw == null || typeof raw !== "object") return null;
	const s = raw as Record<string, unknown>;

	if (typeof s.earnings_surprise !== "number") return null;
	if (typeof s.guidance_change !== "number") return null;
	if (typeof s.management_tone !== "number") return null;
	if (typeof s.regulatory_risk !== "number") return null;
	if (typeof s.acquisition_likelihood !== "number") return null;
	if (typeof s.catalyst_type !== "string") return null;
	if (typeof s.expected_move_duration !== "string") return null;

	return {
		earningsSurprise: clamp01(s.earnings_surprise),
		guidanceChange: clamp01(s.guidance_change),
		managementTone: clamp01(s.management_tone),
		regulatoryRisk: clamp01(s.regulatory_risk),
		acquisitionLikelihood: clamp01(s.acquisition_likelihood),
		catalystType: VALID_CATALYST_TYPES.has(s.catalyst_type) ? s.catalyst_type : "other",
		expectedMoveDuration: VALID_MOVE_DURATIONS.has(s.expected_move_duration)
			? s.expected_move_duration
			: "1-3d",
	};
}

export function parseClassificationResponse(text: string): ClassificationResult | null {
	try {
		const jsonStr = text
			.replace(/```json?\n?/g, "")
			.replace(/```/g, "")
			.trim();
		const parsed = JSON.parse(jsonStr);

		if (typeof parsed.tradeable !== "boolean") return null;
		if (typeof parsed.sentiment !== "number") return null;
		if (typeof parsed.confidence !== "number") return null;
		if (typeof parsed.event_type !== "string") return null;
		if (typeof parsed.urgency !== "string") return null;

		const validUrgency = ["low", "medium", "high"];
		if (!validUrgency.includes(parsed.urgency)) return null;

		const validEventTypes = new Set([
			"earnings_beat",
			"earnings_miss",
			"guidance_raise",
			"guidance_lower",
			"fda_approval",
			"fda_rejection",
			"acquisition",
			"merger",
			"buyback",
			"dividend",
			"profit_warning",
			"upgrade",
			"downgrade",
			"legal",
			"restructuring",
			"other",
		]);
		const eventType = validEventTypes.has(parsed.event_type) ? parsed.event_type : "other";

		return {
			tradeable: parsed.tradeable,
			sentiment: Math.max(-1, Math.min(1, parsed.sentiment)),
			confidence: Math.max(0, Math.min(1, parsed.confidence)),
			eventType,
			urgency: parsed.urgency as "low" | "medium" | "high",
			signals: parseSignals(parsed.signals),
		};
	} catch {
		return null;
	}
}
```

- [ ] **Step 6: Update max_tokens in classifyHeadline**

In the `classifyHeadline` function, increase `max_tokens` from 150 to 300 to accommodate the larger response:

```typescript
max_tokens: 300,
```

Also update the estimated cost comment:

```typescript
const estimatedCost = 0.0003; // ~200 input + 100 output tokens at Haiku rates
```

- [ ] **Step 7: Verify all classifier tests pass**

```bash
bun test --preload ./tests/preload.ts tests/news/classifier.test.ts
```

Expected: All 8 tests pass (4 existing + 4 new).

- [ ] **Step 8: Commit**

```bash
git add src/news/classifier.ts tests/news/classifier.test.ts
git commit -m "feat: expand classifier with event-specific signal fields"
```

---

### Task 2: Add Signal Columns to Database Schema

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add signal columns to quotes_cache table**

In `src/db/schema.ts`, add the following columns to the `quotesCache` table definition, after the `newsSentiment` column:

```typescript
newsEarningsSurprise: real("news_earnings_surprise"),
newsGuidanceChange: real("news_guidance_change"),
newsManagementTone: real("news_management_tone"),
newsRegulatoryRisk: real("news_regulatory_risk"),
newsAcquisitionLikelihood: real("news_acquisition_likelihood"),
newsCatalystType: text("news_catalyst_type"),
newsExpectedMoveDuration: text("news_expected_move_duration"),
```

- [ ] **Step 2: Add signal columns to news_events table**

In `src/db/schema.ts`, add signal columns to the `newsEvents` table definition, after the `urgency` column:

```typescript
earningsSurprise: real("earnings_surprise"),
guidanceChange: real("guidance_change"),
managementTone: real("management_tone"),
regulatoryRisk: real("regulatory_risk"),
acquisitionLikelihood: real("acquisition_likelihood"),
catalystType: text("catalyst_type"),
expectedMoveDuration: text("expected_move_duration"),
```

- [ ] **Step 3: Generate migration**

```bash
bun run db:generate
```

Expected: A new migration file appears in `drizzle/migrations/` with ALTER TABLE statements adding the new columns.

- [ ] **Step 4: Verify schema test still passes**

```bash
bun test --preload ./tests/preload.ts tests/db/schema.test.ts
```

Expected: All existing DB tests pass (migrations run cleanly with new columns).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "schema: add signal columns to quotes_cache and news_events"
```

---

### Task 3: Update Sentiment Writer to Write Signal Fields

**Files:**
- Modify: `src/news/sentiment-writer.ts`
- Modify: `tests/news/sentiment-writer.test.ts`

- [ ] **Step 1: Write failing test for signal field writes**

Add to `tests/news/sentiment-writer.test.ts`:

```typescript
test("writeSignals writes all signal fields to quote cache", async () => {
	const { writeSignals } = await import("../../src/news/sentiment-writer.ts");
	const { quotesCache } = await import("../../src/db/schema.ts");

	await db.insert(quotesCache).values({
		symbol: "AAPL",
		exchange: "NASDAQ",
		last: 150,
	});

	await writeSignals("AAPL", "NASDAQ", {
		sentiment: 0.8,
		earningsSurprise: 0.9,
		guidanceChange: 0.3,
		managementTone: 0.7,
		regulatoryRisk: 0.0,
		acquisitionLikelihood: 0.0,
		catalystType: "fundamental",
		expectedMoveDuration: "1-3d",
	});

	const [row] = await db
		.select()
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, "AAPL"), eq(quotesCache.exchange, "NASDAQ")));

	expect(row).not.toBeUndefined();
	expect(row!.newsSentiment).toBeCloseTo(0.8);
	expect(row!.newsEarningsSurprise).toBeCloseTo(0.9);
	expect(row!.newsGuidanceChange).toBeCloseTo(0.3);
	expect(row!.newsManagementTone).toBeCloseTo(0.7);
	expect(row!.newsRegulatoryRisk).toBeCloseTo(0.0);
	expect(row!.newsAcquisitionLikelihood).toBeCloseTo(0.0);
	expect(row!.newsCatalystType).toBe("fundamental");
	expect(row!.newsExpectedMoveDuration).toBe("1-3d");
	expect(row!.last).toBe(150); // price unchanged
});

test("writeSignals creates cache row if missing", async () => {
	const { writeSignals } = await import("../../src/news/sentiment-writer.ts");
	const { quotesCache } = await import("../../src/db/schema.ts");

	await writeSignals("NEW", "NASDAQ", {
		sentiment: -0.5,
		earningsSurprise: 0.0,
		guidanceChange: 0.0,
		managementTone: 0.3,
		regulatoryRisk: 0.8,
		acquisitionLikelihood: 0.0,
		catalystType: "other",
		expectedMoveDuration: "1-2w",
	});

	const [row] = await db
		.select()
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, "NEW"), eq(quotesCache.exchange, "NASDAQ")));

	expect(row).not.toBeUndefined();
	expect(row!.newsSentiment).toBeCloseTo(-0.5);
	expect(row!.newsRegulatoryRisk).toBeCloseTo(0.8);
	expect(row!.last).toBeNull();
});

test("storeNewsEvent stores signal fields in news_events table", async () => {
	const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
	const { newsEvents } = await import("../../src/db/schema.ts");

	await storeNewsEvent({
		source: "finnhub",
		headline: "Apple beats earnings with strong guidance",
		url: "https://example.com",
		symbols: ["AAPL"],
		sentiment: 0.8,
		confidence: 0.9,
		tradeable: true,
		eventType: "earnings_beat",
		urgency: "high" as const,
		signals: {
			earningsSurprise: 0.9,
			guidanceChange: 0.6,
			managementTone: 0.7,
			regulatoryRisk: 0.0,
			acquisitionLikelihood: 0.0,
			catalystType: "fundamental",
			expectedMoveDuration: "1-3d",
		},
	});

	const rows = await db.select().from(newsEvents);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.earningsSurprise).toBeCloseTo(0.9);
	expect(rows[0]!.guidanceChange).toBeCloseTo(0.6);
	expect(rows[0]!.managementTone).toBeCloseTo(0.7);
	expect(rows[0]!.catalystType).toBe("fundamental");
});

test("storeNewsEvent handles null signals", async () => {
	const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
	const { newsEvents } = await import("../../src/db/schema.ts");

	await storeNewsEvent({
		source: "finnhub",
		headline: "Routine board appointment at XYZ Corp",
		url: null,
		symbols: ["XYZ"],
		sentiment: null,
		confidence: null,
		tradeable: null,
		eventType: null,
		urgency: null,
		signals: null,
	});

	const rows = await db.select().from(newsEvents);
	expect(rows).toHaveLength(1);
	expect(rows[0]!.earningsSurprise).toBeNull();
	expect(rows[0]!.catalystType).toBeNull();
});
```

- [ ] **Step 2: Verify tests fail**

```bash
bun test --preload ./tests/preload.ts tests/news/sentiment-writer.test.ts
```

Expected: 4 new tests fail (writeSignals does not exist, storeNewsEvent does not accept signals).

- [ ] **Step 3: Add SignalWriteInput interface and writeSignals function**

In `src/news/sentiment-writer.ts`, add:

```typescript
import type { ClassificationSignals } from "./classifier.ts";

export interface SignalWriteInput {
	sentiment: number;
	earningsSurprise: number;
	guidanceChange: number;
	managementTone: number;
	regulatoryRisk: number;
	acquisitionLikelihood: number;
	catalystType: string;
	expectedMoveDuration: string;
}

/**
 * Write all signal fields to quotes_cache for a symbol.
 * Creates the cache row if it doesn't exist. Does NOT overwrite price data.
 */
export async function writeSignals(
	symbol: string,
	exchange: string,
	signals: SignalWriteInput,
): Promise<void> {
	const db = getDb();
	await db
		.insert(quotesCache)
		.values({
			symbol,
			exchange,
			newsSentiment: signals.sentiment,
			newsEarningsSurprise: signals.earningsSurprise,
			newsGuidanceChange: signals.guidanceChange,
			newsManagementTone: signals.managementTone,
			newsRegulatoryRisk: signals.regulatoryRisk,
			newsAcquisitionLikelihood: signals.acquisitionLikelihood,
			newsCatalystType: signals.catalystType,
			newsExpectedMoveDuration: signals.expectedMoveDuration,
		})
		.onConflictDoUpdate({
			target: [quotesCache.symbol, quotesCache.exchange],
			set: {
				newsSentiment: signals.sentiment,
				newsEarningsSurprise: signals.earningsSurprise,
				newsGuidanceChange: signals.guidanceChange,
				newsManagementTone: signals.managementTone,
				newsRegulatoryRisk: signals.regulatoryRisk,
				newsAcquisitionLikelihood: signals.acquisitionLikelihood,
				newsCatalystType: signals.catalystType,
				newsExpectedMoveDuration: signals.expectedMoveDuration,
				updatedAt: new Date().toISOString(),
			},
		});

	log.debug({ symbol, exchange }, "Signals written to cache");
}
```

- [ ] **Step 4: Update NewsEventInput and storeNewsEvent to include signals**

Replace the `NewsEventInput` interface and `storeNewsEvent` function:

```typescript
export interface NewsEventInput {
	source: string;
	headline: string;
	url: string | null;
	symbols: string[];
	sentiment: number | null;
	confidence: number | null;
	tradeable: boolean | null;
	eventType: string | null;
	urgency: "low" | "medium" | "high" | null;
	signals: ClassificationSignals | null;
}

/**
 * Store a classified news event in the news_events table.
 */
export async function storeNewsEvent(input: NewsEventInput): Promise<void> {
	const db = getDb();
	await db.insert(newsEvents).values({
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
	});
}
```

- [ ] **Step 5: Verify all sentiment-writer tests pass**

```bash
bun test --preload ./tests/preload.ts tests/news/sentiment-writer.test.ts
```

Expected: All 7 tests pass (3 existing + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/news/sentiment-writer.ts tests/news/sentiment-writer.test.ts
git commit -m "feat: write signal fields to quotes_cache and news_events"
```

---

### Task 4: Update News Ingest Pipeline to Pass Signals Through

**Files:**
- Modify: `src/news/ingest.ts`

- [ ] **Step 1: Update storeNewsEvent calls to pass signals**

In `src/news/ingest.ts`, update all three `storeNewsEvent` calls to include the `signals` field.

For the two calls where classification failed or was filtered (null result), add:

```typescript
signals: null,
```

For the successful classification call, replace the `storeNewsEvent` block:

```typescript
// Store classified event
await storeNewsEvent({
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

- [ ] **Step 2: Replace writeSentiment with writeSignals when signals are available**

Replace the sentiment-writing block in the successful classification path:

```typescript
// Write signals to quote cache for each symbol
for (const symbol of article.symbols) {
	if (result.signals) {
		await writeSignals(symbol, exchange, {
			sentiment: result.sentiment,
			earningsSurprise: result.signals.earningsSurprise,
			guidanceChange: result.signals.guidanceChange,
			managementTone: result.signals.managementTone,
			regulatoryRisk: result.signals.regulatoryRisk,
			acquisitionLikelihood: result.signals.acquisitionLikelihood,
			catalystType: result.signals.catalystType,
			expectedMoveDuration: result.signals.expectedMoveDuration,
		});
	} else {
		await writeSentiment(symbol, exchange, result.sentiment);
	}
}
```

Update the imports at the top of `src/news/ingest.ts`:

```typescript
import { storeNewsEvent, writeSignals, writeSentiment } from "./sentiment-writer.ts";
```

- [ ] **Step 3: Verify existing ingest tests still pass**

```bash
bun test --preload ./tests/preload.ts tests/news/
```

Expected: All news tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/news/ingest.ts
git commit -m "feat: pass signal fields through news ingest pipeline"
```

---

### Task 5: Expose Signal Fields in ExprContext

**Files:**
- Modify: `src/strategy/context.ts`
- Create: `tests/strategy/context.test.ts`

- [ ] **Step 1: Write failing test for new context fields**

Create `tests/strategy/context.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("buildSignalContext", () => {
	test("includes base quote and indicator fields", async () => {
		const { buildSignalContext } = await import("../../src/strategy/context.ts");

		const ctx = buildSignalContext({
			quote: {
				last: 150,
				bid: 149.9,
				ask: 150.1,
				volume: 1000000,
				avgVolume: 800000,
				changePercent: 1.5,
				newsSentiment: 0.7,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 45, atr14: 2.5, volume_ratio: 1.2 },
			position: null,
		});

		expect(ctx.last).toBe(150);
		expect(ctx.news_sentiment).toBe(0.7);
		expect(ctx.rsi14).toBe(45);
		expect(ctx.earnings_surprise).toBeNull();
	});

	test("includes signal fields when present", async () => {
		const { buildSignalContext } = await import("../../src/strategy/context.ts");

		const ctx = buildSignalContext({
			quote: {
				last: 150,
				bid: 149.9,
				ask: 150.1,
				volume: 2000000,
				avgVolume: 800000,
				changePercent: 3.5,
				newsSentiment: 0.8,
				newsEarningsSurprise: 0.9,
				newsGuidanceChange: 0.3,
				newsManagementTone: 0.7,
				newsRegulatoryRisk: 0.0,
				newsAcquisitionLikelihood: 0.0,
				newsCatalystType: "fundamental",
				newsExpectedMoveDuration: "1-3d",
			},
			indicators: { rsi14: 55, atr14: 3.0, volume_ratio: 2.5 },
			position: null,
		});

		expect(ctx.earnings_surprise).toBeCloseTo(0.9);
		expect(ctx.guidance_change).toBeCloseTo(0.3);
		expect(ctx.management_tone).toBeCloseTo(0.7);
		expect(ctx.regulatory_risk).toBeCloseTo(0.0);
		expect(ctx.acquisition_likelihood).toBeCloseTo(0.0);
	});

	test("hold_days and pnl_pct computed from position", async () => {
		const { buildSignalContext } = await import("../../src/strategy/context.ts");

		const threeDaysAgo = new Date();
		threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

		const ctx = buildSignalContext({
			quote: {
				last: 160,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: null, atr14: null, volume_ratio: null },
			position: {
				entryPrice: 150,
				openedAt: threeDaysAgo.toISOString(),
				quantity: 10,
			},
		});

		expect(ctx.hold_days).toBe(3);
		expect(ctx.pnl_pct).toBeCloseTo(6.67, 1);
	});
});
```

- [ ] **Step 2: Verify tests fail**

```bash
bun test --preload ./tests/preload.ts tests/strategy/context.test.ts
```

Expected: Tests fail because QuoteFields does not include the new signal fields.

- [ ] **Step 3: Update QuoteFields interface and buildSignalContext**

Replace the content of `src/strategy/context.ts`:

```typescript
import type { ExprContext } from "./expr-eval.ts";
import type { SymbolIndicators } from "./historical.ts";

export interface QuoteFields {
	last: number | null;
	bid: number | null;
	ask: number | null;
	volume: number | null;
	avgVolume: number | null;
	changePercent: number | null;
	newsSentiment: number | null;
	newsEarningsSurprise: number | null;
	newsGuidanceChange: number | null;
	newsManagementTone: number | null;
	newsRegulatoryRisk: number | null;
	newsAcquisitionLikelihood: number | null;
	newsCatalystType: string | null;
	newsExpectedMoveDuration: string | null;
}

export interface PositionFields {
	entryPrice: number;
	openedAt: string;
	quantity: number;
}

export interface ContextInput {
	quote: QuoteFields;
	indicators: SymbolIndicators;
	position: PositionFields | null;
}

export function buildSignalContext(input: ContextInput): ExprContext {
	const { quote, indicators, position } = input;

	let holdDays: number | null = null;
	let pnlPct: number | null = null;

	if (position) {
		const openedAt = new Date(position.openedAt);
		const now = new Date();
		holdDays = Math.floor((now.getTime() - openedAt.getTime()) / (1000 * 60 * 60 * 24));

		if (quote.last != null && position.entryPrice > 0) {
			pnlPct = ((quote.last - position.entryPrice) / position.entryPrice) * 100;
		}
	}

	return {
		last: quote.last,
		bid: quote.bid,
		ask: quote.ask,
		volume: quote.volume,
		avg_volume: quote.avgVolume,
		change_percent: quote.changePercent,
		news_sentiment: quote.newsSentiment,
		earnings_surprise: quote.newsEarningsSurprise,
		guidance_change: quote.newsGuidanceChange,
		management_tone: quote.newsManagementTone,
		regulatory_risk: quote.newsRegulatoryRisk,
		acquisition_likelihood: quote.newsAcquisitionLikelihood,
		rsi14: indicators.rsi14,
		atr14: indicators.atr14,
		volume_ratio: indicators.volume_ratio,
		hold_days: holdDays,
		pnl_pct: pnlPct,
	};
}
```

Note: `newsCatalystType` and `newsExpectedMoveDuration` are strings, not numbers. The `ExprContext` type is `Record<string, number | null | undefined>`, so string fields cannot be added directly. They are omitted from the numeric context — strategies cannot use them in signal expressions (which only support numeric comparisons). If string matching is needed later, the expr-eval parser would need extending. This is an acceptable trade-off: the numeric scores (earnings_surprise, management_tone, etc.) are what strategies actually compare against.

- [ ] **Step 4: Verify all context tests pass**

```bash
bun test --preload ./tests/preload.ts tests/strategy/context.test.ts
```

Expected: All 3 tests pass.

- [ ] **Step 5: Fix any downstream type errors from QuoteFields change**

The `QuoteFields` interface is imported by `src/strategy/evaluator.ts` and any callers that build quote objects. Search for all files importing `QuoteFields` and update them to include the new fields. The evaluator reads from `quotesCache` rows which will now have the new columns, so the mapping should include them.

Check and update the quote-building code in `src/data/quotes.ts` or wherever `QuoteFields` objects are constructed from DB rows. Add the new fields, defaulting to `null` if the DB column is null.

- [ ] **Step 6: Verify full test suite passes**

```bash
bun test --preload ./tests/preload.ts
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/strategy/context.ts tests/strategy/context.test.ts src/strategy/evaluator.ts
git commit -m "feat: expose signal fields in strategy ExprContext"
```

---

### Task 6: Update Earnings Drift Seed Strategy Signals

**Files:**
- Modify: `src/strategy/seed.ts`

- [ ] **Step 1: Update earnings_drift_v1 signals to use richer fields**

The `earnings_drift_v1` strategy currently uses generic `news_sentiment` in its signal expressions. Update it to use the richer signal fields now available in the context.

In `src/strategy/seed.ts`, replace the signals for `earnings_drift_v1`:

```typescript
signals: JSON.stringify({
	entry_long:
		"earnings_surprise > 0.7 AND management_tone > 0.5 AND volume_ratio > 2.0",
	entry_short:
		"earnings_surprise > 0.7 AND management_tone < 0.3 AND volume_ratio > 2.0",
	exit: "hold_days >= 5 OR pnl_pct < -3 OR pnl_pct > 8",
}),
```

Also update the parameters to reflect the new fields:

```typescript
parameters: JSON.stringify({
	earnings_surprise_min: 0.7,
	tone_long_min: 0.5,
	tone_short_max: 0.3,
	hold_days: 5,
	position_size_pct: 8,
}),
```

- [ ] **Step 2: Verify seed test passes (if one exists) or run a quick sanity check**

```bash
bun test --preload ./tests/preload.ts tests/strategy/
```

Expected: All strategy tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/strategy/seed.ts
git commit -m "feat: update earnings_drift signals to use richer classifier fields"
```

---

### Task 7: Create Universe Management Module

**Files:**
- Create: `src/strategy/universe.ts`
- Create: `tests/strategy/universe.test.ts`

- [ ] **Step 1: Write failing tests for universe management**

Create `tests/strategy/universe.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("universe management", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("UNIVERSE_CAP is 50", async () => {
		const { UNIVERSE_CAP } = await import("../../src/strategy/universe.ts");
		expect(UNIVERSE_CAP).toBe(50);
	});

	test("MIN_AVG_VOLUME is 500000", async () => {
		const { MIN_AVG_VOLUME } = await import("../../src/strategy/universe.ts");
		expect(MIN_AVG_VOLUME).toBe(500_000);
	});

	test("validateUniverse caps at 50 symbols", async () => {
		const { validateUniverse, UNIVERSE_CAP } = await import(
			"../../src/strategy/universe.ts"
		);

		const symbols = Array.from({ length: 60 }, (_, i) => `SYM${i}`);
		const result = validateUniverse(symbols);
		expect(result).toHaveLength(UNIVERSE_CAP);
		// Keeps the first 50
		expect(result[0]).toBe("SYM0");
		expect(result[49]).toBe("SYM49");
	});

	test("validateUniverse deduplicates symbols", async () => {
		const { validateUniverse } = await import("../../src/strategy/universe.ts");

		const result = validateUniverse(["AAPL", "MSFT", "AAPL", "GOOGL", "MSFT"]);
		expect(result).toHaveLength(3);
		expect(result).toEqual(["AAPL", "MSFT", "GOOGL"]);
	});

	test("filterByLiquidity removes symbols below avg volume threshold", async () => {
		const { filterByLiquidity } = await import("../../src/strategy/universe.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		// Insert quotes with different avg volumes
		await db.insert(quotesCache).values([
			{ symbol: "AAPL", exchange: "NASDAQ", avgVolume: 1_000_000 },
			{ symbol: "TINY", exchange: "NASDAQ", avgVolume: 100_000 },
			{ symbol: "MSFT", exchange: "NASDAQ", avgVolume: 800_000 },
			{ symbol: "MICRO", exchange: "AIM", avgVolume: 50_000 },
		]);

		const result = await filterByLiquidity(
			["AAPL", "TINY", "MSFT", "MICRO"],
			"NASDAQ",
		);

		expect(result).toContain("AAPL");
		expect(result).toContain("MSFT");
		expect(result).not.toContain("TINY");
		expect(result).not.toContain("MICRO");
	});

	test("filterByLiquidity keeps symbols with no quote data (not yet fetched)", async () => {
		const { filterByLiquidity } = await import("../../src/strategy/universe.ts");

		const result = await filterByLiquidity(["UNKNOWN"], "NASDAQ");
		expect(result).toContain("UNKNOWN");
	});

	test("getInjectedSymbols returns empty when no high-urgency events", async () => {
		const { getInjectedSymbols } = await import("../../src/strategy/universe.ts");

		const result = await getInjectedSymbols();
		expect(result).toHaveLength(0);
	});

	test("injectSymbol adds a symbol with TTL", async () => {
		const { injectSymbol, getInjectedSymbols } = await import(
			"../../src/strategy/universe.ts"
		);

		injectSymbol("BREAKING", "NASDAQ", 60_000); // 60s TTL

		const result = await getInjectedSymbols();
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ symbol: "BREAKING", exchange: "NASDAQ" });
	});

	test("injectSymbol expires after TTL", async () => {
		const { injectSymbol, getInjectedSymbols, _expireInjections } = await import(
			"../../src/strategy/universe.ts"
		);

		// Inject with 0ms TTL (already expired)
		injectSymbol("OLD", "NASDAQ", 0);

		// Force expiry check
		_expireInjections();

		const result = await getInjectedSymbols();
		expect(result).toHaveLength(0);
	});

	test("buildEffectiveUniverse merges strategy universe with injected symbols and applies cap", async () => {
		const { buildEffectiveUniverse, injectSymbol, _clearInjections } = await import(
			"../../src/strategy/universe.ts"
		);

		_clearInjections();
		injectSymbol("BREAKING", "NYSE", 60_000);

		const base = ["AAPL", "MSFT", "GOOGL"];
		const result = await buildEffectiveUniverse(base);

		expect(result).toContain("AAPL");
		expect(result).toContain("MSFT");
		expect(result).toContain("GOOGL");
		expect(result).toContain("BREAKING:NYSE");
	});
});
```

- [ ] **Step 2: Verify tests fail**

```bash
bun test --preload ./tests/preload.ts tests/strategy/universe.test.ts
```

Expected: All tests fail (module does not exist).

- [ ] **Step 3: Implement universe.ts**

Create `src/strategy/universe.ts`:

```typescript
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "universe" });

export const UNIVERSE_CAP = 50;
export const MIN_AVG_VOLUME = 500_000;

/** Default TTL for injected symbols: 4 hours */
const DEFAULT_INJECTION_TTL_MS = 4 * 60 * 60 * 1000;

interface InjectedSymbol {
	symbol: string;
	exchange: string;
	expiresAt: number; // Date.now() + TTL
}

const injectedSymbols: InjectedSymbol[] = [];

/**
 * Validate and cap a universe array.
 * Deduplicates, then truncates to UNIVERSE_CAP.
 */
export function validateUniverse(symbols: string[]): string[] {
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const s of symbols) {
		if (!seen.has(s)) {
			seen.add(s);
			deduped.push(s);
		}
	}
	return deduped.slice(0, UNIVERSE_CAP);
}

/**
 * Filter symbols by minimum average daily volume.
 * Symbols with no quote data yet are kept (we haven't fetched them yet).
 */
export async function filterByLiquidity(
	symbols: string[],
	defaultExchange: string,
): Promise<string[]> {
	const db = getDb();

	const symbolNames = symbols.map((s) => (s.includes(":") ? s.split(":")[0]! : s));

	const rows = await db
		.select({
			symbol: quotesCache.symbol,
			avgVolume: quotesCache.avgVolume,
		})
		.from(quotesCache)
		.where(inArray(quotesCache.symbol, symbolNames));

	const volumeMap = new Map<string, number | null>();
	for (const row of rows) {
		volumeMap.set(row.symbol, row.avgVolume);
	}

	return symbols.filter((symbolSpec) => {
		const symbol = symbolSpec.includes(":") ? symbolSpec.split(":")[0]! : symbolSpec;
		const avgVol = volumeMap.get(symbol);

		// Keep symbols we haven't fetched data for yet
		if (avgVol === undefined || avgVol === null) return true;

		return avgVol >= MIN_AVG_VOLUME;
	});
}

/**
 * Inject a symbol into all strategy evaluations temporarily.
 * Used when the news bus detects a high-urgency event for an unknown symbol.
 */
export function injectSymbol(
	symbol: string,
	exchange: string,
	ttlMs: number = DEFAULT_INJECTION_TTL_MS,
): void {
	// Avoid duplicate injections
	const existing = injectedSymbols.find(
		(s) => s.symbol === symbol && s.exchange === exchange,
	);
	if (existing) {
		existing.expiresAt = Date.now() + ttlMs;
		return;
	}

	injectedSymbols.push({ symbol, exchange, expiresAt: Date.now() + ttlMs });
	log.info({ symbol, exchange, ttlMs }, "Symbol injected into universe");
}

/**
 * Get currently active injected symbols (not expired).
 */
export async function getInjectedSymbols(): Promise<
	Array<{ symbol: string; exchange: string }>
> {
	_expireInjections();
	return injectedSymbols.map(({ symbol, exchange }) => ({ symbol, exchange }));
}

/**
 * Build the effective universe for a strategy: base universe + injected symbols, capped.
 */
export async function buildEffectiveUniverse(baseUniverse: string[]): Promise<string[]> {
	const injected = await getInjectedSymbols();
	const injectedSpecs = injected.map(
		({ symbol, exchange }) => `${symbol}:${exchange}`,
	);

	// Merge: base universe first, then injected (dedup handled by validateUniverse)
	const merged = [...baseUniverse, ...injectedSpecs];
	return validateUniverse(merged);
}

/** Remove expired injections. Exported with _ prefix for testing only. */
export function _expireInjections(): void {
	const now = Date.now();
	let i = injectedSymbols.length;
	while (i--) {
		if (injectedSymbols[i]!.expiresAt <= now) {
			injectedSymbols.splice(i, 1);
		}
	}
}

/** Clear all injections. Exported with _ prefix for testing only. */
export function _clearInjections(): void {
	injectedSymbols.length = 0;
}
```

- [ ] **Step 4: Verify all universe tests pass**

```bash
bun test --preload ./tests/preload.ts tests/strategy/universe.test.ts
```

Expected: All 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/universe.ts tests/strategy/universe.test.ts
git commit -m "feat: add universe management with cap, liquidity filter, symbol injection"
```

---

### Task 8: Wire Universe Management into Evaluator

**Files:**
- Modify: `src/strategy/evaluator.ts`

- [ ] **Step 1: Import and apply universe management in evaluateAllStrategies**

In `src/strategy/evaluator.ts`, update the `evaluateAllStrategies` function to use `buildEffectiveUniverse` and `filterByLiquidity`:

Add imports:

```typescript
import { buildEffectiveUniverse, filterByLiquidity } from "./universe.ts";
```

Replace the universe-parsing and iteration block inside `evaluateAllStrategies`:

```typescript
export async function evaluateAllStrategies(
	getQuoteAndIndicators: (
		symbol: string,
		exchange: string,
	) => Promise<{ quote: QuoteFields; indicators: SymbolIndicators } | null>,
): Promise<void> {
	const db = getDb();

	const activeStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	log.info({ count: activeStrategies.length }, "Evaluating paper strategies");

	for (const strategy of activeStrategies) {
		if (!strategy.universe) continue;
		const rawUniverse: string[] = JSON.parse(strategy.universe);

		// Apply universe management: merge injections, cap at 50, filter liquidity
		const withInjections = await buildEffectiveUniverse(rawUniverse);
		const defaultExchange = "NASDAQ";
		const universe = await filterByLiquidity(withInjections, defaultExchange);

		for (const symbolSpec of universe) {
			const [symbol, exchange] = symbolSpec.includes(":")
				? symbolSpec.split(":")
				: [symbolSpec, "NASDAQ"];

			const data = await getQuoteAndIndicators(symbol!, exchange!);
			if (!data) continue;

			try {
				await evaluateStrategyForSymbol(strategy, symbol!, exchange!, data);
			} catch (error) {
				log.error({ strategy: strategy.name, symbol, error }, "Error evaluating strategy");
			}
		}
	}
}
```

- [ ] **Step 2: Verify evaluator tests still pass**

```bash
bun test --preload ./tests/preload.ts tests/strategy/
```

Expected: All strategy tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/strategy/evaluator.ts
git commit -m "feat: apply universe cap and liquidity filter in evaluator"
```

---

### Task 9: Wire Symbol Injection into News Ingest

**Files:**
- Modify: `src/news/ingest.ts`

- [ ] **Step 1: Add symbol injection on high-urgency tradeable events**

In `src/news/ingest.ts`, add the import:

```typescript
import { injectSymbol } from "../strategy/universe.ts";
```

After the `writeSentiment`/`writeSignals` block in the successful classification path, add:

```typescript
// Inject high-urgency symbols into all strategy universes temporarily
if (result.tradeable && result.urgency === "high") {
	for (const symbol of article.symbols) {
		injectSymbol(symbol, exchange);
	}
	log.info(
		{ symbols: article.symbols, urgency: result.urgency },
		"High-urgency symbols injected into universes",
	);
}
```

- [ ] **Step 2: Verify all news tests pass**

```bash
bun test --preload ./tests/preload.ts tests/news/
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/news/ingest.ts
git commit -m "feat: inject high-urgency news symbols into strategy universes"
```

---

### Task 10: Update Classifier Evals for Signal Fields

**Files:**
- Modify: `src/evals/classifier/tasks.ts`
- Modify: `src/evals/classifier/graders.ts`

- [ ] **Step 1: Add signal field reference to classifier eval tasks**

In `src/evals/classifier/tasks.ts`, update the `ClassifierReference` interface to include optional signal expectations:

```typescript
export interface ClassifierReference {
	tradeable: boolean;
	sentimentDirection: "positive" | "negative" | "neutral";
	sentimentMin: number;
	sentimentMax: number;
	expectedEventTypes: string[];
	expectedUrgency: "low" | "medium" | "high";
	/** Optional: expected signal field ranges for tradeable events */
	expectedSignals?: {
		earningsSurpriseMin?: number;
		managementToneMin?: number;
		catalystType?: string;
	};
}
```

Update the first task (`cls-001`, "Clear earnings beat") to include signal expectations:

```typescript
reference: {
	tradeable: true,
	sentimentDirection: "positive",
	sentimentMin: 0.5,
	sentimentMax: 1.0,
	expectedEventTypes: ["earnings_beat"],
	expectedUrgency: "high",
	expectedSignals: {
		earningsSurpriseMin: 0.5,
		managementToneMin: 0.3,
		catalystType: "fundamental",
	},
},
```

- [ ] **Step 2: Add signal shape grader**

In `src/evals/classifier/graders.ts`, add a new grader after the existing ones:

```typescript
export const signalShapeGrader: CG = {
	name: "signal-shape",
	type: "code",
	grade: async (output, reference) => {
		// Non-tradeable events don't need signals
		if (!reference.tradeable) {
			return { score: 1, pass: true, reason: "Non-tradeable, signals not required" };
		}

		if (!output.signals) {
			return { score: 0, pass: false, reason: "Tradeable event missing signals object" };
		}

		const s = output.signals;
		const checks = [
			typeof s.earningsSurprise === "number" && s.earningsSurprise >= 0 && s.earningsSurprise <= 1,
			typeof s.guidanceChange === "number" && s.guidanceChange >= 0 && s.guidanceChange <= 1,
			typeof s.managementTone === "number" && s.managementTone >= 0 && s.managementTone <= 1,
			typeof s.regulatoryRisk === "number" && s.regulatoryRisk >= 0 && s.regulatoryRisk <= 1,
			typeof s.acquisitionLikelihood === "number" &&
				s.acquisitionLikelihood >= 0 &&
				s.acquisitionLikelihood <= 1,
			typeof s.catalystType === "string" && s.catalystType.length > 0,
			typeof s.expectedMoveDuration === "string" && s.expectedMoveDuration.length > 0,
		];

		const passed = checks.filter(Boolean).length;
		const total = checks.length;
		const allPass = passed === total;

		return {
			score: passed / total,
			pass: allPass,
			reason: allPass
				? "All signal fields valid"
				: `${passed}/${total} signal fields valid`,
		};
	},
};

export const signalValueGrader: CG = {
	name: "signal-values",
	type: "code",
	grade: async (output, reference) => {
		if (!reference.expectedSignals || !output.signals) {
			return { score: 1, pass: true, reason: "No signal value expectations" };
		}

		const failures: string[] = [];
		const exp = reference.expectedSignals;
		const sig = output.signals;

		if (exp.earningsSurpriseMin !== undefined && sig.earningsSurprise < exp.earningsSurpriseMin) {
			failures.push(
				`earnings_surprise ${sig.earningsSurprise} < ${exp.earningsSurpriseMin}`,
			);
		}
		if (exp.managementToneMin !== undefined && sig.managementTone < exp.managementToneMin) {
			failures.push(
				`management_tone ${sig.managementTone} < ${exp.managementToneMin}`,
			);
		}
		if (exp.catalystType !== undefined && sig.catalystType !== exp.catalystType) {
			failures.push(
				`catalyst_type "${sig.catalystType}" != "${exp.catalystType}"`,
			);
		}

		const pass = failures.length === 0;
		return {
			score: pass ? 1 : 0,
			pass,
			reason: pass ? "Signal values match expectations" : failures.join("; "),
		};
	},
};
```

- [ ] **Step 3: Register new graders in the classifier eval suite**

In `src/evals/classifier/suite.ts`, import and add the new graders to the graders array:

```typescript
import { signalShapeGrader, signalValueGrader } from "./graders.ts";
```

Add them to the graders list alongside the existing ones.

- [ ] **Step 4: Verify evals still load without errors**

```bash
bun run src/evals/run.ts --suite classifier --dry-run 2>&1 | head -20
```

Expected: No import errors. (If `--dry-run` is not supported, just verify the file loads without syntax errors by importing it.)

- [ ] **Step 5: Commit**

```bash
git add src/evals/classifier/tasks.ts src/evals/classifier/graders.ts src/evals/classifier/suite.ts
git commit -m "evals: add signal shape and value graders for expanded classifier"
```

---

## Phase Complete Checklist

- [ ] `ClassificationResult` includes `signals: ClassificationSignals | null`
- [ ] `SYSTEM_PROMPT` requests all signal fields from the LLM
- [ ] `parseClassificationResponse` extracts, validates, and clamps signal values
- [ ] `quotes_cache` has columns: `news_earnings_surprise`, `news_guidance_change`, `news_management_tone`, `news_regulatory_risk`, `news_acquisition_likelihood`, `news_catalyst_type`, `news_expected_move_duration`
- [ ] `news_events` has columns: `earnings_surprise`, `guidance_change`, `management_tone`, `regulatory_risk`, `acquisition_likelihood`, `catalyst_type`, `expected_move_duration`
- [ ] Drizzle migration generated and applies cleanly
- [ ] `writeSignals()` writes all signal fields to `quotes_cache` in one upsert
- [ ] `storeNewsEvent()` persists signal fields to `news_events`
- [ ] `ingest.ts` passes signals through the full pipeline
- [ ] `ExprContext` exposes `earnings_surprise`, `guidance_change`, `management_tone`, `regulatory_risk`, `acquisition_likelihood` as numeric fields
- [ ] `earnings_drift_v1` signals updated to `earnings_surprise > 0.7 AND management_tone > 0.5`
- [ ] `validateUniverse()` deduplicates and caps at 50 symbols
- [ ] `filterByLiquidity()` removes symbols with avg volume < 500k
- [ ] `injectSymbol()` adds temporary symbols with TTL
- [ ] `buildEffectiveUniverse()` merges base + injected symbols
- [ ] `evaluateAllStrategies()` uses `buildEffectiveUniverse` and `filterByLiquidity`
- [ ] High-urgency news triggers `injectSymbol` in `ingest.ts`
- [ ] Classifier evals include `signalShapeGrader` and `signalValueGrader`
- [ ] All tests pass: `bun test --preload ./tests/preload.ts`
- [ ] Linter passes: `bunx biome check .`
- [ ] Type check passes: `tsc --noEmit`
