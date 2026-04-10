# News Signal Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace last-write-wins `quotes_cache.news_*` columns with a read-time aggregator that computes per-symbol confidence-weighted exponentially-decayed news signals from `news_analyses` and `news_events`.

**Architecture:** New pure-ish module `src/news/signal-aggregator.ts` exposes `getAggregatedNewsSignal(symbol, exchange, now?)`. It queries both `news_analyses` (for sentiment, per-symbol-exchange filtered) and `news_events` (for sub-signals like `earningsSurprise`, symbol-match only via JSON LIKE). Weights each row by `confidence × exp(-ageHours/2)` inside a 24h window, returns a weighted mean. Callers (`strategy-eval-job.ts`, `live/executor.ts`) switch from reading `quotes_cache.news_*` to calling the aggregator. Once wired, the legacy `writeSignals`/`writeSentiment` call sites in `src/news/ingest.ts` and `src/news/research-agent.ts` are deleted; the `quotes_cache.news_*` columns become dead weight and are dropped in a follow-up PR.

**Tech Stack:** Bun, TypeScript strict, Drizzle ORM + SQLite, Biome, `bun test`

**Canonical spec:** `docs/specs/2026-04-10-news-signal-aggregation.md`

---

## File Structure

**New files:**
- `src/news/signal-aggregator.ts` — pure aggregator module with `getAggregatedNewsSignal` + exported constants for testability
- `tests/news/signal-aggregator.test.ts` — unit tests, in-memory SQLite
- `drizzle/migrations/0009_news_signal_indices.sql` — two indexes

**Modified files:**
- `src/db/schema.ts` — add index definitions to `newsAnalyses` and `newsEvents` tables (match migration)
- `src/scheduler/strategy-eval-job.ts` — swap `cached.newsSentiment` etc. for `getAggregatedNewsSignal` call
- `src/live/executor.ts` — swap `null` news fields for `getAggregatedNewsSignal` call
- `src/news/ingest.ts` — remove `writeSignals`/`writeSentiment` calls
- `src/news/research-agent.ts` — remove `writeSignals` call
- `src/news/sentiment-writer.ts` — delete `writeSignals` and `writeSentiment` functions
- `tests/news/sentiment-writer.test.ts` — remove the four tests that exercise deleted functions

---

### Task 1: Migration adding news signal indices

**Files:**
- Create: `drizzle/migrations/0009_news_signal_indices.sql`
- Modify: `src/db/schema.ts` (lines ~308-311 and ~338-347)

- [ ] **Step 1: Write the migration SQL**

Create `drizzle/migrations/0009_news_signal_indices.sql`:

```sql
CREATE INDEX IF NOT EXISTS `news_analyses_symbol_exchange_created_idx` ON `news_analyses` (`symbol`, `exchange`, `created_at`);
CREATE INDEX IF NOT EXISTS `news_events_classified_at_idx` ON `news_events` (`classified_at`);
```

- [ ] **Step 2: Update schema.ts `newsEvents` table indexes**

In `src/db/schema.ts`, find the `newsEvents` table definition (starts around line 281). Replace the trailing `(table) => ({...})` block with:

```ts
	(table) => ({
		headlineIdx: index("news_events_headline_idx").on(table.headline),
		classifiedAtIdx: index("news_events_classified_at_idx").on(table.classifiedAt),
	}),
```

- [ ] **Step 3: Update schema.ts `newsAnalyses` table indexes**

In `src/db/schema.ts`, find the `newsAnalyses` table definition (starts around line 313). Replace the trailing `(table) => ({...})` block with:

```ts
	(table) => ({
		newsEventIdx: index("news_analyses_news_event_idx").on(table.newsEventId),
		symbolIdx: index("news_analyses_symbol_idx").on(table.symbol),
		inUniverseIdx: index("news_analyses_in_universe_idx").on(table.inUniverse),
		symbolExchangeCreatedIdx: index("news_analyses_symbol_exchange_created_idx").on(
			table.symbol,
			table.exchange,
			table.createdAt,
		),
		uniqueEventSymbol: uniqueIndex("news_analyses_event_symbol_uniq").on(
			table.newsEventId,
			table.symbol,
		),
	}),
```

- [ ] **Step 4: Run migrator against in-memory DB via existing tests**

Run: `bun test tests/news/sentiment-writer.test.ts --preload ./tests/preload.ts`
Expected: PASS. The test uses `migrate(...)` against a fresh `:memory:` DB, which will fail if the new migration SQL is syntactically broken.

