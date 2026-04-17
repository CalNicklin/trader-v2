# Universe Step 1a — Metrics Enrichers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This plan has 7 tasks — under the 10-task threshold for `long-running-task-harness`, but each task still requires the verification gate (typecheck + tests + lint + commit SHA). No progress file needed.

**Goal:** Wire FMP profile data into the existing `enrichWithMetrics` so US candidates (Russell 1000) populate `marketCapUsd`, `freeFloatUsd`, `listingAgeDays`. Relax `freeFloatUsd` from a required critical field to optional so UK candidates (FTSE 350, AIM) can pass on quotes-cache data alone. After this ships, the Monday 03:00 UTC universe refresh produces an actually populated `investable_universe` table.

**Architecture:** New `symbol_profiles` cache table + `profile-fetcher` module. `metrics-enricher` splits candidates by exchange: US goes through FMP profile batch (with last-known-good cache fallback); UK skips profiles entirely. Filter rule for `freeFloatUsd` moves from critical to optional. Zero new cron jobs — the weekly refresh already calls `enrichWithMetrics`.

**Tech Stack:** Bun + TypeScript, Drizzle + SQLite, Biome, `bun test --preload ./tests/preload.ts`. FMP endpoint: `/v3/profile/<comma-separated-symbols>`.

**Parent spec:** `docs/superpowers/specs/2026-04-17-universe-step1a-metrics-enrichers-design.md`

---

## Verification gate (every task)

1. `bun run typecheck` passes
2. `bun test --preload ./tests/preload.ts` passes (no regression from 729 baseline + new tests)
3. `bun run lint` passes (no new errors; pre-existing warnings about `any` in test stubs are OK)
4. Commit is made with a clear scope-prefixed message
5. Only ONE task `in_progress` at a time

Do NOT mark a task complete based on "it looks right." Run the checks.

---

## File Structure

**New files:**

- `drizzle/migrations/0015_<drizzle-generated-name>.sql` — schema migration
- `src/universe/profile-fetcher.ts` — FMP profile batch fetcher + cache read/write
- `tests/universe/profile-fetcher.test.ts` — profile fetcher unit tests

**Modified files:**

- `src/db/schema.ts` — add `symbolProfiles` table definition
- `src/universe/filters.ts` — relax `freeFloatUsd` from critical to optional
- `src/universe/metrics-enricher.ts` — enrich US candidates via profile cache + batch FMP, skip UK
- `tests/universe/filters.test.ts` — update missing_data test + add UK-without-float PASSES test
- `tests/universe/integration.test.ts` — update to verify real-world-shape US + UK candidates

---

## Task 1: Schema — symbol_profiles table

**Files:**
- Create: `drizzle/migrations/0015_<drizzle-generated-name>.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (drizzle-kit appends automatically)
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add table definition to schema.ts**

Append to `src/db/schema.ts` below existing tables:

```typescript
export const symbolProfiles = sqliteTable("symbol_profiles", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	marketCapUsd: real("market_cap_usd"),
	sharesOutstanding: real("shares_outstanding"),
	freeFloatShares: real("free_float_shares"),
	ipoDate: text("ipo_date"),
	fetchedAt: text("fetched_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
}, (table) => ({
	symbolExchangeUnique: uniqueIndex("symbol_profiles_symbol_exchange_unique").on(
		table.symbol,
		table.exchange,
	),
}));
```

Imports (`uniqueIndex` from `drizzle-orm/sqlite-core`) should already be present from Step 1. If not, add them.

- [ ] **Step 2: Generate the migration**

Run: `bunx drizzle-kit generate`

Expected: creates `drizzle/migrations/0015_<drizzle-auto-generated-name>.sql` with `CREATE TABLE` for `symbol_profiles`, appends entry to `_journal.json`. Do NOT rename the generated file.

- [ ] **Step 3: Verify migration applies cleanly**

```bash
rm -f data/test-migration.db
bun -e 'import { Database } from "bun:sqlite"; import { drizzle } from "drizzle-orm/bun-sqlite"; import { migrate } from "drizzle-orm/bun-sqlite/migrator"; const db = drizzle(new Database("data/test-migration.db")); migrate(db, { migrationsFolder: "./drizzle/migrations" }); console.log("migrations applied");'
rm data/test-migration.db
```

Expected: `migrations applied`.

- [ ] **Step 4: Run verification gate**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

All three pass. Test count remains 729 (no new tests yet).

- [ ] **Step 5: Commit**

```bash
git add drizzle/migrations/ src/db/schema.ts
git commit -m "Universe Step 1a Task 1: symbol_profiles schema + migration"
```

---

## Task 2: Profile fetcher — FMP batch fetch

**Files:**
- Create: `src/universe/profile-fetcher.ts`
- Create: `tests/universe/profile-fetcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/universe/profile-fetcher.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import type { FetchLike } from "../../src/universe/sources.ts";

