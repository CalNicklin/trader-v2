# US Profile Enricher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace FMP `/v3/profile/` (now 403 Legacy for our account) with a free-source US enrichment stack that gives Russell 1000 rows enough data to pass the liquidity filter.

**Architecture:** Combine three free endpoints — (1) SEC EDGAR `company_tickers.json` for ticker↔CIK mapping, (2) SEC EDGAR `/api/xbrl/frames/` bulk endpoint for `CommonStockSharesOutstanding`, (3) Yahoo v8 chart for price + `firstTradeDate` — to compute `marketCapUsd` = sharesOutstanding × price. Plus a `symbol_ciks` cache table.

**Tech Stack:** Bun + TypeScript, SQLite/Drizzle, existing `yahoo-uk.ts` pattern mirrored for US.

**Verification gate:** `scripts/universe-refresh-smoke-test.ts` must show ≥700 Russell 1000 post-filter rows before the PR is opened. This is a hard gate — the previous PR (#37) shipped a regression because this check didn't exist.

---

## File Structure

**New files:**
- `drizzle/migrations/0017_<drizzle-generated>.sql` — migration for `symbol_ciks` table
- `src/universe/ciks/edgar-ticker-map.ts` — fetch + cache `company_tickers.json`
- `src/universe/enrichers/edgar-shares-frames.ts` — fetch bulk shares-outstanding via XBRL frames endpoint
- `src/universe/enrichers/yahoo-us.ts` — fetch Yahoo chart for US symbols (mirror of `yahoo-uk.ts`)
- `src/universe/enrichers/us-profile.ts` — compose CIK map + frames + Yahoo into a profile map
- `tests/universe/ciks/edgar-ticker-map.test.ts`
- `tests/universe/enrichers/edgar-shares-frames.test.ts`
- `tests/universe/enrichers/yahoo-us.test.ts`
- `tests/universe/enrichers/us-profile.test.ts`

**Modified files:**
- `src/db/schema.ts` — add `symbolCiks` table
- `src/universe/metrics-enricher.ts` — dispatch US rows to new composer instead of FMP profile
- `scripts/universe-refresh-smoke-test.ts` — raise expected `russell_1000` post-filter count to 700
- `tests/universe/metrics-enricher.test.ts` — update any US tests that assumed FMP profile path

---

## Task 1: Schema — symbol_ciks table

**Files:**
- Create: `drizzle/migrations/0017_<drizzle-generated>.sql`
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add `symbolCiks` table to schema.ts**

Append below the existing `symbolProfiles` table:

```typescript
export const symbolCiks = sqliteTable(
	"symbol_ciks",
	{
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		cik: integer("cik").notNull(),
		entityName: text("entity_name"),
		source: text("source").notNull().default("sec_company_tickers"),
		fetchedAt: text("fetched_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.symbol, table.exchange] }),
		cikIdx: index("symbol_ciks_cik_idx").on(table.cik),
	}),
);
```

Required imports at top of file (add if missing): `primaryKey`. All other imports are already present.

- [ ] **Step 2: Generate migration**

```bash
bunx drizzle-kit generate
```

Expected: creates `drizzle/migrations/0017_<auto-name>.sql` with `CREATE TABLE` for `symbol_ciks` plus the index. Do NOT rename the file.

- [ ] **Step 3: Verify migration applies cleanly**

```bash
rm -f data/test-migration.db
bun -e 'import { Database } from "bun:sqlite"; import { drizzle } from "drizzle-orm/bun-sqlite"; import { migrate } from "drizzle-orm/bun-sqlite/migrator"; const db = drizzle(new Database("data/test-migration.db")); migrate(db, { migrationsFolder: "./drizzle/migrations" }); console.log("migrations applied");'
rm data/test-migration.db
```

Expected: `migrations applied`.

- [ ] **Step 4: Typecheck + test**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
```

Expected: typecheck clean; 843 tests pass (no change; we haven't added tests yet).

- [ ] **Step 5: Commit**

```bash
git add drizzle/migrations/ src/db/schema.ts
git commit -m "feat(universe): symbol_ciks table for EDGAR CIK mapping"
```

---

## Task 2: EDGAR ticker→CIK map (fetch + cache)

**Files:**
- Create: `src/universe/ciks/edgar-ticker-map.ts`
- Create: `tests/universe/ciks/edgar-ticker-map.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/universe/ciks/edgar-ticker-map.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../../src/db/client.ts";
import { symbolCiks } from "../../../src/db/schema.ts";
import {
	getCikForSymbol,
	refreshCikMap,
} from "../../../src/universe/ciks/edgar-ticker-map.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

const SAMPLE_RESPONSE = {
	"0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
	"1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corp" },
	"2": { cik_str: 1018724, ticker: "AMZN", title: "Amazon.com Inc." },
};

describe("refreshCikMap", () => {
	test("upserts rows from SEC company_tickers response", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_RESPONSE,
		});
		const count = await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });
		expect(count).toBe(3);

		const rows = await getDb().select().from(symbolCiks).all();
		expect(rows.length).toBe(3);
		const aapl = rows.find((r) => r.symbol === "AAPL");
		expect(aapl?.cik).toBe(320193);
		expect(aapl?.entityName).toBe("Apple Inc.");
	});

	test("idempotent — second call updates rather than duplicates", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_RESPONSE,
		});
		await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });
		await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });
		const rows = await getDb().select().from(symbolCiks).all();
		expect(rows.length).toBe(3);
	});

	test("throws on non-200", async () => {
		const fetchStub = async () => ({ ok: false, status: 500, json: async () => ({}) });
		await expect(
			refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch }),
		).rejects.toThrow(/SEC company_tickers/);
	});
});

