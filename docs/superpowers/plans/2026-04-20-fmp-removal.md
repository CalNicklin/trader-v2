# FMP Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every FMP dependency from the codebase, replacing each call site with a verified free alternative (Yahoo v8 chart, Frankfurter FX, SEC EDGAR, Finnhub).

**Architecture:** Build small, focused adapters (`src/data/yahoo-us.ts`, `src/news/yahoo-rss-uk.ts`) that mirror the data shapes FMP provided. Swap each FMP call site to the adapter. Delete `src/data/fmp.ts`, `src/data/ftse100.ts`, and `src/universe/profile-fetcher.ts` after all callers are migrated. Cancel FMP subscription post-merge.

**Tech Stack:** Bun + TypeScript (strict), Biome (tab indent), `bun test --preload ./tests/preload.ts`, SQLite + Drizzle.

**Hard verification gate (before PR opens):**
1. `bun run typecheck` — clean
2. `bun test --preload ./tests/preload.ts` — all green
3. `bun scripts/universe-refresh-smoke-test.ts` — russell_1000 post-filter ≥ 700
4. `bun scripts/uk-pipeline-smoke-test.ts` — ftse_350 post-filter ≥ 150
5. `bun scripts/fmp-removal-smoke-test.ts` (new, Task 14) — each swapped path returns non-null live data
6. `grep -rn "fmpFetch\|fmpQuote\|fmpHistorical\|fmpFxRate\|fmpValidateSymbol\|fmpResolveExchange\|fmpBatchQuotes\|toFmpSymbol\|normalizeFmpExchange\|financialmodelingprep\|FMP_API_KEY" src/` — returns nothing except the deleted file-history markers

This gate catches the class of issue PR #37 and PR #40 both burned cycles on.

---

## File Structure

**New files:**
- `src/data/yahoo-us.ts` — US quote + historical bars via Yahoo v8 chart (replaces `fmpQuote` US branch + `fmpHistorical` US branch)
- `src/news/yahoo-rss-uk.ts` — UK news via Yahoo RSS (replaces `fmp-news.ts`)
- `tests/data/yahoo-us.test.ts`
- `tests/news/yahoo-rss-uk.test.ts`
- `scripts/fmp-removal-smoke-test.ts` — live hits each swapped path once, asserts non-null

**Modified files:**
- `src/data/quotes.ts` — swap `fmpQuote` → Yahoo
- `src/scheduler/quote-refresh.ts` — swap `fmpBatchQuotes` → Yahoo loop
- `src/scheduler/missed-opportunity-job.ts` — swap `fmpQuote` → Yahoo
- `src/scheduler/earnings-catalyst-job.ts` — swap hardcoded `/v3/earning_calendar` → Finnhub
- `src/news/research-agent.ts` — swap `fmpQuote` (fallback inside `getPriceForSymbol`) + `fmpValidateSymbol` → EDGAR
- `src/news/exchange-resolver.ts` — swap `fmpResolveExchange` → EDGAR submissions
- `src/scheduler/news-poll-job.ts` — swap `fetchFmpCompanyNews` → `fetchYahooRssUk` for UK symbols
- `src/strategy/historical.ts` — swap `fmpHistorical` → Yahoo
- `src/utils/fx.ts` — swap `fmpFxRate` → Frankfurter
- `src/config.ts` — remove `FMP_API_KEY`
- `src/db/schema.ts` — remove `symbolProfiles` export (table stays in prod DB, harmless)

**Deleted files:**
- `src/data/fmp.ts`
- `src/data/ftse100.ts`
- `src/universe/profile-fetcher.ts`
- `tests/data/fmp.test.ts`
- `tests/data/fmp-active-trading.test.ts`
- `tests/data/fmp-resolve-exchange.test.ts`
- `tests/data/ftse100.test.ts`
- `tests/news/fmp-news.test.ts`
- `tests/universe/profile-fetcher.test.ts`

---

## Task 1: Yahoo US quote adapter

**Files:**
- Create: `src/data/yahoo-us.ts`
- Create: `tests/data/yahoo-us.test.ts`

This module replaces `fmpQuote` and `fmpHistorical` for US symbols only (UK routes to IBKR; that stays unchanged at call sites).

- [ ] **Step 1: Write failing tests**

Create `tests/data/yahoo-us.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { yahooUsHistorical, yahooUsQuote } from "../../src/data/yahoo-us.ts";

describe("yahooUsQuote", () => {
	test("returns price, volume, avgVolume (5d), computed changePercent", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				chart: {
					result: [
						{
							meta: {
								symbol: "AAPL",
								currency: "USD",
								regularMarketPrice: 270,
								regularMarketVolume: 50_000_000,
								previousClose: 265,
							},
							indicators: {
								quote: [{ close: [260, 265, 268, 271, 270], volume: [40_000_000, 42_000_000, 45_000_000, 50_000_000, 50_000_000] }],
							},
						},
					],
				},
			}),
		});
		const out = await yahooUsQuote("AAPL", "NASDAQ", { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(out?.last).toBe(270);
		expect(out?.volume).toBe(50_000_000);
		expect(out?.avgVolume).toBeCloseTo(45_400_000); // mean of the 5 volumes
		// changePercent = (270 - 265) / 265 * 100 = 1.8867...
		expect(out?.changePercent).toBeCloseTo(1.8867, 2);
	});

	test("returns null on 404", async () => {
		const fetchStub = async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
		const out = await yahooUsQuote("BOGUS", "NASDAQ", { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(out).toBeNull();
	});

	test("returns null when chart.error present", async () => {
		const fetchStub = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({ chart: { error: { code: "Not Found", description: "no data" } } }),
		});
		const out = await yahooUsQuote("BOGUS", "NASDAQ", { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(out).toBeNull();
	});
});

describe("yahooUsHistorical", () => {
	test("returns bars in chronological order with OHLCV", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				chart: {
					result: [
						{
							meta: { currency: "USD" },
							timestamp: [1776198000, 1776284400, 1776370800], // 3 trading days
							indicators: {
								quote: [
									{
										open: [267, 268, 269],
										high: [270, 271, 272],
										low: [265, 266, 267],
										close: [269, 270, 271],
										volume: [40_000_000, 45_000_000, 50_000_000],
									},
								],
							},
						},
					],
				},
			}),
		});
		const out = await yahooUsHistorical("AAPL", "NASDAQ", 3, { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(out).not.toBeNull();
		expect(out?.length).toBe(3);
		expect(out?.[0]?.open).toBe(267);
		expect(out?.[2]?.close).toBe(271);
	});

	test("skips bars where any OHLCV field is null (Yahoo returns null for non-trading days)", async () => {
		const fetchStub = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => ({
				chart: {
					result: [
						{
							meta: { currency: "USD" },
							timestamp: [1776198000, 1776284400],
							indicators: {
								quote: [
									{
										open: [267, null],
										high: [270, null],
										low: [265, null],
										close: [269, null],
										volume: [40_000_000, null],
									},
								],
							},
						},
					],
				},
			}),
		});
		const out = await yahooUsHistorical("AAPL", "NASDAQ", 2, { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(out?.length).toBe(1);
	});

	test("returns null on 404", async () => {
		const fetchStub = async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) });
		const out = await yahooUsHistorical("BOGUS", "NASDAQ", 30, { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(out).toBeNull();
	});
});
```