describe("fetchSymbolProfiles", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
	});

	test("batches symbols up to 500 per FMP call", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const calls: string[] = [];
		const mockFetch: FetchLike = async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => [
					{
						symbol: "AAPL",
						mktCap: 3_000_000_000_000,
						sharesOutstanding: 15_000_000_000,
						floatShares: 14_900_000_000,
						ipoDate: "1980-12-12",
					},
				],
			};
		};

		const result = await fetchSymbolProfiles(["AAPL"], mockFetch);
		expect(result).toHaveLength(1);
		expect(result[0]?.symbol).toBe("AAPL");
		expect(result[0]?.marketCapUsd).toBe(3_000_000_000_000);
		expect(result[0]?.sharesOutstanding).toBe(15_000_000_000);
		expect(result[0]?.freeFloatShares).toBe(14_900_000_000);
		expect(result[0]?.ipoDate).toBe("1980-12-12");
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("/profile/AAPL");
	});

	test("splits >500 symbols into multiple batch calls", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const calls: string[] = [];
		const mockFetch: FetchLike = async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => [],
			};
		};

		const symbols = Array.from({ length: 750 }, (_, i) => `SYM${i}`);
		await fetchSymbolProfiles(symbols, mockFetch);
		expect(calls).toHaveLength(2);
	});

	test("returns empty array for empty input without calling FMP", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		let called = false;
		const mockFetch: FetchLike = async () => {
			called = true;
			return { ok: true, status: 200, statusText: "OK", json: async () => [] };
		};
		const result = await fetchSymbolProfiles([], mockFetch);
		expect(result).toEqual([]);
		expect(called).toBe(false);
	});

	test("handles null floatShares by leaving freeFloatShares null", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const mockFetch: FetchLike = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => [
				{
					symbol: "OBSCURE",
					mktCap: 1e9,
					sharesOutstanding: 50_000_000,
					floatShares: null,
					ipoDate: "2010-01-01",
				},
			],
		});
		const result = await fetchSymbolProfiles(["OBSCURE"], mockFetch);
		expect(result[0]?.freeFloatShares).toBeNull();
		expect(result[0]?.sharesOutstanding).toBe(50_000_000);
	});

	test("throws on non-ok FMP response", async () => {
		const { fetchSymbolProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const mockFetch: FetchLike = async () =>
			({ ok: false, status: 500, statusText: "Server Error" }) as Awaited<ReturnType<FetchLike>>;
		await expect(fetchSymbolProfiles(["AAPL"], mockFetch)).rejects.toThrow();
	});
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/universe/profile-fetcher.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the implementation**

Create `src/universe/profile-fetcher.ts`:

```typescript
import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { FetchLike } from "./sources.ts";

const log = createChildLogger({ module: "universe-profile-fetcher" });

export const PROFILE_CACHE_TTL_DAYS = 30;
const FMP_PROFILE_BATCH_SIZE = 500;

export interface SymbolProfile {
	symbol: string;
	exchange: string;
	marketCapUsd: number | null;
	sharesOutstanding: number | null;
	freeFloatShares: number | null;
	ipoDate: string | null; // ISO date
	fetchedAt: string; // ISO timestamp
}

interface FmpProfile {
	symbol: string;
	mktCap?: number | null;
	sharesOutstanding?: number | null;
	floatShares?: number | null;
	ipoDate?: string | null;
	exchange?: string | null;
	exchangeShortName?: string | null;
}

export async function fetchSymbolProfiles(
	symbols: string[],
	fetchImpl: FetchLike = fetch,
): Promise<SymbolProfile[]> {
	if (symbols.length === 0) return [];
	const config = getConfig();
	const now = new Date().toISOString();
	const profiles: SymbolProfile[] = [];

	for (let i = 0; i < symbols.length; i += FMP_PROFILE_BATCH_SIZE) {
		const batch = symbols.slice(i, i + FMP_PROFILE_BATCH_SIZE);
		const url = `https://financialmodelingprep.com/api/v3/profile/${batch.join(",")}?apikey=${config.FMP_API_KEY}`;
		const res = await fetchImpl(url);
		if (!res.ok) {
			throw new Error(
				`FMP profile batch request failed: ${res.status} ${res.statusText}`,
			);
		}
		const rows = (await res.json()) as FmpProfile[];
		for (const r of rows) {
			profiles.push({
				symbol: r.symbol,
				exchange: r.exchangeShortName ?? r.exchange ?? "NASDAQ",
				marketCapUsd: r.mktCap ?? null,
				sharesOutstanding: r.sharesOutstanding ?? null,
				freeFloatShares: r.floatShares ?? null,
				ipoDate: r.ipoDate ?? null,
				fetchedAt: now,
			});
		}
	}

	log.info(
		{ requested: symbols.length, returned: profiles.length },
		"FMP profile batch fetch complete",
	);
	return profiles;
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/universe/profile-fetcher.test.ts`
Expected: PASS (5/5).

- [ ] **Step 5: Run verification gate**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

Test count: 734 (729 + 5 new).

- [ ] **Step 6: Commit**

```bash
git add src/universe/profile-fetcher.ts tests/universe/profile-fetcher.test.ts
git commit -m "Universe Step 1a Task 2: FMP profile batch fetcher"
```

---

## Task 3: Profile fetcher — cache read/write helpers

**Files:**
- Modify: `src/universe/profile-fetcher.ts`
- Modify: `tests/universe/profile-fetcher.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/universe/profile-fetcher.test.ts`:

```typescript
describe("upsertProfiles + getProfile", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("upsertProfiles inserts new rows", async () => {
		const { upsertProfiles, getProfile } = await import(
			"../../src/universe/profile-fetcher.ts"
		);

		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: "2026-04-17T00:00:00.000Z",
			},
		]);

		const result = await getProfile("AAPL", "NASDAQ");
		expect(result?.symbol).toBe("AAPL");
		expect(result?.marketCapUsd).toBe(3e12);
	});

	test("upsertProfiles updates existing rows on conflict", async () => {
		const { upsertProfiles, getProfile } = await import(
			"../../src/universe/profile-fetcher.ts"
		);

		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: "2026-04-01T00:00:00.000Z",
			},
		]);

		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3.1e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: "2026-04-17T00:00:00.000Z",
			},
		]);

		const result = await getProfile("AAPL", "NASDAQ");
		expect(result?.marketCapUsd).toBe(3.1e12);
		expect(result?.fetchedAt).toBe("2026-04-17T00:00:00.000Z");
	});

	test("getProfile returns null for unknown symbol", async () => {
		const { getProfile } = await import("../../src/universe/profile-fetcher.ts");
		const result = await getProfile("GHOST", "NASDAQ");
		expect(result).toBeNull();
	});

	test("PROFILE_CACHE_TTL_DAYS is 30", async () => {
		const { PROFILE_CACHE_TTL_DAYS } = await import(
			"../../src/universe/profile-fetcher.ts"
		);
		expect(PROFILE_CACHE_TTL_DAYS).toBe(30);
	});
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/universe/profile-fetcher.test.ts`
Expected: FAIL (`upsertProfiles` / `getProfile` not exported).

- [ ] **Step 3: Append implementations**

Append to `src/universe/profile-fetcher.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { symbolProfiles } from "../db/schema.ts";

