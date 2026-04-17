# Universe Research — Step 1 (Investable Universe) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILLS:
> - `superpowers:subagent-driven-development` to implement this plan task-by-task (recommended execution mode)
> - `long-running-task-harness` for progress tracking, verification gates, and premature completion prevention — this plan has 11 tasks and MUST use the harness
>
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the rules-based investable universe (Tier 1 of the four-tier architecture). Populates an `investable_universe` table from Russell 1000 + FTSE 350 + AIM All-Share, filtered by liquidity. Refreshed weekly, delta-checked daily, snapshotted for point-in-time backtests. No behaviour change to trading yet — this is pure additive infrastructure.

**Architecture:** A new `src/universe/` module encapsulates sources, filters, snapshots, refresh, and delta-check logic. Two new Drizzle tables (`investable_universe`, `universe_snapshots`). Two new cron jobs wired into the existing session-aware scheduler. Monitoring surfaces the universe state in the existing `/health` endpoint. Zero change to strategies, evaluator, or signals in this plan.

**Tech Stack:** Bun + TypeScript (strict), Drizzle ORM on SQLite, Biome, `bun test --preload ./tests/preload.ts`, FMP and IBKR data sources already wired.

**Parent spec:** `docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md`

---

## Harness setup (run BEFORE Task 1)

This plan has 11 tasks. The `long-running-task-harness` skill requires a progress file and verification gate.

**Create the progress file at session start:**

```bash
mkdir -p docs/progress
cat > docs/progress/2026-04-17-universe-research-step1-investable-universe.md <<'EOF'
# Universe Research Step 1 — Progress

Plan: docs/superpowers/plans/2026-04-17-universe-research-step1-investable-universe.md
Spec: docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md

## Task status

- [ ] Task 1: Schema — investable_universe + universe_snapshots tables
- [ ] Task 2: FMP Russell 1000 constituents fetcher
- [ ] Task 3: FMP FTSE 350 + AIM constituents fetchers
- [ ] Task 4: Liquidity filter pipeline
- [ ] Task 5: Universe snapshot writer
- [ ] Task 6: Weekly refresh orchestrator
- [ ] Task 7: Daily delta check (halt/bankrupt detection)
- [ ] Task 8: Cron job registration (weekly + daily)
- [ ] Task 9: Health endpoint exposure
- [ ] Task 10: Initial seed + verification
- [ ] Task 11: End-to-end integration test

## Completed tasks

(will be appended below as tasks complete)
EOF
```

**Verification gate — every task MUST pass before being marked complete:**

1. `bun run typecheck` passes
2. `bun test --preload ./tests/preload.ts` passes
3. `bun run lint` passes (no new errors)
4. Progress file updated with completed work, exported contracts/types, verification results, next task
5. Git commit made (single commit per task)
6. Commit SHA recorded in progress file

**Execution invariants:**
- Only ONE task `in_progress` at a time
- Do NOT start the next task until current task has passing verification + progress entry + commit
- Only the main agent may mark a task `completed`

---

## File Structure

**New files (created during this plan):**

- `drizzle/migrations/0014_investable_universe.sql` — schema migration
- `drizzle/migrations/meta/_journal.json` — migration registry entry
- `src/universe/constants.ts` — liquidity thresholds as named exports
- `src/universe/sources.ts` — index constituent fetchers (Russell 1000, FTSE 350, AIM)
- `src/universe/filters.ts` — liquidity eligibility filter pipeline
- `src/universe/snapshots.ts` — daily point-in-time snapshot writer
- `src/universe/refresh.ts` — weekly refresh orchestrator
- `src/universe/delta.ts` — daily delta check for halt/bankrupt/delisted names
- `src/universe/repo.ts` — DB read helpers for universe membership queries
- `src/scheduler/universe-jobs.ts` — cron job handlers
- `tests/universe/sources.test.ts`
- `tests/universe/filters.test.ts`
- `tests/universe/snapshots.test.ts`
- `tests/universe/refresh.test.ts`
- `tests/universe/delta.test.ts`
- `tests/universe/integration.test.ts`

**Modified files:**

- `src/db/schema.ts` — add two new table definitions
- `src/scheduler/cron.ts` — register two new jobs
- `src/monitoring/cron-schedule.ts` — mirror the cron additions (per CLAUDE.md convention)
- `src/monitoring/health.ts` — expose universe stats

---

## Task 1: Schema — investable_universe + universe_snapshots tables

**Files:**
- Create: `drizzle/migrations/0014_investable_universe.sql`
- Modify: `drizzle/migrations/meta/_journal.json`
- Modify: `src/db/schema.ts`
- Test: (covered by Task 11 integration test — schema compiles via typecheck)

- [ ] **Step 1: Add table definitions to schema.ts**

Append to `src/db/schema.ts` (below existing table exports):

```typescript
export const investableUniverse = sqliteTable("investable_universe", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	indexSource: text("index_source", {
		enum: ["russell_1000", "ftse_350", "aim_allshare"],
	}).notNull(),
	marketCapUsd: real("market_cap_usd"),
	avgDollarVolume: real("avg_dollar_volume"),
	price: real("price"),
	freeFloatUsd: real("free_float_usd"),
	spreadBps: real("spread_bps"),
	listingAgeDays: integer("listing_age_days"),
	inclusionDate: text("inclusion_date")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	lastRefreshed: text("last_refreshed")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
	active: integer("active", { mode: "boolean" }).notNull().default(true),
}, (table) => ({
	symbolExchangeUnique: uniqueIndex("investable_universe_symbol_exchange_unique").on(
		table.symbol,
		table.exchange,
	),
}));

export const universeSnapshots = sqliteTable("universe_snapshots", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	snapshotDate: text("snapshot_date").notNull(),
	symbol: text("symbol").notNull(),
	exchange: text("exchange").notNull(),
	action: text("action", { enum: ["added", "removed", "unchanged"] }).notNull(),
	reason: text("reason"),
	createdAt: text("created_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
}, (table) => ({
	dateIdx: index("universe_snapshots_date_idx").on(table.snapshotDate),
}));
```

Add the imports at the top of `src/db/schema.ts` if not already present: `index`, `uniqueIndex` from `drizzle-orm/sqlite-core`.

- [ ] **Step 2: Generate the migration**

Run: `bunx drizzle-kit generate`

Expected: creates `drizzle/migrations/0014_<drizzle-generated-name>.sql` with `CREATE TABLE` statements for both new tables, appends entry to `_journal.json`. Do NOT rename the generated file — drizzle-kit's naming is tracked by the journal hash; renaming will break migration replay.

- [ ] **Step 3: Verify migration applies cleanly**

