# LSE News FMP Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken RSS + RNS UK news ingestion layer with a per-symbol FMP `/news/stock` call. All downstream logic (whitelist filter, primary-symbol pin, research agent, eval suite) remains unchanged.

**Architecture:** New `src/news/fmp-news.ts` exposes `fetchFmpCompanyNews(symbol, exchange)`. The LSE/AIM branch in `src/scheduler/news-poll-job.ts` is rewritten to loop per-symbol calling this function. RSS + RNS files are deleted. Dedup is already `headline`-based, so FMP articles with `finnhubId: null` need no schema change.

**Tech Stack:** Bun, TypeScript strict, Biome, Drizzle on SQLite, `bun:test`. FMP Starter plan (already in use for quotes, historical, FX, profile validation).

**Canonical spec:** `docs/specs/2026-04-10-lse-news-fmp-migration.md`

---

## Pre-flight (MUST run before any code change)

### Task 0: Live FMP news endpoint smoke test

**Why first:** The whole plan assumes FMP `/news/stock` exists, returns articles for LSE symbols, and matches the `FmpNewsRaw` interface in the spec. If it doesn't, we stop and redesign. This is Acceptance Criterion #1.

**Files:**
- Create: `scripts/smoke-fmp-news.ts` (throwaway — deleted in the final task)

- [ ] **Step 1: Write the smoke script**

```ts
// scripts/smoke-fmp-news.ts
// Throwaway pre-flight check — delete before merge.
// Usage: bun scripts/smoke-fmp-news.ts

import { fmpFetch } from "../src/data/fmp.ts";

async function main() {
	const symbols = ["SHEL.L", "BP.L", "HSBA.L"];
	for (const sym of symbols) {
		console.log(`\n=== ${sym} ===`);
		const data = await fmpFetch<unknown>("/news/stock", { symbols: sym, limit: "5" });
		if (!Array.isArray(data)) {
			console.error(`FAIL: ${sym} returned non-array:`, data);
			continue;
		}
		console.log(`OK: ${data.length} articles`);
		if (data.length > 0) {
			console.log("First article:", JSON.stringify(data[0], null, 2));
		}
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Run the smoke test**

Run: `bun scripts/smoke-fmp-news.ts`

Expected:
- Each of SHEL.L, BP.L, HSBA.L returns `OK: N articles` with `N >= 1` (on any trading day; may be 0 on weekends for less active symbols — in that case try again Monday or add more symbols)
- The first article JSON has these fields present (at minimum): `symbol`, `publishedDate`, `publisher`, `title`, `url`
- `publishedDate` is an ISO-ish string like `"2026-04-08 03:46:00"` (space-separated, UTC)

**Hard stop:** If FMP returns 401/403, or no symbol returns any articles on a weekday, STOP the plan. The approach is wrong. Report back to the operator.

- [ ] **Step 3: Capture the smoke output for the PR**

Pipe the successful run to a file (will be attached to the PR description per Acceptance Criterion #1):

```bash
bun scripts/smoke-fmp-news.ts > /tmp/fmp-news-smoke.txt 2>&1
cat /tmp/fmp-news-smoke.txt
```

- [ ] **Step 4: Do NOT commit the smoke script yet**

Leave `scripts/smoke-fmp-news.ts` uncommitted. It gets deleted in Task 12 before the final push. This keeps git clean and avoids accidentally shipping a throwaway script.

---

## Implementation tasks

### Task 1: Create `src/news/fmp-news.ts` with failing test

**Files:**
- Create: `src/news/fmp-news.ts`
- Create: `tests/news/fmp-news.test.ts`

**Scene:** This is the new FMP news client. It parses FMP `/news/stock` payloads into the shared `NewsArticle` interface (defined in `src/news/finnhub.ts` — not renamed, it's the common shape). The client reuses `fmpFetch` (rate limiter, retries, auth) and `toFmpSymbol` (exchange → FMP ticker rewrite) from `src/data/fmp.ts`. Error handling: per-symbol failures swallow and return `[]` with a warn log. Per-article parse failures silently skip.

- [ ] **Step 1: Write failing tests for `parseFmpArticle`**

Create `tests/news/fmp-news.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { _test_parseFmpArticle as parseFmpArticle } from "../../src/news/fmp-news.ts";