export async function upsertProfiles(profiles: SymbolProfile[]): Promise<void> {
	if (profiles.length === 0) return;
	const db = getDb();
	for (const p of profiles) {
		await db
			.insert(symbolProfiles)
			.values({
				symbol: p.symbol,
				exchange: p.exchange,
				marketCapUsd: p.marketCapUsd,
				sharesOutstanding: p.sharesOutstanding,
				freeFloatShares: p.freeFloatShares,
				ipoDate: p.ipoDate,
				fetchedAt: p.fetchedAt,
			})
			.onConflictDoUpdate({
				target: [symbolProfiles.symbol, symbolProfiles.exchange],
				set: {
					marketCapUsd: p.marketCapUsd,
					sharesOutstanding: p.sharesOutstanding,
					freeFloatShares: p.freeFloatShares,
					ipoDate: p.ipoDate,
					fetchedAt: p.fetchedAt,
				},
			});
	}
}

export async function getProfile(
	symbol: string,
	exchange: string,
): Promise<SymbolProfile | null> {
	const db = getDb();
	const rows = await db
		.select()
		.from(symbolProfiles)
		.where(and(eq(symbolProfiles.symbol, symbol), eq(symbolProfiles.exchange, exchange)))
		.limit(1)
		.all();
	const row = rows[0];
	if (!row) return null;
	return {
		symbol: row.symbol,
		exchange: row.exchange,
		marketCapUsd: row.marketCapUsd,
		sharesOutstanding: row.sharesOutstanding,
		freeFloatShares: row.freeFloatShares,
		ipoDate: row.ipoDate,
		fetchedAt: row.fetchedAt,
	};
}
```

Move the new `import` lines to the top of the file with the other imports (don't leave them inline mid-file).

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/universe/profile-fetcher.test.ts`
Expected: PASS (9/9 total).