- [ ] **Step 5: Three-check gate**

Run:
- `bunx tsc --noEmit`
- `bunx biome check src/ tests/ drizzle/`
- `bun test --preload ./tests/preload.ts`

Expected: tsc clean, biome clean, 573 pass / 2 fail (2 pre-existing broker test failures in `tests/broker/contracts.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add drizzle/migrations/0009_news_signal_indices.sql src/db/schema.ts
git commit -m "feat: add indices for read-time news signal aggregation"
```

---

### Task 2: Aggregator — sentiment from `news_analyses`

**Files:**
- Create: `src/news/signal-aggregator.ts`
- Create: `tests/news/signal-aggregator.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `tests/news/signal-aggregator.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { newsAnalyses, newsEvents } from "../../src/db/schema.ts";
import { getAggregatedNewsSignal } from "../../src/news/signal-aggregator.ts";

const NOW = new Date("2026-04-10T20:00:00.000Z");

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => {
	closeDb();
});

function minutesAgo(n: number): string {
	return new Date(NOW.getTime() - n * 60 * 1000).toISOString();
}

async function insertAnalysis(row: {
	symbol: string;
	exchange: string;
	sentiment: number;
	confidence: number;
	createdAt: string;
}): Promise<void> {
	const db = getDb();
	await db.insert(newsEvents).values({
		source: "test",
		headline: `test-${Math.random()}`,
		symbols: JSON.stringify([row.symbol]),
		sentiment: 0,
		confidence: 0,
		tradeable: true,
		eventType: "test",
		urgency: "low",
		classifiedAt: row.createdAt,
	});
	const [evt] = await db.select({ id: newsEvents.id }).from(newsEvents).orderBy(newsEvents.id);
	await db.insert(newsAnalyses).values({
		newsEventId: evt!.id,
		symbol: row.symbol,
		exchange: row.exchange,
		sentiment: row.sentiment,
		urgency: "low",
		eventType: "test",
		direction: "long",
		tradeThesis: "t",
		confidence: row.confidence,
		recommendTrade: false,
		inUniverse: true,
		createdAt: row.createdAt,
	});
}

describe("getAggregatedNewsSignal — sentiment", () => {
	test("returns all-null when no rows exist", async () => {
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.sentiment).toBeNull();
		expect(result.earningsSurprise).toBeNull();
		expect(result.catalystType).toBeNull();
	});

	test("single row returns its sentiment", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0.5,
			confidence: 0.8,
			createdAt: minutesAgo(0),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.sentiment).toBeCloseTo(0.5, 5);
	});

	test("confidence-weighted mean of two rows at same age", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 1,
			confidence: 0.9,
			createdAt: minutesAgo(0),
		});
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: -1,
			confidence: 0.3,
			createdAt: minutesAgo(0),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		// (1*0.9 + -1*0.3) / (0.9 + 0.3) = 0.6/1.2 = 0.5
		expect(result.sentiment).toBeCloseTo(0.5, 5);
	});

	test("exponential decay weights fresh rows more heavily than stale rows", async () => {
		// Fresh row: +1 at age 0 (decay weight = 1)
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 1,
			confidence: 1,
			createdAt: minutesAgo(0),
		});
		// Stale row: -1 at age 4h (2 half-lives, decay weight = 0.25)
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: -1,
			confidence: 1,
			createdAt: minutesAgo(240),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		// (1*1 + -1*0.25) / (1 + 0.25) = 0.75/1.25 = 0.6
		expect(result.sentiment).toBeCloseTo(0.6, 5);
	});

	test("excludes rows older than 24h window", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 1,
			confidence: 1,
			createdAt: minutesAgo(25 * 60), // 25h ago
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.sentiment).toBeNull();
	});

	test("filters by exchange", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 1,
			confidence: 1,
			createdAt: minutesAgo(0),
		});
		await insertAnalysis({
			symbol: "AZN",
			exchange: "NASDAQ",
			sentiment: -1,
			confidence: 1,
			createdAt: minutesAgo(0),
		});
		const lse = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(lse.sentiment).toBeCloseTo(1, 5);
	});
});
```

- [ ] **Step 2: Run tests — expect import failure**

Run: `bun test tests/news/signal-aggregator.test.ts --preload ./tests/preload.ts`
Expected: FAIL with `Cannot find module '../../src/news/signal-aggregator.ts'`

- [ ] **Step 3: Create the aggregator module**

Create `src/news/signal-aggregator.ts`:

```ts
import { and, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsAnalyses, newsEvents } from "../db/schema.ts";