describe("getCikForSymbol", () => {
	test("returns CIK for cached symbol", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_RESPONSE,
		});
		await refreshCikMap({ fetchImpl: fetchStub as unknown as typeof fetch });
		const cik = await getCikForSymbol("AAPL", "NASDAQ");
		expect(cik).toBe(320193);
	});

	test("returns null for unknown symbol", async () => {
		const cik = await getCikForSymbol("ZZZZZ", "NASDAQ");
		expect(cik).toBeNull();
	});
});
```

Run: `bun test tests/universe/ciks/edgar-ticker-map.test.ts --preload ./tests/preload.ts`. Expected: FAIL (module not found).

- [ ] **Step 2: Implement the module**

Create `src/universe/ciks/edgar-ticker-map.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client.ts";
import { symbolCiks } from "../../db/schema.ts";
import { createChildLogger } from "../../utils/logger.ts";

const log = createChildLogger({ module: "edgar-ticker-map" });

// SEC requires a descriptive User-Agent. Official guidance says to include an
// email or app identifier.
const EDGAR_UA = "trader-v2 (cal@nicklin.io)";
const COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

export interface RefreshCikMapInput {
	fetchImpl?: typeof fetch;
}

export async function refreshCikMap(input: RefreshCikMapInput = {}): Promise<number> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const res = await fetchImpl(COMPANY_TICKERS_URL, {
		headers: { "User-Agent": EDGAR_UA },
	});
	if (!res.ok) {
		throw new Error(`SEC company_tickers request failed: ${res.status}`);
	}
	const data = (await res.json()) as Record<
		string,
		{ cik_str: number; ticker: string; title: string }
	>;

	const db = getDb();
	const now = new Date().toISOString();
	let count = 0;

	// SEC's file doesn't report which exchange each ticker lives on, so we store
	// both NASDAQ and NYSE variants. The active-universe row's `exchange` field
	// determines which we look up. This means we need to insert a row per
	// exchange per ticker. We use the submission data later (from EDGAR's
	// /submissions endpoint) to pick the "real" exchange, but for v1 we just
	// store NASDAQ (most Russell 1000 names) and accept that NYSE lookups
	// fall back to the symbol-only match.
	for (const entry of Object.values(data)) {
		for (const exchange of ["NASDAQ", "NYSE"]) {
			await db
				.insert(symbolCiks)
				.values({
					symbol: entry.ticker,
					exchange,
					cik: entry.cik_str,
					entityName: entry.title,
					source: "sec_company_tickers",
					fetchedAt: now,
				})
				.onConflictDoUpdate({
					target: [symbolCiks.symbol, symbolCiks.exchange],
					set: { cik: entry.cik_str, entityName: entry.title, fetchedAt: now },
				});
		}
		count++;
	}
	log.info({ count }, "CIK map refreshed");
	return count;
}

export async function getCikForSymbol(
	symbol: string,
	exchange: string,
): Promise<number | null> {
	const db = getDb();
	const row = await db
		.select({ cik: symbolCiks.cik })
		.from(symbolCiks)
		.where(and(eq(symbolCiks.symbol, symbol), eq(symbolCiks.exchange, exchange)))
		.get();
	return row?.cik ?? null;
}