- [ ] **Step 5: Run verification gate**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

Test count: 738 (734 + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/universe/profile-fetcher.ts tests/universe/profile-fetcher.test.ts
git commit -m "Universe Step 1a Task 3: profile cache upsert + read helpers"
```

---

## Task 4: Relax freeFloatUsd in liquidity filter

**Files:**
- Modify: `src/universe/filters.ts`
- Modify: `tests/universe/filters.test.ts`

- [ ] **Step 1: Append new failing tests**

Append to `tests/universe/filters.test.ts`:

```typescript
describe("applyLiquidityFilters — UK-shaped candidates without free-float", () => {
	test("UK LSE candidate with null freeFloatUsd PASSES when other critical fields present", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const candidate = {
			symbol: "HSBA",
			exchange: "LSE",
			indexSource: "ftse_350" as const,
			marketCapUsd: null,
			avgDollarVolume: 5e9,
			price: 700,
			freeFloatUsd: null, // UK names systematically lack this
			spreadBps: 4,
			listingAgeDays: null,
		};
		const result = applyLiquidityFilters([candidate]);
		expect(result.passed).toHaveLength(1);
		expect(result.rejected).toHaveLength(0);
	});

	test("UK AIM candidate with null freeFloatUsd PASSES", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const candidate = {
			symbol: "GAW",
			exchange: "AIM",
			indexSource: "aim_allshare" as const,
			marketCapUsd: null,
			avgDollarVolume: 5e7,
			price: 10000, // 100 GBP in pence
			freeFloatUsd: null,
			spreadBps: 10,
			listingAgeDays: null,
		};
		const result = applyLiquidityFilters([candidate]);
		expect(result.passed).toHaveLength(1);
	});

	test("candidate with null price still rejects as missing_data", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const candidate = {
			symbol: "BAD",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			marketCapUsd: 1e12,
			avgDollarVolume: 1e10,
			price: null,
			freeFloatUsd: 1e11,
			spreadBps: 2,
			listingAgeDays: 5000,
		};
		const result = applyLiquidityFilters([candidate]);
		expect(result.rejected[0]?.reasons).toContain("missing_data");
	});

	test("candidate with null avgDollarVolume still rejects as missing_data", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const candidate = {
			symbol: "BAD2",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			marketCapUsd: 1e12,
			avgDollarVolume: null,
			price: 100,
			freeFloatUsd: 1e11,
			spreadBps: 2,
			listingAgeDays: 5000,
		};
		const result = applyLiquidityFilters([candidate]);
		expect(result.rejected[0]?.reasons).toContain("missing_data");
	});
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/universe/filters.test.ts`
Expected: FAIL — the first two new tests fail because current filter treats `freeFloatUsd: null` as `missing_data`.

Also verify that the existing `"gracefully handles missing metric data (rejects with missing_data)"` test still passes — it sets `avgDollarVolume: null, price: null`, which still rejects under the new rule.

- [ ] **Step 3: Update the filter**

Edit `src/universe/filters.ts`. Find the missing-data check block:

```typescript
// Missing-data check: if critical fields are null, we can't evaluate.
if (c.avgDollarVolume == null || c.price == null || c.freeFloatUsd == null) {
    reasons.push("missing_data");
}
```

Replace with:

```typescript
// Missing-data check: price and avgDollarVolume are the hard requirements —
// without them we can't evaluate liquidity at all. freeFloatUsd is NOT
// required because UK (LSE/AIM) candidates systematically lack this data
// (FMP profile coverage is US-only). Free-float still gets a threshold
// check below when present.
if (c.avgDollarVolume == null || c.price == null) {
    reasons.push("missing_data");
}
```

The existing `low_float` check below stays unchanged — it only fires when `freeFloatUsd != null && < MIN_FREE_FLOAT_USD`, which is already the right optional-treatment pattern.

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/universe/filters.test.ts`
Expected: PASS (all tests — 10 previous + 4 new = 14 total in this file).

- [ ] **Step 5: Run verification gate**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

