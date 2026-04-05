# Phase 3: News Event Bus — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a news ingestion pipeline that polls financial headlines, filters and classifies them with Claude Haiku, and writes sentiment scores into the quote cache so strategy signals can react to news events.

**Architecture:** Finnhub REST API polls company news for all symbols in the strategy universe every 10 minutes. Headlines pass through a keyword pre-filter (~80% rejected), then Claude Haiku classifies survivors with sentiment/tradeability scores. Classified sentiment is written to `quotes_cache.news_sentiment` where the existing strategy evaluator already reads it. A separate nightly job syncs the earnings calendar from Finnhub.

**Tech Stack:** Bun, TypeScript, Finnhub REST API (free tier, 60 calls/min), `@anthropic-ai/sdk` (already installed), `fast-xml-parser` (for RSS fallback), Drizzle ORM, `bun:sqlite`

**Depends on:** Phase 2 Paper Lab (complete). All code lives in `~/Documents/Projects/trader-v2`.

---

## File Structure

```
src/
├── news/
│   ├── finnhub.ts           # Finnhub REST client: fetch company news
│   ├── rss.ts               # Yahoo Finance RSS poller (fallback/supplement)
│   ├── pre-filter.ts        # Keyword gate: pass/block headlines
│   ├── classifier.ts        # Haiku classification: sentiment, tradeability
│   ├── sentiment-writer.ts  # Write sentiment to quotes_cache
│   └── ingest.ts            # Orchestrator: poll → filter → classify → write
├── scheduler/
│   ├── news-poll-job.ts     # News polling job implementation
│   ├── earnings-sync-job.ts # Earnings calendar sync job implementation
│   ├── jobs.ts              # (modify) Wire up news_poll + earnings_calendar_sync
│   └── cron.ts              # (modify) Add news poll + earnings sync schedules
├── config.ts                # (modify) Add optional RSS_ENABLED flag
tests/
├── news/
│   ├── pre-filter.test.ts
│   ├── classifier.test.ts
│   ├── sentiment-writer.test.ts
│   └── ingest.test.ts
```

---

### Task 1: Keyword Pre-Filter

**Files:**
- Create: `src/news/pre-filter.ts`
- Create: `tests/news/pre-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/news/pre-filter.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("keyword pre-filter", () => {
	test("passes headlines with tradeable keywords", async () => {
		const { shouldClassify } = await import("../../src/news/pre-filter.ts");

		expect(shouldClassify("Apple beats earnings estimates with record Q4 revenue")).toBe(true);
		expect(shouldClassify("FDA approves Pfizer's new cancer treatment")).toBe(true);
		expect(shouldClassify("Microsoft announces $60B stock buyback program")).toBe(true);
		expect(shouldClassify("BP issues profit warning ahead of quarterly results")).toBe(true);
		expect(shouldClassify("Tesla to acquire robotics startup for $2.1B")).toBe(true);
	});

	test("blocks routine/noise headlines", async () => {
		const { shouldClassify } = await import("../../src/news/pre-filter.ts");

		expect(shouldClassify("Analyst reiterates Buy rating on Apple")).toBe(false);
		expect(shouldClassify("Company appoints new board member")).toBe(false);
		expect(shouldClassify("Annual ESG report published")).toBe(false);
		expect(shouldClassify("Routine filing submitted to SEC")).toBe(false);
	});

	test("passes headlines with no matching keywords (defaults to classify)", async () => {
		const { shouldClassify } = await import("../../src/news/pre-filter.ts");

		// Ambiguous headlines should pass through to Haiku for classification
		expect(shouldClassify("Major development at Apple headquarters")).toBe(true);
	});

	test("is case-insensitive", async () => {
		const { shouldClassify } = await import("../../src/news/pre-filter.ts");

		expect(shouldClassify("APPLE BEATS EARNINGS ESTIMATES")).toBe(true);
		expect(shouldClassify("analyst REITERATES buy rating")).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/news/pre-filter.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/news/pre-filter.ts`:

```typescript
// Keyword pre-filter gate: eliminates ~80% of headlines before Haiku classification.
// Logic: if headline matches a BLOCK pattern, reject. Otherwise accept.
// This is intentionally permissive — better to classify a few extra headlines
// than miss a tradeable event. Haiku calls are ~$0.0001 each.

const BLOCK_PATTERNS = [
	/\banalyst\s+reiterates?\b/i,
	/\broutine\s+filing\b/i,
	/\bboard\s+(appointment|member|director)\b/i,
	/\bESG\s+report\b/i,
	/\bannual\s+(general\s+)?meeting\b/i,
	/\bcorporate\s+governance\b/i,
	/\bshareholder\s+letter\b/i,
	/\bno\s+material\s+change\b/i,
];

/**
 * Returns true if the headline should be sent to Haiku for classification.
 * Returns false if the headline is routine noise that can be skipped.
 */
export function shouldClassify(headline: string): boolean {
	for (const pattern of BLOCK_PATTERNS) {
		if (pattern.test(headline)) return false;
	}
	return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/news/pre-filter.test.ts
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/news/pre-filter.ts tests/news/pre-filter.test.ts
git commit -m "feat: add keyword pre-filter for news headlines"
```

---

### Task 2: Haiku Classifier

**Files:**
- Create: `src/news/classifier.ts`
- Create: `tests/news/classifier.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/news/classifier.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("news classifier", () => {
	test("buildClassificationPrompt returns valid prompt", async () => {
		const { buildClassificationPrompt } = await import("../../src/news/classifier.ts");

		const prompt = buildClassificationPrompt("Apple beats Q4 earnings estimates", "AAPL");
		expect(prompt).toContain("Apple beats Q4 earnings estimates");
		expect(prompt).toContain("AAPL");
		expect(prompt).toContain("JSON");
	});

	test("parseClassificationResponse extracts valid result", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		const response = JSON.stringify({
			tradeable: true,
			sentiment: 0.8,
			confidence: 0.9,
			event_type: "earnings_beat",
			urgency: "high",
		});

		const result = parseClassificationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.tradeable).toBe(true);
		expect(result!.sentiment).toBeCloseTo(0.8);
		expect(result!.confidence).toBeCloseTo(0.9);
		expect(result!.eventType).toBe("earnings_beat");
		expect(result!.urgency).toBe("high");
	});

	test("parseClassificationResponse returns null for invalid JSON", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		expect(parseClassificationResponse("not json")).toBeNull();
		expect(parseClassificationResponse('{"tradeable": "maybe"}')).toBeNull();
	});

	test("parseClassificationResponse clamps sentiment to [-1, 1]", async () => {
		const { parseClassificationResponse } = await import("../../src/news/classifier.ts");

		const response = JSON.stringify({
			tradeable: true,
			sentiment: 5.0,
			confidence: 0.5,
			event_type: "other",
			urgency: "low",
		});

		const result = parseClassificationResponse(response);
		expect(result).not.toBeNull();
		expect(result!.sentiment).toBe(1.0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/news/classifier.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/news/classifier.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.ts";
import { canAffordCall } from "../utils/budget.ts";
import { recordUsage } from "../utils/token-tracker.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "news-classifier" });

const SYSTEM_PROMPT = `You are a financial news classifier for an automated trading system.
Analyze the headline and return a JSON object with these fields:
- tradeable: boolean — true if this news could materially move the stock price
- sentiment: number — from -1.0 (very bearish) to 1.0 (very bullish), 0 = neutral
- confidence: number — from 0.0 to 1.0, how confident you are in the classification
- event_type: string — one of: earnings_beat, earnings_miss, guidance_raise, guidance_lower, fda_approval, fda_rejection, acquisition, merger, buyback, dividend, profit_warning, upgrade, downgrade, legal, restructuring, other
- urgency: string — one of: low, medium, high