export async function getCiksForSymbols(
	refs: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, number>> {
	if (refs.length === 0) return new Map();
	const db = getDb();
	// Batch into chunks of 100 to stay under SQLite expression-tree limit
	// (same bug we hit in getProfiles in PR #39).
	const BATCH = 100;
	const out = new Map<string, number>();
	for (let i = 0; i < refs.length; i += BATCH) {
		const batch = refs.slice(i, i + BATCH);
		// Build OR clause: (symbol=X AND exchange=Y) OR ...
		const rows = await db
			.select()
			.from(symbolCiks)
			.where(
				// biome-ignore lint/style/noNonNullAssertion: batch is always non-empty
				batch.map((r) => and(eq(symbolCiks.symbol, r.symbol), eq(symbolCiks.exchange, r.exchange)))
					.reduce((acc, cond) => (acc ? acc : cond))!,
			)
			.all();
		// Simpler approach: just fetch all and filter in-memory — the table is
		// ~10k rows, which is fine to scan. Replace the where-clause above with
		// a flat select and filter here if the query builder gets hairy.
		for (const r of rows) {
			out.set(`${r.symbol}:${r.exchange}`, r.cik);
		}
	}
	return out;
}
```

**Note:** the `getCiksForSymbols` batch implementation above is provisional. If the OR-chain approach is awkward, the simpler implementation is:

```typescript
// Fallback: just fetch all and filter in-memory. Symbol_ciks is ~20k rows
// (10k tickers × 2 exchanges), which is fine to scan.
export async function getCiksForSymbols(
	refs: Array<{ symbol: string; exchange: string }>,
): Promise<Map<string, number>> {
	if (refs.length === 0) return new Map();
	const db = getDb();
	const all = await db.select().from(symbolCiks).all();
	const allMap = new Map(all.map((r) => [`${r.symbol}:${r.exchange}`, r.cik]));
	const out = new Map<string, number>();
	for (const ref of refs) {
		const cik = allMap.get(`${ref.symbol}:${ref.exchange}`);
		if (cik != null) out.set(`${ref.symbol}:${ref.exchange}`, cik);
	}
	return out;
}
```

Implementer: use the in-memory scan version above. 20k-row scan is trivially fast and avoids the SQL complexity.

Run: `bun test tests/universe/ciks/edgar-ticker-map.test.ts --preload ./tests/preload.ts`. Expected: PASS (5 tests).

- [ ] **Step 3: Verification gate**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/universe/ciks/ tests/universe/ciks/
```

Test count: 843 + 5 = 848.

- [ ] **Step 4: Commit**

```bash
git add src/universe/ciks/ tests/universe/ciks/
git commit -m "feat(universe): EDGAR ticker→CIK map with cache"
```

---

## Task 3: EDGAR shares-outstanding frames fetcher

**Files:**
- Create: `src/universe/enrichers/edgar-shares-frames.ts`
- Create: `tests/universe/enrichers/edgar-shares-frames.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/universe/enrichers/edgar-shares-frames.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { fetchSharesOutstandingFrames } from "../../../src/universe/enrichers/edgar-shares-frames.ts";

const SAMPLE_FRAMES_RESPONSE = {
	taxonomy: "us-gaap",
	tag: "CommonStockSharesOutstanding",
	ccp: "CY2025Q4I",
	uom: "shares",
	pts: 3,
	data: [
		{ accn: "0001193125-26-102079", cik: 320193, entityName: "Apple Inc.", val: 14681140000, end: "2025-12-31" },
		{ accn: "0001193125-26-100001", cik: 789019, entityName: "Microsoft Corp", val: 7430000000, end: "2025-12-31" },
		{ accn: "0001193125-26-100002", cik: 1018724, entityName: "Amazon.com Inc.", val: 10500000000, end: "2025-12-31" },
	],
};

describe("fetchSharesOutstandingFrames", () => {
	test("returns a Map<cik, sharesOutstanding> for the given quarter", async () => {
		const fetchStub = async (_url: string) => ({
			ok: true,
			status: 200,
			json: async () => SAMPLE_FRAMES_RESPONSE,
		});
		const out = await fetchSharesOutstandingFrames({
			quarter: "CY2025Q4I",
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(out.size).toBe(3);
		expect(out.get(320193)).toBe(14681140000);
		expect(out.get(789019)).toBe(7430000000);
	});

	test("throws on non-200", async () => {
		const fetchStub = async () => ({ ok: false, status: 404, json: async () => ({}) });
		await expect(
			fetchSharesOutstandingFrames({
				quarter: "CY2025Q4I",
				fetchImpl: fetchStub as unknown as typeof fetch,
			}),
		).rejects.toThrow(/EDGAR frames/);
	});

	test("uses the configured quarter in the URL", async () => {
		let seenUrl = "";
		const fetchStub = async (url: string) => {
			seenUrl = url;
			return { ok: true, status: 200, json: async () => SAMPLE_FRAMES_RESPONSE };
		};
		await fetchSharesOutstandingFrames({
			quarter: "CY2025Q3I",
			fetchImpl: fetchStub as unknown as typeof fetch,
		});
		expect(seenUrl).toContain("CY2025Q3I");
	});
});
```

Run: confirm FAIL.

- [ ] **Step 2: Implement the module**

Create `src/universe/enrichers/edgar-shares-frames.ts`:

```typescript
import { createChildLogger } from "../../utils/logger.ts";

const log = createChildLogger({ module: "edgar-shares-frames" });

const EDGAR_UA = "trader-v2 (cal@nicklin.io)";

// Example: CY2025Q4I → Calendar Year 2025 Q4 Instant (2025-12-31).
// "I" (instant) gives point-in-time values like sharesOutstanding.
export type FramesQuarter = `CY${number}Q${1 | 2 | 3 | 4}I`;

export interface FramesFetchInput {
	quarter: FramesQuarter;
	fetchImpl?: typeof fetch;
}

interface FramesResponse {
	taxonomy: string;
	tag: string;
	ccp: string;
	data: Array<{ cik: number; entityName?: string; val: number; end: string }>;
}

export async function fetchSharesOutstandingFrames(
	input: FramesFetchInput,
): Promise<Map<number, number>> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const url = `https://data.sec.gov/api/xbrl/frames/us-gaap/CommonStockSharesOutstanding/shares/${input.quarter}.json`;
	const res = await fetchImpl(url, { headers: { "User-Agent": EDGAR_UA } });
	if (!res.ok) {
		throw new Error(`EDGAR frames request failed: ${res.status} for ${input.quarter}`);
	}
	const data = (await res.json()) as FramesResponse;
	const out = new Map<number, number>();
	for (const row of data.data) {
		out.set(row.cik, row.val);
	}
	log.info(
		{ quarter: input.quarter, count: out.size },
		"EDGAR shares-outstanding frames fetched",
	);
	return out;
}

// Helper: pick the most-recent completed quarter as of `now`.
export function mostRecentCompletedQuarter(now: Date): FramesQuarter {
	// Quarter ends: Mar 31, Jun 30, Sep 30, Dec 31. We want the most recent
	// END that has already passed. Add a ~45-day lag since companies file 10-K
	// within 60–90 days of quarter-end.
	const lagged = new Date(now.getTime() - 45 * 86400_000);
	const year = lagged.getUTCFullYear();
	const month = lagged.getUTCMonth() + 1; // 1..12
	let q: 1 | 2 | 3 | 4;
	let yy = year;
	if (month <= 3) { q = 4; yy = year - 1; }
	else if (month <= 6) { q = 1; }
	else if (month <= 9) { q = 2; }
	else { q = 3; }
	return `CY${yy}Q${q}I` as FramesQuarter;
}
```

Run: expect 3 tests PASS.

- [ ] **Step 3: Add quarter-picker test**

Append to `tests/universe/enrichers/edgar-shares-frames.test.ts`:

```typescript
import { mostRecentCompletedQuarter } from "../../../src/universe/enrichers/edgar-shares-frames.ts";