Test count: 742 (738 + 4 new).

- [ ] **Step 6: Commit**

```bash
git add src/universe/filters.ts tests/universe/filters.test.ts
git commit -m "Universe Step 1a Task 4: relax freeFloatUsd — optional, not critical (UK names lack FMP profile data)"
```

---

## Task 5: Update metrics-enricher to use profile cache for US candidates

**Files:**
- Modify: `src/universe/metrics-enricher.ts`
- Create: `tests/universe/metrics-enricher.test.ts`

This is the largest task — the enricher now splits candidates by exchange, looks up the cache for US symbols, batch-fetches anything stale, and falls back to last-known-good on fetch failure.

- [ ] **Step 1: Write the failing test**

Create `tests/universe/metrics-enricher.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import type { ConstituentRow } from "../../src/universe/sources.ts";

describe("enrichWithMetrics", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("US candidate uses cached fresh profile without fetching", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { upsertProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			last: 200,
			avgVolume: 50_000_000,
			bid: 199.95,
			ask: 200.05,
			updatedAt: new Date().toISOString(),
		});

		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: new Date().toISOString(),
			},
		]);

		let fetchCalled = false;
		const rows: ConstituentRow[] = [
			{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];

		const result = await enrichWithMetrics(rows, {
			fetchImpl: async () => {
				fetchCalled = true;
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => [],
				};
			},
		});

		expect(fetchCalled).toBe(false);
		expect(result).toHaveLength(1);
		expect(result[0]?.marketCapUsd).toBe(3e12);
		expect(result[0]?.freeFloatUsd).toBeCloseTo(14.9e9 * 200, -3);
		expect(result[0]?.listingAgeDays).toBeGreaterThan(10_000);
		expect(result[0]?.price).toBe(200);
		expect(result[0]?.avgDollarVolume).toBe(50_000_000 * 200);
	});

	test("UK candidate skips profile fetch and uses quotes_cache only", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "HSBA",
			exchange: "LSE",
			last: 700,
			avgVolume: 10_000_000,
			bid: 699,
			ask: 701,
			updatedAt: new Date().toISOString(),
		});

		let fetchCalled = false;
		const rows: ConstituentRow[] = [
			{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" },
		];

		const result = await enrichWithMetrics(rows, {
			fetchImpl: async () => {
				fetchCalled = true;
				return {
					ok: true,
					status: 200,
					statusText: "OK",
					json: async () => [],
				};
			},
		});

		expect(fetchCalled).toBe(false);
		expect(result[0]?.marketCapUsd).toBeNull();
		expect(result[0]?.freeFloatUsd).toBeNull();
		expect(result[0]?.listingAgeDays).toBeNull();
		expect(result[0]?.price).toBe(700);
		expect(result[0]?.avgDollarVolume).toBe(10_000_000 * 700);
	});

	test("US candidate with no cache triggers profile fetch and upserts result", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getProfile } = await import("../../src/universe/profile-fetcher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "MSFT",
			exchange: "NASDAQ",
			last: 400,
			avgVolume: 25_000_000,
			updatedAt: new Date().toISOString(),
		});

		const mockFetch = async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			json: async () => [
				{
					symbol: "MSFT",
					mktCap: 3e12,
					sharesOutstanding: 7.4e9,
					floatShares: 7.4e9,
					ipoDate: "1986-03-13",
				},
			],
		});

		const rows: ConstituentRow[] = [
			{ symbol: "MSFT", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, { fetchImpl: mockFetch });

		expect(result[0]?.marketCapUsd).toBe(3e12);
		const cached = await getProfile("MSFT", "NASDAQ");
		expect(cached?.marketCapUsd).toBe(3e12);
	});

	test("US candidate with stale cache AND fetch failure uses last-known-good", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { upsertProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "GOOGL",
			exchange: "NASDAQ",
			last: 150,
			avgVolume: 30_000_000,
			updatedAt: new Date().toISOString(),
		});

		const thirtyOneDaysAgo = new Date(
			Date.now() - 31 * 24 * 60 * 60 * 1000,
		).toISOString();
		await upsertProfiles([
			{
				symbol: "GOOGL",
				exchange: "NASDAQ",
				marketCapUsd: 2e12,
				sharesOutstanding: 12e9,
				freeFloatShares: 11.9e9,
				ipoDate: "2004-08-19",
				fetchedAt: thirtyOneDaysAgo,
			},
		]);

		const mockFetch = async () => ({
			ok: false,
			status: 500,
			statusText: "Server Error",
			json: async () => [],
		});

		const rows: ConstituentRow[] = [
			{ symbol: "GOOGL", exchange: "NASDAQ", indexSource: "russell_1000" },
		];

		const result = await enrichWithMetrics(rows, { fetchImpl: mockFetch });

		// Should still populate from stale cache, not null out
		expect(result[0]?.marketCapUsd).toBe(2e12);
	});

	test("US candidate with no cache AND fetch failure leaves profile fields null", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "NEWCO",
			exchange: "NASDAQ",
			last: 50,
			avgVolume: 5_000_000,
			updatedAt: new Date().toISOString(),
		});

		const mockFetch = async () => ({
			ok: false,
			status: 500,
			statusText: "Server Error",
			json: async () => [],
		});

		const rows: ConstituentRow[] = [
			{ symbol: "NEWCO", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, { fetchImpl: mockFetch });

		expect(result[0]?.marketCapUsd).toBeNull();
		expect(result[0]?.freeFloatUsd).toBeNull();
		expect(result[0]?.listingAgeDays).toBeNull();
		// Price and volume still populated from quotes_cache
		expect(result[0]?.price).toBe(50);
	});

	test("freeFloatUsd falls back to sharesOutstanding × price when floatShares is null", async () => {
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { upsertProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		await getDb().insert(quotesCache).values({
			symbol: "OBSCURE",
			exchange: "NASDAQ",
			last: 10,
			avgVolume: 2_000_000,
			updatedAt: new Date().toISOString(),
		});

		await upsertProfiles([
			{
				symbol: "OBSCURE",
				exchange: "NASDAQ",
				marketCapUsd: 5e8,
				sharesOutstanding: 50_000_000,
				freeFloatShares: null, // unreliable from FMP
				ipoDate: "2015-01-01",
				fetchedAt: new Date().toISOString(),
			},
		]);

		const rows: ConstituentRow[] = [
			{ symbol: "OBSCURE", exchange: "NASDAQ", indexSource: "russell_1000" },
		];
		const result = await enrichWithMetrics(rows, {
			fetchImpl: async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => [],
			}),
		});

		// Fallback: sharesOutstanding × price = 50M × 10 = 500M
		expect(result[0]?.freeFloatUsd).toBe(5e8);
	});
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/universe/metrics-enricher.test.ts`
Expected: FAIL — the current `enrichWithMetrics` has no `options` parameter and hard-codes profile fields to null.