export const HALF_LIFE_HOURS = 2;
export const WINDOW_HOURS = 24;

export interface AggregatedNewsSignal {
	sentiment: number | null;
	earningsSurprise: number | null;
	guidanceChange: number | null;
	managementTone: number | null;
	regulatoryRisk: number | null;
	acquisitionLikelihood: number | null;
	catalystType: string | null;
	expectedMoveDuration: string | null;
}

function ageHours(createdAt: string, now: Date): number {
	return (now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
}

function decayWeight(confidence: number, ageH: number): number {
	return confidence * Math.exp(-ageH / HALF_LIFE_HOURS);
}

export async function getAggregatedNewsSignal(
	symbol: string,
	exchange: string,
	now: Date = new Date(),
): Promise<AggregatedNewsSignal> {
	const db = getDb();
	const cutoff = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

	const analyses = await db
		.select({
			sentiment: newsAnalyses.sentiment,
			confidence: newsAnalyses.confidence,
			createdAt: newsAnalyses.createdAt,
		})
		.from(newsAnalyses)
		.where(
			and(
				eq(newsAnalyses.symbol, symbol),
				eq(newsAnalyses.exchange, exchange),
				gte(newsAnalyses.createdAt, cutoff),
			),
		);

	let sentimentNum = 0;
	let sentimentDen = 0;
	for (const row of analyses) {
		const w = decayWeight(row.confidence, ageHours(row.createdAt, now));
		sentimentNum += row.sentiment * w;
		sentimentDen += w;
	}

	return {
		sentiment: sentimentDen > 0 ? sentimentNum / sentimentDen : null,
		earningsSurprise: null,
		guidanceChange: null,
		managementTone: null,
		regulatoryRisk: null,
		acquisitionLikelihood: null,
		catalystType: null,
		expectedMoveDuration: null,
	};
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/news/signal-aggregator.test.ts --preload ./tests/preload.ts`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/news/signal-aggregator.ts tests/news/signal-aggregator.test.ts
git commit -m "feat: signal aggregator with decayed weighted sentiment"
```

---

### Task 3: Aggregator — sub-signals from `news_events`

**Files:**
- Modify: `src/news/signal-aggregator.ts`
- Modify: `tests/news/signal-aggregator.test.ts`

- [ ] **Step 1: Write failing tests for sub-signals**

Append to `tests/news/signal-aggregator.test.ts` (inside a new `describe` block):

```ts
async function insertEvent(row: {
	symbol: string;
	sentiment: number | null;
	confidence: number;
	classifiedAt: string;
	earningsSurprise?: number | null;
	guidanceChange?: number | null;
	managementTone?: number | null;
	regulatoryRisk?: number | null;
	acquisitionLikelihood?: number | null;
	catalystType?: string | null;
	expectedMoveDuration?: string | null;
}): Promise<void> {
	const db = getDb();
	await db.insert(newsEvents).values({
		source: "test",
		headline: `ev-${Math.random()}`,
		symbols: JSON.stringify([row.symbol]),
		sentiment: row.sentiment,
		confidence: row.confidence,
		tradeable: true,
		eventType: "test",
		urgency: "low",
		classifiedAt: row.classifiedAt,
		earningsSurprise: row.earningsSurprise ?? null,
		guidanceChange: row.guidanceChange ?? null,
		managementTone: row.managementTone ?? null,
		regulatoryRisk: row.regulatoryRisk ?? null,
		acquisitionLikelihood: row.acquisitionLikelihood ?? null,
		catalystType: row.catalystType ?? null,
		expectedMoveDuration: row.expectedMoveDuration ?? null,
	});
}

describe("getAggregatedNewsSignal — sub-signals", () => {
	test("returns weighted mean of earningsSurprise", async () => {
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.5,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.8,
		});
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.1,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.2,
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.earningsSurprise).toBeCloseTo(0.5, 5);
	});

	test("null sub-signal excluded from its own denominator", async () => {
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.5,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.8,
		});
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.5,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: null, // not treated as 0
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.earningsSurprise).toBeCloseTo(0.8, 5);
	});

	test("skips events where sentiment is null (classification failed)", async () => {
		await insertEvent({
			symbol: "AZN",
			sentiment: null,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.8,
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.earningsSurprise).toBeNull();
	});

	test("symbol matching uses JSON array membership (no prefix collision)", async () => {
		await insertEvent({
			symbol: "AZNL", // distinct ticker, should not match AZN query
			sentiment: 0.5,
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.8,
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.earningsSurprise).toBeNull();
	});

	test("news_events drives sub-signals, news_analyses drives sentiment (no crossover)", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0.7,
			confidence: 1,
			createdAt: minutesAgo(0),
		});
		await insertEvent({
			symbol: "AZN",
			sentiment: -0.3, // would corrupt sentiment if read from events
			confidence: 1,
			classifiedAt: minutesAgo(0),
			earningsSurprise: 0.4,
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.sentiment).toBeCloseTo(0.7, 5);
		expect(result.earningsSurprise).toBeCloseTo(0.4, 5);
	});
});
```

- [ ] **Step 2: Run tests — expect fail**

Run: `bun test tests/news/signal-aggregator.test.ts --preload ./tests/preload.ts`
Expected: 5 new tests fail (sub-signals all null in current implementation).

- [ ] **Step 3: Extend the aggregator to read `news_events`**

Replace the body of `getAggregatedNewsSignal` in `src/news/signal-aggregator.ts` with:

```ts
export async function getAggregatedNewsSignal(
	symbol: string,
	exchange: string,
	now: Date = new Date(),
): Promise<AggregatedNewsSignal> {
	const db = getDb();
	const cutoff = new Date(now.getTime() - WINDOW_HOURS * 60 * 60 * 1000).toISOString();

	const analyses = await db
		.select({
			sentiment: newsAnalyses.sentiment,
			confidence: newsAnalyses.confidence,
			createdAt: newsAnalyses.createdAt,
		})
		.from(newsAnalyses)
		.where(
			and(
				eq(newsAnalyses.symbol, symbol),
				eq(newsAnalyses.exchange, exchange),
				gte(newsAnalyses.createdAt, cutoff),
			),
		);

	let sentimentNum = 0;
	let sentimentDen = 0;
	for (const row of analyses) {
		const w = decayWeight(row.confidence, ageHours(row.createdAt, now));
		sentimentNum += row.sentiment * w;
		sentimentDen += w;
	}

	const events = await db
		.select({
			sentiment: newsEvents.sentiment,
			confidence: newsEvents.confidence,
			classifiedAt: newsEvents.classifiedAt,
			earningsSurprise: newsEvents.earningsSurprise,
			guidanceChange: newsEvents.guidanceChange,
			managementTone: newsEvents.managementTone,
			regulatoryRisk: newsEvents.regulatoryRisk,
			acquisitionLikelihood: newsEvents.acquisitionLikelihood,
			catalystType: newsEvents.catalystType,
			expectedMoveDuration: newsEvents.expectedMoveDuration,
		})
		.from(newsEvents)
		.where(
			and(
				sql`${newsEvents.symbols} LIKE ${`%"${symbol}"%`}`,
				gte(newsEvents.classifiedAt, cutoff),
			),
		);

	const subFields = [
		"earningsSurprise",
		"guidanceChange",
		"managementTone",
		"regulatoryRisk",
		"acquisitionLikelihood",
	] as const;
	type SubField = (typeof subFields)[number];
	const sub: Record<SubField, { num: number; den: number }> = {
		earningsSurprise: { num: 0, den: 0 },
		guidanceChange: { num: 0, den: 0 },
		managementTone: { num: 0, den: 0 },
		regulatoryRisk: { num: 0, den: 0 },
		acquisitionLikelihood: { num: 0, den: 0 },
	};

	for (const row of events) {
		if (row.sentiment == null || row.classifiedAt == null || row.confidence == null) continue;
		const w = decayWeight(row.confidence, ageHours(row.classifiedAt, now));
		for (const field of subFields) {
			const value = row[field];
			if (value != null) {
				sub[field].num += value * w;
				sub[field].den += w;
			}
		}
	}

	const mean = (field: SubField): number | null =>
		sub[field].den > 0 ? sub[field].num / sub[field].den : null;

	return {
		sentiment: sentimentDen > 0 ? sentimentNum / sentimentDen : null,
		earningsSurprise: mean("earningsSurprise"),
		guidanceChange: mean("guidanceChange"),
		managementTone: mean("managementTone"),
		regulatoryRisk: mean("regulatoryRisk"),
		acquisitionLikelihood: mean("acquisitionLikelihood"),
		catalystType: null,
		expectedMoveDuration: null,
	};
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/news/signal-aggregator.test.ts --preload ./tests/preload.ts`
Expected: 11 tests pass (6 from Task 2 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add src/news/signal-aggregator.ts tests/news/signal-aggregator.test.ts
git commit -m "feat: aggregate news_events sub-signals with null-safe denominators"
```

---

### Task 4: Aggregator — categorical fields + neutralised-pin edge case

**Files:**
- Modify: `src/news/signal-aggregator.ts`
- Modify: `tests/news/signal-aggregator.test.ts`

- [ ] **Step 1: Write failing tests for categoricals and neutralised pin**

Append to `tests/news/signal-aggregator.test.ts`:

```ts
describe("getAggregatedNewsSignal — categoricals and edge cases", () => {
	test("catalystType taken from the highest-weight row", async () => {
		// Older low-confidence row — loser
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.2,
			confidence: 0.4,
			classifiedAt: minutesAgo(120), // 1 half-life
			catalystType: "partnership",
		});
		// Fresh high-confidence row — winner
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.8,
			confidence: 0.9,
			classifiedAt: minutesAgo(0),
			catalystType: "earnings_beat",
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.catalystType).toBe("earnings_beat");
	});

	test("expectedMoveDuration taken from the highest-weight row", async () => {
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.2,
			confidence: 0.4,
			classifiedAt: minutesAgo(120),
			expectedMoveDuration: "1-2w",
		});
		await insertEvent({
			symbol: "AZN",
			sentiment: 0.8,
			confidence: 0.9,
			classifiedAt: minutesAgo(0),
			expectedMoveDuration: "1-3d",
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.expectedMoveDuration).toBe("1-3d");
	});

	test("categoricals null when no news_events rows exist", async () => {
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0.5,
			confidence: 0.8,
			createdAt: minutesAgo(0),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		expect(result.catalystType).toBeNull();
		expect(result.expectedMoveDuration).toBeNull();
	});

	test("neutralised filterAndPin row dampens but does not flip sentiment", async () => {
		// Real positive signal
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0.8,
			confidence: 0.9,
			createdAt: minutesAgo(0),
		});
		// Neutralised pin (what filterAndPin writes when LLM drops primary)
		await insertAnalysis({
			symbol: "AZN",
			exchange: "LSE",
			sentiment: 0,
			confidence: 0.5,
			createdAt: minutesAgo(0),
		});
		const result = await getAggregatedNewsSignal("AZN", "LSE", NOW);
		// (0.8*0.9 + 0*0.5) / (0.9 + 0.5) = 0.72/1.4 ≈ 0.514
		expect(result.sentiment).toBeCloseTo(0.514, 2);
		expect(result.sentiment!).toBeGreaterThan(0);
	});
});
```

- [ ] **Step 2: Run tests — expect fail**

Run: `bun test tests/news/signal-aggregator.test.ts --preload ./tests/preload.ts`
Expected: Categorical tests fail (still returning `null`). The neutralised pin test should already pass from Task 2 logic — verify in the output.

- [ ] **Step 3: Add categorical tie-break to the aggregator**

In `src/news/signal-aggregator.ts`, replace the event loop and return statement with:

```ts
	let topWeight = 0;
	let topCatalystType: string | null = null;
	let topExpectedMoveDuration: string | null = null;

	for (const row of events) {
		if (row.sentiment == null || row.classifiedAt == null || row.confidence == null) continue;
		const w = decayWeight(row.confidence, ageHours(row.classifiedAt, now));
		for (const field of subFields) {
			const value = row[field];
			if (value != null) {
				sub[field].num += value * w;
				sub[field].den += w;
			}
		}
		if (w > topWeight) {
			topWeight = w;
			topCatalystType = row.catalystType;
			topExpectedMoveDuration = row.expectedMoveDuration;
		}
	}

	const mean = (field: SubField): number | null =>
		sub[field].den > 0 ? sub[field].num / sub[field].den : null;

	return {
		sentiment: sentimentDen > 0 ? sentimentNum / sentimentDen : null,
		earningsSurprise: mean("earningsSurprise"),
		guidanceChange: mean("guidanceChange"),
		managementTone: mean("managementTone"),
		regulatoryRisk: mean("regulatoryRisk"),
		acquisitionLikelihood: mean("acquisitionLikelihood"),
		catalystType: topCatalystType,
		expectedMoveDuration: topExpectedMoveDuration,
	};
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test tests/news/signal-aggregator.test.ts --preload ./tests/preload.ts`
Expected: 15 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/news/signal-aggregator.ts tests/news/signal-aggregator.test.ts
git commit -m "feat: pick categoricals by highest-weight news_events row"
```