```bash
rm -f data/test-migration.db
bun -e 'import { Database } from "bun:sqlite"; import { drizzle } from "drizzle-orm/bun-sqlite"; import { migrate } from "drizzle-orm/bun-sqlite/migrator"; const db = drizzle(new Database("data/test-migration.db")); migrate(db, { migrationsFolder: "./drizzle/migrations" }); console.log("migrations applied");'
rm data/test-migration.db
```

Expected: `migrations applied` with no errors.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors).

- [ ] **Step 5: Run full test suite (baseline)**

Run: `bun test --preload ./tests/preload.ts`
Expected: all existing tests still pass (no regression from schema changes).

- [ ] **Step 6: Run lint**

Run: `bun run lint`
Expected: no new errors. Pre-existing warnings about `any` in test stubs are OK.

- [ ] **Step 7: Update progress file**

Edit `docs/progress/2026-04-17-universe-research-step1-investable-universe.md`: change Task 1 status to `[x]`, append a `## Task 1: Completed` section with exported types (`investableUniverse`, `universeSnapshots`), verification results, and the next task.

- [ ] **Step 8: Commit**

```bash
git add drizzle/migrations/0014_investable_universe.sql drizzle/migrations/meta/_journal.json src/db/schema.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 1: investable_universe + universe_snapshots schema"
```

Record the commit SHA in the progress file.

---

## Task 2: FMP Russell 1000 constituents fetcher

**Files:**
- Create: `src/universe/sources.ts`
- Create: `tests/universe/sources.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/universe/sources.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("fetchRussell1000Constituents", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
	});

	test("returns array of US-listed constituents with symbol and exchange", async () => {
		const { fetchRussell1000Constituents } = await import("../../src/universe/sources.ts");
		const mockFetch = async (url: string) => {
			expect(url).toContain("russell-1000");
			return {
				ok: true,
				json: async () => [
					{ symbol: "AAPL", name: "Apple Inc.", sector: "Technology", exchange: "NASDAQ" },
					{ symbol: "MSFT", name: "Microsoft", sector: "Technology", exchange: "NASDAQ" },
				],
			} as Response;
		};
		const result = await fetchRussell1000Constituents(mockFetch);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ symbol: "AAPL", exchange: "NASDAQ", indexSource: "russell_1000" });
	});

	test("throws on non-ok response", async () => {
		const { fetchRussell1000Constituents } = await import("../../src/universe/sources.ts");
		const mockFetch = async () => ({ ok: false, status: 500, statusText: "Server Error" }) as Response;
		await expect(fetchRussell1000Constituents(mockFetch)).rejects.toThrow();
	});

	test("returns empty array on empty constituent list", async () => {
		const { fetchRussell1000Constituents } = await import("../../src/universe/sources.ts");
		const mockFetch = async () =>
			({ ok: true, json: async () => [] }) as unknown as Response;
		const result = await fetchRussell1000Constituents(mockFetch);
		expect(result).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/universe/sources.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the implementation**

Create `src/universe/sources.ts`:

```typescript
import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "universe:sources" });

export interface ConstituentRow {
	symbol: string;
	exchange: string;
	indexSource: "russell_1000" | "ftse_350" | "aim_allshare";
}

type FetchLike = typeof fetch;

interface FmpConstituent {
	symbol: string;
	name?: string;
	sector?: string;
	exchange?: string;
}

export async function fetchRussell1000Constituents(
	fetchImpl: FetchLike = fetch,
): Promise<ConstituentRow[]> {
	const config = getConfig();
	const url = `https://financialmodelingprep.com/api/v3/russell-1000-constituent?apikey=${config.FMP_API_KEY}`;
	const res = await fetchImpl(url);
	if (!res.ok) {
		throw new Error(`FMP russell-1000 request failed: ${res.status} ${res.statusText}`);
	}
	const rows = (await res.json()) as FmpConstituent[];
	log.info({ count: rows.length }, "Russell 1000 constituents fetched");
	return rows.map((r) => ({
		symbol: r.symbol,
		exchange: r.exchange ?? "NASDAQ",
		indexSource: "russell_1000" as const,
	}));
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/universe/sources.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Run typecheck + full tests + lint**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

All three must pass.

- [ ] **Step 6: Update progress file, commit**

Update progress file with exports (`ConstituentRow`, `fetchRussell1000Constituents`), verification, SHA. Commit:

```bash
git add src/universe/sources.ts tests/universe/sources.test.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 2: Russell 1000 constituents fetcher"
```

---

## Task 3: FMP FTSE 350 + AIM constituents fetchers

**Files:**
- Modify: `src/universe/sources.ts`
- Modify: `tests/universe/sources.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `tests/universe/sources.test.ts`:

```typescript
describe("fetchFtse350Constituents", () => {
	test("returns LSE-listed constituents tagged ftse_350", async () => {
		const { fetchFtse350Constituents } = await import("../../src/universe/sources.ts");
		const mockFetch = async (url: string) => {
			expect(url).toContain("symbol/FTSE");
			return {
				ok: true,
				json: async () => [
					{ symbol: "HSBA.L", name: "HSBC", exchange: "LSE" },
					{ symbol: "BP.L", name: "BP", exchange: "LSE" },
				],
			} as Response;
		};
		const result = await fetchFtse350Constituents(mockFetch);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ symbol: "HSBA", exchange: "LSE", indexSource: "ftse_350" });
	});
});

describe("fetchAimAllShareConstituents", () => {
	test("returns AIM-listed constituents tagged aim_allshare", async () => {
		const { fetchAimAllShareConstituents } = await import("../../src/universe/sources.ts");
		const mockFetch = async (url: string) => {
			expect(url).toContain("symbol/AIM");
			return {
				ok: true,
				json: async () => [
					{ symbol: "GAW.L", name: "Games Workshop", exchange: "AIM" },
					{ symbol: "FDEV.L", name: "Frontier Developments", exchange: "AIM" },
				],
			} as Response;
		};
		const result = await fetchAimAllShareConstituents(mockFetch);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ symbol: "GAW", exchange: "AIM", indexSource: "aim_allshare" });
	});
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/universe/sources.test.ts`
Expected: FAIL with "Property 'fetchFtse350Constituents' does not exist" (and AIM one too).

- [ ] **Step 3: Append implementations to sources.ts**

Append to `src/universe/sources.ts`:

```typescript
// FMP returns LSE symbols with ".L" suffix (e.g. "HSBA.L"); normalise to bare ticker.
function normaliseLondonSymbol(fmpSymbol: string): string {
	return fmpSymbol.endsWith(".L") ? fmpSymbol.slice(0, -2) : fmpSymbol;
}