describe("mostRecentCompletedQuarter", () => {
	test("returns Q4 of previous year when called mid-Feb", () => {
		expect(mostRecentCompletedQuarter(new Date("2026-02-15T00:00:00Z"))).toBe("CY2025Q4I");
	});

	test("returns Q1 when called mid-June", () => {
		expect(mostRecentCompletedQuarter(new Date("2026-06-15T00:00:00Z"))).toBe("CY2026Q1I");
	});

	test("returns Q3 when called mid-November", () => {
		expect(mostRecentCompletedQuarter(new Date("2026-11-15T00:00:00Z"))).toBe("CY2026Q3I");
	});
});
```

Run: confirm all 6 tests PASS.

- [ ] **Step 4: Verification gate + commit**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/universe/enrichers/edgar-shares-frames.ts tests/universe/enrichers/edgar-shares-frames.test.ts
git add src/universe/enrichers/edgar-shares-frames.ts tests/universe/enrichers/edgar-shares-frames.test.ts
git commit -m "feat(universe): EDGAR shares-outstanding frames fetcher"
```

Test count: 848 + 6 = 854.

---

## Task 4: Yahoo US chart enricher (mirror yahoo-uk.ts)

**Files:**
- Create: `src/universe/enrichers/yahoo-us.ts`
- Create: `tests/universe/enrichers/yahoo-us.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/universe/enrichers/yahoo-us.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { fetchYahooUsQuotes } from "../../../src/universe/enrichers/yahoo-us.ts";
import type { ConstituentRow } from "../../../src/universe/sources.ts";

describe("fetchYahooUsQuotes", () => {
	test("fetches price + 30d avg volume + firstTradeDate for each US row", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }, // should be skipped
		];
		const calls: string[] = [];
		const fetchImpl = async (url: string) => {
			calls.push(url);
			return {
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
									regularMarketPrice: 270.23,
									firstTradeDate: 345479400, // 1980-12-12
								},
								indicators: {
									quote: [
										{
											close: [270, 271, 269, 272, 270],
											volume: [50_000_000, 52_000_000, 48_000_000, 51_000_000, 50_000_000],
										},
									],
								},
							},
						],
					},
				}),
			};
		};
		const out = await fetchYahooUsQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(calls.length).toBe(1);
		expect(calls[0]).toContain("chart/AAPL");
		expect(out.size).toBe(1);
		const aapl = out.get("AAPL:NASDAQ");
		expect(aapl?.priceUsd).toBe(270.23);
		expect(aapl?.avgVolume30d).toBeCloseTo(50_200_000);
		expect(aapl?.avgDollarVolumeUsd).toBeCloseTo(270.23 * 50_200_000);
		expect(aapl?.ipoDate).toBe("1980-12-12");
	});

	test("skips UK rows entirely", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" },
		];
		const fetchImpl = async () => {
			throw new Error("should not be called");
		};
		const out = await fetchYahooUsQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(out.size).toBe(0);
	});

	test("gracefully skips symbols that Yahoo 404s", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "BOGUS", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const fetchImpl = async (url: string) => {
			if (url.includes("BOGUS")) {
				return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
			}
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({
					chart: {
						result: [
							{
								meta: { symbol: "AAPL", currency: "USD", regularMarketPrice: 270 },
								indicators: { quote: [{ close: [270], volume: [50_000_000] }] },
							},
						],
					},
				}),
			};
		};
		const out = await fetchYahooUsQuotes(rows, {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		expect(out.size).toBe(1);
		expect(out.has("AAPL:NASDAQ")).toBe(true);
		expect(out.has("BOGUS:NASDAQ")).toBe(false);
	});
});
```

Run: confirm FAIL.

- [ ] **Step 2: Implement `yahoo-us.ts`**

Create `src/universe/enrichers/yahoo-us.ts`. Mirror of `yahoo-uk.ts`, but:
- US symbol has no `.L` suffix
- Price is USD native (no FX conversion)
- Exposes `firstTradeDate` as `ipoDate` (epoch-seconds → ISO `YYYY-MM-DD`)