---

### Task 5: Wire aggregator into `strategy-eval-job.ts`

**Files:**
- Modify: `src/scheduler/strategy-eval-job.ts:36-51`

- [ ] **Step 1: Read the current call site**

Open `src/scheduler/strategy-eval-job.ts`. The `QuoteFields` construction currently reads `cached.newsSentiment`, `cached.newsEarningsSurprise`, etc. from `quotes_cache`. These are the fields to replace.

- [ ] **Step 2: Swap the reads for an aggregator call**

In `src/scheduler/strategy-eval-job.ts`, add the import at the top alongside the other imports:

```ts
import { getAggregatedNewsSignal } from "../news/signal-aggregator.ts";
```

Replace the `QuoteFields` construction block (the `const quote: QuoteFields = { ... };` assignment) with:

```ts
				const newsSignal = await getAggregatedNewsSignal(symbol, exchange);
				const quote: QuoteFields = {
					last: cached.last,
					bid: cached.bid,
					ask: cached.ask,
					volume: cached.volume,
					avgVolume: cached.avgVolume,
					changePercent: cached.changePercent,
					newsSentiment: newsSignal.sentiment,
					newsEarningsSurprise: newsSignal.earningsSurprise,
					newsGuidanceChange: newsSignal.guidanceChange,
					newsManagementTone: newsSignal.managementTone,
					newsRegulatoryRisk: newsSignal.regulatoryRisk,
					newsAcquisitionLikelihood: newsSignal.acquisitionLikelihood,
					newsCatalystType: newsSignal.catalystType,
					newsExpectedMoveDuration: newsSignal.expectedMoveDuration,
				};
```