export async function fetchFtse350Constituents(
	fetchImpl: FetchLike = fetch,
): Promise<ConstituentRow[]> {
	const config = getConfig();
	const url = `https://financialmodelingprep.com/api/v3/symbol/FTSE?apikey=${config.FMP_API_KEY}`;
	const res = await fetchImpl(url);
	if (!res.ok) {
		throw new Error(`FMP FTSE 350 request failed: ${res.status} ${res.statusText}`);
	}
	const rows = (await res.json()) as FmpConstituent[];
	log.info({ count: rows.length }, "FTSE 350 constituents fetched");
	return rows.map((r) => ({
		symbol: normaliseLondonSymbol(r.symbol),
		exchange: "LSE",
		indexSource: "ftse_350" as const,
	}));
}

export async function fetchAimAllShareConstituents(
	fetchImpl: FetchLike = fetch,
): Promise<ConstituentRow[]> {
	const config = getConfig();
	const url = `https://financialmodelingprep.com/api/v3/symbol/AIM?apikey=${config.FMP_API_KEY}`;
	const res = await fetchImpl(url);
	if (!res.ok) {
		throw new Error(`FMP AIM request failed: ${res.status} ${res.statusText}`);
	}
	const rows = (await res.json()) as FmpConstituent[];
	log.info({ count: rows.length }, "AIM All-Share constituents fetched");
	return rows.map((r) => ({
		symbol: normaliseLondonSymbol(r.symbol),
		exchange: "AIM",
		indexSource: "aim_allshare" as const,
	}));
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/universe/sources.test.ts`
Expected: PASS (5/5 total now).

- [ ] **Step 5: Typecheck + full tests + lint**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

- [ ] **Step 6: Update progress file, commit**

```bash
git add src/universe/sources.ts tests/universe/sources.test.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 3: FTSE 350 + AIM constituents fetchers"
```

---

## Task 4: Liquidity filter pipeline

**Files:**
- Create: `src/universe/constants.ts`
- Create: `src/universe/filters.ts`
- Create: `tests/universe/filters.test.ts`

- [ ] **Step 1: Write constants**

Create `src/universe/constants.ts`:

```typescript
// Liquidity thresholds for investable universe eligibility.
// All symbols in the universe must pass ALL filters below.

export const MIN_AVG_DOLLAR_VOLUME_USD = 5_000_000; // 20-day median dollar volume
export const MIN_PRICE_USD = 5; // US microstructure floor
export const MIN_PRICE_GBP_PENCE = 100; // UK microstructure floor (1 GBP)
export const MIN_FREE_FLOAT_USD = 100_000_000;
export const MAX_SPREAD_BPS = 25;
export const MIN_LISTING_AGE_DAYS = 90;

// Universe size safety caps (additive, not a filter)
export const MAX_UNIVERSE_SIZE = 2_000; // hard ceiling across all index sources
```

- [ ] **Step 2: Write the failing test**

Create `tests/universe/filters.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { FilterCandidate } from "../../src/universe/filters.ts";

const US_PASS: FilterCandidate = {
	symbol: "AAPL",
	exchange: "NASDAQ",
	indexSource: "russell_1000",
	marketCapUsd: 3_000_000_000_000,
	avgDollarVolume: 10_000_000_000,
	price: 200,
	freeFloatUsd: 2_000_000_000_000,
	spreadBps: 2,
	listingAgeDays: 10_000,
};

describe("applyLiquidityFilters", () => {
	test("accepts a healthy US mega-cap", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([US_PASS]);
		expect(result.passed).toHaveLength(1);
		expect(result.rejected).toHaveLength(0);
	});

	test("rejects on low dollar volume", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, avgDollarVolume: 100_000 }]);
		expect(result.passed).toHaveLength(0);
		expect(result.rejected[0]?.reasons).toContain("low_dollar_volume");
	});

	test("rejects on low US price", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, price: 2 }]);
		expect(result.rejected[0]?.reasons).toContain("low_price");
	});

	test("rejects on low UK price (pence floor)", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([
			{ ...US_PASS, exchange: "LSE", price: 50 },
		]);
		expect(result.rejected[0]?.reasons).toContain("low_price");
	});

	test("accepts UK name at 150p", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([
			{ ...US_PASS, exchange: "LSE", price: 150 },
		]);
		expect(result.passed).toHaveLength(1);
	});

	test("rejects on low free float", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, freeFloatUsd: 1_000_000 }]);
		expect(result.rejected[0]?.reasons).toContain("low_float");
	});

	test("rejects on wide spread", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, spreadBps: 50 }]);
		expect(result.rejected[0]?.reasons).toContain("wide_spread");
	});

	test("rejects on recent IPO (< 90 days)", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([{ ...US_PASS, listingAgeDays: 30 }]);
		expect(result.rejected[0]?.reasons).toContain("recent_listing");
	});

	test("gracefully handles missing metric data (rejects with missing_data)", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([
			{ ...US_PASS, avgDollarVolume: null, price: null },
		]);
		expect(result.rejected[0]?.reasons).toContain("missing_data");
	});

	test("accumulates multiple reasons when several filters fail", async () => {
		const { applyLiquidityFilters } = await import("../../src/universe/filters.ts");
		const result = applyLiquidityFilters([
			{ ...US_PASS, price: 2, spreadBps: 50, avgDollarVolume: 100 },
		]);
		expect(result.rejected[0]?.reasons.length).toBeGreaterThan(1);
	});
});
```

- [ ] **Step 3: Run test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/universe/filters.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 4: Write the implementation**

Create `src/universe/filters.ts`:

```typescript
import type { ConstituentRow } from "./sources.ts";
import {
	MAX_SPREAD_BPS,
	MIN_AVG_DOLLAR_VOLUME_USD,
	MIN_FREE_FLOAT_USD,
	MIN_LISTING_AGE_DAYS,
	MIN_PRICE_GBP_PENCE,
	MIN_PRICE_USD,
} from "./constants.ts";

export interface FilterCandidate extends ConstituentRow {
	marketCapUsd: number | null;
	avgDollarVolume: number | null;
	price: number | null;
	freeFloatUsd: number | null;
	spreadBps: number | null;
	listingAgeDays: number | null;
}

export type RejectionReason =
	| "missing_data"
	| "low_dollar_volume"
	| "low_price"
	| "low_float"
	| "wide_spread"
	| "recent_listing";

export interface FilterResult {
	passed: FilterCandidate[];
	rejected: Array<{ candidate: FilterCandidate; reasons: RejectionReason[] }>;
}