```typescript
import { createChildLogger } from "../../utils/logger.ts";
import type { ConstituentRow } from "../sources.ts";

const log = createChildLogger({ module: "yahoo-us-enricher" });

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const BATCH_CONCURRENCY = 4;

interface YahooChartResponse {
	chart: {
		result?: Array<{
			meta: {
				symbol: string;
				currency: string;
				regularMarketPrice: number;
				firstTradeDate?: number;
			};
			indicators: {
				quote: Array<{ close: (number | null)[]; volume: (number | null)[] }>;
			};
		}>;
		error?: { code: string; description: string };
	};
}

export interface YahooUsQuote {
	symbol: string;
	exchange: string;
	priceUsd: number;
	avgVolume30d: number;
	avgDollarVolumeUsd: number;
	ipoDate: string | null; // ISO YYYY-MM-DD
}

export interface YahooUsEnrichDeps {
	fetchImpl?: typeof fetch;
}

// Fetches Yahoo chart data for US rows (russell_1000). Returns a map keyed by
// `${symbol}:${exchange}` with price, 30d avg volume, USD-denominated $ADV,
// and an IPO date proxy from `firstTradeDate`.
export async function fetchYahooUsQuotes(
	rows: ConstituentRow[],
	deps: YahooUsEnrichDeps = {},
): Promise<Map<string, YahooUsQuote>> {
	const usRows = rows.filter((r) => r.exchange === "NASDAQ" || r.exchange === "NYSE");
	if (usRows.length === 0) return new Map();

	const fetchImpl = deps.fetchImpl ?? fetch;
	const out = new Map<string, YahooUsQuote>();

	for (let i = 0; i < usRows.length; i += BATCH_CONCURRENCY) {
		const batch = usRows.slice(i, i + BATCH_CONCURRENCY);
		const results = await Promise.all(batch.map((r) => fetchOne(r, fetchImpl)));
		for (const q of results) {
			if (q) out.set(`${q.symbol}:${q.exchange}`, q);
		}
	}

	log.info({ requested: usRows.length, fetched: out.size }, "Yahoo US quotes enrichment complete");
	return out;
}

async function fetchOne(
	row: ConstituentRow,
	fetchImpl: typeof fetch,
): Promise<YahooUsQuote | null> {
	const url = `https://query1.finance.yahoo.com/v8/finance/chart/${row.symbol}?interval=1d&range=30d`;
	try {
		const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT } });
		if (!res.ok) {
			log.debug({ symbol: row.symbol, status: res.status }, "Yahoo chart non-200");
			return null;
		}
		const data = (await res.json()) as YahooChartResponse;
		if (data.chart.error) return null;
		const result = data.chart.result?.[0];
		if (!result) return null;

		const volumes = result.indicators.quote[0]?.volume ?? [];
		const validVols = volumes.filter((v): v is number => typeof v === "number" && v > 0);
		if (validVols.length === 0) return null;

		const avgVolume30d = validVols.reduce((a, b) => a + b, 0) / validVols.length;
		const priceUsd = result.meta.regularMarketPrice;
		const avgDollarVolumeUsd = priceUsd * avgVolume30d;
		const ipoDate = result.meta.firstTradeDate
			? new Date(result.meta.firstTradeDate * 1000).toISOString().slice(0, 10)
			: null;

		return {
			symbol: row.symbol,
			exchange: row.exchange,
			priceUsd,
			avgVolume30d,
			avgDollarVolumeUsd,
			ipoDate,
		};
	} catch (err) {
		log.debug(
			{ symbol: row.symbol, err: err instanceof Error ? err.message : String(err) },
			"Yahoo chart request failed",
		);
		return null;
	}
}
```

Run: confirm 3 tests PASS.

- [ ] **Step 3: Verification gate + commit**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/universe/enrichers/yahoo-us.ts tests/universe/enrichers/yahoo-us.test.ts
git add src/universe/enrichers/yahoo-us.ts tests/universe/enrichers/yahoo-us.test.ts
git commit -m "feat(universe): Yahoo US chart enricher (mirror of UK)"
```

Test count: 854 + 3 = 857.

---

## Task 5: US profile composer

**Files:**
- Create: `src/universe/enrichers/us-profile.ts`
- Create: `tests/universe/enrichers/us-profile.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/universe/enrichers/us-profile.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { fetchUsProfiles } from "../../../src/universe/enrichers/us-profile.ts";
import type { ConstituentRow } from "../../../src/universe/sources.ts";

describe("fetchUsProfiles", () => {
	test("composes CIK map + frames + Yahoo into a profile Map", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "MSFT", exchange: "NASDAQ", indexSource: "russell_1000" },
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }, // skipped
		];

		const cikMap = new Map<string, number>([
			["AAPL:NASDAQ", 320193],
			["MSFT:NASDAQ", 789019],
		]);

		const sharesMap = new Map<number, number>([
			[320193, 14_681_140_000],
			[789019, 7_430_000_000],
		]);

		const yahooMap = new Map<string, { priceUsd: number; avgVolume30d: number; avgDollarVolumeUsd: number; ipoDate: string | null; symbol: string; exchange: string }>([
			[
				"AAPL:NASDAQ",
				{
					symbol: "AAPL",
					exchange: "NASDAQ",
					priceUsd: 270.23,
					avgVolume30d: 50_000_000,
					avgDollarVolumeUsd: 270.23 * 50_000_000,
					ipoDate: "1980-12-12",
				},
			],
			[
				"MSFT:NASDAQ",
				{
					symbol: "MSFT",
					exchange: "NASDAQ",
					priceUsd: 420,
					avgVolume30d: 20_000_000,
					avgDollarVolumeUsd: 420 * 20_000_000,
					ipoDate: "1986-03-13",
				},
			],
		]);

		const out = await fetchUsProfiles(rows, {
			getCiks: async () => cikMap,
			getSharesFrames: async () => sharesMap,
			getYahooQuotes: async () => yahooMap,
		});

		expect(out.size).toBe(2);
		const aapl = out.get("AAPL:NASDAQ");
		expect(aapl?.sharesOutstanding).toBe(14_681_140_000);
		expect(aapl?.priceUsd).toBe(270.23);
		expect(aapl?.marketCapUsd).toBeCloseTo(14_681_140_000 * 270.23);
		expect(aapl?.ipoDate).toBe("1980-12-12");
	});

	test("returns partial data when frames is missing a CIK (use Yahoo only)", async () => {
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const out = await fetchUsProfiles(rows, {
			getCiks: async () => new Map([["AAPL:NASDAQ", 320193]]),
			getSharesFrames: async () => new Map(), // no shares data
			getYahooQuotes: async () =>
				new Map([
					[
						"AAPL:NASDAQ",
						{
							symbol: "AAPL",
							exchange: "NASDAQ",
							priceUsd: 270,
							avgVolume30d: 50_000_000,
							avgDollarVolumeUsd: 270 * 50_000_000,
							ipoDate: "1980-12-12",
						},
					],
				]),
		});
		const aapl = out.get("AAPL:NASDAQ");
		expect(aapl?.priceUsd).toBe(270);
		expect(aapl?.marketCapUsd).toBeNull();
		expect(aapl?.sharesOutstanding).toBeNull();
	});

	test("returns empty map when no US rows", async () => {
		const out = await fetchUsProfiles(
			[{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" }],
			{
				getCiks: async () => new Map(),
				getSharesFrames: async () => new Map(),
				getYahooQuotes: async () => new Map(),
			},
		);
		expect(out.size).toBe(0);
	});
});
```