- [ ] **Step 3: Three-check gate**

Run:
- `bunx tsc --noEmit`
- `bunx biome check src/ tests/`
- `bun test --preload ./tests/preload.ts`

Expected: tsc clean, biome clean, tests at 573 pass / 2 fail baseline + the 15 new aggregator tests = 588 pass / 2 fail. No test regressions.

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/strategy-eval-job.ts
git commit -m "feat: strategy eval reads aggregated news signal"
```

---

### Task 6: Wire aggregator into `live/executor.ts`

**Files:**
- Modify: `src/live/executor.ts:435-450`

- [ ] **Step 1: Make `evaluateSignal` async and take symbol/exchange**

In `src/live/executor.ts`, the `evaluateSignal` function currently takes `quote` but not the symbol or exchange — it also sets all `news*` fields to `null`. We need the symbol and exchange in scope to call the aggregator, and `evaluateSignal` must become `async` because the aggregator is async.

Add the import at the top:

```ts
import { getAggregatedNewsSignal } from "../news/signal-aggregator.ts";
```

Replace the `evaluateSignal` function signature and body with:

```ts
async function evaluateSignal(
	symbol: string,
	exchange: string,
	signal: string,
	_parameters: Record<string, unknown>,
	quote: {
		last: number | null;
		bid: number | null;
		ask: number | null;
		changePercent: number | null;
	},
	indicators: SymbolIndicators,
	position?: { entryPrice: number; openedAt: string; quantity: number },
): Promise<boolean> {
	const newsSignal = await getAggregatedNewsSignal(symbol, exchange);
	const fullQuote: QuoteFields = {
		last: quote.last,
		bid: quote.bid,
		ask: quote.ask,
		volume: null,
		avgVolume: null,
		changePercent: quote.changePercent,
		newsSentiment: newsSignal.sentiment,
		newsEarningsSurprise: newsSignal.earningsSurprise,
		newsGuidanceChange: newsSignal.guidanceChange,
		newsManagementTone: newsSignal.managementTone,
		newsRegulatoryRisk: newsSignal.regulatoryRisk,
		newsAcquisitionLikelihood: newsSignal.acquisitionLikelihood,
		newsCatalystType: newsSignal.catalystType,
		newsExpectedMoveDuration: newsSignal.expectedMoveDuration,
	};
	const posFields: PositionFields | null = position
		? { entryPrice: position.entryPrice, openedAt: position.openedAt, quantity: position.quantity }
		: null;
	const ctx = buildSignalContext({ quote: fullQuote, indicators, position: posFields });
	return evalExpr(signal, ctx);
}
```

- [ ] **Step 2: Update all `evaluateSignal` call sites**

Run: `grep -n "evaluateSignal(" src/live/executor.ts`

For each call, add `symbol` and `exchange` as the first two arguments and `await` the call. The call sites will have a `symbol` and `exchange` in the surrounding scope (look for the nearest loop or function that iterates positions/signals). Example transformation:

Before:
```ts
if (evaluateSignal(strategy.entrySignal, params, quote, indicators)) {
```

After:
```ts
if (await evaluateSignal(symbol, exchange, strategy.entrySignal, params, quote, indicators)) {
```

If the enclosing function is not already `async`, add `async` to its declaration.

- [ ] **Step 3: Three-check gate**

Run:
- `bunx tsc --noEmit`
- `bunx biome check src/ tests/`
- `bun test --preload ./tests/preload.ts`

Expected: tsc clean, biome clean, no new test failures beyond the 2 pre-existing broker tests. If `tsc` complains about missing `await` on an `evaluateSignal` call, you missed a call site in step 2.

- [ ] **Step 4: Commit**

```bash
git add src/live/executor.ts
git commit -m "feat: live executor reads aggregated news signal"
```

---

### Task 7: Remove writer call sites from `ingest.ts` and `research-agent.ts`

**Files:**
- Modify: `src/news/ingest.ts` (the `writeSignals`/`writeSentiment` block in the symbol loop)
- Modify: `src/news/research-agent.ts` (the `writeSignals` call inside the analysis loop)

- [ ] **Step 1: Remove the writer block in `ingest.ts`**

Open `src/news/ingest.ts`. Find the block that looks like:

```ts
	// Write signals or sentiment to quote cache for each symbol
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

Delete the entire block. Also remove `writeSignals` and `writeSentiment` from the import line at the top — leave only `storeNewsEvent` from that module.

- [ ] **Step 2: Remove the writer block in `research-agent.ts`**

Open `src/news/research-agent.ts`. Find the block (inside the `if (isValidTicker) { ... }` branch of the analyses loop):

```ts
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
```

Delete the block. Remove `writeSignals` from the import line at the top of the file (the `import { writeSignals } from "./sentiment-writer.ts";` line goes away entirely).

- [ ] **Step 3: Three-check gate**

Run:
- `bunx tsc --noEmit`
- `bunx biome check src/ tests/`
- `bun test --preload ./tests/preload.ts`

Expected: tsc clean, biome clean, no new test failures.

- [ ] **Step 4: Commit**

```bash
git add src/news/ingest.ts src/news/research-agent.ts
git commit -m "refactor: stop writing news signals to quotes_cache"
```

---

### Task 8: Delete `writeSignals`/`writeSentiment` functions and prune tests

**Files:**
- Modify: `src/news/sentiment-writer.ts`
- Modify: `tests/news/sentiment-writer.test.ts`

- [ ] **Step 1: Delete the two functions from `sentiment-writer.ts`**

In `src/news/sentiment-writer.ts`, delete:
- The `writeSentiment` function (roughly lines 14-29)
- The `SignalWriteInput` interface (roughly lines 31-40)
- The `writeSignals` function (roughly lines 47-83)

Also remove any imports that become unused as a result (e.g. `ClassificationSignals` stays because `storeNewsEvent` still needs it; `quotesCache` is no longer used after the deletions, remove it from the Drizzle import list — keep `newsEvents` and `eq`).

After edits, the file should contain only the `storeNewsEvent` function, its imports, and `NewsEventInput`.

- [ ] **Step 2: Delete the four obsolete tests**

In `tests/news/sentiment-writer.test.ts`, delete:
- `test("writes sentiment to existing quote cache row", ...)` (~line 21)
- `test("creates quote cache row if missing", ...)` (~line 44)
- `test("writeSignals writes all signal fields to quote cache", ...)` (~line 85)
- `test("writeSignals creates cache row if missing", ...)` (~line 123)

Keep the `storeNewsEvent` tests. If any `describe` block becomes empty as a result, delete it too. If the test file's imports reference `writeSignals` or `writeSentiment` only, remove those references.

- [ ] **Step 3: Three-check gate**

Run:
- `bunx tsc --noEmit`
- `bunx biome check src/ tests/`
- `bun test --preload ./tests/preload.ts`

Expected: tsc clean, biome clean, test count drops by 4 from the prior baseline, no new failures.

- [ ] **Step 4: Commit**

```bash
git add src/news/sentiment-writer.ts tests/news/sentiment-writer.test.ts
git commit -m "refactor: delete unused writeSignals and writeSentiment"
```

---

### Task 9: Final verification and PR

**Files:** none

- [ ] **Step 1: Run the full three-check gate**

Run:
- `bunx tsc --noEmit`
- `bunx biome check src/ tests/ drizzle/`
- `bun test --preload ./tests/preload.ts`

Expected:
- tsc clean
- biome clean
- Tests: `573 - 4 (deleted) + 15 (new) = 584 pass`, 2 fail (pre-existing broker failures). Verify the 2 failures are `tests/broker/contracts.test.ts` and nothing else.

- [ ] **Step 2: Sanity-check the signal path with a one-off script**

Run this inline in `bun` against the production DB (read-only):

```bash
./scripts/vps-ssh.sh 'cd /opt/trader-v2 && bun -e "
import { getAggregatedNewsSignal } from \"./src/news/signal-aggregator.ts\";
const r = await getAggregatedNewsSignal(\"AZN\", \"LSE\");
console.log(JSON.stringify(r, null, 2));
"'
```

Expected: a finite weighted sentiment (not null, not NaN), and `catalystType` populated if any events exist. If sentiment is null the window is quiet — run again with `SHEL` or `BP.` to confirm the code path works.

Note: this step requires the branch to already be on the VPS. If it isn't yet, skip it and do the check manually post-merge.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feature/news-signal-aggregation
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --title "Read-time aggregation of news signals (fix race)" --body "$(cat <<'EOF'
## Summary

Fixes a signal-correctness race where multiple headlines landing within seconds for the same symbol would each call \`writeSignals\` on \`quotes_cache\`, and strategies would read whichever HTTP response arrived last. Replaces the writer path with a read-time aggregator over \`news_analyses\` (sentiment, per-symbol-exchange) and \`news_events\` (sub-signals, symbol-only) using confidence-weighted exponential decay with a 2h half-life and 24h window.

Caller changes:
- \`src/scheduler/strategy-eval-job.ts\` reads via \`getAggregatedNewsSignal\` instead of \`quotes_cache.news_*\`
- \`src/live/executor.ts\` same
- \`src/news/ingest.ts\` and \`src/news/research-agent.ts\` no longer write to \`quotes_cache\` news columns
- \`writeSignals\` and \`writeSentiment\` are deleted entirely

Legacy \`quotes_cache.news_*\` columns are left in place for this PR — they are dead weight now and get dropped in a follow-up PR (keeps the migration reversible).

## Evidence

- 15 new unit tests in \`tests/news/signal-aggregator.test.ts\` cover empty/single/weighted-mean/decay/window/exchange/null-safe sub-signals/symbol prefix collision/categorical tie-break/neutralised-pin
- Three-check gate clean (tsc, biome, tests)
- Spec: \`docs/specs/2026-04-10-news-signal-aggregation.md\`

## Test plan

- [ ] Watch a news burst for an active LSE symbol post-deploy and confirm strategy-eval logs show a stable weighted sentiment
- [ ] Spot-check one symbol via a one-off script against the VPS DB
- [ ] Confirm no references to \`writeSignals\` or \`writeSentiment\` remain in the codebase

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review complete

**Spec coverage:** every spec requirement maps to a task —
- Aggregation rule → Tasks 2, 3, 4
- API surface (`AggregatedNewsSignal`, `getAggregatedNewsSignal`) → Task 2
- DB indices → Task 1
- `context.ts` / `strategy-eval-job.ts` switch → Task 5
- `live/executor.ts` switch → Task 6 (extension of spec — spec mentioned only `context.ts` but the live path has a parallel call site that also needs the change)
- Writer removal → Tasks 7, 8
- Unit tests (10 spec cases) → 15 tests across Tasks 2-4, covering every spec case

**Type consistency:** `AggregatedNewsSignal` fields are consistent across all tasks. `getAggregatedNewsSignal` signature identical everywhere. `HALF_LIFE_HOURS` and `WINDOW_HOURS` exported from one place.

**No placeholders:** every step has exact code or exact commands.