- [ ] **Step 3: Rewrite metrics-enricher.ts**

Replace the contents of `src/universe/metrics-enricher.ts` with:

```typescript
import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { FilterCandidate } from "./filters.ts";
import {
	fetchSymbolProfiles,
	getProfile,
	PROFILE_CACHE_TTL_DAYS,
	type SymbolProfile,
	upsertProfiles,
} from "./profile-fetcher.ts";
import type { ConstituentRow, FetchLike } from "./sources.ts";

const log = createChildLogger({ module: "universe-metrics-enricher" });

// Enriches constituents with market-cap, free-float, price, volume, and spread.
// Strategy:
//   - US candidates (russell_1000): fetch FMP profile for market-cap + free-float
//     + listing-age, with a `symbol_profiles` cache (last-known-good on failure).
//   - UK candidates (ftse_350, aim_allshare): skip profile fetch — FMP lacks
//     reliable LSE/AIM coverage. These fields stay null; the liquidity filter
//     treats freeFloatUsd as optional and listingAgeDays as optional.
//   - All candidates get price, volume, and spread from quotes_cache
//     (populated by IBKR market-data for all exchanges).
export interface EnrichOptions {
	fetchImpl?: FetchLike;
}

export async function enrichWithMetrics(
	rows: ConstituentRow[],
	options: EnrichOptions = {},
): Promise<FilterCandidate[]> {
	if (rows.length === 0) return [];

	const profilesMap = await resolveProfiles(rows, options.fetchImpl ?? fetch);
	const quotesMap = await loadQuotes(rows);

	return rows.map((r) => enrichOne(r, profilesMap, quotesMap));
}

// ------ helpers ------

function isUsRow(r: ConstituentRow): boolean {
	return r.indexSource === "russell_1000";
}

async function resolveProfiles(
	rows: ConstituentRow[],
	fetchImpl: FetchLike,
): Promise<Map<string, SymbolProfile>> {
	const profiles = new Map<string, SymbolProfile>();
	const usRows = rows.filter(isUsRow);
	if (usRows.length === 0) return profiles;

	const now = Date.now();
	const ttlMs = PROFILE_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

	const stale: string[] = [];
	for (const r of usRows) {
		const cached = await getProfile(r.symbol, r.exchange);
		if (cached) profiles.set(profileKey(r.symbol, r.exchange), cached);
		const isFresh =
			cached != null && now - Date.parse(cached.fetchedAt) <= ttlMs;
		if (!isFresh) stale.push(r.symbol);
	}

	if (stale.length === 0) return profiles;

	try {
		const fresh = await fetchSymbolProfiles(stale, fetchImpl);
		// Override exchange: FMP returns the symbol's primary exchange string,
		// but we want to key profiles by the exchange our fetchers use (NASDAQ/NYSE).
		// Align each fresh profile with the constituent row that requested it.
		const rowByLookupSymbol = new Map(usRows.map((r) => [r.symbol, r]));
		const aligned: SymbolProfile[] = fresh.map((p) => {
			const r = rowByLookupSymbol.get(p.symbol);
			return { ...p, exchange: r?.exchange ?? p.exchange };
		});

		await upsertProfiles(aligned);
		for (const p of aligned) {
			profiles.set(profileKey(p.symbol, p.exchange), p);
		}
	} catch (err) {
		log.warn(
			{ err: err instanceof Error ? err.message : String(err), staleCount: stale.length },
			"Profile fetch failed; using last-known-good cache where available",
		);
		// On fetch failure, any cached profile (even stale) is retained in the map.
	}

	return profiles;
}

function profileKey(symbol: string, exchange: string): string {
	return `${symbol}:${exchange}`;
}

async function loadQuotes(rows: ConstituentRow[]) {
	const db = getDb();
	const symbols = rows.map((r) => r.symbol);
	if (symbols.length === 0) return new Map();
	const quotes = await db
		.select()
		.from(quotesCache)
		.where(inArray(quotesCache.symbol, symbols))
		.all();
	return new Map(quotes.map((q) => [profileKey(q.symbol, q.exchange), q]));
}

function enrichOne(
	row: ConstituentRow,
	profiles: Map<string, SymbolProfile>,
	quotes: Map<string, Awaited<ReturnType<typeof loadQuotes>> extends Map<string, infer V> ? V : never>,
): FilterCandidate {
	const key = profileKey(row.symbol, row.exchange);
	const profile = profiles.get(key) ?? null;
	const quote = quotes.get(key) ?? null;

	const price = quote?.last ?? null;
	const avgDollarVolume =
		quote?.avgVolume != null && quote?.last != null
			? quote.avgVolume * quote.last
			: null;
	const spreadBps =
		quote?.bid != null && quote?.ask != null && quote.bid > 0 && quote.ask > 0
			? ((quote.ask - quote.bid) / ((quote.ask + quote.bid) / 2)) * 10_000
			: null;

	// freeFloatUsd: floatShares × price if available, else sharesOutstanding × price
	// as overestimate fallback. See spec for rationale.
	const freeFloatUsd =
		profile != null && price != null
			? profile.freeFloatShares != null
				? profile.freeFloatShares * price
				: profile.sharesOutstanding != null
					? profile.sharesOutstanding * price
					: null
			: null;

	const listingAgeDays = profile?.ipoDate
		? Math.floor((Date.now() - Date.parse(profile.ipoDate)) / 86_400_000)
		: null;

	return {
		...row,
		marketCapUsd: profile?.marketCapUsd ?? null,
		avgDollarVolume,
		price,
		freeFloatUsd,
		spreadBps,
		listingAgeDays,
	};
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/universe/metrics-enricher.test.ts`
Expected: PASS (6/6).