Return ONLY the JSON object, no other text.`;

export interface ClassificationResult {
	tradeable: boolean;
	sentiment: number;
	confidence: number;
	eventType: string;
	urgency: "low" | "medium" | "high";
}

export function buildClassificationPrompt(headline: string, symbol: string): string {
	return `Classify this financial headline for ticker ${symbol}:\n\n"${headline}"\n\nReturn JSON only.`;
}

export function parseClassificationResponse(text: string): ClassificationResult | null {
	try {
		// Extract JSON from response (handle markdown code blocks)
		const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
		const parsed = JSON.parse(jsonStr);

		if (typeof parsed.tradeable !== "boolean") return null;
		if (typeof parsed.sentiment !== "number") return null;
		if (typeof parsed.confidence !== "number") return null;
		if (typeof parsed.event_type !== "string") return null;
		if (typeof parsed.urgency !== "string") return null;

		const validUrgency = ["low", "medium", "high"];
		if (!validUrgency.includes(parsed.urgency)) return null;

		return {
			tradeable: parsed.tradeable,
			sentiment: Math.max(-1, Math.min(1, parsed.sentiment)),
			confidence: Math.max(0, Math.min(1, parsed.confidence)),
			eventType: parsed.event_type,
			urgency: parsed.urgency as "low" | "medium" | "high",
		};
	} catch {
		return null;
	}
}

export async function classifyHeadline(
	headline: string,
	symbol: string,
): Promise<ClassificationResult | null> {
	const config = getConfig();

	const estimatedCost = 0.0002; // ~200 input + 50 output tokens at Haiku rates
	if (!(await canAffordCall(estimatedCost))) {
		log.warn("Skipping classification — daily budget exceeded");
		return null;
	}

	try {
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const userMessage = buildClassificationPrompt(headline, symbol);

		const response = await client.messages.create({
			model: config.CLAUDE_MODEL_FAST,
			max_tokens: 150,
			system: SYSTEM_PROMPT,
			messages: [{ role: "user", content: userMessage }],
		});

		const text =
			response.content[0]?.type === "text" ? response.content[0].text : "";

		await recordUsage(
			"news_classification",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

		const result = parseClassificationResponse(text);
		if (!result) {
			log.warn({ headline, response: text }, "Failed to parse classification response");
		}
		return result;
	} catch (error) {
		log.error({ headline, error }, "Classification API call failed");
		return null;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/news/classifier.test.ts
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/news/classifier.ts tests/news/classifier.test.ts
git commit -m "feat: add Haiku news classifier with prompt builder and response parser"
```

---

### Task 3: Finnhub News Client

**Files:**
- Create: `src/news/finnhub.ts`
- Create: `tests/news/finnhub.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/news/finnhub.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("finnhub news client", () => {
	test("parseFinnhubArticle extracts required fields", async () => {
		const { parseFinnhubArticle } = await import("../../src/news/finnhub.ts");

		const raw = {
			category: "company",
			datetime: 1711987200,
			headline: "Apple Reports Q1 Earnings Beat",
			id: 12345,
			image: "https://example.com/image.jpg",
			related: "AAPL",
			source: "Reuters",
			summary: "Apple Inc reported better than expected...",
			url: "https://example.com/article",
		};

		const article = parseFinnhubArticle(raw);
		expect(article).not.toBeNull();
		expect(article!.headline).toBe("Apple Reports Q1 Earnings Beat");
		expect(article!.symbols).toEqual(["AAPL"]);
		expect(article!.url).toBe("https://example.com/article");
		expect(article!.source).toBe("finnhub");
		expect(article!.publishedAt).toBeInstanceOf(Date);
	});

	test("parseFinnhubArticle handles multiple related symbols", async () => {
		const { parseFinnhubArticle } = await import("../../src/news/finnhub.ts");

		const raw = {
			category: "company",
			datetime: 1711987200,
			headline: "Merger announced",
			id: 12346,
			image: "",
			related: "AAPL,MSFT,GOOG",
			source: "CNBC",
			summary: "",
			url: "https://example.com",
		};

		const article = parseFinnhubArticle(raw);
		expect(article!.symbols).toEqual(["AAPL", "MSFT", "GOOG"]);
	});

	test("parseFinnhubArticle returns null for missing headline", async () => {
		const { parseFinnhubArticle } = await import("../../src/news/finnhub.ts");

		const raw = { datetime: 1711987200, related: "AAPL" };
		expect(parseFinnhubArticle(raw)).toBeNull();
	});

	test("buildFinnhubUrl constructs correct URL", async () => {
		const { buildFinnhubUrl } = await import("../../src/news/finnhub.ts");

		const url = buildFinnhubUrl("AAPL", "test-key");
		expect(url).toContain("finnhub.io");
		expect(url).toContain("symbol=AAPL");
		expect(url).toContain("token=test-key");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/news/finnhub.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/news/finnhub.ts`:

```typescript
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";

const log = createChildLogger({ module: "finnhub" });

export interface NewsArticle {
	headline: string;
	symbols: string[];
	url: string | null;
	source: string;
	publishedAt: Date;
	finnhubId: number | null;
}

export function buildFinnhubUrl(symbol: string, apiKey: string): string {
	const now = new Date();
	const from = new Date(now.getTime() - 24 * 60 * 60 * 1000); // last 24h
	const fromStr = from.toISOString().split("T")[0];
	const toStr = now.toISOString().split("T")[0];
	return `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromStr}&to=${toStr}&token=${apiKey}`;
}

export function parseFinnhubArticle(raw: Record<string, unknown>): NewsArticle | null {
	const headline = raw.headline;
	if (typeof headline !== "string" || headline.length === 0) return null;

	const related = typeof raw.related === "string" ? raw.related : "";
	const symbols = related
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	const datetime = typeof raw.datetime === "number" ? raw.datetime : 0;

	return {
		headline,
		symbols,
		url: typeof raw.url === "string" ? raw.url : null,
		source: "finnhub",
		publishedAt: new Date(datetime * 1000),
		finnhubId: typeof raw.id === "number" ? raw.id : null,
	};
}

/**
 * Fetch recent news articles for a symbol from Finnhub.
 * Returns parsed articles, deduped by headline.
 */
export async function fetchCompanyNews(
	symbol: string,
	apiKey: string,
): Promise<NewsArticle[]> {
	const url = buildFinnhubUrl(symbol, apiKey);

	const response = await withRetry(
		async () => {
			const res = await fetch(url);
			if (res.status === 429) throw new Error("Finnhub rate limited");
			if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
			return res;
		},
		`finnhub-news-${symbol}`,
		{ maxAttempts: 2, baseDelayMs: 2000 },
	);

	const data: unknown[] = await response.json();

	if (!Array.isArray(data)) {
		log.warn({ symbol }, "Finnhub returned non-array response");
		return [];
	}

	const articles: NewsArticle[] = [];
	for (const item of data) {
		if (typeof item !== "object" || item === null) continue;
		const article = parseFinnhubArticle(item as Record<string, unknown>);
		if (article) articles.push(article);
	}

	return articles;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/news/finnhub.test.ts
```

Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/news/finnhub.ts tests/news/finnhub.test.ts
git commit -m "feat: add Finnhub company news REST client"
```

---

### Task 4: Sentiment Writer

**Files:**
- Create: `src/news/sentiment-writer.ts`
- Create: `tests/news/sentiment-writer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/news/sentiment-writer.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

describe("sentiment writer", () => {
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

	test("writes sentiment to existing quote cache row", async () => {
		const { writeSentiment } = await import("../../src/news/sentiment-writer.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		// Insert a quote first
		await db.insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 150,
		});

		await writeSentiment("AAPL", "NASDAQ", 0.8);

		const [row] = await db
			.select()
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, "AAPL"), eq(quotesCache.exchange, "NASDAQ")));

		expect(row).not.toBeUndefined();
		expect(row!.newsSentiment).toBeCloseTo(0.8);
		expect(row!.last).toBe(150); // price unchanged
	});

	test("creates quote cache row if missing", async () => {
		const { writeSentiment } = await import("../../src/news/sentiment-writer.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await writeSentiment("NEW", "NASDAQ", -0.5);

		const [row] = await db
			.select()
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, "NEW"), eq(quotesCache.exchange, "NASDAQ")));

		expect(row).not.toBeUndefined();
		expect(row!.newsSentiment).toBeCloseTo(-0.5);
		expect(row!.last).toBeNull();
	});

	test("stores news event in news_events table", async () => {
		const { storeNewsEvent } = await import("../../src/news/sentiment-writer.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		await storeNewsEvent({
			source: "finnhub",
			headline: "Apple beats earnings",
			url: "https://example.com",
			symbols: ["AAPL"],
			sentiment: 0.8,
			confidence: 0.9,
			tradeable: true,
			eventType: "earnings_beat",
			urgency: "high" as const,
		});

		const rows = await db.select().from(newsEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.headline).toBe("Apple beats earnings");
		expect(rows[0]!.tradeable).toBe(true);
		expect(rows[0]!.sentiment).toBeCloseTo(0.8);
		expect(rows[0]!.classifiedAt).not.toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/news/sentiment-writer.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/news/sentiment-writer.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsEvents, quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "sentiment-writer" });