export function applyLiquidityFilters(candidates: FilterCandidate[]): FilterResult {
	const passed: FilterCandidate[] = [];
	const rejected: FilterResult["rejected"] = [];

	for (const c of candidates) {
		const reasons: RejectionReason[] = [];

		// Missing-data check: if critical fields are null, we can't evaluate.
		if (c.avgDollarVolume == null || c.price == null || c.freeFloatUsd == null) {
			reasons.push("missing_data");
		}

		if (c.avgDollarVolume != null && c.avgDollarVolume < MIN_AVG_DOLLAR_VOLUME_USD) {
			reasons.push("low_dollar_volume");
		}

		if (c.price != null) {
			const isUk = c.exchange === "LSE" || c.exchange === "AIM";
			const floor = isUk ? MIN_PRICE_GBP_PENCE : MIN_PRICE_USD;
			if (c.price < floor) reasons.push("low_price");
		}

		if (c.freeFloatUsd != null && c.freeFloatUsd < MIN_FREE_FLOAT_USD) {
			reasons.push("low_float");
		}

		// Spread is tolerated as optional — many LSE/AIM names won't have live spread.
		// Only reject if we have a measurement AND it exceeds the cap.
		if (c.spreadBps != null && c.spreadBps > MAX_SPREAD_BPS) {
			reasons.push("wide_spread");
		}

		// Listing age is tolerated as optional too — if we don't know, we don't reject.
		if (c.listingAgeDays != null && c.listingAgeDays < MIN_LISTING_AGE_DAYS) {
			reasons.push("recent_listing");
		}

		if (reasons.length === 0) {
			passed.push(c);
		} else {
			rejected.push({ candidate: c, reasons });
		}
	}

	return { passed, rejected };
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/universe/filters.test.ts`
Expected: PASS (10/10).

- [ ] **Step 6: Typecheck + full tests + lint**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

- [ ] **Step 7: Update progress file, commit**

```bash
git add src/universe/constants.ts src/universe/filters.ts tests/universe/filters.test.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 4: liquidity filter pipeline"
```

---

## Task 5: Universe snapshot writer

**Files:**
- Create: `src/universe/snapshots.ts`
- Create: `tests/universe/snapshots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/universe/snapshots.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("writeDailySnapshot", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("records an added row when symbol is new in current membership", async () => {
		const { writeDailySnapshot } = await import("../../src/universe/snapshots.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { universeSnapshots } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await writeDailySnapshot("2026-04-17", {
			current: [{ symbol: "AAPL", exchange: "NASDAQ" }],
			previous: [],
		});

		const rows = await getDb()
			.select()
			.from(universeSnapshots)
			.where(eq(universeSnapshots.snapshotDate, "2026-04-17"))
			.all();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.action).toBe("added");
		expect(rows[0]?.symbol).toBe("AAPL");
	});

	test("records a removed row when symbol exits membership", async () => {
		const { writeDailySnapshot } = await import("../../src/universe/snapshots.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { universeSnapshots } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await writeDailySnapshot("2026-04-17", {
			current: [],
			previous: [{ symbol: "MSFT", exchange: "NASDAQ" }],
			removalReasons: { "MSFT:NASDAQ": "halted" },
		});

		const rows = await getDb()
			.select()
			.from(universeSnapshots)
			.where(eq(universeSnapshots.snapshotDate, "2026-04-17"))
			.all();

		expect(rows).toHaveLength(1);
		expect(rows[0]?.action).toBe("removed");
		expect(rows[0]?.reason).toBe("halted");
	});

	test("writes nothing for unchanged membership", async () => {
		const { writeDailySnapshot } = await import("../../src/universe/snapshots.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { universeSnapshots } = await import("../../src/db/schema.ts");

		await writeDailySnapshot("2026-04-17", {
			current: [{ symbol: "AAPL", exchange: "NASDAQ" }],
			previous: [{ symbol: "AAPL", exchange: "NASDAQ" }],
		});

		const rows = await getDb().select().from(universeSnapshots).all();
		expect(rows).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/universe/snapshots.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the implementation**

Create `src/universe/snapshots.ts`:

```typescript
import { getDb } from "../db/client.ts";
import { universeSnapshots } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "universe:snapshots" });

export interface SymbolRef {
	symbol: string;
	exchange: string;
}

export interface SnapshotInput {
	current: SymbolRef[];
	previous: SymbolRef[];
	// Keyed by `${symbol}:${exchange}` — optional, only for removed rows.
	removalReasons?: Record<string, string>;
}

const key = (r: SymbolRef) => `${r.symbol}:${r.exchange}`;

export async function writeDailySnapshot(
	snapshotDate: string,
	input: SnapshotInput,
): Promise<{ added: number; removed: number }> {
	const db = getDb();
	const currentSet = new Set(input.current.map(key));
	const previousSet = new Set(input.previous.map(key));

	const added = input.current.filter((r) => !previousSet.has(key(r)));
	const removed = input.previous.filter((r) => !currentSet.has(key(r)));

	if (added.length === 0 && removed.length === 0) {
		log.info({ snapshotDate }, "No universe changes to snapshot");
		return { added: 0, removed: 0 };
	}

	const rows = [
		...added.map((r) => ({
			snapshotDate,
			symbol: r.symbol,
			exchange: r.exchange,
			action: "added" as const,
			reason: null,
		})),
		...removed.map((r) => ({
			snapshotDate,
			symbol: r.symbol,
			exchange: r.exchange,
			action: "removed" as const,
			reason: input.removalReasons?.[key(r)] ?? null,
		})),
	];

	await db.insert(universeSnapshots).values(rows);
	log.info(
		{ snapshotDate, added: added.length, removed: removed.length },
		"Universe snapshot written",
	);
	return { added: added.length, removed: removed.length };
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/universe/snapshots.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Typecheck + full tests + lint**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

- [ ] **Step 6: Update progress file, commit**

```bash
git add src/universe/snapshots.ts tests/universe/snapshots.test.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 5: daily snapshot writer"
```

---

## Task 6: Weekly refresh orchestrator

**Files:**
- Create: `src/universe/repo.ts`
- Create: `src/universe/refresh.ts`
- Create: `tests/universe/refresh.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/universe/refresh.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import type { FilterCandidate } from "../../src/universe/filters.ts";

describe("refreshInvestableUniverse", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("populates investable_universe with passed candidates and writes a snapshot", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse, universeSnapshots } = await import("../../src/db/schema.ts");

		const candidates: FilterCandidate[] = [
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				indexSource: "russell_1000",
				marketCapUsd: 3e12,
				avgDollarVolume: 1e10,
				price: 200,
				freeFloatUsd: 2e12,
				spreadBps: 2,
				listingAgeDays: 10000,
			},
		];

		const result = await refreshInvestableUniverse({
			fetchCandidates: async () => candidates,
			snapshotDate: "2026-04-17",
		});

		expect(result.added).toBe(1);
		expect(result.rejected).toBe(0);

		const rows = await getDb().select().from(investableUniverse).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.symbol).toBe("AAPL");

		const snaps = await getDb().select().from(universeSnapshots).all();
		expect(snaps.some((s) => s.action === "added" && s.symbol === "AAPL")).toBe(true);
	});

	test("removes symbols no longer passing filters", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		// Seed an initial entry
		await getDb().insert(investableUniverse).values({
			symbol: "STALE",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			active: true,
		});

		const result = await refreshInvestableUniverse({
			fetchCandidates: async () => [], // nothing passes this cycle
			snapshotDate: "2026-04-17",
		});

		expect(result.removed).toBe(1);
		const rows = await getDb()
			.select()
			.from(investableUniverse)
			.where(eq(investableUniverse.active, false))
			.all();
		expect(rows).toHaveLength(1);
	});

	test("does not remove symbols that are exempted (e.g. open positions)", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await getDb().insert(investableUniverse).values({
			symbol: "HOLD",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			active: true,
		});

		await refreshInvestableUniverse({
			fetchCandidates: async () => [],
			snapshotDate: "2026-04-17",
			exemptSymbols: ["HOLD:NASDAQ"],
		});

		const rows = await getDb()
			.select()
			.from(investableUniverse)
			.where(eq(investableUniverse.symbol, "HOLD"))
			.all();
		expect(rows[0]?.active).toBe(true);
	});
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/universe/refresh.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the repo helper**