Run: confirm FAIL.

- [ ] **Step 2: Implement `us-profile.ts`**

Create `src/universe/enrichers/us-profile.ts`:

```typescript
import { createChildLogger } from "../../utils/logger.ts";
import { getCiksForSymbols } from "../ciks/edgar-ticker-map.ts";
import type { ConstituentRow } from "../sources.ts";
import {
	fetchSharesOutstandingFrames,
	type FramesQuarter,
	mostRecentCompletedQuarter,
} from "./edgar-shares-frames.ts";
import { fetchYahooUsQuotes, type YahooUsQuote } from "./yahoo-us.ts";

const log = createChildLogger({ module: "us-profile-composer" });

export interface UsProfile {
	symbol: string;
	exchange: string;
	sharesOutstanding: number | null;
	priceUsd: number | null;
	marketCapUsd: number | null;
	avgVolume30d: number | null;
	avgDollarVolumeUsd: number | null;
	ipoDate: string | null;
}

export interface UsProfileDeps {
	getCiks?: (refs: Array<{ symbol: string; exchange: string }>) => Promise<Map<string, number>>;
	getSharesFrames?: (quarter: FramesQuarter) => Promise<Map<number, number>>;
	getYahooQuotes?: (rows: ConstituentRow[]) => Promise<Map<string, YahooUsQuote>>;
	now?: Date;
}

export async function fetchUsProfiles(
	rows: ConstituentRow[],
	deps: UsProfileDeps = {},
): Promise<Map<string, UsProfile>> {
	const usRows = rows.filter((r) => r.exchange === "NASDAQ" || r.exchange === "NYSE");
	if (usRows.length === 0) return new Map();

	const getCiks = deps.getCiks ?? getCiksForSymbols;
	const getShares = deps.getSharesFrames ?? ((q: FramesQuarter) => fetchSharesOutstandingFrames({ quarter: q }));
	const getYahoo = deps.getYahooQuotes ?? fetchYahooUsQuotes;
	const now = deps.now ?? new Date();

	const quarter = mostRecentCompletedQuarter(now);
	// Fetch in parallel — each is independent
	const [cikMap, sharesMap, yahooMap] = await Promise.all([
		getCiks(usRows.map((r) => ({ symbol: r.symbol, exchange: r.exchange }))),
		getShares(quarter).catch((err) => {
			log.warn({ err: err instanceof Error ? err.message : String(err), quarter }, "Shares frames fetch failed — marketCap will be null");
			return new Map<number, number>();
		}),
		getYahoo(usRows),
	]);

	const out = new Map<string, UsProfile>();
	for (const row of usRows) {
		const key = `${row.symbol}:${row.exchange}`;
		const cik = cikMap.get(key);
		const shares = cik != null ? sharesMap.get(cik) ?? null : null;
		const yq = yahooMap.get(key);
		const marketCap = shares != null && yq?.priceUsd != null ? shares * yq.priceUsd : null;
		out.set(key, {
			symbol: row.symbol,
			exchange: row.exchange,
			sharesOutstanding: shares,
			priceUsd: yq?.priceUsd ?? null,
			marketCapUsd: marketCap,
			avgVolume30d: yq?.avgVolume30d ?? null,
			avgDollarVolumeUsd: yq?.avgDollarVolumeUsd ?? null,
			ipoDate: yq?.ipoDate ?? null,
		});
	}
	log.info(
		{
			requested: usRows.length,
			withShares: [...out.values()].filter((v) => v.sharesOutstanding != null).length,
			withPrice: [...out.values()].filter((v) => v.priceUsd != null).length,
			quarter,
		},
		"US profiles composed",
	);
	return out;
}
```

Run: confirm all 3 tests PASS.

- [ ] **Step 3: Verification gate + commit**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/universe/enrichers/us-profile.ts tests/universe/enrichers/us-profile.test.ts
git add src/universe/enrichers/us-profile.ts tests/universe/enrichers/us-profile.test.ts
git commit -m "feat(universe): US profile composer (CIK + frames + Yahoo)"
```

Test count: 857 + 3 = 860.

---

## Task 6: Wire into metrics-enricher

**Files:**
- Modify: `src/universe/metrics-enricher.ts`
- Modify: `tests/universe/metrics-enricher.test.ts`

- [ ] **Step 1: Update metrics-enricher to use US profile composer**

Modify `src/universe/metrics-enricher.ts`:

1. Add import near the existing ones:

```typescript
import { fetchUsProfiles, type UsProfile } from "./enrichers/us-profile.ts";
```

2. Add optional injection point in `EnrichOptions`:

```typescript
export interface EnrichOptions {
	fetchImpl?: FetchLike;
	yahooUkEnricher?: (rows: ConstituentRow[]) => Promise<Map<string, YahooUkQuote>>;
	usProfileEnricher?: (rows: ConstituentRow[]) => Promise<Map<string, UsProfile>>;
}
```

3. Replace the `resolveProfiles` call in `enrichWithMetrics` with a new composer:

Find:

```typescript
	const profiles = await resolveProfiles(rows, options.fetchImpl ?? fetch);
```

Replace with:

```typescript
	const usProfiles = await safeUsProfiles(rows, options.usProfileEnricher);