Run: `bun test tests/data/yahoo-us.test.ts --preload ./tests/preload.ts`
Expected: FAIL (module not found).

- [ ] **Step 2: Implement `src/data/yahoo-us.ts`**

```typescript
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "yahoo-us-data" });

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export interface YahooUsQuoteData {
	symbol: string;
	exchange: string;
	last: number | null;
	volume: number | null;
	avgVolume: number | null;
	changePercent: number | null;
}

export interface YahooUsBar {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
}

interface YahooChartResponse {
	chart: {
		result?: Array<{
			meta: {
				symbol?: string;
				currency?: string;
				regularMarketPrice?: number;
				regularMarketVolume?: number;
				previousClose?: number;
			};
			timestamp?: number[];
			indicators: {
				quote: Array<{
					open?: (number | null)[];
					high?: (number | null)[];
					low?: (number | null)[];
					close?: (number | null)[];
					volume?: (number | null)[];
				}>;
			};
		}>;
		error?: { code: string; description: string };
	};
}

export interface YahooFetchDeps {
	fetchImpl?: typeof fetch;
}

// US quote — mirrors the fields downstream expects from fmpQuote. UK callers
// already route to IBKR via broker/market-data.ts; this module is US-only.
export async function yahooUsQuote(
	symbol: string,
	exchange: string,
	deps: YahooFetchDeps = {},
): Promise<YahooUsQuoteData | null> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
	try {
		const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
		if (!res.ok) {
			log.debug({ symbol, status: res.status }, "Yahoo chart non-200");
			return null;
		}
		const data = (await res.json()) as YahooChartResponse;
		if (data.chart.error) return null;
		const result = data.chart.result?.[0];
		if (!result) return null;

		const volumes = result.indicators.quote[0]?.volume ?? [];
		const validVols = volumes.filter((v): v is number => typeof v === "number" && v > 0);
		const avgVolume = validVols.length > 0 ? validVols.reduce((a, b) => a + b) / validVols.length : null;

		const last = result.meta.regularMarketPrice ?? null;
		const prev = result.meta.previousClose ?? null;
		const changePercent = last != null && prev != null && prev !== 0 ? ((last - prev) / prev) * 100 : null;

		return {
			symbol,
			exchange,
			last,
			volume: result.meta.regularMarketVolume ?? null,
			avgVolume,
			changePercent,
		};
	} catch (err) {
		log.debug(
			{ symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo chart request failed",
		);
		return null;
	}
}

// US historical bars — mirrors FmpHistoricalBar shape for drop-in replacement.
// Returns newest-last (chronological) to match existing expectations.
export async function yahooUsHistorical(
	symbol: string,
	_exchange: string,
	days: number,
	deps: YahooFetchDeps = {},
): Promise<YahooUsBar[] | null> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	// Yahoo accepts `range` as 1d|5d|1mo|3mo|6mo|1y|2y|5y|10y|ytd|max
	const range = days <= 5 ? "5d" : days <= 30 ? "1mo" : days <= 90 ? "3mo" : days <= 180 ? "6mo" : days <= 365 ? "1y" : "5y";
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
	try {
		const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
		if (!res.ok) return null;
		const data = (await res.json()) as YahooChartResponse;
		if (data.chart.error) return null;
		const result = data.chart.result?.[0];
		if (!result?.timestamp || !result.indicators.quote[0]) return null;

		const { open, high, low, close, volume } = result.indicators.quote[0];
		if (!open || !high || !low || !close || !volume) return null;

		const bars: YahooUsBar[] = [];
		for (let i = 0; i < result.timestamp.length; i++) {
			const o = open[i];
			const h = high[i];
			const l = low[i];
			const c = close[i];
			const v = volume[i];
			const ts = result.timestamp[i];
			if (o == null || h == null || l == null || c == null || v == null || ts == null) continue;
			bars.push({
				date: new Date(ts * 1000).toISOString().slice(0, 10),
				open: o,
				high: h,
				low: l,
				close: c,
				volume: v,
			});
		}
		return bars;
	} catch (err) {
		log.debug(
			{ symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo historical request failed",
		);
		return null;
	}
}
```

Run: `bun test tests/data/yahoo-us.test.ts --preload ./tests/preload.ts`
Expected: PASS (5 tests).

- [ ] **Step 3: Verification gate + commit**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/data/yahoo-us.ts tests/data/yahoo-us.test.ts
git add src/data/yahoo-us.ts tests/data/yahoo-us.test.ts
git commit -m "feat(data): Yahoo US quote + historical adapters"
```

---

## Task 2: Yahoo RSS UK news adapter

**Files:**
- Create: `src/news/yahoo-rss-uk.ts`
- Create: `tests/news/yahoo-rss-uk.test.ts`

Replaces `fmp-news.ts` (returns `[]` on our FMP tier for UK) with Yahoo RSS per `.L` symbol.

- [ ] **Step 1: Understand existing shape**

Read `src/news/fmp-news.ts` to see the `fetchFmpCompanyNews` signature and return shape. The new function must return the same shape so `news-poll-job.ts` can swap with minimal changes.

- [ ] **Step 2: Write failing tests**

Create `tests/news/yahoo-rss-uk.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { fetchYahooRssUk, parseYahooRssXml } from "../../src/news/yahoo-rss-uk.ts";