Create `src/universe/repo.ts`:

```typescript
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse } from "../db/schema.ts";
import type { SymbolRef } from "./snapshots.ts";

export async function getActiveUniverseMembership(): Promise<SymbolRef[]> {
	const db = getDb();
	const rows = await db
		.select({ symbol: investableUniverse.symbol, exchange: investableUniverse.exchange })
		.from(investableUniverse)
		.where(eq(investableUniverse.active, true))
		.all();
	return rows;
}
```

- [ ] **Step 4: Write the refresh orchestrator**

Create `src/universe/refresh.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { applyLiquidityFilters, type FilterCandidate } from "./filters.ts";
import { getActiveUniverseMembership } from "./repo.ts";
import { writeDailySnapshot } from "./snapshots.ts";

const log = createChildLogger({ module: "universe:refresh" });

export interface RefreshInput {
	fetchCandidates: () => Promise<FilterCandidate[]>;
	snapshotDate: string;
	// Symbols that must NOT be removed even if they fail filters (e.g. open positions).
	// Keyed as `${symbol}:${exchange}`.
	exemptSymbols?: string[];
}

export interface RefreshResult {
	added: number;
	removed: number;
	rejected: number;
}

export async function refreshInvestableUniverse(input: RefreshInput): Promise<RefreshResult> {
	const db = getDb();
	const exempt = new Set(input.exemptSymbols ?? []);

	const candidates = await input.fetchCandidates();
	const { passed, rejected } = applyLiquidityFilters(candidates);

	const previous = await getActiveUniverseMembership();
	const previousSet = new Set(previous.map((r) => `${r.symbol}:${r.exchange}`));
	const passedSet = new Set(passed.map((p) => `${p.symbol}:${p.exchange}`));

	// Upsert all passed candidates as active
	for (const p of passed) {
		await db
			.insert(investableUniverse)
			.values({
				symbol: p.symbol,
				exchange: p.exchange,
				indexSource: p.indexSource,
				marketCapUsd: p.marketCapUsd ?? null,
				avgDollarVolume: p.avgDollarVolume ?? null,
				price: p.price ?? null,
				freeFloatUsd: p.freeFloatUsd ?? null,
				spreadBps: p.spreadBps ?? null,
				listingAgeDays: p.listingAgeDays ?? null,
				active: true,
				lastRefreshed: new Date().toISOString(),
			})
			.onConflictDoUpdate({
				target: [investableUniverse.symbol, investableUniverse.exchange],
				set: {
					indexSource: p.indexSource,
					marketCapUsd: p.marketCapUsd ?? null,
					avgDollarVolume: p.avgDollarVolume ?? null,
					price: p.price ?? null,
					freeFloatUsd: p.freeFloatUsd ?? null,
					spreadBps: p.spreadBps ?? null,
					listingAgeDays: p.listingAgeDays ?? null,
					active: true,
					lastRefreshed: new Date().toISOString(),
				},
			});
	}

	// Deactivate previous entries that aren't in the new passed set and aren't exempt
	const removedSymbols: { symbol: string; exchange: string }[] = [];
	for (const prev of previous) {
		const k = `${prev.symbol}:${prev.exchange}`;
		if (passedSet.has(k) || exempt.has(k)) continue;
		await db
			.update(investableUniverse)
			.set({ active: false, lastRefreshed: new Date().toISOString() })
			.where(
				and(
					eq(investableUniverse.symbol, prev.symbol),
					eq(investableUniverse.exchange, prev.exchange),
				),
			);
		removedSymbols.push(prev);
	}

	const addedSymbols = passed.filter((p) => !previousSet.has(`${p.symbol}:${p.exchange}`));

	await writeDailySnapshot(input.snapshotDate, {
		current: passed.map((p) => ({ symbol: p.symbol, exchange: p.exchange })),
		previous,
		removalReasons: Object.fromEntries(
			removedSymbols.map((r) => [`${r.symbol}:${r.exchange}`, "filter_reject_or_delisted"]),
		),
	});

	log.info(
		{ added: addedSymbols.length, removed: removedSymbols.length, rejected: rejected.length },
		"Investable universe refresh complete",
	);

	return {
		added: addedSymbols.length,
		removed: removedSymbols.length,
		rejected: rejected.length,
	};
}
```

- [ ] **Step 5: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/universe/refresh.test.ts`
Expected: PASS (3/3).

- [ ] **Step 6: Typecheck + full tests + lint**

- [ ] **Step 7: Update progress file, commit**

```bash
git add src/universe/repo.ts src/universe/refresh.ts tests/universe/refresh.test.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 6: weekly refresh orchestrator"
```

---

## Task 7: Daily delta check (halt/bankrupt detection)

**Files:**
- Create: `src/universe/delta.ts`
- Create: `tests/universe/delta.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/universe/delta.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("runDailyDeltaCheck", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("demotes symbols flagged as halted by the checker", async () => {
		const { runDailyDeltaCheck } = await import("../../src/universe/delta.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await getDb().insert(investableUniverse).values({
			symbol: "HALT",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			active: true,
		});

		const result = await runDailyDeltaCheck({
			checker: async () => [{ symbol: "HALT", exchange: "NASDAQ", reason: "halted" }],
			snapshotDate: "2026-04-17",
		});

		expect(result.demoted).toBe(1);
		const rows = await getDb()
			.select()
			.from(investableUniverse)
			.where(eq(investableUniverse.symbol, "HALT"))
			.all();
		expect(rows[0]?.active).toBe(false);
	});

	test("does nothing when no symbols are flagged", async () => {
		const { runDailyDeltaCheck } = await import("../../src/universe/delta.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");

		await getDb().insert(investableUniverse).values({
			symbol: "OK",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			active: true,
		});

		const result = await runDailyDeltaCheck({
			checker: async () => [],
			snapshotDate: "2026-04-17",
		});

		expect(result.demoted).toBe(0);
	});

	test("respects exemptSymbols (open positions stay active)", async () => {
		const { runDailyDeltaCheck } = await import("../../src/universe/delta.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await getDb().insert(investableUniverse).values({
			symbol: "HOLD",
			exchange: "NASDAQ",
			indexSource: "russell_1000" as const,
			active: true,
		});

		await runDailyDeltaCheck({
			checker: async () => [{ symbol: "HOLD", exchange: "NASDAQ", reason: "halted" }],
			snapshotDate: "2026-04-17",
			exemptSymbols: ["HOLD:NASDAQ"],
		});

		const rows = await getDb()
			.select()
			.from(investableUniverse)
			.where(eq(investableUniverse.symbol, "HOLD"))
			.all();
		expect(rows[0]?.active).toBe(true);
	});
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/universe/delta.test.ts`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Write the implementation**

Create `src/universe/delta.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse, universeSnapshots } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "universe:delta" });