- [ ] **Step 5: Run verification gate**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

Test count: 748 (742 + 6 new).

- [ ] **Step 6: Commit**

```bash
git add src/universe/metrics-enricher.ts tests/universe/metrics-enricher.test.ts
git commit -m "Universe Step 1a Task 5: enrich US candidates via FMP profile cache; UK skips profile fetch"
```

---

## Task 6: Update integration test to cover end-to-end enrichment

**Files:**
- Modify: `tests/universe/integration.test.ts`

- [ ] **Step 1: Append a realistic scenario test**

Append to `tests/universe/integration.test.ts` (inside the existing `describe` block):

```typescript
	test("full pipeline: US+UK candidates with quote data flow through refresh, get filtered, land in universe", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { enrichWithMetrics } = await import("../../src/universe/metrics-enricher.ts");
		const { upsertProfiles } = await import("../../src/universe/profile-fetcher.ts");
		const { getUniverseHealth } = await import("../../src/monitoring/health.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { quotesCache } = await import("../../src/db/schema.ts");

		// Seed quote data for both US and UK symbols
		await getDb()
			.insert(quotesCache)
			.values([
				{
					symbol: "AAPL",
					exchange: "NASDAQ",
					last: 200,
					avgVolume: 50_000_000,
					bid: 199.9,
					ask: 200.1,
					updatedAt: new Date().toISOString(),
				},
				{
					symbol: "HSBA",
					exchange: "LSE",
					last: 700,
					avgVolume: 10_000_000,
					bid: 699,
					ask: 701,
					updatedAt: new Date().toISOString(),
				},
			]);

		// Seed a fresh profile for AAPL so we don't need to mock fetch
		await upsertProfiles([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				marketCapUsd: 3e12,
				sharesOutstanding: 15e9,
				freeFloatShares: 14.9e9,
				ipoDate: "1980-12-12",
				fetchedAt: new Date().toISOString(),
			},
		]);

		const fetchCandidates = async () =>
			enrichWithMetrics(
				[
					{ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" as const },
					{ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" as const },
				],
				{
					// Shouldn't fire since AAPL profile is fresh and HSBA is UK
					fetchImpl: async () => ({
						ok: false,
						status: 500,
						statusText: "Should not be called",
						json: async () => [],
					}),
				},
			);

		const result = await refreshInvestableUniverse({
			fetchCandidates,
			snapshotDate: "2026-04-17",
		});

		expect(result.added).toBe(2);
		expect(result.rejected).toBe(0);

		const health = await getUniverseHealth();
		expect(health.activeCount).toBe(2);
		expect(health.bySource.russell_1000).toBe(1);
		expect(health.bySource.ftse_350).toBe(1);
	});
```