/**
 * Update the news_sentiment column in quotes_cache for a symbol.
 * Creates the cache row if it doesn't exist.
 * Does NOT overwrite price data.
 */
export async function writeSentiment(
	symbol: string,
	exchange: string,
	sentiment: number,
): Promise<void> {
	const db = getDb();
	const existing = await db
		.select()
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, symbol), eq(quotesCache.exchange, exchange)))
		.limit(1);

	if (existing.length > 0) {
		await db
			.update(quotesCache)
			.set({ newsSentiment: sentiment, updatedAt: new Date().toISOString() })
			.where(and(eq(quotesCache.symbol, symbol), eq(quotesCache.exchange, exchange)));
	} else {
		await db.insert(quotesCache).values({
			symbol,
			exchange,
			newsSentiment: sentiment,
		});
	}

	log.debug({ symbol, exchange, sentiment }, "Sentiment written to cache");
}

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
		classifiedAt: input.sentiment != null ? new Date().toISOString() : null,
	});
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/news/sentiment-writer.test.ts
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/news/sentiment-writer.ts tests/news/sentiment-writer.test.ts
git commit -m "feat: add sentiment writer for quotes cache and news events storage"
```

---

### Task 5: News Ingest Orchestrator

**Files:**
- Create: `src/news/ingest.ts`
- Create: `tests/news/ingest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/news/ingest.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("news ingest orchestrator", () => {
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

	test("processArticle stores event and writes sentiment for classified headline", async () => {
		const { processArticle } = await import("../../src/news/ingest.ts");
		const { newsEvents, quotesCache } = await import("../../src/db/schema.ts");
		const { and, eq } = await import("drizzle-orm");

		// Mock: provide a fake classifier that returns a canned result
		const result = await processArticle(
			{
				headline: "Apple beats earnings estimates",
				symbols: ["AAPL"],
				url: "https://example.com",
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: 123,
			},
			"NASDAQ",
			async () => ({
				tradeable: true,
				sentiment: 0.8,
				confidence: 0.9,
				eventType: "earnings_beat",
				urgency: "high" as const,
			}),
		);

		expect(result).toBe("classified");

		const events = await db.select().from(newsEvents);
		expect(events).toHaveLength(1);
		expect(events[0]!.tradeable).toBe(true);

		const [quote] = await db
			.select()
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, "AAPL"), eq(quotesCache.exchange, "NASDAQ")));
		expect(quote!.newsSentiment).toBeCloseTo(0.8);
	});

	test("processArticle skips blocked headlines", async () => {
		const { processArticle } = await import("../../src/news/ingest.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		const result = await processArticle(
			{
				headline: "Analyst reiterates Buy rating on Apple",
				symbols: ["AAPL"],
				url: null,
				source: "finnhub",
				publishedAt: new Date(),
				finnhubId: 456,
			},
			"NASDAQ",
			async () => null, // should not be called
		);

		expect(result).toBe("filtered");

		// Filtered headlines are still stored but without classification
		const events = await db.select().from(newsEvents);
		expect(events).toHaveLength(1);
		expect(events[0]!.classifiedAt).toBeNull();
	});

	test("deduplicates headlines already in news_events", async () => {
		const { processArticle, isHeadlineSeen } = await import("../../src/news/ingest.ts");
		const { newsEvents } = await import("../../src/db/schema.ts");

		// Insert existing headline
		await db.insert(newsEvents).values({
			source: "finnhub",
			headline: "Apple beats earnings estimates",
			symbols: JSON.stringify(["AAPL"]),
		});

		const seen = await isHeadlineSeen("Apple beats earnings estimates");
		expect(seen).toBe(true);

		const notSeen = await isHeadlineSeen("Brand new headline");
		expect(notSeen).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/news/ingest.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/news/ingest.ts`:

```typescript
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { newsEvents } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { ClassificationResult } from "./classifier.ts";
import type { NewsArticle } from "./finnhub.ts";
import { shouldClassify } from "./pre-filter.ts";
import { storeNewsEvent, writeSentiment } from "./sentiment-writer.ts";

const log = createChildLogger({ module: "news-ingest" });

type ClassifyFn = (
	headline: string,
	symbol: string,
) => Promise<ClassificationResult | null>;

/**
 * Check if a headline has already been ingested (dedup by exact headline match).
 */
export async function isHeadlineSeen(headline: string): Promise<boolean> {
	const db = getDb();
	const [existing] = await db
		.select({ id: newsEvents.id })
		.from(newsEvents)
		.where(eq(newsEvents.headline, headline))
		.limit(1);
	return existing != null;
}

/**
 * Process a single news article through the pipeline:
 * dedup → pre-filter → classify → store → write sentiment
 *
 * Returns: "duplicate" | "filtered" | "classified" | "failed"
 */
export async function processArticle(
	article: NewsArticle,
	exchange: string,
	classify: ClassifyFn,
): Promise<"duplicate" | "filtered" | "classified" | "failed"> {
	// Check pre-filter
	if (!shouldClassify(article.headline)) {
		// Store unclassified for record-keeping
		await storeNewsEvent({
			source: article.source,
			headline: article.headline,
			url: article.url,
			symbols: article.symbols,
			sentiment: null,
			confidence: null,
			tradeable: null,
			eventType: null,
			urgency: null,
		});
		return "filtered";
	}

	// Classify with Haiku
	const primarySymbol = article.symbols[0];
	if (!primarySymbol) return "failed";

	const result = await classify(article.headline, primarySymbol);
	if (!result) {
		await storeNewsEvent({
			source: article.source,
			headline: article.headline,
			url: article.url,
			symbols: article.symbols,
			sentiment: null,
			confidence: null,
			tradeable: null,
			eventType: null,
			urgency: null,
		});
		return "failed";
	}

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
	});

	// Write sentiment to quote cache for each symbol
	for (const symbol of article.symbols) {
		await writeSentiment(symbol, exchange, result.sentiment);
	}

	log.info(
		{
			headline: article.headline.slice(0, 60),
			symbols: article.symbols,
			sentiment: result.sentiment,
			tradeable: result.tradeable,
			urgency: result.urgency,
		},
		"News classified",
	);

	return "classified";
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/news/ingest.test.ts
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/news/ingest.ts tests/news/ingest.test.ts
git commit -m "feat: add news ingest orchestrator with dedup, filter, classify pipeline"
```

---

### Task 6: News Poll Job + Earnings Sync Job

**Files:**
- Create: `src/scheduler/news-poll-job.ts`
- Create: `src/scheduler/earnings-sync-job.ts`

- [ ] **Step 1: Create `src/scheduler/news-poll-job.ts`**

```typescript
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { getConfig } from "../config.ts";
import { classifyHeadline } from "../news/classifier.ts";
import { fetchCompanyNews } from "../news/finnhub.ts";
import { isHeadlineSeen, processArticle } from "../news/ingest.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "news-poll-job" });

/**
 * Collect all unique symbols from paper strategy universes.
 */
async function getWatchlistSymbols(): Promise<Array<{ symbol: string; exchange: string }>> {
	const db = getDb();
	const paperStrategies = await db
		.select({ universe: strategies.universe })
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	const seen = new Set<string>();
	const result: Array<{ symbol: string; exchange: string }> = [];

	for (const strat of paperStrategies) {
		if (!strat.universe) continue;
		const universe: string[] = JSON.parse(strat.universe);
		for (const spec of universe) {
			const [symbol, exchange] = spec.includes(":") ? spec.split(":") : [spec, "NASDAQ"];
			const key = `${symbol}:${exchange}`;
			if (!seen.has(key)) {
				seen.add(key);
				result.push({ symbol: symbol!, exchange: exchange! });
			}
		}
	}

	return result;
}

/**
 * Map exchange to Finnhub symbol format.
 * Finnhub uses plain symbols for US, and SYMBOL.L for LSE/AIM.
 */
function finnhubSymbol(symbol: string, exchange: string): string {
	if (exchange === "LSE" || exchange === "AIM") return `${symbol}.L`;
	return symbol;
}

export async function runNewsPoll(): Promise<void> {
	const config = getConfig();
	if (!config.FINNHUB_API_KEY) {
		log.warn("FINNHUB_API_KEY not set — skipping news poll");
		return;
	}

	const watchlist = await getWatchlistSymbols();
	if (watchlist.length === 0) {
		log.debug("No symbols in watchlist — skipping news poll");
		return;
	}

	let totalArticles = 0;
	let classified = 0;
	let filtered = 0;
	let duplicates = 0;

	for (const { symbol, exchange } of watchlist) {
		const fhSymbol = finnhubSymbol(symbol, exchange);
		const articles = await fetchCompanyNews(fhSymbol, config.FINNHUB_API_KEY);

		for (const article of articles) {
			// Ensure symbol mapping back from Finnhub format
			if (article.symbols.length === 0) {
				article.symbols = [symbol];
			}

			const seen = await isHeadlineSeen(article.headline);
			if (seen) {
				duplicates++;
				continue;
			}

			totalArticles++;
			const result = await processArticle(article, exchange, classifyHeadline);
			if (result === "classified") classified++;
			if (result === "filtered") filtered++;
		}

		// Respect Finnhub rate limit: 60 calls/min
		await Bun.sleep(1100);
	}

	log.info(
		{ symbols: watchlist.length, totalArticles, classified, filtered, duplicates },
		"News poll complete",
	);
}
```

- [ ] **Step 2: Create `src/scheduler/earnings-sync-job.ts`**

```typescript
import { getDb } from "../db/client.ts";
import { earningsCalendar } from "../db/schema.ts";
import { getConfig } from "../config.ts";
import { withRetry } from "../utils/retry.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "earnings-sync" });

interface FinnhubEarning {
	date: string;
	epsActual: number | null;
	epsEstimate: number | null;
	hour: string;
	quarter: number;
	revenueActual: number | null;
	revenueEstimate: number | null;
	symbol: string;
	year: number;
}

export async function runEarningsSync(): Promise<void> {
	const config = getConfig();
	if (!config.FINNHUB_API_KEY) {
		log.warn("FINNHUB_API_KEY not set — skipping earnings sync");
		return;
	}

	const from = new Date();
	const to = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000); // next 2 weeks
	const fromStr = from.toISOString().split("T")[0];
	const toStr = to.toISOString().split("T")[0];

	const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromStr}&to=${toStr}&token=${config.FINNHUB_API_KEY}`;

	try {
		const response = await withRetry(
			async () => {
				const res = await fetch(url);
				if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
				return res;
			},
			"earnings-sync",
			{ maxAttempts: 2 },
		);

		const data = await response.json();
		const earnings: FinnhubEarning[] = data?.earningsCalendar ?? [];

		const db = getDb();
		let inserted = 0;

		for (const earning of earnings) {
			if (!earning.symbol || !earning.date) continue;

			// Upsert: skip if already exists for this symbol+date
			const existing = await db
				.select({ id: earningsCalendar.id })
				.from(earningsCalendar)
				.where(
					// Simple dedup by symbol + date
					sql`${earningsCalendar.symbol} = ${earning.symbol} AND ${earningsCalendar.date} = ${earning.date}`,
				)
				.limit(1);

			if (existing.length === 0) {
				await db.insert(earningsCalendar).values({
					symbol: earning.symbol,
					exchange: "NASDAQ", // Finnhub calendar is primarily US
					date: earning.date,
					estimatedEps: earning.epsEstimate,
					source: "finnhub",
				});
				inserted++;
			}
		}

		log.info({ total: earnings.length, inserted }, "Earnings calendar synced");
	} catch (error) {
		log.error({ error }, "Earnings sync failed");
	}
}
```