export interface DeltaFlag {
	symbol: string;
	exchange: string;
	reason: string; // e.g. "halted", "delisted", "bankrupt"
}

export interface DeltaCheckInput {
	checker: () => Promise<DeltaFlag[]>;
	snapshotDate: string;
	exemptSymbols?: string[]; // `${symbol}:${exchange}` — open positions
}

export interface DeltaCheckResult {
	demoted: number;
}

export async function runDailyDeltaCheck(input: DeltaCheckInput): Promise<DeltaCheckResult> {
	const db = getDb();
	const exempt = new Set(input.exemptSymbols ?? []);
	const flags = await input.checker();

	let demoted = 0;
	for (const flag of flags) {
		const k = `${flag.symbol}:${flag.exchange}`;
		if (exempt.has(k)) {
			log.info({ symbol: flag.symbol, exchange: flag.exchange }, "Skipping exempt symbol");
			continue;
		}
		const result = await db
			.update(investableUniverse)
			.set({ active: false, lastRefreshed: new Date().toISOString() })
			.where(
				and(
					eq(investableUniverse.symbol, flag.symbol),
					eq(investableUniverse.exchange, flag.exchange),
					eq(investableUniverse.active, true),
				),
			)
			.returning({ id: investableUniverse.id });

		if (result.length > 0) {
			demoted++;
			await db.insert(universeSnapshots).values({
				snapshotDate: input.snapshotDate,
				symbol: flag.symbol,
				exchange: flag.exchange,
				action: "removed" as const,
				reason: flag.reason,
			});
		}
	}

	log.info({ flagged: flags.length, demoted }, "Daily delta check complete");
	return { demoted };
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/universe/delta.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Typecheck + full tests + lint**

- [ ] **Step 6: Update progress file, commit**

```bash
git add src/universe/delta.ts tests/universe/delta.test.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 7: daily delta check for halted/delisted names"
```

---

## Task 8: Cron job registration

**Files:**
- Create: `src/scheduler/universe-jobs.ts`
- Modify: `src/scheduler/cron.ts`
- Modify: `src/monitoring/cron-schedule.ts`

- [ ] **Step 1: Write the job handlers**

Create `src/scheduler/universe-jobs.ts`:

```typescript
import { getOpenPositionSymbols } from "../paper/manager.ts";
import { runDailyDeltaCheck } from "../universe/delta.ts";
import { refreshInvestableUniverse } from "../universe/refresh.ts";
import { fetchCandidatesFromAllSources } from "../universe/source-aggregator.ts";
import { ibkrHaltChecker } from "../universe/halt-checker.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "scheduler-jobs" });

export async function runWeeklyUniverseRefresh(): Promise<void> {
	log.info({ job: "universe_refresh_weekly" }, "Job starting");
	const start = Date.now();
	const openPositions = await getOpenPositionSymbols();
	const exemptSymbols = openPositions.map((p) => `${p.symbol}:${p.exchange}`);
	const result = await refreshInvestableUniverse({
		fetchCandidates: fetchCandidatesFromAllSources,
		snapshotDate: new Date().toISOString().slice(0, 10),
		exemptSymbols,
	});
	log.info(
		{ job: "universe_refresh_weekly", durationMs: Date.now() - start, ...result },
		"Job completed",
	);
}

export async function runDailyUniverseDelta(): Promise<void> {
	log.info({ job: "universe_delta_daily" }, "Job starting");
	const start = Date.now();
	const openPositions = await getOpenPositionSymbols();
	const exemptSymbols = openPositions.map((p) => `${p.symbol}:${p.exchange}`);
	const result = await runDailyDeltaCheck({
		checker: ibkrHaltChecker,
		snapshotDate: new Date().toISOString().slice(0, 10),
		exemptSymbols,
	});
	log.info(
		{ job: "universe_delta_daily", durationMs: Date.now() - start, demoted: result.demoted },
		"Job completed",
	);
}
```

- [ ] **Step 2: Write the source aggregator (internal helper)**

Create `src/universe/source-aggregator.ts`:

```typescript
import type { FilterCandidate } from "./filters.ts";
import {
	fetchAimAllShareConstituents,
	fetchFtse350Constituents,
	fetchRussell1000Constituents,
	type ConstituentRow,
} from "./sources.ts";
import { enrichWithMetrics } from "./metrics-enricher.ts";

export async function fetchCandidatesFromAllSources(): Promise<FilterCandidate[]> {
	const [russell, ftse, aim] = await Promise.all([
		fetchRussell1000Constituents(),
		fetchFtse350Constituents(),
		fetchAimAllShareConstituents(),
	]);
	const rows: ConstituentRow[] = [...russell, ...ftse, ...aim];
	return enrichWithMetrics(rows);
}
```

- [ ] **Step 3: Write the metrics enricher (uses existing FMP + IBKR quote data)**

Create `src/universe/metrics-enricher.ts`:

```typescript
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import type { FilterCandidate } from "./filters.ts";
import type { ConstituentRow } from "./sources.ts";

// Enriches constituents with market-cap, avg volume, price, and spread data
// sourced from the existing quotes_cache table. Symbols with no cached data
// get null fields and are rejected by the filters with reason "missing_data".
export async function enrichWithMetrics(rows: ConstituentRow[]): Promise<FilterCandidate[]> {
	const db = getDb();
	const symbols = rows.map((r) => r.symbol);
	const quotes = await db
		.select()
		.from(quotesCache)
		.where(inArray(quotesCache.symbol, symbols))
		.all();
	const map = new Map(quotes.map((q) => [`${q.symbol}:${q.exchange}`, q]));
	return rows.map((r) => {
		const q = map.get(`${r.symbol}:${r.exchange}`);
		const avgDollarVolume =
			q?.avgVolume != null && q?.last != null ? q.avgVolume * q.last : null;
		return {
			...r,
			marketCapUsd: null,
			avgDollarVolume,
			price: q?.last ?? null,
			freeFloatUsd: null,
			spreadBps:
				q?.bid != null && q?.ask != null && q.bid > 0
					? ((q.ask - q.bid) / q.bid) * 10_000
					: null,
			listingAgeDays: null,
		};
	});
}
```

- [ ] **Step 4: Write the halt checker (IBKR stub for v1)**

Create `src/universe/halt-checker.ts`:

```typescript
import { createChildLogger } from "../utils/logger.ts";
import type { DeltaFlag } from "./delta.ts";

const log = createChildLogger({ module: "universe:halt-checker" });

// v1 design: returns an empty list — live halt detection requires an IBKR
// event-stream subscription or a paid SEC halt feed, both of which are
// deferred to the follow-up iteration (see spec "Deferred" section).
// Symbols that genuinely go stale are still caught by the weekly refresh's
// filter pass (missing_data or low_dollar_volume rejects them), so the
// universe self-corrects within 7 days of any dropout even without this.
export async function ibkrHaltChecker(): Promise<DeltaFlag[]> {
	log.info("Halt checker v1 is a no-op; weekly refresh handles stale symbols");
	return [];
}
```

- [ ] **Step 5: Add getOpenPositionSymbols to paper manager**

Check `src/paper/manager.ts` first. If `getOpenPositionSymbols` doesn't exist, add it. If it does, skip this step.

Append to `src/paper/manager.ts` if missing:

```typescript
export async function getOpenPositionSymbols(): Promise<{ symbol: string; exchange: string }[]> {
	const db = getDb();
	const rows = await db
		.select({ symbol: paperPositions.symbol, exchange: paperPositions.exchange })
		.from(paperPositions)
		.where(isNull(paperPositions.closedAt))
		.all();
	return rows;
}
```

- [ ] **Step 6: Wire jobs into cron.ts**

Read `src/scheduler/cron.ts` first — the file is the canonical registration point and uses a specific schema (job name, cron expression, category, handler, lock scope). Follow the pattern used by existing jobs like `news_poll` and `strategy_eval_us`. Register two new jobs:

- **`universe_refresh_weekly`** — cron `0 3 * * 1` (Mon 03:00 UTC, before pre-market), category `analysis`, handler `runWeeklyUniverseRefresh` (imported from `./universe-jobs.ts`). Lock scope: `analysis` (serialises against other batch jobs).
- **`universe_delta_daily`** — cron `30 22 * * 1-5` (weekdays 22:30 UTC, during post_close window), category `analysis`, handler `runDailyUniverseDelta`. Lock scope: `analysis`.

Both jobs do NOT require market-data sessions — they run off cached quote data. Category `analysis` is the correct fit (same category as `research_outcome_backfill` from Wave 1).

Mirror the same two entries in `src/monitoring/cron-schedule.ts`. Per CLAUDE.md convention the two files must be kept in sync — the monitoring mirror is what the health dashboard reads to display the schedule. If `src/monitoring/cron-schedule.ts` tracks a `JOB_COUNT` constant or array length, increment by 2.

- [ ] **Step 7: Typecheck + full tests + lint**

Pay attention to `src/monitoring/cron-schedule.ts` — the job count value must match the new total.

- [ ] **Step 8: Update progress file, commit**

```bash
git add src/scheduler/universe-jobs.ts src/scheduler/cron.ts src/monitoring/cron-schedule.ts src/universe/source-aggregator.ts src/universe/metrics-enricher.ts src/universe/halt-checker.ts src/paper/manager.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 8: cron job registration + source aggregator"
```

---

## Task 9: Health endpoint exposure

**Files:**
- Modify: `src/monitoring/health.ts`
- Modify existing health test if one exists, otherwise add a unit test for the new function.

- [ ] **Step 1: Read the existing health endpoint**

Read `src/monitoring/health.ts` to understand how sections are added. Identify the response shape (probably `{ status, strategies, positions, ... }`).

- [ ] **Step 2: Add a universe stats helper**

Append to `src/monitoring/health.ts` (or a new `src/monitoring/universe-health.ts` if the health file is large):

```typescript
export async function getUniverseHealth(): Promise<{
	activeCount: number;
	lastRefreshed: string | null;
	bySource: { russell_1000: number; ftse_350: number; aim_allshare: number };
}> {
	const db = getDb();
	const rows = await db
		.select({
			indexSource: investableUniverse.indexSource,
			lastRefreshed: investableUniverse.lastRefreshed,
		})
		.from(investableUniverse)
		.where(eq(investableUniverse.active, true))
		.all();
	const bySource = { russell_1000: 0, ftse_350: 0, aim_allshare: 0 };
	let latest: string | null = null;
	for (const r of rows) {
		bySource[r.indexSource]++;
		if (latest == null || r.lastRefreshed > latest) latest = r.lastRefreshed;
	}
	return { activeCount: rows.length, lastRefreshed: latest, bySource };
}
```

Ensure imports at top of file include `investableUniverse` from schema and `eq` from drizzle-orm.

- [ ] **Step 3: Include in health response**

Locate the exported HTTP handler in `src/monitoring/health.ts` (search for the function that returns the JSON response body — typically named `getHealth`, `healthHandler`, or invoked by the `/health` route in `src/http`). Add `universe: await getUniverseHealth()` as a new top-level field in the returned object, alongside existing fields like `strategies`, `positions`, `cronJobs`, etc. Do NOT nest it inside an existing section.

- [ ] **Step 4: Write a test**

Create or append to `tests/monitoring/health.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("getUniverseHealth", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("reports zero when universe is empty", async () => {
		const { getUniverseHealth } = await import("../../src/monitoring/health.ts");
		const result = await getUniverseHealth();
		expect(result.activeCount).toBe(0);
		expect(result.bySource.russell_1000).toBe(0);
	});

	test("counts active symbols by source", async () => {
		const { getUniverseHealth } = await import("../../src/monitoring/health.ts");
		const { getDb } = await import("../../src/db/client.ts");
		const { investableUniverse } = await import("../../src/db/schema.ts");

		await getDb().insert(investableUniverse).values([
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				active: true,
			},
			{
				symbol: "HSBA",
				exchange: "LSE",
				indexSource: "ftse_350" as const,
				active: true,
			},
			{
				symbol: "GONE",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				active: false,
			},
		]);

		const result = await getUniverseHealth();
		expect(result.activeCount).toBe(2);
		expect(result.bySource.russell_1000).toBe(1);
		expect(result.bySource.ftse_350).toBe(1);
	});
});
```

- [ ] **Step 5: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/monitoring/health.test.ts`
Expected: PASS (2/2 for the new tests; existing tests also still pass).

- [ ] **Step 6: Typecheck + full tests + lint**

- [ ] **Step 7: Update progress file, commit**

```bash
git add src/monitoring/health.ts tests/monitoring/health.test.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 9: health endpoint universe section"
```

---

## Task 10: Initial seed + verification

**Files:**
- Create: `scripts/seed-universe.ts`

- [ ] **Step 1: Write the seeding script**

Create `scripts/seed-universe.ts`:

```typescript
#!/usr/bin/env bun
// Manual one-off script to trigger the first universe refresh. Run locally
// against dev DB first, then against VPS production DB via vps-ssh.sh.
import { runWeeklyUniverseRefresh } from "../src/scheduler/universe-jobs.ts";

async function main() {
	console.log("Running initial universe seed...");
	await runWeeklyUniverseRefresh();
	console.log("Done. Check /health for universe stats.");
	process.exit(0);
}

main().catch((err) => {
	console.error("Seed failed:", err);
	process.exit(1);
});
```

- [ ] **Step 2: Run locally against a throwaway DB**

```bash
DATABASE_PATH=data/seed-test.db bun run drizzle-kit migrate
DATABASE_PATH=data/seed-test.db bun scripts/seed-universe.ts
```

Expected: log output showing candidates fetched, passed, rejected. Universe should have some rows in `investable_universe`.

Verify:

```bash
DATABASE_PATH=data/seed-test.db bun -e 'import { getDb } from "./src/db/client.ts"; import { investableUniverse } from "./src/db/schema.ts"; import { eq } from "drizzle-orm"; const rows = await getDb().select().from(investableUniverse).where(eq(investableUniverse.active, true)).all(); console.log("active:", rows.length);'
```

Expected: count > 0 (note: many candidates will reject on `missing_data` because quotes_cache is empty in a fresh DB — that's fine for now; production has live quotes).

Clean up: `rm data/seed-test.db`

- [ ] **Step 3: Update progress file, commit**

```bash
git add scripts/seed-universe.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 10: seed script + local verification"
```

---

## Task 11: End-to-end integration test

**Files:**
- Create: `tests/universe/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/universe/integration.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("universe — end-to-end integration", () => {
	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		const db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("refresh -> snapshot -> delta -> health reports consistent state", async () => {
		const { refreshInvestableUniverse } = await import("../../src/universe/refresh.ts");
		const { runDailyDeltaCheck } = await import("../../src/universe/delta.ts");
		const { getUniverseHealth } = await import("../../src/monitoring/health.ts");

		const candidates = [
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				indexSource: "russell_1000" as const,
				marketCapUsd: 3e12,
				avgDollarVolume: 1e10,
				price: 200,
				freeFloatUsd: 2e12,
				spreadBps: 2,
				listingAgeDays: 10000,
			},
			{
				symbol: "HSBA",
				exchange: "LSE",
				indexSource: "ftse_350" as const,
				marketCapUsd: 150e9,
				avgDollarVolume: 5e8,
				price: 700,
				freeFloatUsd: 100e9,
				spreadBps: 4,
				listingAgeDays: 10000,
			},
		];

		// Initial refresh
		const r1 = await refreshInvestableUniverse({
			fetchCandidates: async () => candidates,
			snapshotDate: "2026-04-17",
		});
		expect(r1.added).toBe(2);

		// Delta check flags one as halted
		const d1 = await runDailyDeltaCheck({
			checker: async () => [{ symbol: "AAPL", exchange: "NASDAQ", reason: "halted" }],
			snapshotDate: "2026-04-17",
		});
		expect(d1.demoted).toBe(1);

		// Health reports 1 active
		const h = await getUniverseHealth();
		expect(h.activeCount).toBe(1);
		expect(h.bySource.russell_1000).toBe(0);
		expect(h.bySource.ftse_350).toBe(1);
	});
});
```

- [ ] **Step 2: Run test — verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/universe/integration.test.ts`
Expected: PASS (1/1).