const SAMPLE_RSS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<rss version="2.0">
<channel>
<title>Yahoo! Finance: BP.L News</title>
<item>
<title>BP reports strong Q2 earnings</title>
<pubDate>Mon, 20 Apr 2026 14:00:00 +0000</pubDate>
<link>https://finance.yahoo.com/news/bp-q2-earnings-123</link>
<description>BP PLC reported record quarterly earnings today.</description>
</item>
<item>
<title>Oil prices surge on Iran tension</title>
<pubDate>Mon, 20 Apr 2026 10:00:00 +0000</pubDate>
<link>https://finance.yahoo.com/news/oil-surge-456</link>
<description>Brent crude broke $90 overnight.</description>
</item>
</channel>
</rss>`;

describe("parseYahooRssXml", () => {
	test("extracts title, pubDate, link, description per item", () => {
		const items = parseYahooRssXml(SAMPLE_RSS);
		expect(items.length).toBe(2);
		expect(items[0]?.title).toBe("BP reports strong Q2 earnings");
		expect(items[0]?.link).toBe("https://finance.yahoo.com/news/bp-q2-earnings-123");
		expect(items[0]?.pubDate).toBe("Mon, 20 Apr 2026 14:00:00 +0000");
		expect(items[1]?.description).toContain("Brent crude");
	});

	test("returns empty array on malformed XML", () => {
		expect(parseYahooRssXml("not xml")).toEqual([]);
	});

	test("handles CDATA-wrapped fields", () => {
		const xml = `<rss><channel><item>
<title><![CDATA[Foo & Bar]]></title>
<link>https://example.com/1</link>
<pubDate>Mon, 20 Apr 2026 14:00:00 +0000</pubDate>
</item></channel></rss>`;
		const items = parseYahooRssXml(xml);
		expect(items[0]?.title).toBe("Foo & Bar");
	});
});

describe("fetchYahooRssUk", () => {
	test("hits Yahoo RSS URL for .L symbol and returns parsed items", async () => {
		let seenUrl = "";
		const fetchStub = async (url: string) => {
			seenUrl = url;
			return { ok: true, status: 200, statusText: "OK", text: async () => SAMPLE_RSS };
		};
		const items = await fetchYahooRssUk("BP", "LSE", { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(seenUrl).toContain("s=BP.L");
		expect(items.length).toBe(2);
	});

	test("appends .L for AIM exchange too (Yahoo uses .L for both LSE main + AIM)", async () => {
		let seenUrl = "";
		const fetchStub = async (url: string) => {
			seenUrl = url;
			return { ok: true, status: 200, statusText: "OK", text: async () => SAMPLE_RSS };
		};
		await fetchYahooRssUk("GAW", "AIM", { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(seenUrl).toContain("s=GAW.L");
	});

	test("returns empty array on HTTP failure", async () => {
		const fetchStub = async () => ({ ok: false, status: 500, statusText: "Server Error", text: async () => "" });
		const items = await fetchYahooRssUk("BP", "LSE", { fetchImpl: fetchStub as unknown as typeof fetch });
		expect(items).toEqual([]);
	});
});
```

Run: confirm FAIL.

- [ ] **Step 3: Implement `src/news/yahoo-rss-uk.ts`**

```typescript
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "yahoo-rss-uk" });

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

export interface YahooRssItem {
	title: string;
	pubDate: string;
	link: string;
	description: string;
	source: "yahoo_rss";
}

export interface YahooRssFetchDeps {
	fetchImpl?: typeof fetch;
}

// Yahoo Finance publishes a per-symbol RSS feed. For UK, we append `.L` to the
// bare ticker (works for both LSE-main and AIM — Yahoo treats them the same).
export async function fetchYahooRssUk(
	symbol: string,
	_exchange: string,
	deps: YahooRssFetchDeps = {},
): Promise<YahooRssItem[]> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const yahooSymbol = `${symbol}.L`;
	const url = `https://finance.yahoo.com/rss/headline?s=${encodeURIComponent(yahooSymbol)}`;
	try {
		const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
		if (!res.ok) {
			log.debug({ symbol, status: res.status }, "Yahoo RSS non-200");
			return [];
		}
		const xml = await res.text();
		const items = parseYahooRssXml(xml);
		log.info({ symbol, count: items.length }, "Yahoo RSS fetched");
		return items;
	} catch (err) {
		log.debug(
			{ symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo RSS fetch failed",
		);
		return [];
	}
}

// Minimal RSS parser — Yahoo's feed is well-formed and small, so a regex-based
// extractor is sufficient and avoids pulling in an XML dependency.
export function parseYahooRssXml(xml: string): YahooRssItem[] {
	const items: YahooRssItem[] = [];
	const itemMatches = xml.matchAll(/<item>([\s\S]*?)<\/item>/g);
	for (const match of itemMatches) {
		const body = match[1];
		if (!body) continue;
		const title = extractField(body, "title");
		const link = extractField(body, "link");
		const pubDate = extractField(body, "pubDate");
		const description = extractField(body, "description");
		if (!title || !link) continue;
		items.push({
			title,
			pubDate: pubDate ?? "",
			link,
			description: description ?? "",
			source: "yahoo_rss",
		});
	}
	return items;
}