describe("parseFmpArticle", () => {
	const validRaw = {
		symbol: "SHEL",
		publishedDate: "2026-04-08 03:46:00",
		publisher: "Reuters",
		title: "Shell raises dividend",
		url: "https://example.com/shell-dividend",
		site: "reuters.com",
		text: "Shell plc announced...",
	};

	test("parses a valid FMP payload into a NewsArticle", () => {
		const article = parseFmpArticle(validRaw);
		expect(article).not.toBeNull();
		expect(article?.headline).toBe("Shell raises dividend");
		expect(article?.url).toBe("https://example.com/shell-dividend");
		expect(article?.source).toBe("reuters.com");
		expect(article?.symbols).toEqual(["SHEL"]);
		expect(article?.finnhubId).toBeNull();
	});

	test("parses publishedDate as UTC", () => {
		const article = parseFmpArticle(validRaw);
		expect(article?.publishedAt.toISOString()).toBe("2026-04-08T03:46:00.000Z");
	});

	test("returns null when title is missing", () => {
		const article = parseFmpArticle({ ...validRaw, title: "" });
		expect(article).toBeNull();
	});

	test("returns null when url is missing", () => {
		const article = parseFmpArticle({ ...validRaw, url: "" });
		expect(article).toBeNull();
	});

	test("returns null when publishedDate is missing", () => {
		const article = parseFmpArticle({ ...validRaw, publishedDate: "" });
		expect(article).toBeNull();
	});

	test("returns null when publishedDate is malformed", () => {
		const article = parseFmpArticle({ ...validRaw, publishedDate: "not-a-date" });
		expect(article).toBeNull();
	});

	test("prefers site over publisher for source", () => {
		const article = parseFmpArticle({ ...validRaw, site: "reuters.com", publisher: "Reuters Inc" });
		expect(article?.source).toBe("reuters.com");
	});

	test("falls back to publisher when site is missing", () => {
		const { site, ...rawNoSite } = validRaw;
		const article = parseFmpArticle(rawNoSite as typeof validRaw);
		expect(article?.source).toBe("Reuters");
	});

	test("falls back to 'fmp' when neither site nor publisher is present", () => {
		const { site, publisher, ...rawBare } = validRaw;
		const article = parseFmpArticle({ ...rawBare, publisher: "" } as typeof validRaw);
		expect(article?.source).toBe("fmp");
	});
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/news/fmp-news.test.ts`

Expected: FAIL with "Cannot find module '../../src/news/fmp-news.ts'"

- [ ] **Step 3: Implement `src/news/fmp-news.ts`**

**Important — dual-listing fallback.** Task 0 smoke testing verified that FMP's `/news/stock` keys news articles to the primary ticker for dual-listed companies. For example:
- `SHEL.L` → 10 articles ✓ (Shell uses `SHEL` on both exchanges)
- `BP.L` → 0 articles ✗ (FMP keys BP news to plain `BP` — the NYSE ticker — which has 50 articles)
- `VOD.L` → 0 articles ✗ (same dual-listing issue)

For LSE/AIM symbols, the client tries the `.L` variant first; if it returns empty, it falls back to the stripped variant (plain symbol without `.L`). AIM symbols also get stripped-dot normalization (production universe stores `"BP."` with a trailing dot, which would otherwise become `"BP..L"`).

```ts
// src/news/fmp-news.ts
import { fmpFetch, toFmpSymbol } from "../data/fmp.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { NewsArticle } from "./finnhub.ts";

const log = createChildLogger({ module: "fmp-news" });

interface FmpNewsRaw {
	symbol: string;
	publishedDate: string;
	publisher: string;
	title: string;
	image?: string;
	site?: string;
	text?: string;
	url: string;
}

function parseFmpArticle(raw: FmpNewsRaw): NewsArticle | null {
	if (!raw.title || !raw.url || !raw.publishedDate) return null;
	const publishedAt = new Date(raw.publishedDate.replace(" ", "T") + "Z");
	if (Number.isNaN(publishedAt.getTime())) return null;
	const source = raw.site && raw.site.length > 0
		? raw.site
		: raw.publisher && raw.publisher.length > 0
			? raw.publisher
			: "fmp";
	return {
		headline: raw.title,
		symbols: [raw.symbol],
		url: raw.url,
		source,
		publishedAt,
		finnhubId: null,
	};
}

async function fetchRaw(fmpSymbol: string): Promise<FmpNewsRaw[]> {
	try {
		const data = await fmpFetch<FmpNewsRaw[]>("/news/stock", {
			symbols: fmpSymbol,
			limit: "20",
		});
		if (!Array.isArray(data)) return [];
		return data;
	} catch (err) {
		log.warn({ fmpSymbol, err }, "FMP news fetch failed");
		return [];
	}
}

/**
 * Fetches news articles for a symbol via FMP /news/stock.
 *
 * For LSE/AIM, we try the .L variant first (e.g. "SHEL.L"). If that returns
 * no articles, we fall back to the stripped variant (e.g. "SHEL") — this
 * handles dual-listed companies where FMP keys news to the US ticker.
 *
 * The production universe sometimes stores symbols with trailing dots
 * (e.g. "BP."). These are normalised to "BP" before building the FMP ticker.
 *
 * Regardless of which ticker FMP returned articles under, the attribution
 * is the original queried symbol — so BP.:LSE always gets articles
 * attributed to "BP." in downstream news_analyses rows.
 */
export async function fetchFmpCompanyNews(
	symbol: string,
	exchange: string,
): Promise<NewsArticle[]> {
	// Normalise: strip trailing dot from LSE-style tickers like "BP."
	const cleanSymbol = symbol.replace(/\.$/, "");
	const primary = toFmpSymbol(cleanSymbol, exchange);

	let raw = await fetchRaw(primary);

	// Dual-listing fallback: LSE/AIM companies with a US listing often have
	// their FMP news indexed under the plain (US) ticker instead of .L.
	if (raw.length === 0 && (exchange === "LSE" || exchange === "AIM") && primary !== cleanSymbol) {
		log.debug(
			{ symbol, exchange, primary, fallback: cleanSymbol },
			"No articles under .L ticker, trying US fallback",
		);
		raw = await fetchRaw(cleanSymbol);
		if (raw.length > 0) {
			log.info(
				{ symbol, exchange, fallback: cleanSymbol, count: raw.length },
				"FMP news fetched via US dual-listing fallback",
			);
		}
	}

	if (raw.length === 0) {
		log.debug({ symbol, exchange }, "FMP news returned no articles");
		return [];
	}

	const articles: NewsArticle[] = [];
	for (const rawArticle of raw) {
		const article = parseFmpArticle(rawArticle);
		if (article) {
			article.symbols = [symbol];
			articles.push(article);
		}
	}
	return articles;
}

export const _test_parseFmpArticle = parseFmpArticle;
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/news/fmp-news.test.ts`

Expected: 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/news/fmp-news.ts tests/news/fmp-news.test.ts
git commit -m "feat: add fmp-news client with parseFmpArticle

Reuses fmpFetch + toFmpSymbol from src/data/fmp.ts. Per-symbol
fetch returns [] on failure with warn log; per-article parse
failures skip silently. finnhubId: null — dedup is headline-based
in processArticle so no schema change needed."
```

### Task 2: Add `fetchFmpCompanyNews` integration test

**Files:**
- Modify: `tests/news/fmp-news.test.ts`

**Scene:** Mock `fmpFetch` and verify the client: (a) rewrites the ticker via `toFmpSymbol` before calling, (b) overrides `article.symbols` to the queried symbol regardless of FMP payload, (c) returns `[]` on non-array response, (d) returns `[]` on thrown error. We use `mock.module()` to stub `src/data/fmp.ts`.

- [ ] **Step 1: Append integration tests to `tests/news/fmp-news.test.ts`**

Append this block inside the same file, after the `describe("parseFmpArticle", ...)` block:

```ts
import { mock } from "bun:test";

describe("fetchFmpCompanyNews", () => {
	test("rewrites LSE symbol to .L form before fetching", async () => {
		const calls: Array<{ path: string; params: Record<string, string> }> = [];
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async (path: string, params: Record<string, string>) => {
				calls.push({ path, params });
				return [];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		await fetchFmpCompanyNews("SHEL", "LSE");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/news/stock");
		expect(calls[0]?.params.symbols).toBe("SHEL.L");
		expect(calls[0]?.params.limit).toBe("20");
	});

	test("returns [] when fmpFetch returns non-array", async () => {
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async () => null,
			toFmpSymbol: (sym: string) => sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		const result = await fetchFmpCompanyNews("SHEL", "LSE");
		expect(result).toEqual([]);
	});

	test("returns [] when fmpFetch throws", async () => {
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async () => {
				throw new Error("boom");
			},
			toFmpSymbol: (sym: string) => sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		const result = await fetchFmpCompanyNews("SHEL", "LSE");
		expect(result).toEqual([]);
	});

	test("overrides article.symbols to the queried symbol", async () => {
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async () => [
				{
					symbol: "WRONG",
					publishedDate: "2026-04-08 03:46:00",
					publisher: "Reuters",
					title: "Shell raises dividend",
					url: "https://example.com/a",
				},
			],
			toFmpSymbol: (sym: string) => sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		const result = await fetchFmpCompanyNews("SHEL", "LSE");
		expect(result).toHaveLength(1);
		expect(result[0]?.symbols).toEqual(["SHEL"]);
	});

	test("skips articles that fail to parse", async () => {
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async () => [
				{ symbol: "SHEL", publishedDate: "", publisher: "X", title: "Valid", url: "https://a" },
				{
					symbol: "SHEL",
					publishedDate: "2026-04-08 03:46:00",
					publisher: "X",
					title: "OK",
					url: "https://b",
				},
			],
			toFmpSymbol: (sym: string) => sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		const result = await fetchFmpCompanyNews("SHEL", "LSE");
		expect(result).toHaveLength(1);
		expect(result[0]?.headline).toBe("OK");
	});

	test("falls back to plain symbol when .L returns empty (dual-listing)", async () => {
		const calls: string[] = [];
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				calls.push(params.symbols as string);
				if (params.symbols === "BP.L") return [];
				if (params.symbols === "BP") {
					return [
						{
							symbol: "BP",
							publishedDate: "2026-04-08 03:46:00",
							publisher: "Reuters",
							title: "BP Q1 earnings beat",
							url: "https://example.com/bp",
						},
					];
				}
				return [];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		const result = await fetchFmpCompanyNews("BP", "LSE");
		expect(calls).toEqual(["BP.L", "BP"]);
		expect(result).toHaveLength(1);
		expect(result[0]?.headline).toBe("BP Q1 earnings beat");
		// Attribution preserved to original queried symbol
		expect(result[0]?.symbols).toEqual(["BP"]);
	});

	test("does NOT fall back when .L returns non-empty", async () => {
		const calls: string[] = [];
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				calls.push(params.symbols as string);
				return [
					{
						symbol: "SHEL",
						publishedDate: "2026-04-08 03:46:00",
						publisher: "Reuters",
						title: "Shell news",
						url: "https://example.com/shel",
					},
				];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		const result = await fetchFmpCompanyNews("SHEL", "LSE");
		expect(calls).toEqual(["SHEL.L"]); // only one call — no fallback
		expect(result).toHaveLength(1);
	});

	test("strips trailing dot from symbol before building .L ticker", async () => {
		const calls: string[] = [];
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				calls.push(params.symbols as string);
				return [];
			},
			toFmpSymbol: (sym: string, exch: string) =>
				exch === "LSE" || exch === "AIM" ? `${sym}.L` : sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		// Production universe stores "BP." (with trailing dot) — must normalise
		// to "BP" before toFmpSymbol, not produce "BP..L".
		await fetchFmpCompanyNews("BP.", "LSE");
		expect(calls).toEqual(["BP.L", "BP"]); // primary + fallback, no "BP..L"
	});

	test("does not fall back for US exchanges", async () => {
		const calls: string[] = [];
		mock.module("../../src/data/fmp.ts", () => ({
			fmpFetch: async (_path: string, params: Record<string, string>) => {
				calls.push(params.symbols as string);
				return [];
			},
			toFmpSymbol: (sym: string) => sym,
		}));
		const { fetchFmpCompanyNews } = await import("../../src/news/fmp-news.ts");
		await fetchFmpCompanyNews("AAPL", "NASDAQ");
		expect(calls).toEqual(["AAPL"]); // no fallback for NASDAQ
	});
});
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/news/fmp-news.test.ts`

Expected: 18 tests pass (9 from Task 1 + 9 new: 5 original integration + 4 dual-listing fallback).

- [ ] **Step 3: Commit**

```bash
git add tests/news/fmp-news.test.ts
git commit -m "test: add fetchFmpCompanyNews integration tests

Mocks fmpFetch via mock.module() and verifies: LSE->.L ticker
rewrite, non-array response handling, error swallowing, symbol
override, per-article parse-failure skip."
```

### Task 3: Rewrite LSE/AIM branch in `news-poll-job.ts`

**Files:**
- Modify: `src/scheduler/news-poll-job.ts:1-134` (full rewrite of the non-US branch)

**Scene:** The current non-US branch (lines 99-128) calls the now-deleted `fetchUkNewsForSymbols` and `fetchRnsNews`. Replace it with a per-symbol loop calling `fetchFmpCompanyNews`. Keep the US/Finnhub branch exactly as-is. Preserve the result counters and the existing log line.

- [ ] **Step 1: Write a failing integration test for the LSE branch**

Create `tests/scheduler/news-poll-job-lse.test.ts`:

```ts
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getDb } from "../../src/db/client.ts";
import { strategies } from "../../src/db/schema.ts";

describe("runNewsPoll LSE branch (FMP)", () => {
	beforeEach(async () => {
		const db = getDb();
		await db.delete(strategies).execute();
		await db.insert(strategies).values({
			name: "lse-test",
			description: "test",
			parameters: "{}",
			universe: JSON.stringify(["SHEL:LSE", "BP.:LSE"]),
			status: "paper",
		});
	});

	test("calls fetchFmpCompanyNews once per LSE symbol and routes to processArticle", async () => {
		const fmpCalls: Array<{ symbol: string; exchange: string }> = [];
		const processCalls: Array<{ headline: string; exchange: string }> = [];

		mock.module("../../src/news/fmp-news.ts", () => ({
			fetchFmpCompanyNews: async (symbol: string, exchange: string) => {
				fmpCalls.push({ symbol, exchange });
				if (symbol === "SHEL") {
					return [
						{
							headline: `Shell news ${Date.now()}-${Math.random()}`,
							symbols: ["SHEL"],
							url: "https://example.com/a",
							source: "reuters.com",
							publishedAt: new Date(),
							finnhubId: null,
						},
					];
				}
				return [];
			},
		}));

		mock.module("../../src/news/ingest.ts", () => ({
			processArticle: async (article: { headline: string }, exchange: string) => {
				processCalls.push({ headline: article.headline, exchange });
				return "classified";
			},
			isHeadlineSeen: async () => false,
		}));

		mock.module("../../src/news/finnhub.ts", () => ({
			fetchCompanyNews: async () => [],
		}));

		const { runNewsPoll } = await import("../../src/scheduler/news-poll-job.ts");
		await runNewsPoll();

		expect(fmpCalls).toEqual([
			{ symbol: "SHEL", exchange: "LSE" },
			{ symbol: "BP.", exchange: "LSE" },
		]);
		expect(processCalls).toHaveLength(1);
		expect(processCalls[0]?.exchange).toBe("LSE");
	});
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/scheduler/news-poll-job-lse.test.ts`

Expected: FAIL — the current `news-poll-job.ts` still imports `fetchUkNewsForSymbols` and `fetchRnsNews`, and does not call `fetchFmpCompanyNews`.

- [ ] **Step 3: Rewrite `src/scheduler/news-poll-job.ts`**

Replace the entire file contents with:

```ts
import { eq } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { classifyHeadline } from "../news/classifier.ts";
import { fetchCompanyNews } from "../news/finnhub.ts";
import { fetchFmpCompanyNews } from "../news/fmp-news.ts";
import { processArticle } from "../news/ingest.ts";
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
		let universe: string[];
		try {
			universe = JSON.parse(strat.universe);
		} catch {
			log.warn({ universe: strat.universe }, "Malformed universe JSON — skipping");
			continue;
		}
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

	const watchlist = await getWatchlistSymbols();
	if (watchlist.length === 0) {
		log.debug("No symbols in watchlist — skipping news poll");
		return;
	}

	let totalArticles = 0;
	let classified = 0;
	let filtered = 0;
	let duplicates = 0;

	// US stocks: Finnhub API
	const usSymbols = watchlist.filter((s) => s.exchange === "NASDAQ" || s.exchange === "NYSE");
	if (usSymbols.length > 0 && !config.FINNHUB_API_KEY) {
		log.warn("FINNHUB_API_KEY not set — skipping US news poll");
	} else {
		for (const { symbol, exchange } of usSymbols) {
			const fhSymbol = finnhubSymbol(symbol, exchange);
			const articles = await fetchCompanyNews(fhSymbol, config.FINNHUB_API_KEY);

			for (const article of articles) {
				if (article.symbols.length === 0) {
					article.symbols = [symbol];
				}

				totalArticles++;
				const result = await processArticle(article, exchange, classifyHeadline);
				if (result === "classified") classified++;
				else if (result === "filtered") filtered++;
				else if (result === "duplicate") duplicates++;
			}

			// Respect Finnhub rate limit: 60 calls/min
			await Bun.sleep(1100);
		}
	}

	// Non-US stocks (LSE, AIM): FMP /news/stock, per-symbol
	const nonUsSymbols = watchlist.filter((s) => s.exchange === "LSE" || s.exchange === "AIM");
	if (nonUsSymbols.length > 0) {
		log.info(
			{ symbolCount: nonUsSymbols.length },
			"Polling FMP news per symbol for LSE/AIM",
		);
		for (const { symbol, exchange } of nonUsSymbols) {
			const articles = await fetchFmpCompanyNews(symbol, exchange);
			for (const article of articles) {
				totalArticles++;
				const result = await processArticle(article, exchange, classifyHeadline);
				if (result === "classified") classified++;
				else if (result === "filtered") filtered++;
				else if (result === "duplicate") duplicates++;
			}
			// Soft pacing against FMP rate limit (hard limit is in fmpFetch)
			await Bun.sleep(200);
		}
		log.info(
			{ exchange: "LSE/AIM", symbols: nonUsSymbols.length, articles: totalArticles },
			"FMP news poll complete",
		);
	}

	log.info(
		{ symbols: watchlist.length, totalArticles, classified, filtered, duplicates },
		"News poll complete",
	);
}
```

Key changes from the current file:
- Removed imports: `fetchRnsNews`, `fetchUkNewsForSymbols`, `NewsArticle` (the type-only import is no longer needed — the non-US branch doesn't reference the type directly).
- Added import: `fetchFmpCompanyNews`.
- The Finnhub-key guard is scoped to US symbols only — LSE/AIM can run even without `FINNHUB_API_KEY`.
- Non-US branch filter now explicitly matches `LSE || AIM` (previously a negative match on US exchanges — which would have silently polled unknown exchanges via the RSS path).
- Non-US loop calls `fetchFmpCompanyNews` per symbol with 200ms soft pacing.
- Emits a dedicated `"FMP news poll complete"` log line (matches Acceptance Criterion #6).

- [ ] **Step 4: Run the LSE test, verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/scheduler/news-poll-job-lse.test.ts`

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/news-poll-job.ts tests/scheduler/news-poll-job-lse.test.ts
git commit -m "feat: rewrite LSE/AIM branch to use FMP /news/stock

Per-symbol loop calling fetchFmpCompanyNews with 200ms soft
pacing. Dedicated 'FMP news poll complete' log line for
production smoke test. Finnhub key guard scoped to US branch
only so LSE/AIM can run independently.

BREAKING: removes imports from rss-feeds.ts and rns-scraper.ts
— those files are deleted in the next commit."
```

### Task 4: Delete RSS and RNS files

**Files:**
- Delete: `src/news/rss-feeds.ts`
- Delete: `src/news/rns-scraper.ts`
- Delete: `src/news/alias-overrides.ts`
- Delete: `src/news/uk-feed-config.ts`
- Delete: `tests/news/rss-feeds.test.ts`
- Delete: `tests/news/rns-scraper.test.ts`
- Delete: `tests/news/alias-overrides.test.ts`

**Scene:** The RSS feed and RNS scraper are dead code after Task 3. Their tests assert behaviors that no longer matter. Delete everything.

- [ ] **Step 1: Verify nothing else imports the files being deleted**

Run:

```bash
grep -rn "rss-feeds\|rns-scraper\|alias-overrides\|uk-feed-config" src/ tests/ --include="*.ts" | grep -v "src/news/rss-feeds.ts" | grep -v "src/news/rns-scraper.ts" | grep -v "src/news/alias-overrides.ts" | grep -v "src/news/uk-feed-config.ts" | grep -v "tests/news/rss-feeds.test.ts" | grep -v "tests/news/rns-scraper.test.ts" | grep -v "tests/news/alias-overrides.test.ts"
```

Expected: no output (empty result).

**If there are remaining imports:** STOP. Update the importing files in a new step before deleting. Do not force-delete with broken imports.

- [ ] **Step 2: Delete the files**

```bash
git rm src/news/rss-feeds.ts \
       src/news/rns-scraper.ts \
       src/news/alias-overrides.ts \
       src/news/uk-feed-config.ts \
       tests/news/rss-feeds.test.ts \
       tests/news/rns-scraper.test.ts \
       tests/news/alias-overrides.test.ts
```

- [ ] **Step 3: Run typecheck to verify no broken imports**

Run: `bunx tsc --noEmit`

Expected: no errors. If errors appear, a dependent file still imports the deleted modules — fix by either removing those imports or replacing with `fmp-news.ts` equivalents.

- [ ] **Step 4: Run full test suite to verify no runtime import failures**

Run: `bun test --preload ./tests/preload.ts 2>&1 | tail -20`

Expected: Same pass/fail counts as baseline, minus the deleted tests. Baseline was 601 pass / 2 pre-existing flaky fails. After deleting the 3 test files (which together contained ~30-40 tests for RSS/RNS/alias logic), expect ~560-570 pass / 2 fail. The 2 flaky `tests/broker/contracts.test.ts` failures remain (pre-existing baseline).

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: delete RSS, RNS, and alias-override files

The RSS feeds are blocked by Cloudflare/Incapsula in production
and the RNS scraper targets an Angular SPA that returns 0
articles. FMP /news/stock replaces both (see Task 3).

Deletes:
- src/news/rss-feeds.ts
- src/news/rns-scraper.ts
- src/news/alias-overrides.ts
- src/news/uk-feed-config.ts
- 3 corresponding test files"
```

### Task 5: Update `src/news/CLAUDE.md`

**Files:**
- Modify: `src/news/CLAUDE.md` (full rewrite of invariants and pipeline map)

**Scene:** The subsystem guide still references the deleted RSS matcher, alias map, and collision blacklist. Rewrite to reflect the FMP path.

- [ ] **Step 1: Replace `src/news/CLAUDE.md` contents**

```markdown
# News Pipeline Subsystem

This directory implements the news→trade pipeline. Read this before touching any file in it.

**Canonical spec:** `docs/specs/2026-04-10-lse-news-fmp-migration.md`
**Prior spec (partially superseded):** `docs/specs/2026-04-10-lse-news-signal-fix.md`

## Pipeline map

```
US: Finnhub /company-news (per symbol)
UK: FMP /news/stock (per symbol, via fmp-news.ts)
  → news-poll-job.ts                   # routes per exchange
  → pre-filter.ts                      # 8 keyword blocks
  → classifier.ts (Haiku)              # single-symbol sentiment
  → research-agent.ts (Sonnet)         # whitelist-filtered, primary symbol pinned
  → fmp.ts fmpValidateSymbol()         # FMP /profile + isActivelyTrading check
  → news_analyses row (always logged)
  → sentiment-writer.ts → quotes_cache # only if validatedTicker=1 AND inUniverse=1
```

## Invariants (do NOT break these)

1. **FMP `/news/stock` is the authoritative source for LSE/AIM symbols.**
   Do not add an RSS, scraper, or third-party fallback. Verified in
   production: RSS feeds are Cloudflare/Incapsula-blocked, LSE RNS is
   a client-rendered SPA. If FMP is down, news is down — quotes are
   also down in that case, so news being down is a non-issue.

2. **The queried symbol is authoritative for attribution.** When
   `fetchFmpCompanyNews(symbol, exchange)` parses a payload, it
   overrides `article.symbols = [symbol]` regardless of what FMP
   returned. The research agent downstream is still responsible for
   identifying additional co-referenced symbols inside the article text.

3. **Research agent output is whitelist-filtered.** Any symbol not in
   a paper strategy universe is dropped before reaching `news_analyses`
   with a logged warning. Do not remove this filter.

4. **Dedup is headline-based.** `processArticle` calls `isHeadlineSeen`,
   which does an exact match on `newsEvents.headline`. Do NOT rely on
   `finnhubId` or `url` for dedup. FMP articles carry `finnhubId: null`
   and that is fine.

5. **The universe is the single source of truth for what gets polled.**
   `news-poll-job.ts` reads strategy universes via `getWatchlistSymbols`.
   Symbols are only polled if at least one paper strategy includes them.
   Out-of-universe symbol *discovery* happens at the research agent
   stage, via co-referenced symbols inside article text — not via the
   fetch layer.

6. **Classifier changes are out of scope.** The classifier is called
   per symbol and is not the source of attribution bugs. If
   classification quality is the problem, propose a spec — do not
   silently retune the classifier prompt.

## Surfacing a new symbol to the news loop

Add it to a strategy's universe. Do NOT add it to a hand-maintained
whitelist or hand-edit the FMP client. The universe is the single
source of truth.

## Related tests

- `tests/news/fmp-news.test.ts`
- `tests/news/research-agent.test.ts`
- `tests/scheduler/news-poll-job-lse.test.ts`
- `src/evals/research-agent/` — regression-gating eval suite
```

- [ ] **Step 2: Commit**

```bash
git add src/news/CLAUDE.md
git commit -m "docs: rewrite src/news/CLAUDE.md for FMP news path

Removes the RSS matcher invariant, alias management, and collision
blacklist (all dead). Adds new invariants: FMP authoritative for
LSE/AIM, queried symbol authoritative for attribution, dedup is
headline-based (finnhubId: null is fine)."
```

### Task 6: Update `src/evals/research-agent/CLAUDE.md`

**Files:**
- Modify: `src/evals/research-agent/CLAUDE.md`

**Scene:** Add a single-line note that the ingestion source changed but the eval corpus remains valid (headline-based, source-independent).

- [ ] **Step 1: Read the current file**

```bash
cat src/evals/research-agent/CLAUDE.md
```

- [ ] **Step 2: Update the spec pointer and add a note**

Replace the `**Canonical spec:**` line (near the top) with:

```markdown
**Canonical spec:** `docs/specs/2026-04-10-lse-news-signal-fix.md` (Section 4)
**Follow-up spec (ingestion layer):** `docs/specs/2026-04-10-lse-news-fmp-migration.md`

This suite remains valid after the FMP migration. The corpus is
headline-based and source-independent; the research agent logic
under test (whitelist filter, primary-symbol pin, attribution)
does not depend on how articles arrive.
```

- [ ] **Step 3: Commit**

```bash
git add src/evals/research-agent/CLAUDE.md
git commit -m "docs: note FMP migration in research-agent eval guide

Eval corpus is headline-based and source-independent — remains
valid after ingestion layer rewrite."
```

### Task 7: Remove `RNS_SCRAPER_ENABLED` from `.env.example`

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Remove the `RNS_SCRAPER_ENABLED` line**

Run:

```bash
grep -n "RNS_SCRAPER_ENABLED" .env.example
```

Expected: one matching line. If present, edit `.env.example` and delete that single line. Keep `RESEARCH_WHITELIST_ENFORCE` and all other variables untouched.

If the grep returns no matches, skip to step 2.

- [ ] **Step 2: Verify nothing else references `RNS_SCRAPER_ENABLED`**

Run:

```bash
grep -rn "RNS_SCRAPER_ENABLED" src/ tests/ scripts/ --include="*.ts"
```

Expected: no output. If any matches, delete those references too — they're reading a config variable that no longer exists.

- [ ] **Step 3: Commit (only if step 1 made a change)**

```bash
git add .env.example
git commit -m "chore: remove RNS_SCRAPER_ENABLED from .env.example

The RNS scraper is deleted; the config flag has no consumers."
```

### Task 8: Three-check gate (full suite)

**Scene:** Before the end-to-end test, confirm typecheck, lint, and the full test suite are all green. This is Acceptance Criterion #4.

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`

Expected: no output (success).

- [ ] **Step 2: Biome lint**

Run: `bunx biome check src/ tests/`

Expected: `Checked N files. No fixes applied.` with exit code 0.

If Biome reports issues, run `bunx biome check --write src/ tests/` to autofix, then re-run `bunx biome check src/ tests/` to verify clean, then commit the formatting fix with message `style: apply biome formatting`.

- [ ] **Step 3: Full test suite**

Run: `bun test --preload ./tests/preload.ts 2>&1 | tail -20`

Expected: Pass count is baseline minus the deleted tests (~560-570 pass), fail count is 2 (the pre-existing `tests/broker/contracts.test.ts` flakies). The FMP news tests and LSE branch test added in this PR all pass.

**Hard stop:** If any new failures appear beyond the 2 baseline flakies, investigate and fix before proceeding. Do not skip to Task 9.

### Task 9: Live end-to-end test against production FMP

**Scene:** This is Acceptance Criterion #6 — the criterion that would have caught PR #4. Run `runNewsPoll` locally with real FMP calls, a local DB seeded with the FTSE-100 universe, and confirm articles actually flow through to `news_analyses` rows. Without this, we are not allowed to merge.

**Files:**
- Create: `scripts/smoke-lse-e2e.ts` (throwaway — deleted in Task 12)

- [ ] **Step 1: Write the end-to-end smoke script**

```ts
// scripts/smoke-lse-e2e.ts
// Throwaway end-to-end smoke test for LSE FMP news path.
// Usage: bun scripts/smoke-lse-e2e.ts
//
// Seeds a temporary paper strategy with the production LSE + AIM
// universe, runs the real news poll, and reports how many articles
// reached news_events.

import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client.ts";
import { newsAnalyses, newsEvents, strategies } from "../src/db/schema.ts";
import { runNewsPoll } from "../src/scheduler/news-poll-job.ts";

const TEST_STRATEGY_NAME = "smoke-lse-e2e";

async function main() {
	const db = getDb();

	// Seed a paper strategy matching the production UK universe.
	// LSE: 6 large-caps (2 dual-listed — BP, VOD — which exercise the fallback).
	// AIM: 5 small-caps (expected to return 0 articles — FMP has no coverage).
	const universe = JSON.stringify([
		"SHEL:LSE",
		"BP.:LSE",
		"HSBA:LSE",
		"VOD:LSE",
		"RIO:LSE",
		"AZN:LSE",
		"GAW:AIM",
		"FDEV:AIM",
		"TET:AIM",
		"JET2:AIM",
		"BOWL:AIM",
	]);

	await db.delete(strategies).where(eq(strategies.name, TEST_STRATEGY_NAME)).execute();
	await db.insert(strategies).values({
		name: TEST_STRATEGY_NAME,
		description: "e2e smoke test strategy",
		parameters: "{}",
		universe,
		status: "paper",
	});

	const beforeEvents = await db.select().from(newsEvents);
	const beforeAnalyses = await db
		.select()
		.from(newsAnalyses)
		.where(eq(newsAnalyses.exchange, "LSE"));

	console.log(`Before: ${beforeEvents.length} news_events, ${beforeAnalyses.length} LSE news_analyses`);
	console.log("Running runNewsPoll()...");
	const startedAt = Date.now();

	await runNewsPoll();

	const elapsedMs = Date.now() - startedAt;
	console.log(`runNewsPoll() completed in ${elapsedMs}ms`);

	const afterEvents = await db.select().from(newsEvents);
	const afterAnalyses = await db
		.select()
		.from(newsAnalyses)
		.where(eq(newsAnalyses.exchange, "LSE"));

	const newEvents = afterEvents.length - beforeEvents.length;
	const newAnalyses = afterAnalyses.length - beforeAnalyses.length;
	console.log(`After: ${afterEvents.length} news_events (+${newEvents}), ${afterAnalyses.length} LSE news_analyses (+${newAnalyses})`);

	// Cleanup: remove the test strategy so it doesn't pollute the local DB
	await db.delete(strategies).where(eq(strategies.name, TEST_STRATEGY_NAME)).execute();

	// Verdict
	if (newEvents === 0) {
		console.error("FAIL: 0 new news_events created. FMP returned no articles or they all failed to process.");
		process.exit(1);
	}
	console.log(`\nPASS: ${newEvents} new news_events written from LSE FMP path.`);
	console.log(`Note: newAnalyses may be 0 if none of the headlines were classified tradeable —`);
	console.log(`that's OK, the research agent is fire-and-forget and may not have completed yet.`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
```

- [ ] **Step 2: Run the end-to-end smoke script**

Run: `bun scripts/smoke-lse-e2e.ts 2>&1 | tee /tmp/lse-e2e-smoke.txt`

Expected:
- Script runs without throwing.
- Log lines include `"Polling FMP news per symbol for LSE/AIM"` and `"FMP news poll complete" ... articles=M` with `M >= 4` on a weekday.
- Verdict is `PASS: N new news_events written from LSE FMP path.` with `N >= 4`.
- Per-symbol expectations on a weekday:
  - SHEL, HSBA, RIO, AZN — expect articles via `.L` primary path
  - BP, VOD — expect articles via US dual-listing fallback (check logs for `"FMP news fetched via US dual-listing fallback"`)
  - GAW, FDEV, TET, JET2, BOWL (AIM) — expect 0 articles each (FMP has no AIM coverage, logged at debug level, not a failure)

**Hard stop — DO NOT MERGE if:**
- The script reports `FAIL:` verdict.
- Fewer than 4 new `news_events` rows are created.
- No `"FMP news poll complete"` log line appears.
- Dual-listing fallback log line never fires (would indicate BP/VOD silently getting 0 articles).
- Any uncaught exception during the run.

If this fails, the implementation is broken regardless of unit tests. Investigate root cause (FMP key, rate limiter, processArticle behavior, DB state, fallback logic) before continuing.

- [ ] **Step 3: Capture the output for the PR description**

```bash
cat /tmp/lse-e2e-smoke.txt
```

This output must be pasted into the PR description under an "End-to-end smoke test" section. No merge without it.

- [ ] **Step 4: Do NOT commit the smoke script**

Leave `scripts/smoke-lse-e2e.ts` uncommitted. It gets deleted in Task 12.

### Task 10: Research-agent eval suite run

**Scene:** Acceptance Criterion #5 — the existing research-agent eval suite (32 tasks) must still pass ≥90% on Categories A, B, C across 3 trials. This ensures the research agent whitelist/pin logic still works against the FMP-fed headlines.

- [ ] **Step 1: Run the eval suite**

Run: `bun src/evals/run.ts research-agent 2>&1 | tee /tmp/research-agent-evals.txt`

Expected:
- All 32 tasks execute.
- Categories A, B, C each show pass rate ≥90% across 3 trials.
- Categories D, E are tracked but not blocking.

- [ ] **Step 2: Check for regressions**

If any blocking category drops below 90%, STOP. The research agent or whitelist logic may have regressed. Investigate before continuing.

- [ ] **Step 3: Capture the output for the PR description**

```bash
cat /tmp/research-agent-evals.txt | tail -50
```

This summary must be pasted into the PR description under a "Research agent eval results" section.

### Task 11: Final three-check gate

**Scene:** Re-run the three-check gate after any cleanup. Belt and braces.

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no output.

- [ ] **Step 2: Biome lint**

Run: `bunx biome check src/ tests/`
Expected: `Checked N files. No fixes applied.`

- [ ] **Step 3: Full test suite**

Run: `bun test --preload ./tests/preload.ts 2>&1 | tail -10`
Expected: Same pass/fail as end of Task 8.

### Task 12: Delete throwaway smoke scripts and prepare PR

**Files:**
- Delete: `scripts/smoke-fmp-news.ts`
- Delete: `scripts/smoke-lse-e2e.ts`

- [ ] **Step 1: Delete the smoke scripts (they were never committed)**

```bash
rm scripts/smoke-fmp-news.ts scripts/smoke-lse-e2e.ts
```

- [ ] **Step 2: Verify clean working tree**

```bash
git status
```

Expected: Shows only the intentional changes from Tasks 1–7. No untracked smoke scripts. No uncommitted modifications.

- [ ] **Step 3: Push the branch**

```bash
git push -u origin feature/lse-news-fmp-migration
```

- [ ] **Step 4: Open the PR with required evidence**

Use `gh pr create` with a body that includes ALL of the following (per spec Acceptance Criteria):

```
## Summary
- Replace broken RSS + RNS UK news path with FMP /news/stock per-symbol calls
- Delete 4 source files + 3 test files (RSS, RNS, alias overrides, feed config)
- Rewrite src/news/CLAUDE.md invariants for new pipeline
- No schema changes (dedup is already headline-based)

## Spec
docs/specs/2026-04-10-lse-news-fmp-migration.md

## Acceptance evidence

### 1. Pre-implementation live FMP smoke test (Criterion #1)
<paste /tmp/fmp-news-smoke.txt contents>

### 2-4. Three-check gate + unit/integration tests (Criteria #2, #3, #4)
- `bunx tsc --noEmit` — green
- `bunx biome check src/ tests/` — green
- `bun test --preload ./tests/preload.ts` — N pass / 2 pre-existing baseline fails

### 5. Research agent eval suite (Criterion #5)
<paste /tmp/research-agent-evals.txt tail>

### 6. End-to-end smoke test against production FMP (Criterion #6)
<paste /tmp/lse-e2e-smoke.txt contents>

## Post-merge (Criterion #7)
Will SSH to VPS during uk_session and confirm 'FMP news poll complete' log with articles > 0. Will revert immediately if not.

## Test plan
- [x] bunx tsc --noEmit
- [x] bunx biome check
- [x] bun test (full suite)
- [x] Live FMP endpoint smoke test
- [x] Live end-to-end smoke test
- [x] Research agent eval suite
- [ ] Post-merge production smoke test (manual)
```

**Hard stop:** Do NOT mark the PR ready-for-merge unless all 6 evidence sections above are filled in with real output. An empty section means the test wasn't run.

---

## Post-merge verification (MANUAL — Acceptance Criterion #7)

After the PR is merged and GitHub Actions deploys to the VPS:

1. Wait for the next `uk_session` news poll cycle (or trigger manually if tooling supports it).
2. Tail production logs: `./scripts/vps-logs.sh -f`
3. Look for the log line: `"FMP news poll complete" ... articles=M` with `M > 0`.
4. If `M = 0` or the log line does not appear within 15 minutes of the next cron tick: **revert immediately**.
5. Query `news_analyses` on the VPS for LSE rows created after deploy time:
   ```bash
   ./scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db \"SELECT symbol, headline, created_at FROM news_analyses WHERE exchange='LSE' AND created_at > datetime('now', '-1 hour') LIMIT 10;\""
   ```
   Expected: at least one row within an hour of deploy.

This step is MANUAL. It is the final acceptance gate. The PR is considered "shipped" only after step 5 returns a non-empty result.