- [ ] **Step 2: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/universe/integration.test.ts`
Expected: PASS (2/2).

- [ ] **Step 3: Run verification gate**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

Test count: 749 (748 + 1 new).

- [ ] **Step 4: Commit**

```bash
git add tests/universe/integration.test.ts
git commit -m "Universe Step 1a Task 6: integration test covering US + UK enrichment end-to-end"
```

---

## Task 7: Verify source-aggregator still compiles against new enricher signature

**Files:**
- Modify: `src/universe/source-aggregator.ts` (only if needed)

The `enrichWithMetrics` signature changed from `(rows)` to `(rows, options?)`. The `options` param is optional, so existing callers (only `source-aggregator.ts`) continue to work without changes. This task verifies that assumption and makes any trivial adjustments needed.

- [ ] **Step 1: Run typecheck**

Run: `bun run typecheck`

Expected: pass. If there's a TypeScript error about the enricher signature mismatch, proceed to Step 2. Otherwise skip to Step 3.

- [ ] **Step 2: Fix if needed**

If typecheck fails, read `src/universe/source-aggregator.ts` and update the `enrichWithMetrics(rows)` call. No options need to be passed — it'll use the default `fetchImpl = fetch` which is correct for production.

- [ ] **Step 3: Final full verification suite**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

All three must pass. Test count: 749.

- [ ] **Step 4: Commit (only if Step 2 changed anything)**

```bash
git add src/universe/source-aggregator.ts
git commit -m "Universe Step 1a Task 7: source-aggregator trivially compatible with new enricher signature"
```

If Step 2 made no changes, skip the commit — just verify and move on.

---

## Post-plan verification

After Task 7 completes:

1. Run the full verification suite one final time:
   ```bash
   bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
   ```
2. Confirm all 7 tasks' checkboxes are `[x]` in this file
3. Open a PR targeting `main` with a summary of what Step 1a delivers

Expected state after merge + deploy + first Monday 03:00 UTC refresh:

- `symbol_profiles` table populated with ~700 US rows (Russell 1000)
- `investable_universe` table populated with 600–900 active rows across all three `indexSource` buckets
- `/health` universe section shows non-zero counts for all three `bySource` fields

---

## What this plan does NOT do (out of scope)

- UK fundamentals via IBKR `reqFundamentalData` — deferred. If we later want free-float protection for UK, add it as an independent enricher without changing Step 1a.
- Intraday profile updates — profiles refresh at most once per 30 days.
- Per-symbol TTL overrides — flat 30 days for v1.
- Alternative data sources on FMP outage — last-known-good cache is the mitigation.
- Re-running the seed script on VPS — Cal triggers manually after deploy.