```

4. Delete the helper `resolveProfiles` and the `profile-fetcher.ts` import if unused. (Keep `profile-fetcher.ts` on disk for now — some other code path may reference `upsertProfiles`; verify with grep before removal in a follow-up task.)

5. Update `enrichOne` signature to take `usProfiles` instead of `profiles`:

```typescript
function enrichOne(
	row: ConstituentRow,
	usProfiles: Map<string, UsProfile>,
	quotes: Map<string, QuoteRow>,
	yahooUk: Map<string, YahooUkQuote>,
): FilterCandidate {
	const key = keyOf(row.symbol, row.exchange);
	const usProfile = usProfiles.get(key) ?? null;
	const quote = quotes.get(key) ?? null;
	const yahooUkQ = yahooUk.get(key) ?? null;

	// Price: live quotes_cache > Yahoo US > Yahoo UK
	const price =
		quote?.last ?? usProfile?.priceUsd ?? yahooUkQ?.priceGbpPence ?? null;

	// avgDollarVolume priority:
	//   - Yahoo UK (FX-converted USD)
	//   - Yahoo US (native USD)
	//   - quotes_cache fallback (native × volume; wrong for UK but only used for US)
	const avgDollarVolume =
		yahooUkQ?.avgDollarVolumeUsd ??
		usProfile?.avgDollarVolumeUsd ??
		(quote?.avgVolume != null && quote?.last != null ? quote.avgVolume * quote.last : null);

	const spreadBps =
		quote?.bid != null && quote?.ask != null && quote.bid > 0 && quote.ask > 0
			? ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 10_000
			: null;

	// Free float derivation:
	//  - US: we don't fetch freeFloatShares any more (deferred as wishlist). Fall
	//    back to sharesOutstanding × price as an overestimate, same as the
	//    previous FMP path.
	//  - UK: null (same as before).
	let freeFloatUsd: number | null = null;
	if (
		usProfile?.sharesOutstanding != null &&
		usProfile?.priceUsd != null
	) {
		freeFloatUsd = usProfile.sharesOutstanding * usProfile.priceUsd;
	}

	const listingAgeDays = usProfile?.ipoDate
		? Math.floor((Date.now() - Date.parse(usProfile.ipoDate)) / 86_400_000)
		: null;

	return {
		...row,
		marketCapUsd: usProfile?.marketCapUsd ?? null,
		avgDollarVolume,
		price,
		freeFloatUsd,
		spreadBps,
		listingAgeDays,
	};
}
```

6. Add the new safe-wrapper next to the existing `safeYahooUk`:

```typescript
async function safeUsProfiles(
	rows: ConstituentRow[],
	override?: (rows: ConstituentRow[]) => Promise<Map<string, UsProfile>>,
): Promise<Map<string, UsProfile>> {
	const enricher = override ?? fetchUsProfiles;
	try {
		return await enricher(rows);
	} catch (err) {
		log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"US profile enrichment failed — US rows will lack market cap / IPO date",
		);
		return new Map();
	}
}
```

- [ ] **Step 2: Update existing US test in metrics-enricher.test.ts**

Open `tests/universe/metrics-enricher.test.ts`. The test at line ~107 ("US candidate with no cache triggers profile fetch and upserts result") currently relies on FMP profile fetch. Update it to use the new `usProfileEnricher` dep:

```typescript
test("US candidate with injected profile enricher produces full FilterCandidate", async () => {
	const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
	const rows: ConstituentRow[] = [{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" }];
	const result = await enrichWithMetrics(rows, {
		yahooUkEnricher: async () => new Map(),
		usProfileEnricher: async () =>
			new Map([
				[
					"AAPL:NASDAQ",
					{
						symbol: "AAPL",
						exchange: "NASDAQ",
						sharesOutstanding: 14_681_140_000,
						priceUsd: 270.23,
						marketCapUsd: 14_681_140_000 * 270.23,
						avgVolume30d: 50_000_000,
						avgDollarVolumeUsd: 270.23 * 50_000_000,
						ipoDate: "1980-12-12",
					},
				],
			]),
	});
	expect(result[0]?.marketCapUsd).toBeCloseTo(14_681_140_000 * 270.23);
	expect(result[0]?.price).toBe(270.23);
	expect(result[0]?.avgDollarVolume).toBeCloseTo(270.23 * 50_000_000);
	expect(result[0]?.freeFloatUsd).toBeCloseTo(14_681_140_000 * 270.23);
	expect(result[0]?.listingAgeDays).toBeGreaterThan(10_000);
});
```

Remove any assertion in the old test that depended on FMP's `upsertProfiles` being called — that path is no longer exercised.

Other existing US tests (profile-fetcher-based) should keep passing unchanged because we haven't deleted the module, but if any assertions on the output of `enrichWithMetrics` for US rows break, update them to use `usProfileEnricher: async () => new Map()` to disable enrichment (mirrors how we disabled `yahooUkEnricher`).

Run: `bun test tests/universe/metrics-enricher.test.ts --preload ./tests/preload.ts`. Expected: all pass after the updates.

- [ ] **Step 3: Full test suite**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/universe/metrics-enricher.ts tests/universe/metrics-enricher.test.ts
```

All pass. Test count should be ~860–862 depending on how many old tests were updated.

- [ ] **Step 4: Commit**

```bash
git add src/universe/metrics-enricher.ts tests/universe/metrics-enricher.test.ts
git commit -m "feat(universe): dispatch US rows through new profile composer"
```

---

## Task 7: Run smoke test and raise the bar

**Files:**
- Modify: `scripts/universe-refresh-smoke-test.ts`

- [ ] **Step 1: Manually trigger CIK map refresh locally**

Before running the smoke test, the `symbol_ciks` table in the in-memory DB needs to be populated so the US profile enricher can resolve tickers. Add a pre-stage to the smoke test that seeds the CIK map.

Open `scripts/universe-refresh-smoke-test.ts` and after the migration step, add:

```typescript
// STAGE 0: Seed the CIK map (needed for US profile enricher)
console.log("\n── Stage 0: Seed CIK map ──");
const { refreshCikMap } = await import("../src/universe/ciks/edgar-ticker-map.ts");
const cikCount = await refreshCikMap();
console.log(`  ${cikCount} CIK entries loaded from SEC`);
```

- [ ] **Step 2: Raise the russell_1000 post-filter expectation**

Update `EXPECTED_MIN_AFTER_FILTER`:

```typescript
const EXPECTED_MIN_AFTER_FILTER = {
	russell_1000: 700, // was 0; with EDGAR+Yahoo enrichment should easily pass 700
	ftse_350: 150,
	aim_allshare: 1,
};
```

- [ ] **Step 3: Run it**

```bash
bun scripts/universe-refresh-smoke-test.ts
```

Expected output ends with:

```
✅ All expectations met. Pipeline is green.
```

If the russell_1000 count is below 700, investigate before committing:
- Check the log for `"EDGAR shares-outstanding frames fetched"` — how many CIKs came back?
- Check for `"US profiles composed"` — how many had shares + price?
- Use `SELECT COUNT(*), COUNT(market_cap_usd) FROM investable_universe WHERE index_source='russell_1000'` in the :memory: run if you hack in a debug break.

If the smoke test passes, commit:

```bash
git add scripts/universe-refresh-smoke-test.ts
git commit -m "test: raise smoke-test russell_1000 expectation after US profile enricher"
```

---

## Task 8: Universe refresh job triggers CIK map refresh

**Files:**
- Modify: `src/scheduler/universe-jobs.ts`

- [ ] **Step 1: Call refreshCikMap before fetchCandidates**

Prod doesn't have the CIK map populated on first boot. The weekly refresh job should seed / refresh it before it runs the fetch pipeline.

Modify `src/scheduler/universe-jobs.ts`:

```typescript
import { refreshCikMap } from "../universe/ciks/edgar-ticker-map.ts";
```

In `runWeeklyUniverseRefresh`, before the `fetchCandidatesFromAllSources()` call:

```typescript
	// Refresh the SEC ticker→CIK map before fetching candidates. Idempotent
	// and cheap (~10k rows, one HTTP call). Safe to run weekly.
	try {
		const count = await refreshCikMap();
		log.info({ count }, "SEC CIK map refreshed");
	} catch (err) {
		log.warn(
			{ err: err instanceof Error ? err.message : String(err) },
			"CIK map refresh failed — US profile enrichment will use stale cache",
		);
	}
```

- [ ] **Step 2: Run the smoke test again to confirm no regression**

```bash
bun scripts/universe-refresh-smoke-test.ts
```

Expected: still green (the smoke test seeds its own CIK map in Task 7 Step 1).

- [ ] **Step 3: Commit**

```bash
git add src/scheduler/universe-jobs.ts
git commit -m "feat(scheduler): refresh CIK map before weekly universe refresh"
```

---

## Task 9: Full verification + PR

- [ ] **Step 1: Full repo verification gate**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bunx biome check src/universe/ tests/universe/ scripts/universe-refresh-smoke-test.ts
bun scripts/universe-refresh-smoke-test.ts
```

All four must pass. The smoke-test output should show `russell_1000 post-filter: >=700`.

- [ ] **Step 2: Push + PR**

```bash
git push -u origin feat/us-profile-enricher
gh pr create --title "feat(universe): US profile enricher (EDGAR + Yahoo) — closes FMP profile gap" --body "$(cat <<'EOF'
## Summary

Replaces FMP \`/v3/profile/\` (dead since Aug 2025 for our account) with a free-source composition:

- **SEC EDGAR \`company_tickers.json\`** — ticker→CIK map, cached in \`symbol_ciks\` table
- **SEC EDGAR \`/api/xbrl/frames/\`** — bulk sharesOutstanding for all filers in one call per quarter
- **Yahoo v8 chart** — current price + \`firstTradeDate\` (IPO proxy)
- **marketCapUsd = sharesOutstanding × price** (client-side)

All endpoints free, official, no auth.

## Test plan

- [x] \`bun run typecheck\` clean
- [x] \`bun test --preload ./tests/preload.ts\` — ~860 pass
- [x] \`bunx biome check\` clean
- [x] **\`bun scripts/universe-refresh-smoke-test.ts\` — russell_1000 post-filter ≥ 700**
- [ ] Post-merge VPS: trigger weekly refresh; confirm \`universe.bySource.russell_1000 ≈ 900\`

## Lessons from PR #37

This plan was written specifically because PR #37 shipped a regression (FMP \`/profile/\` was also dead and I didn't catch it). The smoke test added in this PR closes that loop by running the full pipeline end-to-end before any PR is opened.

EOF
)"
```

- [ ] **Step 3: Post-merge VPS verification**

```bash
./scripts/vps-ssh.sh "cd /opt/trader-v2 && sudo -u deploy /home/deploy/.bun/bin/bun -e 'import { runWeeklyUniverseRefresh } from \"./src/scheduler/universe-jobs.ts\"; await runWeeklyUniverseRefresh(); console.log(\"done\");' 2>&1" | tail -15
```

Expected: `added: ~900+`, `rejected: ~400`. Then:

```bash
./scripts/vps-ssh.sh "curl -s http://localhost:3847/health" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(d["universe"], indent=2))'
```

Expected: `russell_1000: ~900`, `ftse_350: ~200`, `aim_allshare: 2`.

---

## Final verification

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun scripts/universe-refresh-smoke-test.ts
```

Expected: all green. Total new tests: ~17. Final test count ~860.