- [ ] **Step 3: Final typecheck + full suite + lint**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

All three must pass. This is the final verification gate per the long-running-task-harness skill.

- [ ] **Step 4: Update progress file**

Mark Task 11 complete. Add a final summary section: total tasks completed, total tests added, total files touched, any deferred decisions (e.g. SEC data — deferred to Step 2's follow-up).

- [ ] **Step 5: Commit**

```bash
git add tests/universe/integration.test.ts docs/progress/2026-04-17-universe-research-step1-investable-universe.md
git commit -m "Universe Step 1 Task 11: end-to-end integration test"
```

---

## Post-plan verification (long-running-task-harness)

After Task 11 completes, run the premature-completion-prevention checks:

1. Confirm every task checkbox is `[x]` in this plan file
2. Confirm the progress file has completion entries for all 11 tasks
3. Run the full verification suite one final time:
   ```bash
   bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
   ```
4. Note any deferred items in the progress file's final summary (specifically: Form 4 / 8-K filing triggers remain deferred; those land in a future follow-up plan)
5. Open a PR using the `gh pr create` workflow — target `main`, include a summary of tasks and what ships

Do NOT declare "Step 1 complete" without running the full verification suite one last time.

---

## What this plan does NOT do (out of scope)

These live in separate plans that follow this one:

- **Step 2** — Active Watchlist construction (catalyst-promoted, LLM-enriched)
- **Step 3** — Migrate `news_sentiment_mr_v1` to consume the watchlist via `watchlist_filter`
- **Step 4** — Migrate `earnings_drift_v1` and `earnings_drift_aggressive_v1`
- **Step 5** — Retire the legacy static `universe` column from seeds

SEC filings (Form 4, 8-K) triggers are deferred entirely to a post-v1 follow-up — the spec locks this in as a cost-minimisation decision.

## Explicit v1 deferrals (documented, not bugs)

The spec lists several eligibility criteria we do NOT enforce in Step 1. These are conscious scope cuts, recorded here so they aren't mistaken for missing requirements during review:

- **Live halt detection** — the halt checker returns an empty list. Weekly refresh catches stale symbols via `missing_data` / `low_dollar_volume`.
- **SPAC-merger-within-90-days exclusion** — relying on `listingAgeDays` filter as a proxy. Explicit SPAC detection requires a tagged dataset we don't have.
- **Leveraged/inverse ETF exclusion** — Russell 1000 doesn't contain these; LSE/AIM contain a handful but they'll mostly fail the $5M ADV filter. Explicit exclusion deferred.
- **SEC-investigation flag** — no data source; deferred.
- **Learning-loop `exclude_from_universe` flag** — not implemented; the learning loop currently produces insights at a different layer. Wiring is deferred to Step 2 or later.

None of these prevent the v1 universe from being useful; they just mean a handful of edge-case names might slip through that a mature system would exclude. Step 5 (retire legacy universes) is a natural checkpoint to revisit these.