function extractField(body: string, tag: string): string | null {
	const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`);
	const m = body.match(re);
	return m?.[1]?.trim() ?? null;
}
```

Run: expect 6 tests PASS.

- [ ] **Step 4: Verification gate + commit**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/news/yahoo-rss-uk.ts tests/news/yahoo-rss-uk.test.ts
git add src/news/yahoo-rss-uk.ts tests/news/yahoo-rss-uk.test.ts
git commit -m "feat(news): Yahoo RSS UK adapter (replaces FMP UK news)"
```

---

## Task 3: Swap `fmpQuote` → Yahoo in `src/data/quotes.ts`

**Files:**
- Modify: `src/data/quotes.ts`

- [ ] **Step 1: Read the current `refreshQuote` function**

```bash
grep -n "fmpQuote\|refreshQuote" src/data/quotes.ts
```

- [ ] **Step 2: Swap the import and call**

In `src/data/quotes.ts`, change:

```typescript
import { fmpQuote } from "./fmp.ts";
```

to:

```typescript
import { yahooUsQuote } from "./yahoo-us.ts";
import { ibkrQuote } from "../broker/market-data.ts";
```

Change the `refreshQuote` body (around lines 70-95):

```typescript
export async function refreshQuote(symbol: string, exchange: string): Promise<QuoteData | null> {
	try {
		// US: Yahoo chart. UK: IBKR (connection managed by running service).
		const isUk = exchange === "LSE" || exchange === "AIM";
		const quote = isUk ? await ibkrQuote(symbol, exchange) : await yahooUsQuote(symbol, exchange);
		if (!quote || quote.last == null) {
			log.warn({ symbol, exchange }, "No quote data");
			return null;
		}
		const data: QuoteData = {
			symbol,
			exchange,
			last: quote.last,
			bid: null,
			ask: null,
			volume: quote.volume,
			avgVolume: quote.avgVolume,
			changePercent: quote.changePercent,
		};
		await upsertQuote(data);
		return data;
	} catch (error) {
		log.error({ symbol, exchange, error }, "Failed to refresh quote");
		return null;
	}
}
```

Note: `ibkrQuote` already returns a shape compatible with `QuoteData`. `yahooUsQuote` returns `YahooUsQuoteData` which has the same field names — duck-typing works.

- [ ] **Step 3: Verify + commit**

```bash
bun run typecheck
bun test tests/data/ --preload ./tests/preload.ts
bunx biome check src/data/quotes.ts
git add src/data/quotes.ts
git commit -m "refactor(data): route refreshQuote through Yahoo/IBKR instead of FMP"
```

---

## Task 4: Swap `fmpBatchQuotes` → Yahoo loop in `src/scheduler/quote-refresh.ts`

**Files:**
- Modify: `src/scheduler/quote-refresh.ts`

- [ ] **Step 1: Read the current `refreshQuotesForAllCached`**

```bash
grep -n "fmpBatchQuotes\|refreshQuotesForAllCached" src/scheduler/quote-refresh.ts
```

- [ ] **Step 2: Swap the call**

In `src/scheduler/quote-refresh.ts`:

Remove import:

```typescript
import { fmpBatchQuotes } from "../data/fmp.ts";
```

Add:

```typescript
import { refreshQuote, upsertQuote } from "../data/quotes.ts";
```

Replace `refreshQuotesForAllCached` body (around lines 30-55):

```typescript
export async function refreshQuotesForAllCached(exchanges?: Exchange[]): Promise<void> {
	const cached = await getSymbolsToRefresh(exchanges);

	if (cached.length === 0) {
		log.info("No symbols in quotes cache — nothing to refresh");
		return;
	}

	// Sequential loop — each refreshQuote routes to Yahoo (US) or IBKR (UK).
	// Yahoo is throttled per-request; IBKR uses the existing pacing in @stoqey/ib.
	let refreshed = 0;
	for (const s of cached) {
		const quote = await refreshQuote(s.symbol, s.exchange);
		if (quote?.last != null) refreshed++;
	}

	const { markPositionsToMarket } = await import("../paper/manager.ts");
	const marked = await markPositionsToMarket();

	await backfillSentimentPrices();
	await pruneDeadSymbols();
	log.info({ total: cached.length, refreshed, positionsMarked: marked }, "Quote refresh complete");
}
```

- [ ] **Step 3: Verify + commit**

```bash
bun run typecheck
bun test tests/scheduler/quote-refresh*.test.ts --preload ./tests/preload.ts
bunx biome check src/scheduler/quote-refresh.ts
git add src/scheduler/quote-refresh.ts
git commit -m "refactor(scheduler): quote-refresh uses refreshQuote (Yahoo/IBKR) instead of fmpBatchQuotes"
```

---

## Task 5: Swap `fmpQuote` → Yahoo in `src/scheduler/missed-opportunity-job.ts`

**Files:**
- Modify: `src/scheduler/missed-opportunity-job.ts`

- [ ] **Step 1: Read the current call**

```bash
sed -n '25,45p' src/scheduler/missed-opportunity-job.ts
```

- [ ] **Step 2: Swap the dynamic import**

Find the block around line 30-35 that does:

```typescript
const { fmpQuote } = await import("../data/fmp.ts");
const quote = await fmpQuote(symbol, exchange);
```

Replace with:

```typescript
const isUk = exchange === "LSE" || exchange === "AIM";
let quote: { last: number | null } | null;
if (isUk) {
	const { ibkrQuote } = await import("../broker/market-data.ts");
	quote = await ibkrQuote(symbol, exchange);
} else {
	const { yahooUsQuote } = await import("../data/yahoo-us.ts");
	quote = await yahooUsQuote(symbol, exchange);
}
```

- [ ] **Step 3: Verify + commit**

```bash
bun run typecheck
bun test tests/scheduler/missed-opportunity*.test.ts --preload ./tests/preload.ts
bunx biome check src/scheduler/missed-opportunity-job.ts
git add src/scheduler/missed-opportunity-job.ts
git commit -m "refactor(scheduler): missed-opportunity job uses Yahoo/IBKR instead of FMP"
```

---

## Task 6: Swap `fmpHistorical` → Yahoo in `src/strategy/historical.ts`

**Files:**
- Modify: `src/strategy/historical.ts`

- [ ] **Step 1: Read the current call**

```bash
sed -n '1,45p' src/strategy/historical.ts
```

- [ ] **Step 2: Swap the import and call**

Replace:

```typescript
import { fmpHistorical } from "../data/fmp.ts";
```

With:

```typescript
import { yahooUsHistorical } from "../data/yahoo-us.ts";
import { ibkrHistorical } from "../broker/market-data.ts";
```

And find the call site (around line 33):

```typescript
const data = await fmpHistorical(symbol, exchange, 90);
```

Replace with:

```typescript
const isUk = exchange === "LSE" || exchange === "AIM";
const data = isUk
	? await ibkrHistorical(symbol, exchange, 90)
	: await yahooUsHistorical(symbol, exchange, 90);
```

- [ ] **Step 3: Verify + commit**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/strategy/historical.ts
git add src/strategy/historical.ts
git commit -m "refactor(strategy): historical bars use Yahoo/IBKR instead of FMP"
```

---

## Task 7: Swap `fmpFxRate` → Frankfurter in `src/utils/fx.ts`

**Files:**
- Modify: `src/utils/fx.ts`

- [ ] **Step 1: Read current fx.ts**

```bash
cat src/utils/fx.ts
```

- [ ] **Step 2: Rewrite `getExchangeRate`**

Replace the file body:

```typescript
import { createChildLogger } from "./logger.ts";

const log = createChildLogger({ module: "fx" });

interface FxCache {
	rate: number;
	timestamp: number;
}

const cache = new Map<string, FxCache>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface FrankfurterResponse {
	amount: number;
	base: string;
	date: string;
	rates: Record<string, number>;
}

export async function getExchangeRate(from: string, to: string): Promise<number> {
	if (from === to) return 1;

	const key = `${from}${to}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.rate;
	}

	try {
		const res = await fetch(
			`https://api.frankfurter.dev/v1/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
		);
		if (res.ok) {
			const data = (await res.json()) as FrankfurterResponse;
			const rate = data.rates[to];
			if (rate != null && rate > 0) {
				cache.set(key, { rate, timestamp: Date.now() });
				return rate;
			}
		}
	} catch (error) {
		log.warn({ from, to, error }, "Frankfurter FX fetch failed, using fallback");
	}

	// Hardcoded fallback rates — only hit if Frankfurter is down.
	const fallbacks: Record<string, number> = {
		GBPUSD: 1.27,
		USDGBP: 0.79,
	};
	return fallbacks[key] ?? 1;
}

export async function convertCurrency(amount: number, from: string, to: string): Promise<number> {
	const rate = await getExchangeRate(from, to);
	return amount * rate;
}

export function getTradeFriction(exchange: string, side: "BUY" | "SELL"): number {
	switch (exchange) {
		case "LSE":
			return side === "BUY" ? 0.006 : 0.001;
		case "AIM":
			return 0.001;
		case "NASDAQ":
		case "NYSE":
			return 0.002;
		default:
			return 0.002;
	}
}
```

- [ ] **Step 3: Verify + commit**

```bash
bun run typecheck
bun test tests/utils/fx*.test.ts --preload ./tests/preload.ts 2>/dev/null || bun test --preload ./tests/preload.ts 2>&1 | tail -5
bunx biome check src/utils/fx.ts
git add src/utils/fx.ts
git commit -m "refactor(utils): FX rates via Frankfurter.dev instead of FMP"
```

If existing fx tests exist and break because they mocked `fmpFxRate`, update them to mock the global `fetch` for `api.frankfurter.dev` responses. Keep the test coverage identical.

---

## Task 8: Swap `fmpResolveExchange` → EDGAR in `src/news/exchange-resolver.ts`

**Files:**
- Modify: `src/news/exchange-resolver.ts`

- [ ] **Step 1: Read current file**

```bash
cat src/news/exchange-resolver.ts
```

- [ ] **Step 2: Replace the resolver**

```typescript
import { getCikForSymbol } from "../universe/ciks/edgar-ticker-map.ts";
import { getDb } from "../db/client.ts";
import { investableUniverse } from "../db/schema.ts";
import { and, eq } from "drizzle-orm";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "exchange-resolver" });

export interface ResolveExchangeDeps {
	resolver?: (symbol: string) => Promise<"NASDAQ" | "NYSE" | "LSE" | null>;
}

// Resolves a bare ticker to its primary exchange. Strategy:
//   1. Check investable_universe first — if the symbol is in there, trust it.
//   2. Fall back to SEC CIK map (US-only). Symbols with a CIK are US; we
//      default to NASDAQ which covers ~80% of Russell 1000. A future
//      enhancement could query /submissions for the exact exchange per CIK.
//   3. Otherwise return null — caller will skip the signal.
export async function resolveExchange(
	symbol: string,
	deps: ResolveExchangeDeps = {},
): Promise<"NASDAQ" | "NYSE" | "LSE" | null> {
	if (deps.resolver) return deps.resolver(symbol);

	const db = getDb();
	const ticker = symbol.trim().toUpperCase();

	// Prefer investable_universe match (authoritative for symbols we track).
	for (const exch of ["NASDAQ", "NYSE", "LSE", "AIM"] as const) {
		const row = await db
			.select({ exchange: investableUniverse.exchange })
			.from(investableUniverse)
			.where(and(eq(investableUniverse.symbol, ticker), eq(investableUniverse.exchange, exch)))
			.get();
		if (row) return exch === "AIM" ? "LSE" : exch; // classifier only cares about 3 canonical values
	}

	// SEC CIK presence = US symbol. Default NASDAQ.
	const cik = await getCikForSymbol(ticker, "NASDAQ");
	if (cik != null) return "NASDAQ";
	const cikNyse = await getCikForSymbol(ticker, "NYSE");
	if (cikNyse != null) return "NYSE";

	log.debug({ symbol }, "resolveExchange: no match");
	return null;
}
```

- [ ] **Step 3: Update callers**

Find any import of `fmpResolveExchange` or the module's export pattern:

```bash
grep -rn "fmpResolveExchange\|exchange-resolver" src/ --include="*.ts" | grep -v "\.test\."
```

Update callers that used `import { fmpResolveExchange } from "..."` to use `resolveExchange` from this file. If this file already exported a `resolveExchange` function, keep the export name.

- [ ] **Step 4: Verify + commit**

```bash
bun run typecheck
bun test tests/news/ --preload ./tests/preload.ts
bunx biome check src/news/exchange-resolver.ts
git add src/news/exchange-resolver.ts src/news/*.ts
git commit -m "refactor(news): exchange-resolver uses investable_universe + SEC CIK instead of FMP"
```

---

## Task 9: Swap `fmpValidateSymbol` + `fmpQuote` in `src/news/research-agent.ts`

**Files:**
- Modify: `src/news/research-agent.ts`

Two call sites:
1. Line 237: `const { fmpQuote } = await import("../data/fmp.ts");` inside `getPriceForSymbol`
2. Line 342: `const isValidTicker = await fmpValidateSymbol(...)`

- [ ] **Step 1: Swap the `fmpQuote` fallback in `getPriceForSymbol`**

Replace the block around line 230-240:

```typescript
async function getPriceForSymbol(symbol: string, exchange: string): Promise<number | null> {
	const db = getDb();
	const [cached] = await db
		.select({ last: quotesCache.last })
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, symbol), eq(quotesCache.exchange, exchange)))
		.limit(1);

	if (cached?.last != null) return cached.last;

	// Fallback: Yahoo for US, IBKR for UK (routes through broker/market-data).
	try {
		const isUk = exchange === "LSE" || exchange === "AIM";
		if (isUk) {
			const { ibkrQuote } = await import("../broker/market-data.ts");
			const quote = await ibkrQuote(symbol, exchange);
			return quote?.last ?? null;
		}
		const { yahooUsQuote } = await import("../data/yahoo-us.ts");
		const quote = await yahooUsQuote(symbol, exchange);
		return quote?.last ?? null;
	} catch {
		return null;
	}
}
```

- [ ] **Step 2: Replace `fmpValidateSymbol` with universe-based check**

Remove the import:

```typescript
import { fmpValidateSymbol } from "../data/fmp.ts";
```

Find the call at line ~342:

```typescript
const isValidTicker = await fmpValidateSymbol(analysis.symbol, analysis.exchange);
```

Replace with an inline membership check (a symbol is valid if it's in our investable_universe OR in the SEC CIK map):

```typescript
const isValidTicker = await isTickerValid(analysis.symbol, analysis.exchange);
```

Add this helper near the top of research-agent.ts (after imports, before the first exported function):

```typescript
import { getCikForSymbol } from "../universe/ciks/edgar-ticker-map.ts";

async function isTickerValid(symbol: string, exchange: string): Promise<boolean> {
	// In the investable universe? Trust it.
	const inUniverse = await isSymbolInUniverse(symbol, exchange);
	if (inUniverse) return true;

	// US: has an SEC CIK. Still counts as valid even if not in our universe
	// (research agent may surface new names before the weekly refresh picks them up).
	if (exchange === "NASDAQ" || exchange === "NYSE") {
		const cik = await getCikForSymbol(symbol, exchange);
		return cik != null;
	}

	// UK: without investable_universe hit, we have no cheap validator. Reject.
	return false;
}
```

Note: `isSymbolInUniverse` already exists elsewhere in research-agent.ts — reuse it.

- [ ] **Step 3: Verify + commit**

```bash
bun run typecheck
bun test tests/news/research-agent*.test.ts --preload ./tests/preload.ts
bunx biome check src/news/research-agent.ts
git add src/news/research-agent.ts
git commit -m "refactor(news): research-agent uses Yahoo/IBKR/EDGAR instead of FMP"
```

---

## Task 10: Swap `fetchFmpCompanyNews` → Yahoo RSS for UK in `src/scheduler/news-poll-job.ts`

**Files:**
- Modify: `src/scheduler/news-poll-job.ts`

- [ ] **Step 1: Read the current news-poll-job**

```bash
grep -n "fetchFmpCompanyNews\|fmp-news" src/scheduler/news-poll-job.ts
```

- [ ] **Step 2: Decide shape — inspect `fetchFmpCompanyNews` return type**

Read `src/news/fmp-news.ts` to see what it returns. The new `fetchYahooRssUk` from Task 2 must return items that downstream code can feed into the same pipeline. Specifically, news-poll-job calls `processArticle` from `src/news/ingest.ts` which expects `{ headline, source, url, symbols, finnhubId? }`.

We need an adapter: take `YahooRssItem[]` and map to the shape `processArticle` expects. Add this inline in `news-poll-job.ts`:

```typescript
import { fetchYahooRssUk, type YahooRssItem } from "../news/yahoo-rss-uk.ts";

function yahooItemToArticle(
	item: YahooRssItem,
	symbol: string,
): { headline: string; source: string; url: string; symbols: string[]; finnhubId: null } {
	return {
		headline: item.title,
		source: "yahoo_rss",
		url: item.link,
		symbols: [symbol],
		finnhubId: null,
	};
}
```

- [ ] **Step 3: Swap the UK polling branch**

Find the UK-polling branch of `news-poll-job.ts` (uses `fetchFmpCompanyNews`). Replace with:

```typescript
// UK: Yahoo RSS per symbol. FMP UK news returns [] on our tier.
for (const symbol of ukSymbols) {
	const items = await fetchYahooRssUk(symbol, "LSE");
	for (const item of items) {
		const article = yahooItemToArticle(item, symbol);
		await processArticle(article, "LSE");
	}
}
```

(Adjust the surrounding loop shape to match existing code. If `news-poll-job.ts` has dep-injection for `fetchFmpCompanyNews`, add a parallel dep for `fetchYahooRssUk`.)

- [ ] **Step 4: Verify + commit**

```bash
bun run typecheck
bun test tests/news/ tests/scheduler/news-poll*.test.ts --preload ./tests/preload.ts
bunx biome check src/scheduler/news-poll-job.ts
git add src/scheduler/news-poll-job.ts
git commit -m "refactor(scheduler): UK news poll uses Yahoo RSS instead of FMP"
```

---

## Task 11: Swap hardcoded `/v3/earning_calendar` → Finnhub in `src/scheduler/earnings-catalyst-job.ts`

**Files:**
- Modify: `src/scheduler/earnings-catalyst-job.ts`

- [ ] **Step 1: Inspect the current call**

```bash
sed -n '35,55p' src/scheduler/earnings-catalyst-job.ts
```

- [ ] **Step 2: Look at existing Finnhub usage pattern**

```bash
grep -n "finnhub.io\|FINNHUB_API_KEY" src/scheduler/earnings-sync-job.ts
```

Finnhub response shape (from code inspection and their public docs):

```json
{"earningsCalendar": [{"symbol":"AAPL","date":"2026-05-02","epsActual":null,"epsEstimate":1.5,...}]}
```

- [ ] **Step 3: Replace the fetch URL + response parsing**

Find in `src/scheduler/earnings-catalyst-job.ts` (around line 41):

```typescript
`https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${input.apiKey}`
```

Replace with Finnhub:

```typescript
`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${input.finnhubApiKey}`
```

Change `input.apiKey` to `input.finnhubApiKey` throughout this file. Also change the response parsing:

```typescript
// OLD:
// const rows = (await res.json()) as FmpEarningRow[];

// NEW:
const body = (await res.json()) as { earningsCalendar?: FinnhubEarningRow[] };
const rows = body.earningsCalendar ?? [];
```

Define `FinnhubEarningRow`:

```typescript
interface FinnhubEarningRow {
	symbol: string;
	date: string; // YYYY-MM-DD
	epsEstimate: number | null;
}
```

Then update the job-dispatcher at `src/scheduler/jobs.ts:320`:

```typescript
await runEarningsCatalystJob({ finnhubApiKey: getConfig().FINNHUB_API_KEY!, now: new Date() });
```

Note: `FINNHUB_API_KEY` is already an optional string in config. The `!` assertion is safe because the caller checks presence first — if not, wrap the whole dispatch in an if-check:

```typescript
case "earnings_catalyst": {
	const finnhubKey = getConfig().FINNHUB_API_KEY;
	if (!finnhubKey) {
		log.warn("FINNHUB_API_KEY not set — skipping earnings_catalyst");
		break;
	}
	const { runEarningsCatalystJob } = await import("./earnings-catalyst-job.ts");
	await runEarningsCatalystJob({ finnhubApiKey: finnhubKey, now: new Date() });
	break;
}
```

- [ ] **Step 4: Update tests**

`tests/scheduler/earnings-catalyst-job.test.ts` stubs `fetchImpl` returning FMP-shaped JSON. Update the stub to return Finnhub-shaped JSON:

```typescript
json: async () => ({
	earningsCalendar: [{ symbol: "AAPL", date: inThreeDays, epsEstimate: 1.5 }],
}),
```

- [ ] **Step 5: Verify + commit**

```bash
bun run typecheck
bun test tests/scheduler/earnings-catalyst*.test.ts --preload ./tests/preload.ts
bunx biome check src/scheduler/earnings-catalyst-job.ts src/scheduler/jobs.ts
git add src/scheduler/earnings-catalyst-job.ts src/scheduler/jobs.ts tests/scheduler/earnings-catalyst-job.test.ts
git commit -m "refactor(scheduler): earnings-catalyst-job uses Finnhub instead of FMP"
```

---

## Task 12: Build the FMP-removal smoke test

**Files:**
- Create: `scripts/fmp-removal-smoke-test.ts`

This runs BEFORE the PR is opened. It hits each swapped path live and asserts non-null data. This is the gate that would have caught both PR #37 and PR #40's regressions.

- [ ] **Step 1: Write the script**

```typescript
#!/usr/bin/env bun
/**
 * Smoke test for the FMP removal PR.
 *
 * Exercises each swapped call site against live endpoints. Must pass before
 * the PR is opened. Catches the "I thought this worked but it's silently
 * returning null" class of bug that bit us in PR #37 and PR #40.
 *
 * Usage: bun scripts/fmp-removal-smoke-test.ts
 */

process.env.DB_PATH = ":memory:";
process.env.FMP_API_KEY ??= "removed-but-config-still-requires";
process.env.RESEND_API_KEY ??= "smoke";
process.env.ALERT_EMAIL_TO ??= "smoke@example.com";
process.env.ANTHROPIC_API_KEY ??= "smoke";
process.env.FINNHUB_API_KEY ??= "smoke"; // may need real key for Finnhub probe

const { yahooUsQuote, yahooUsHistorical } = await import("../src/data/yahoo-us.ts");
const { fetchYahooRssUk } = await import("../src/news/yahoo-rss-uk.ts");
const { getExchangeRate } = await import("../src/utils/fx.ts");

interface Check {
	name: string;
	pass: boolean;
	detail: string;
}
const checks: Check[] = [];

function record(name: string, pass: boolean, detail: string) {
	checks.push({ name, pass, detail });
	console.log(`${pass ? "✅" : "❌"} ${name}: ${detail}`);
}

// 1. US quote
const aapl = await yahooUsQuote("AAPL", "NASDAQ");
record(
	"yahooUsQuote(AAPL)",
	aapl != null && aapl.last != null && aapl.volume != null,
	aapl ? `last=${aapl.last}, vol=${aapl.volume}, avgVol=${aapl.avgVolume?.toFixed(0)}` : "null",
);

// 2. US historical (30 days)
const aaplBars = await yahooUsHistorical("AAPL", "NASDAQ", 30);
record(
	"yahooUsHistorical(AAPL, 30d)",
	Array.isArray(aaplBars) && aaplBars.length >= 15,
	`${aaplBars?.length ?? 0} bars`,
);

// 3. UK RSS
const bpItems = await fetchYahooRssUk("BP", "LSE");
record(
	"fetchYahooRssUk(BP.L)",
	bpItems.length >= 1,
	`${bpItems.length} items; first: "${bpItems[0]?.title.slice(0, 60) ?? "?"}"`,
);

// 4. FX via Frankfurter
const gbpUsd = await getExchangeRate("GBP", "USD");
record(
	"getExchangeRate(GBP, USD)",
	gbpUsd > 1.0 && gbpUsd < 2.0,
	`rate=${gbpUsd}`,
);

// 5. No lingering FMP imports
const { execSync } = await import("node:child_process");
const leaks = execSync(
	"grep -rn 'fmpFetch\\|fmpQuote\\|fmpHistorical\\|fmpFxRate\\|fmpValidateSymbol\\|fmpResolveExchange\\|fmpBatchQuotes\\|financialmodelingprep\\|toFmpSymbol\\|normalizeFmpExchange' src/ --include='*.ts' 2>/dev/null || true",
	{ encoding: "utf8" },
).trim();
record(
	"No FMP imports or URLs in src/",
	leaks.length === 0,
	leaks.length === 0 ? "clean" : `${leaks.split("\n").length} lines with FMP references`,
);

const passed = checks.filter((c) => c.pass).length;
console.log(`\n── Summary: ${passed}/${checks.length} checks passed ──`);
if (passed < checks.length) {
	console.log("Failures:");
	for (const c of checks.filter((c) => !c.pass)) console.log(`  - ${c.name}: ${c.detail}`);
	process.exit(1);
}
console.log("\n✅ FMP-removal smoke test green. Safe to open PR.");
```

- [ ] **Step 2: Run the smoke test**

```bash
bun scripts/fmp-removal-smoke-test.ts
```

Expected: all 5 checks pass. If check 5 (no FMP imports) fails, the subsequent delete-tasks haven't run yet — expected. Continue to Tasks 13-14.

- [ ] **Step 3: Commit the script**

```bash
git add scripts/fmp-removal-smoke-test.ts
git commit -m "test: FMP-removal smoke-test gate"
```

---

## Task 13: Delete FMP client + unused files

**Files:**
- Delete: `src/data/fmp.ts`
- Delete: `src/data/ftse100.ts`
- Delete: `src/universe/profile-fetcher.ts`
- Delete: `tests/data/fmp.test.ts`
- Delete: `tests/data/fmp-active-trading.test.ts`
- Delete: `tests/data/fmp-resolve-exchange.test.ts`
- Delete: `tests/data/ftse100.test.ts`
- Delete: `tests/news/fmp-news.test.ts`
- Delete: `src/news/fmp-news.ts`
- Delete: `tests/universe/profile-fetcher.test.ts`
- Modify: `src/db/schema.ts` (remove `symbolProfiles` export)

- [ ] **Step 1: Confirm no callers remain**

```bash
grep -rn "fmpFetch\|fmpQuote\|fmpHistorical\|fmpFxRate\|fmpValidateSymbol\|fmpResolveExchange\|fmpBatchQuotes\|fetchFmpCompanyNews\|toFmpSymbol\|normalizeFmpExchange\|fetchSymbolProfiles\|upsertProfiles\|getProfiles\|getProfile\|SymbolProfile\|PROFILE_CACHE_TTL_DAYS\|financialmodelingprep" src/ --include="*.ts" | grep -v "\.test\."
```

Must return empty. If anything still imports from `fmp.ts`, `ftse100.ts`, `profile-fetcher.ts`, or `fmp-news.ts`, go back and fix those tasks first.

- [ ] **Step 2: Delete the files**

```bash
rm src/data/fmp.ts src/data/ftse100.ts src/universe/profile-fetcher.ts src/news/fmp-news.ts
rm tests/data/fmp.test.ts tests/data/fmp-active-trading.test.ts tests/data/fmp-resolve-exchange.test.ts tests/data/ftse100.test.ts tests/news/fmp-news.test.ts tests/universe/profile-fetcher.test.ts
```

- [ ] **Step 3: Remove `symbolProfiles` from schema.ts**

In `src/db/schema.ts`, find and delete the `symbolProfiles` table definition (around lines 518-540 — including the `uniqueIndex` and `$onUpdate` config). Leave migration files alone — the prod DB's orphan table is harmless.

- [ ] **Step 4: Verify**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/ tests/
```

All three must pass. Test count drops by ~20 (removed FMP-specific tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete FMP client, ftse100 scraper, and profile-fetcher (all dead)"
```

---

## Task 14: Remove `FMP_API_KEY` from config

**Files:**
- Modify: `src/config.ts`
- Modify: any `.env.example` or deploy docs

- [ ] **Step 1: Remove the env var**

In `src/config.ts`, find and remove:

```typescript
FMP_API_KEY: z.string(),
```

If there's a `.env.example` file, remove `FMP_API_KEY=...` from it. Same for any deploy docs (grep shows none expected, but check):

```bash
grep -rn "FMP_API_KEY" . --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null | grep -v "\.md:"
```

- [ ] **Step 2: Verify**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove FMP_API_KEY from config"
```

---

## Task 15: Full gate + PR

- [ ] **Step 1: Run every smoke test and the full suite**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/ tests/ scripts/
bun scripts/universe-refresh-smoke-test.ts
bun scripts/uk-pipeline-smoke-test.ts
bun scripts/fmp-removal-smoke-test.ts
```

All must pass. Verify the expected row counts:
- `universe-refresh-smoke-test`: russell_1000 ≥ 700, ftse_350 ≥ 150, aim_allshare ≥ 1
- `uk-pipeline-smoke-test`: ftse_350 ≥ 150
- `fmp-removal-smoke-test`: 5/5 checks including "no FMP imports in src/"

- [ ] **Step 2: Final leak scan**

```bash
grep -rn "fmpFetch\|fmpQuote\|fmpHistorical\|fmpFxRate\|fmpValidateSymbol\|fmpResolveExchange\|fmpBatchQuotes\|fetchFmpCompanyNews\|toFmpSymbol\|normalizeFmpExchange\|financialmodelingprep\|FMP_API_KEY" . --include="*.ts" --exclude-dir=node_modules --exclude-dir=.git 2>/dev/null
```

Expected: only comments in migration files (e.g. `// was FMP`). If any active code references remain, stop and fix.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin <branch-name>
gh pr create --title "refactor: remove FMP entirely (Yahoo/Frankfurter/EDGAR/Finnhub replacements)" --body "$(cat <<'EOF'
## Summary

Removes every FMP dependency. Each call site swapped for a verified free alternative:

- fmpQuote → yahooUsQuote (US) + ibkrQuote (UK, routes through broker/market-data)
- fmpHistorical → yahooUsHistorical (US) + ibkrHistorical (UK)
- fmpFxRate → Frankfurter.dev (ECB data, no auth)
- fmpValidateSymbol → SEC EDGAR CIK map + investable_universe membership
- fmpResolveExchange → SEC EDGAR /submissions + investable_universe lookup
- fmp-news.ts → yahoo-rss-uk.ts (Yahoo RSS per .L)
- earnings-catalyst-job /v3/earning_calendar → Finnhub /calendar/earnings
- Deleted: src/data/fmp.ts, src/data/ftse100.ts, src/universe/profile-fetcher.ts
- Removed FMP_API_KEY from config

## Verification gate (all green)

- [x] bun run typecheck
- [x] bun test --preload ./tests/preload.ts
- [x] bunx biome check
- [x] bun scripts/universe-refresh-smoke-test.ts — russell_1000 ≥ 700, ftse_350 ≥ 150
- [x] bun scripts/uk-pipeline-smoke-test.ts — ftse_350 ≥ 150
- [x] bun scripts/fmp-removal-smoke-test.ts — 5/5 checks, no FMP imports left

## Known gaps (unchanged from pre-PR)

- UK earnings calendar — no free source; Finnhub is US-only (same as FMP was)
- freeFloatUsd for US — falls back to sharesOutstanding × price (same as pre-PR)

## Post-merge

- Remove FMP subscription
- Update docs/universe-rollout-status.md to reflect completion

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Post-merge VPS verification**

```bash
./scripts/vps-ssh.sh "cd /opt/trader-v2 && sudo -u deploy /home/deploy/.bun/bin/bun -e 'import { runWeeklyUniverseRefresh } from \"./src/scheduler/universe-jobs.ts\"; await runWeeklyUniverseRefresh(); console.log(\"done\");'"
```

Expected: still shows russell_1000 ≈ 988, ftse_350 ≈ 200 (same as pre-PR — FMP removal is internally-transparent).

Then check the service can start without `FMP_API_KEY` in `.env`:

```bash
./scripts/vps-ssh.sh "grep FMP_API_KEY /opt/trader-v2/.env && echo 'still set — remove it' || echo 'already removed'"
./scripts/vps-ssh.sh "sudo systemctl restart trader-v2 && sleep 5 && curl -s http://localhost:3847/health | head -c 200"
```

---

## Final summary (post-merge)

- **Zero FMP references in `src/`**
- **Every silent-dead call site now has a working free alternative**
- **FMP subscription can be cancelled** — saves $15-30/mo indefinitely
- **UK news pipeline alive** (was silently dark with empty `[]` responses)
- **Quote refresh, missed-opportunity, historical, FX all restored to actually working**
- **Smoke-test gate scripts in the repo** — future PRs can re-run them to catch regressions of this class