Note: this file uses `sql` template literal — add the import:

```typescript
import { sql } from "drizzle-orm";
```

Add it to the existing imports at the top of the file (after `import { getDb }`).

- [ ] **Step 3: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 4: Run lint and fix**

```bash
bun run lint:fix
bun run lint
```

Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/news-poll-job.ts src/scheduler/earnings-sync-job.ts
git commit -m "feat: add news poll and earnings sync job implementations"
```

---

### Task 7: Scheduler Wiring

**Files:**
- Modify: `src/scheduler/jobs.ts` — add `news_poll` to JobName, wire up jobs
- Modify: `src/scheduler/cron.ts` — add news poll and earnings sync schedules

- [ ] **Step 1: Update `src/scheduler/jobs.ts`**

Add `"news_poll"` to the `JobName` union type:

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
	| "heartbeat";
```

In the `executeJob` switch, replace the `earnings_calendar_sync` stub and add the `news_poll` case:

```typescript
case "news_poll": {
	const { runNewsPoll } = await import("./news-poll-job.ts");
	await runNewsPoll();
	break;
}

case "earnings_calendar_sync": {
	const { runEarningsSync } = await import("./earnings-sync-job.ts");
	await runEarningsSync();
	break;
}
```

Keep remaining stubs (`weekly_digest`, `strategy_evolution`, `trade_review`, `pattern_analysis`) as-is.

- [ ] **Step 2: Update `src/scheduler/cron.ts`**

Add these schedules inside `startScheduler()` before the log statement:

```typescript
// News poll every 10 minutes during market hours, offset to :02 to avoid collision
tasks.push(
	cron.schedule("2,12,22,32,42,52 8-20 * * 1-5", () => runJob("news_poll"), {
		timezone: "Europe/London",
	}),
);

// Earnings calendar sync at 06:00 weekdays (before market open)
tasks.push(
	cron.schedule("0 6 * * 1-5", () => runJob("earnings_calendar_sync"), {
		timezone: "Europe/London",
	}),
);
```

- [ ] **Step 3: Verify typecheck and tests**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
```

Expected: all pass

- [ ] **Step 4: Run lint and fix**

```bash
bun run lint:fix
bun run lint
```

Expected: clean

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/jobs.ts src/scheduler/cron.ts
git commit -m "feat: wire up news poll and earnings sync to scheduler"
```

---

### Task 8: Add FINNHUB_API_KEY to VPS .env

**Files:**
- Modify: `deploy/setup.sh` — add FINNHUB_API_KEY to .env template

- [ ] **Step 1: Update `deploy/setup.sh`**

Add `FINNHUB_API_KEY=` to the .env template in the setup script, after the `DAILY_API_BUDGET_USD` line:

```bash
FINNHUB_API_KEY=
```

- [ ] **Step 2: Commit**

```bash
git add deploy/setup.sh
git commit -m "docs: add FINNHUB_API_KEY to deploy setup template"
```

Note: after deployment, you'll need to SSH into the VPS and add your Finnhub API key to `/opt/trader-v2/.env`. Get a free key at https://finnhub.io/register.

---

## Phase 3 Complete Checklist

After all tasks, verify:

- [ ] `bun test --preload ./tests/preload.ts` — all tests pass
- [ ] `bun run typecheck` — no errors
- [ ] `bun run lint` — no errors
- [ ] Pre-filter correctly blocks routine headlines and passes tradeable ones
- [ ] Classifier prompt produces valid JSON responses from Haiku
- [ ] Sentiment scores flow: Finnhub → news_events → quotes_cache.news_sentiment
- [ ] Strategy evaluator reads news_sentiment from quote context (already wired by Phase 2)
- [ ] Earnings calendar syncs from Finnhub free tier
- [ ] Budget tracking prevents classification calls when daily limit exceeded

## What's Next

**Phase 4: Live Executor** — IBKR connection via `@stoqey/ib`, real order placement, position guardian, stop-loss enforcement. This is where graduated strategies trade with real capital.

**Phase 5: Evolution** — Strategy mutation, parameter tweaking, new variant generation. The `strategy_mutations` table is ready but unused.
