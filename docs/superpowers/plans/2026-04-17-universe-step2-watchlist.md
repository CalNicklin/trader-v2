# Universe Step 2 — Active Watchlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> This plan has 16 tasks — above the 10-task threshold. Use `long-running-task-harness` for progress tracking and premature-completion prevention.

**Goal:** Build Tier 2 of the four-tier universe architecture — a catalyst-promoted `watchlist` table with async LLM enrichment, demotion rules, and `/health` surface. Step 2 is purely additive; no strategy consumes the watchlist (that's Step 3).

**Architecture:** New `src/watchlist/` module, two new DB tables (`watchlist`, `catalyst_events`), four new scheduler jobs (earnings-catalyst, volume-catalyst, watchlist-enrich, watchlist-demote), integrations into three existing modules (news classifier, research-agent, pattern-analysis), `/health` extension, and an eval suite for enrichment prompt quality.

**Tech Stack:** Bun + TypeScript (strict), Drizzle + SQLite, Biome (tab indent), `bun test --preload ./tests/preload.ts`, `@anthropic-ai/sdk`, `node-cron`, FMP `/v3/earning_calendar`.

**Parent spec:** `docs/superpowers/specs/2026-04-17-universe-step2-watchlist-design.md`

---

## Verification gate (every task)

1. `bun run typecheck` passes
2. `bun test --preload ./tests/preload.ts` passes (no regression from 751 baseline + new tests from this task)
3. `bun run lint` passes (no new errors; pre-existing warnings about `any` in test stubs are OK)
4. Commit is made with a clear scope-prefixed message
5. Only ONE task `in_progress` at a time

Do NOT mark a task complete based on "it looks right." Run the checks.

---

## File Structure

**New files:**

- `drizzle/migrations/0016_<drizzle-generated-name>.sql` — schema migration for `watchlist` + `catalyst_events`
- `src/watchlist/constants.ts` — thresholds and magic numbers
- `src/watchlist/repo.ts` — reads: `getActiveWatchlist`, `getUnenrichedRows`, `getWatchlistByExchange`, `countActive`
- `src/watchlist/catalyst-events.ts` — `writeCatalystEvent`, `markLedToPromotion`
- `src/watchlist/promote.ts` — idempotent upsert with reason merging + TTL extension
- `src/watchlist/filters.ts` — `rankForCapEviction` composite scoring
- `src/watchlist/demote.ts` — seven demotion rules + never-demote exception + cap eviction
- `src/watchlist/enrich.ts` — `buildEnrichmentPrompt`, `parseEnrichmentResponse`, `enrichOne`
- `src/scheduler/earnings-catalyst-job.ts` — daily earnings-calendar sweep
- `src/scheduler/volume-catalyst-job.ts` — session-boundary volume scan
- `src/scheduler/watchlist-enrich-job.ts` — every-15min + post-close enrichment
- `src/scheduler/watchlist-demote-job.ts` — daily demotion sweep
- `src/evals/watchlist-enrichment/tasks.ts` — eval dataset
- `src/evals/watchlist-enrichment/graders.ts` — code + LLM-as-judge graders
- `src/evals/watchlist-enrichment/harness.ts` — eval runner
- `tests/watchlist/promote.test.ts`
- `tests/watchlist/demote.test.ts`
- `tests/watchlist/filters.test.ts`
- `tests/watchlist/enrich.test.ts`
- `tests/watchlist/catalyst-events.test.ts`
- `tests/watchlist/repo.test.ts`
- `tests/scheduler/earnings-catalyst-job.test.ts`
- `tests/scheduler/volume-catalyst-job.test.ts`
- `tests/scheduler/watchlist-enrich-job.test.ts`
- `tests/scheduler/watchlist-demote-job.test.ts`

**Modified files:**

- `src/db/schema.ts` — add `watchlist` and `catalystEvents` table definitions
- `src/news/classifier.ts` — call catalyst + promote after tradeable classification
- `src/news/research-agent.ts` — call catalyst + promote when confidence ≥ 0.75
- `src/learning/pattern-analysis.ts` — call catalyst + promote on feedback trigger
- `src/scheduler/cron.ts` — register four new cron entries
- `src/scheduler/jobs.ts` — add four new job enum members + dispatch cases
- `src/monitoring/cron-schedule.ts` — mirror the new cron entries
- `src/monitoring/health.ts` — add `watchlist` section to `HealthData`
- `tests/news/classifier.test.ts` — extend for watchlist wiring
- `tests/news/research-agent.test.ts` — extend for watchlist wiring
- `tests/learning/pattern-analysis.test.ts` — extend for feedback trigger
- `tests/monitoring/health.test.ts` — extend for watchlist section
- `tests/scheduler/cron.test.ts` — extend for new registrations

---

## Task 1: Schema — watchlist + catalyst_events tables

**Files:**
- Create: `drizzle/migrations/0016_<drizzle-generated-name>.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (drizzle-kit appends automatically)
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add table definitions to schema.ts**

Append to `src/db/schema.ts` below `symbolProfiles`:

```typescript
export const watchlist = sqliteTable(
	"watchlist",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		promotedAt: text("promoted_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		lastCatalystAt: text("last_catalyst_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		promotionReasons: text("promotion_reasons").notNull(), // comma-joined
		catalystSummary: text("catalyst_summary"),
		directionalBias: text("directional_bias", {
			enum: ["long", "short", "ambiguous"],
		}),
		horizon: text("horizon", { enum: ["intraday", "days", "weeks"] }),
		researchPayload: text("research_payload"), // JSON
		enrichedAt: text("enriched_at"),
		enrichmentFailedAt: text("enrichment_failed_at"),
		expiresAt: text("expires_at").notNull(),
		demotedAt: text("demoted_at"),
		demotionReason: text("demotion_reason"),
	},
	(table) => ({
		activeUnique: uniqueIndex("watchlist_active_symbol_exchange_unique")
			.on(table.symbol, table.exchange)
			.where(sql`${table.demotedAt} IS NULL`),
		demotedIdx: index("watchlist_demoted_at_idx").on(table.demotedAt),
		enrichedIdx: index("watchlist_enriched_at_idx").on(table.enrichedAt),
	}),
);

export const catalystEvents = sqliteTable(
	"catalyst_events",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		eventType: text("event_type", {
			enum: ["news", "research", "earnings", "volume", "feedback", "insider_buy", "filing_8k", "rotation"],
		}).notNull(),
		source: text("source").notNull(),
		payload: text("payload"), // JSON, nullable
		firedAt: text("fired_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
		ledToPromotion: integer("led_to_promotion", { mode: "boolean" }).notNull().default(false),
	},
	(table) => ({
		symbolExchangeFiredIdx: index("catalyst_events_symbol_exchange_fired_idx").on(
			table.symbol,
			table.exchange,
			table.firedAt,
		),
		typeFiredIdx: index("catalyst_events_type_fired_idx").on(table.eventType, table.firedAt),
	}),
);
```

Required imports (add at top of file if missing): `uniqueIndex`, `index`, `sql`. The `sql` import is from `drizzle-orm` (not `drizzle-orm/sqlite-core`).

- [ ] **Step 2: Generate the migration**

Run: `bunx drizzle-kit generate`

Expected: creates `drizzle/migrations/0016_<drizzle-auto-generated-name>.sql` with `CREATE TABLE` for both `watchlist` and `catalyst_events`, appends entry to `_journal.json`. Do NOT rename the generated file.

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

All three pass. Test count remains 751 (no new tests yet).

- [ ] **Step 5: Commit**

```bash
git add drizzle/migrations/ src/db/schema.ts
git commit -m "Universe Step 2 Task 1: watchlist + catalyst_events schema"
```

---

## Task 2: Constants, repo, catalyst-events writer

Thin foundation files — all DB-facing, no business logic. Bundled to avoid over-fragmentation.

**Files:**
- Create: `src/watchlist/constants.ts`
- Create: `src/watchlist/repo.ts`
- Create: `src/watchlist/catalyst-events.ts`
- Create: `tests/watchlist/repo.test.ts`
- Create: `tests/watchlist/catalyst-events.test.ts`

- [ ] **Step 1: Write constants**

Create `src/watchlist/constants.ts`:

```typescript
// Promotion triggers
export const VOLUME_TRIGGER_RATIO = 3.0;
export const EARNINGS_LOOKAHEAD_DAYS = 5;
export const RESEARCH_MIN_CONFIDENCE = 0.75;
export const FEEDBACK_INSIGHT_THRESHOLD = 3;
export const FEEDBACK_INSIGHT_WINDOW_DAYS = 14;
export const FEEDBACK_MIN_CONFIDENCE = 0.8;

// Watchlist state
export const WATCHLIST_CAP_SOFT = 150;
export const WATCHLIST_CAP_HARD = 300;
export const DEFAULT_PROMOTION_TTL_HOURS = 72;

// Enrichment
export const ENRICH_BATCH_SIZE = 10;
export const ENRICHMENT_RETRY_HOURS = 24;
export const ENRICHMENT_DEMOTION_HOURS = 48;

// Demotion
export const STALENESS_HOURS = 72;
export const VOLUME_COLLAPSE_SESSIONS = 3;
export const POSITION_CLOSED_IDLE_HOURS = 24;

export type PromotionReason = "news" | "research" | "earnings" | "volume" | "feedback";
export type DemotionReason =
	| "stale"
	| "resolved"
	| "volume_collapse"
	| "universe_removed"
	| "feedback_demote"
	| "position_closed"
	| "enrichment_failed"
	| "cap_eviction";
```

- [ ] **Step 2: Write failing tests for repo**

Create `tests/watchlist/repo.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { watchlist } from "../../src/db/schema.ts";
import {
	countActive,
	getActiveWatchlist,
	getUnenrichedRows,
	getWatchlistByExchange,
} from "../../src/watchlist/repo.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	const db = getDb();
	migrate(db, { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => closeDb());

function insertRow(overrides: Partial<typeof watchlist.$inferInsert> = {}) {
	const db = getDb();
	db.insert(watchlist)
		.values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			promotionReasons: "news",
			expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
			...overrides,
		})
		.run();
}

describe("getActiveWatchlist", () => {
	test("returns only non-demoted rows", () => {
		insertRow({ symbol: "AAPL" });
		insertRow({ symbol: "MSFT", demotedAt: new Date().toISOString(), demotionReason: "stale" });
		const rows = getActiveWatchlist();
		expect(rows.map((r) => r.symbol)).toEqual(["AAPL"]);
	});
});

describe("getUnenrichedRows", () => {
	test("returns rows with enrichedAt null, respects limit", () => {
		insertRow({ symbol: "A" });
		insertRow({ symbol: "B" });
		insertRow({ symbol: "C", enrichedAt: new Date().toISOString() });
		const rows = getUnenrichedRows(10);
		expect(rows.length).toBe(2);
		expect(rows.map((r) => r.symbol).sort()).toEqual(["A", "B"]);
	});

	test("excludes rows with enrichmentFailedAt set", () => {
		insertRow({ symbol: "A", enrichmentFailedAt: new Date().toISOString() });
		insertRow({ symbol: "B" });
		const rows = getUnenrichedRows(10);
		expect(rows.map((r) => r.symbol)).toEqual(["B"]);
	});
});

describe("getWatchlistByExchange", () => {
	test("filters by exchange", () => {
		insertRow({ symbol: "AAPL", exchange: "NASDAQ" });
		insertRow({ symbol: "GAW", exchange: "LSE" });
		const us = getWatchlistByExchange("NASDAQ");
		expect(us.map((r) => r.symbol)).toEqual(["AAPL"]);
	});
});

describe("countActive", () => {
	test("counts only active rows", () => {
		insertRow({ symbol: "A" });
		insertRow({ symbol: "B" });
		insertRow({ symbol: "C", demotedAt: new Date().toISOString(), demotionReason: "stale" });
		expect(countActive()).toBe(2);
	});
});
```

Run: `bun test tests/watchlist/repo.test.ts --preload ./tests/preload.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement repo**

Create `src/watchlist/repo.ts`:

```typescript
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { watchlist } from "../db/schema.ts";

export type WatchlistRow = typeof watchlist.$inferSelect;

export function getActiveWatchlist(): WatchlistRow[] {
	return getDb().select().from(watchlist).where(isNull(watchlist.demotedAt)).all();
}

export function getUnenrichedRows(limit: number): WatchlistRow[] {
	return getDb()
		.select()
		.from(watchlist)
		.where(
			and(
				isNull(watchlist.demotedAt),
				isNull(watchlist.enrichedAt),
				isNull(watchlist.enrichmentFailedAt),
			),
		)
		.limit(limit)
		.all();
}

export function getWatchlistByExchange(exchange: string): WatchlistRow[] {
	return getDb()
		.select()
		.from(watchlist)
		.where(and(isNull(watchlist.demotedAt), eq(watchlist.exchange, exchange)))
		.all();
}

export function countActive(): number {
	const row = getDb()
		.select({ count: sql<number>`count(*)` })
		.from(watchlist)
		.where(isNull(watchlist.demotedAt))
		.get();
	return row?.count ?? 0;
}
```

Run: `bun test tests/watchlist/repo.test.ts --preload ./tests/preload.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Write failing tests for catalyst-events**

Create `tests/watchlist/catalyst-events.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { catalystEvents } from "../../src/db/schema.ts";
import { markLedToPromotion, writeCatalystEvent } from "../../src/watchlist/catalyst-events.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => closeDb());

describe("writeCatalystEvent", () => {
	test("inserts row with defaults and returns id", () => {
		const id = writeCatalystEvent({
			symbol: "AAPL",
			exchange: "NASDAQ",
			eventType: "news",
			source: "news_event_42",
			payload: { headline: "Apple beats" },
		});
		expect(typeof id).toBe("number");

		const row = getDb().select().from(catalystEvents).where(eq(catalystEvents.id, id)).get();
		expect(row?.ledToPromotion).toBe(false);
		expect(row?.firedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(JSON.parse(row?.payload ?? "null")).toEqual({ headline: "Apple beats" });
	});

	test("accepts null payload", () => {
		const id = writeCatalystEvent({
			symbol: "AAPL",
			exchange: "NASDAQ",
			eventType: "volume",
			source: "volume-job",
			payload: null,
		});
		const row = getDb().select().from(catalystEvents).where(eq(catalystEvents.id, id)).get();
		expect(row?.payload).toBeNull();
	});
});

describe("markLedToPromotion", () => {
	test("flips led_to_promotion to true", () => {
		const id = writeCatalystEvent({
			symbol: "AAPL",
			exchange: "NASDAQ",
			eventType: "news",
			source: "news_event_42",
			payload: null,
		});
		markLedToPromotion(id);
		const row = getDb().select().from(catalystEvents).where(eq(catalystEvents.id, id)).get();
		expect(row?.ledToPromotion).toBe(true);
	});
});
```

Run: `bun test tests/watchlist/catalyst-events.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 5: Implement catalyst-events**

Create `src/watchlist/catalyst-events.ts`:

```typescript
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { catalystEvents } from "../db/schema.ts";

export interface CatalystEventInput {
	symbol: string;
	exchange: string;
	eventType:
		| "news"
		| "research"
		| "earnings"
		| "volume"
		| "feedback"
		| "insider_buy"
		| "filing_8k"
		| "rotation";
	source: string;
	payload: unknown | null;
}

export function writeCatalystEvent(input: CatalystEventInput): number {
	const result = getDb()
		.insert(catalystEvents)
		.values({
			symbol: input.symbol,
			exchange: input.exchange,
			eventType: input.eventType,
			source: input.source,
			payload: input.payload == null ? null : JSON.stringify(input.payload),
		})
		.returning({ id: catalystEvents.id })
		.get();
	if (!result) throw new Error("catalyst event insert returned nothing");
	return result.id;
}

export function markLedToPromotion(id: number): void {
	getDb()
		.update(catalystEvents)
		.set({ ledToPromotion: true })
		.where(eq(catalystEvents.id, id))
		.run();
}
```

Run: `bun test tests/watchlist/catalyst-events.test.ts --preload ./tests/preload.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Run verification gate**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
```

All pass. Test count now 751 + 7 = 758.

- [ ] **Step 7: Commit**

```bash
git add src/watchlist/constants.ts src/watchlist/repo.ts src/watchlist/catalyst-events.ts tests/watchlist/
git commit -m "Universe Step 2 Task 2: watchlist constants, repo, catalyst-events"
```

---

## Task 3: promoteToWatchlist — idempotent upsert

Core state-machine logic. Ensures a re-firing catalyst on an active row merges reasons + extends TTL rather than duplicating.

**Files:**
- Create: `src/watchlist/promote.ts`
- Create: `tests/watchlist/promote.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/watchlist/promote.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { investableUniverse, watchlist } from "../../src/db/schema.ts";
import { promoteToWatchlist } from "../../src/watchlist/promote.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	getDb()
		.insert(investableUniverse)
		.values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			indexSource: "russell_1000",
			active: true,
			lastRefreshed: new Date().toISOString(),
		})
		.run();
});

afterEach(() => closeDb());

function activeRow(symbol: string) {
	return getDb()
		.select()
		.from(watchlist)
		.where(and(eq(watchlist.symbol, symbol), isNull(watchlist.demotedAt)))
		.get();
}

describe("promoteToWatchlist", () => {
	test("inserts new row when symbol is in investable_universe", async () => {
		const result = await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: { headline: "Apple beats" },
			ttlHours: 72,
		});
		expect(result.status).toBe("inserted");
		const row = activeRow("AAPL");
		expect(row?.promotionReasons).toBe("news");
		expect(row?.enrichedAt).toBeNull();
	});

	test("rejects symbol NOT in investable_universe", async () => {
		const result = await promoteToWatchlist({
			symbol: "ZZZZZ",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		expect(result.status).toBe("rejected_not_in_universe");
		expect(activeRow("ZZZZZ")).toBeUndefined();
	});

	test("idempotent: second promote with same reason updates last_catalyst_at, does not duplicate", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		const firstCatalyst = activeRow("AAPL")?.lastCatalystAt;
		await new Promise((r) => setTimeout(r, 10));
		const result = await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		expect(result.status).toBe("updated");
		const row = activeRow("AAPL");
		expect(row?.promotionReasons).toBe("news"); // not duplicated
		expect(row?.lastCatalystAt.localeCompare(firstCatalyst!)).toBeGreaterThan(0);

		// No duplicate row
		const all = getDb()
			.select()
			.from(watchlist)
			.where(and(eq(watchlist.symbol, "AAPL"), isNull(watchlist.demotedAt)))
			.all();
		expect(all.length).toBe(1);
	});

	test("merges new reason into existing comma-joined list", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "earnings",
			payload: null,
			ttlHours: 72,
		});
		const row = activeRow("AAPL");
		expect(row?.promotionReasons.split(",").sort()).toEqual(["earnings", "news"]);
	});

	test("extends expires_at when new TTL pushes further out", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 24,
		});
		const firstExpires = activeRow("AAPL")?.expiresAt;
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 96,
		});
		const secondExpires = activeRow("AAPL")?.expiresAt;
		expect(secondExpires!.localeCompare(firstExpires!)).toBeGreaterThan(0);
	});

	test("does NOT shorten expires_at when new TTL is sooner", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 96,
		});
		const firstExpires = activeRow("AAPL")?.expiresAt;
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 24,
		});
		expect(activeRow("AAPL")?.expiresAt).toBe(firstExpires!);
	});

	test("reactivates a previously-demoted row as fresh insert", async () => {
		await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		// Simulate demotion
		getDb()
			.update(watchlist)
			.set({ demotedAt: new Date().toISOString(), demotionReason: "stale" })
			.where(eq(watchlist.symbol, "AAPL"))
			.run();

		const result = await promoteToWatchlist({
			symbol: "AAPL",
			exchange: "NASDAQ",
			reason: "news",
			payload: null,
			ttlHours: 72,
		});
		expect(result.status).toBe("inserted");
		expect(activeRow("AAPL")).toBeDefined();
	});
});
```

Run: `bun test tests/watchlist/promote.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Implement promote.ts**

Create `src/watchlist/promote.ts`:

```typescript
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse, watchlist } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { DEFAULT_PROMOTION_TTL_HOURS, type PromotionReason } from "./constants.ts";

const log = createChildLogger({ module: "watchlist-promote" });

export interface PromoteInput {
	symbol: string;
	exchange: string;
	reason: PromotionReason;
	payload: unknown | null;
	ttlHours?: number;
}

export type PromoteResult =
	| { status: "inserted"; id: number }
	| { status: "updated"; id: number }
	| { status: "rejected_not_in_universe" };

export async function promoteToWatchlist(input: PromoteInput): Promise<PromoteResult> {
	const db = getDb();
	const ttlHours = input.ttlHours ?? DEFAULT_PROMOTION_TTL_HOURS;
	const now = new Date();
	const nowIso = now.toISOString();
	const newExpires = new Date(now.getTime() + ttlHours * 3600_000).toISOString();

	// Enforce universe membership
	const inUniverse = db
		.select()
		.from(investableUniverse)
		.where(
			and(
				eq(investableUniverse.symbol, input.symbol),
				eq(investableUniverse.exchange, input.exchange),
				eq(investableUniverse.active, true),
			),
		)
		.get();
	if (!inUniverse) {
		log.warn(
			{ symbol: input.symbol, exchange: input.exchange, reason: input.reason },
			"Promotion rejected — symbol not in active investable universe",
		);
		return { status: "rejected_not_in_universe" };
	}

	const existing = db
		.select()
		.from(watchlist)
		.where(
			and(
				eq(watchlist.symbol, input.symbol),
				eq(watchlist.exchange, input.exchange),
				isNull(watchlist.demotedAt),
			),
		)
		.get();

	if (existing) {
		const reasons = new Set(existing.promotionReasons.split(","));
		reasons.add(input.reason);
		const mergedReasons = [...reasons].sort().join(",");

		const expiresAt =
			newExpires.localeCompare(existing.expiresAt) > 0 ? newExpires : existing.expiresAt;

		db.update(watchlist)
			.set({
				lastCatalystAt: nowIso,
				promotionReasons: mergedReasons,
				expiresAt,
			})
			.where(eq(watchlist.id, existing.id))
			.run();
		return { status: "updated", id: existing.id };
	}

	const result = db
		.insert(watchlist)
		.values({
			symbol: input.symbol,
			exchange: input.exchange,
			promotedAt: nowIso,
			lastCatalystAt: nowIso,
			promotionReasons: input.reason,
			expiresAt: newExpires,
		})
		.returning({ id: watchlist.id })
		.get();

	if (!result) throw new Error("watchlist insert returned nothing");
	return { status: "inserted", id: result.id };
}
```

Run: `bun test tests/watchlist/promote.test.ts --preload ./tests/preload.ts`
Expected: PASS (7 tests).

- [ ] **Step 3: Run verification gate**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
```

Test count: 758 + 7 = 765.

- [ ] **Step 4: Commit**

```bash
git add src/watchlist/promote.ts tests/watchlist/promote.test.ts
git commit -m "Universe Step 2 Task 3: promoteToWatchlist idempotent upsert"
```

---

## Task 4: Cap-eviction ranking + demotion sweep

Composite ranking function + runDemotionSweep implementing all seven rules and the never-demote exception.

**Files:**
- Create: `src/watchlist/filters.ts`
- Create: `src/watchlist/demote.ts`
- Create: `tests/watchlist/filters.test.ts`
- Create: `tests/watchlist/demote.test.ts`

- [ ] **Step 1: Write failing tests for filters.ts (cap eviction ranking)**

Create `tests/watchlist/filters.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { rankForCapEviction } from "../../src/watchlist/filters.ts";
import type { WatchlistRow } from "../../src/watchlist/repo.ts";

function row(overrides: Partial<WatchlistRow>): WatchlistRow {
	const now = new Date().toISOString();
	return {
		id: 1,
		symbol: "X",
		exchange: "NASDAQ",
		promotedAt: now,
		lastCatalystAt: now,
		promotionReasons: "news",
		catalystSummary: null,
		directionalBias: null,
		horizon: null,
		researchPayload: null,
		enrichedAt: null,
		enrichmentFailedAt: null,
		expiresAt: now,
		demotedAt: null,
		demotionReason: null,
		...overrides,
	} as WatchlistRow;
}

describe("rankForCapEviction", () => {
	test("ranks more-recent catalysts higher (keep them, evict older)", () => {
		const recent = row({ id: 1, lastCatalystAt: new Date().toISOString() });
		const old = row({ id: 2, lastCatalystAt: new Date(Date.now() - 48 * 3600_000).toISOString() });
		const ranked = rankForCapEviction([old, recent]);
		// First element is highest-rank (keep); last is lowest (evict first)
		expect(ranked[0]?.id).toBe(1);
		expect(ranked[ranked.length - 1]?.id).toBe(2);
	});

	test("breaks ties by number of promotion reasons (more reasons = higher rank)", () => {
		const now = new Date().toISOString();
		const oneReason = row({ id: 1, lastCatalystAt: now, promotionReasons: "news" });
		const twoReasons = row({ id: 2, lastCatalystAt: now, promotionReasons: "news,earnings" });
		const ranked = rankForCapEviction([oneReason, twoReasons]);
		expect(ranked[0]?.id).toBe(2);
	});
});
```

Run: `bun test tests/watchlist/filters.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Implement filters.ts**

Create `src/watchlist/filters.ts`:

```typescript
import type { WatchlistRow } from "./repo.ts";

// Composite rank: primary = catalyst recency, tiebreaker = reason count.
// Rows returned in order: [highest-rank ... lowest-rank].
// Callers evict from the tail.
export function rankForCapEviction(rows: WatchlistRow[]): WatchlistRow[] {
	return [...rows].sort((a, b) => {
		// Recency: later lastCatalystAt wins
		const cmp = b.lastCatalystAt.localeCompare(a.lastCatalystAt);
		if (cmp !== 0) return cmp;
		// Tiebreaker: more reasons = higher rank
		const aCount = a.promotionReasons.split(",").length;
		const bCount = b.promotionReasons.split(",").length;
		return bCount - aCount;
	});
}
```

Run: `bun test tests/watchlist/filters.test.ts --preload ./tests/preload.ts`
Expected: PASS (2 tests).

- [ ] **Step 3: Write failing tests for demote.ts**

Create `tests/watchlist/demote.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { investableUniverse, paperPositions, quotesCache, watchlist } from "../../src/db/schema.ts";
import { runDemotionSweep } from "../../src/watchlist/demote.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});

afterEach(() => closeDb());

function insertWatchlist(overrides: Partial<typeof watchlist.$inferInsert> = {}) {
	const now = new Date().toISOString();
	getDb()
		.insert(watchlist)
		.values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			promotionReasons: "news",
			promotedAt: now,
			lastCatalystAt: now,
			expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
			...overrides,
		})
		.run();
}

function insertUniverseRow(symbol: string, active = true) {
	getDb()
		.insert(investableUniverse)
		.values({
			symbol,
			exchange: "NASDAQ",
			indexSource: "russell_1000",
			active,
			lastRefreshed: new Date().toISOString(),
		})
		.run();
}

describe("runDemotionSweep — individual rules", () => {
	test("rule 1: demotes row stale > 72h", async () => {
		insertUniverseRow("AAPL");
		insertWatchlist({
			symbol: "AAPL",
			lastCatalystAt: new Date(Date.now() - 100 * 3600_000).toISOString(),
		});
		const now = new Date();
		const result = await runDemotionSweep(now);
		expect(result.demoted).toBe(1);
		const row = getDb()
			.select()
			.from(watchlist)
			.where(eq(watchlist.symbol, "AAPL"))
			.get();
		expect(row?.demotionReason).toBe("stale");
	});

	test("rule 2: demotes row with resolved status in research_payload", async () => {
		insertUniverseRow("AAPL");
		insertWatchlist({
			symbol: "AAPL",
			researchPayload: JSON.stringify({ status: "resolved" }),
		});
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(1);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.demotionReason).toBe("resolved");
	});

	test("rule 4: demotes row no longer in active investable_universe", async () => {
		insertUniverseRow("DELISTED", false);
		insertWatchlist({ symbol: "DELISTED" });
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(1);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "DELISTED")).get();
		expect(row?.demotionReason).toBe("universe_removed");
	});

	test("rule 7: demotes row with enrichment_failed_at > 48h old", async () => {
		insertUniverseRow("AAPL");
		insertWatchlist({
			symbol: "AAPL",
			enrichmentFailedAt: new Date(Date.now() - 60 * 3600_000).toISOString(),
		});
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(1);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.demotionReason).toBe("enrichment_failed");
	});

	test("never-demote exception: symbol with open paper position is skipped", async () => {
		insertUniverseRow("AAPL");
		insertWatchlist({
			symbol: "AAPL",
			lastCatalystAt: new Date(Date.now() - 200 * 3600_000).toISOString(),
		});
		getDb()
			.insert(paperPositions)
			.values({
				strategyId: 1,
				symbol: "AAPL",
				exchange: "NASDAQ",
				quantity: 10,
				entryPrice: 150,
				status: "open",
			})
			.run();
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBe(0);
		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.demotedAt).toBeNull();
	});
});

describe("runDemotionSweep — cap eviction", () => {
	test("demotes lowest-ranked rows when active count exceeds soft cap (150)", async () => {
		// Insert 152 rows, all fresh — no per-rule demotion should fire
		for (let i = 0; i < 152; i++) {
			const sym = `SYM${i.toString().padStart(3, "0")}`;
			insertUniverseRow(sym);
			const age = i; // earlier i = older = lower rank
			insertWatchlist({
				symbol: sym,
				lastCatalystAt: new Date(Date.now() - age * 60_000).toISOString(),
			});
		}
		const result = await runDemotionSweep(new Date());
		expect(result.demoted).toBeGreaterThanOrEqual(2);
		const activeCount = getDb()
			.select()
			.from(watchlist)
			.where(isNull(watchlist.demotedAt))
			.all().length;
		expect(activeCount).toBeLessThanOrEqual(150);

		// Oldest (SYM151) should be among the demoted
		const oldest = getDb()
			.select()
			.from(watchlist)
			.where(eq(watchlist.symbol, "SYM151"))
			.get();
		expect(oldest?.demotionReason).toBe("cap_eviction");
	});
});
```

Run: `bun test tests/watchlist/demote.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 4: Implement demote.ts**

Create `src/watchlist/demote.ts`:

```typescript
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { investableUniverse, paperPositions, watchlist } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import {
	ENRICHMENT_DEMOTION_HOURS,
	STALENESS_HOURS,
	WATCHLIST_CAP_SOFT,
	type DemotionReason,
} from "./constants.ts";
import { rankForCapEviction } from "./filters.ts";
import { getActiveWatchlist, type WatchlistRow } from "./repo.ts";

const log = createChildLogger({ module: "watchlist-demote" });

export interface DemotionResult {
	scanned: number;
	demoted: number;
	byReason: Record<string, number>;
}

export async function runDemotionSweep(now: Date): Promise<DemotionResult> {
	const db = getDb();
	const rows = getActiveWatchlist();
	const result: DemotionResult = { scanned: rows.length, demoted: 0, byReason: {} };

	const openPositions = db.select().from(paperPositions).where(eq(paperPositions.status, "open")).all();
	const openKeys = new Set(openPositions.map((p) => `${p.symbol}:${p.exchange}`));

	const activeUniverseRows = db
		.select({ symbol: investableUniverse.symbol, exchange: investableUniverse.exchange })
		.from(investableUniverse)
		.where(eq(investableUniverse.active, true))
		.all();
	const activeUniverseKeys = new Set(activeUniverseRows.map((r) => `${r.symbol}:${r.exchange}`));

	const survivors: WatchlistRow[] = [];

	for (const row of rows) {
		const key = `${row.symbol}:${row.exchange}`;
		if (openKeys.has(key)) {
			survivors.push(row);
			continue; // never-demote exception
		}

		const reason = evaluateRules(row, now, activeUniverseKeys);
		if (reason) {
			await demoteRow(row.id, reason, now);
			result.demoted++;
			result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
		} else {
			survivors.push(row);
		}
	}

	// Cap eviction
	if (survivors.length > WATCHLIST_CAP_SOFT) {
		const ranked = rankForCapEviction(survivors);
		const toEvict = ranked.slice(WATCHLIST_CAP_SOFT); // tail is lowest-rank
		for (const row of toEvict) {
			if (openKeys.has(`${row.symbol}:${row.exchange}`)) continue;
			await demoteRow(row.id, "cap_eviction", now);
			result.demoted++;
			result.byReason.cap_eviction = (result.byReason.cap_eviction ?? 0) + 1;
		}
	}

	log.info({ ...result }, "Demotion sweep complete");
	return result;
}

function evaluateRules(
	row: WatchlistRow,
	now: Date,
	activeUniverseKeys: Set<string>,
): DemotionReason | null {
	const nowMs = now.getTime();
	const lastCatalystMs = Date.parse(row.lastCatalystAt);
	const ageHours = (nowMs - lastCatalystMs) / 3600_000;

	// Rule 1: staleness
	if (ageHours > STALENESS_HOURS) return "stale";

	// Rule 2: catalyst resolved (LLM flag)
	if (row.researchPayload) {
		try {
			const payload = JSON.parse(row.researchPayload);
			if (payload?.status === "resolved") return "resolved";
		} catch {
			// Malformed payload — ignore; enrichment will retry or mark failed.
		}
	}

	// Rule 3 (volume collapse) and Rule 6 (position-closed + idle) are
	// intentionally not implemented here. Rule 3 requires multi-session
	// rolling volume data not currently surfaced from quotes_cache; Rule 6
	// requires a position-close event stream. The 72h staleness rule
	// catches the same symbols in both cases during v1. Follow-up PRs add
	// the direct checks when the supporting infrastructure is ready.

	// Rule 4: removed from investable_universe
	if (!activeUniverseKeys.has(`${row.symbol}:${row.exchange}`)) return "universe_removed";

	// Rule 5: learning-loop demote flag (pattern-analysis writes a demote signal
	// into research_payload.learning_demote=true)
	if (row.researchPayload) {
		try {
			const payload = JSON.parse(row.researchPayload);
			if (payload?.learning_demote === true) return "feedback_demote";
		} catch {
			// already handled
		}
	}

	// Rule 6: position-closed + idle — implement once position-close events
	// are observable. For v1 rely on 72h staleness which catches the same case.

	// Rule 7: enrichment permanently failed > 48h ago
	if (row.enrichmentFailedAt) {
		const failedAgeHours = (nowMs - Date.parse(row.enrichmentFailedAt)) / 3600_000;
		if (failedAgeHours > ENRICHMENT_DEMOTION_HOURS) return "enrichment_failed";
	}

	return null;
}

async function demoteRow(id: number, reason: DemotionReason, now: Date): Promise<void> {
	getDb()
		.update(watchlist)
		.set({
			demotedAt: now.toISOString(),
			demotionReason: reason,
		})
		.where(eq(watchlist.id, id))
		.run();
}
```

Note on rules 3 and 6: the parent spec mentions them. Rule 3 (volume collapse) requires rolling multi-session data not currently surfaced from `quotes_cache`; rule 6 (position-closed + idle) requires a position-close event stream. Both are covered in v1 by rule 1 (72h staleness) catching the same symbols. The inline comments document this explicitly rather than silently omitting them. Follow-up PRs can add the direct checks when the supporting infrastructure is ready.

Run: `bun test tests/watchlist/demote.test.ts --preload ./tests/preload.ts`
Expected: PASS (6 tests; the tests only cover implemented rules + never-demote + cap eviction).

- [ ] **Step 5: Run verification gate**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
```

Test count: 765 + 8 = 773.

- [ ] **Step 6: Commit**

```bash
git add src/watchlist/filters.ts src/watchlist/demote.ts tests/watchlist/filters.test.ts tests/watchlist/demote.test.ts
git commit -m "Universe Step 2 Task 4: cap-eviction ranking + demotion sweep"
```

---

## Task 5: Enrichment — pure functions

`buildEnrichmentPrompt` + `parseEnrichmentResponse` are pure and directly testable. No LLM call in this task.

**Files:**
- Create: `src/watchlist/enrich.ts` (partial — only pure fns; `enrichOne` comes in Task 6)
- Create: `tests/watchlist/enrich.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/watchlist/enrich.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
	buildEnrichmentPrompt,
	parseEnrichmentResponse,
} from "../../src/watchlist/enrich.ts";
import type { WatchlistRow } from "../../src/watchlist/repo.ts";

function fakeRow(overrides: Partial<WatchlistRow> = {}): WatchlistRow {
	const now = new Date().toISOString();
	return {
		id: 1,
		symbol: "AAPL",
		exchange: "NASDAQ",
		promotedAt: now,
		lastCatalystAt: now,
		promotionReasons: "news",
		catalystSummary: null,
		directionalBias: null,
		horizon: null,
		researchPayload: null,
		enrichedAt: null,
		enrichmentFailedAt: null,
		expiresAt: now,
		demotedAt: null,
		demotionReason: null,
		...overrides,
	} as WatchlistRow;
}

describe("buildEnrichmentPrompt", () => {
	test("includes symbol, exchange, reasons", () => {
		const prompt = buildEnrichmentPrompt(
			fakeRow({ promotionReasons: "news,earnings" }),
			[],
		);
		expect(prompt).toContain("AAPL");
		expect(prompt).toContain("NASDAQ");
		expect(prompt).toContain("news");
		expect(prompt).toContain("earnings");
	});

	test("embeds recent catalyst payloads", () => {
		const prompt = buildEnrichmentPrompt(
			fakeRow(),
			[
				{
					symbol: "AAPL",
					exchange: "NASDAQ",
					eventType: "news",
					source: "finnhub",
					payload: { headline: "Apple beats Q2" },
					firedAt: new Date().toISOString(),
				},
			],
		);
		expect(prompt).toContain("Apple beats Q2");
	});

	test("instructs model to return JSON with specific fields", () => {
		const prompt = buildEnrichmentPrompt(fakeRow(), []);
		expect(prompt).toMatch(/catalyst_summary/);
		expect(prompt).toMatch(/directional_bias/);
		expect(prompt).toMatch(/horizon/);
		expect(prompt).toMatch(/status/); // for resolved demotion rule
	});
});

describe("parseEnrichmentResponse", () => {
	test("parses valid JSON envelope", () => {
		const raw = JSON.stringify({
			catalyst_summary: "Apple beat Q2 estimates",
			directional_bias: "long",
			horizon: "days",
			status: "active",
		});
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.catalystSummary).toBe("Apple beat Q2 estimates");
			expect(result.value.directionalBias).toBe("long");
			expect(result.value.horizon).toBe("days");
			expect(result.value.status).toBe("active");
		}
	});

	test("unwraps JSON embedded in markdown fence", () => {
		const raw = '```json\n{"catalyst_summary":"x","directional_bias":"short","horizon":"intraday","status":"active"}\n```';
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(true);
	});

	test("rejects invalid directional_bias enum", () => {
		const raw = JSON.stringify({
			catalyst_summary: "x",
			directional_bias: "sideways",
			horizon: "days",
			status: "active",
		});
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(false);
	});

	test("rejects invalid horizon enum", () => {
		const raw = JSON.stringify({
			catalyst_summary: "x",
			directional_bias: "long",
			horizon: "months",
			status: "active",
		});
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(false);
	});

	test("rejects malformed JSON", () => {
		const result = parseEnrichmentResponse("not json");
		expect(result.ok).toBe(false);
	});

	test("rejects missing required field", () => {
		const raw = JSON.stringify({ catalyst_summary: "x", horizon: "days", status: "active" });
		const result = parseEnrichmentResponse(raw);
		expect(result.ok).toBe(false);
	});
});
```

Run: `bun test tests/watchlist/enrich.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Implement pure functions**

Create `src/watchlist/enrich.ts` (pure-fn portion only — `enrichOne` added in Task 6):

```typescript
import type { WatchlistRow } from "./repo.ts";

export interface CatalystContext {
	symbol: string;
	exchange: string;
	eventType: string;
	source: string;
	payload: unknown;
	firedAt: string;
}

export interface EnrichmentPayload {
	catalystSummary: string;
	directionalBias: "long" | "short" | "ambiguous";
	horizon: "intraday" | "days" | "weeks";
	status: "active" | "resolved";
	correlatedSymbols?: string[];
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function buildEnrichmentPrompt(row: WatchlistRow, recentEvents: CatalystContext[]): string {
	const eventsBlock =
		recentEvents.length === 0
			? "(no recent catalyst payloads on record)"
			: recentEvents
					.map(
						(e, i) =>
							`[${i + 1}] ${e.eventType} (${e.firedAt}) source=${e.source} payload=${JSON.stringify(
								e.payload,
							)}`,
					)
					.join("\n");

	return [
		`You are enriching a watchlist entry for a systematic trading system.`,
		``,
		`Symbol: ${row.symbol}`,
		`Exchange: ${row.exchange}`,
		`Promotion reasons: ${row.promotionReasons}`,
		`Promoted at: ${row.promotedAt}`,
		`Last catalyst at: ${row.lastCatalystAt}`,
		``,
		`Recent catalyst events:`,
		eventsBlock,
		``,
		`Return STRICTLY JSON matching this shape:`,
		`{`,
		`  "catalyst_summary": "<one to two sentence summary>",`,
		`  "directional_bias": "long" | "short" | "ambiguous",`,
		`  "horizon": "intraday" | "days" | "weeks",`,
		`  "status": "active" | "resolved",`,
		`  "correlated_symbols": ["OPTIONAL_TICKER", ...]`,
		`}`,
		``,
		`status=resolved means the catalyst has fully played out and the watchlist entry should be demoted.`,
		`Do NOT invent facts beyond the payloads above. If the payloads are sparse, return status=active with directional_bias=ambiguous.`,
	].join("\n");
}

export function parseEnrichmentResponse(raw: string): ParseResult<EnrichmentPayload> {
	const json = unwrapJson(raw);
	if (!json) return { ok: false, error: "no JSON found in response" };

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		return { ok: false, error: `malformed JSON: ${err instanceof Error ? err.message : err}` };
	}

	if (typeof parsed !== "object" || parsed === null) {
		return { ok: false, error: "response is not an object" };
	}

	const p = parsed as Record<string, unknown>;
	if (typeof p.catalyst_summary !== "string") {
		return { ok: false, error: "missing or non-string catalyst_summary" };
	}
	if (
		p.directional_bias !== "long" &&
		p.directional_bias !== "short" &&
		p.directional_bias !== "ambiguous"
	) {
		return { ok: false, error: `invalid directional_bias: ${p.directional_bias}` };
	}
	if (p.horizon !== "intraday" && p.horizon !== "days" && p.horizon !== "weeks") {
		return { ok: false, error: `invalid horizon: ${p.horizon}` };
	}
	if (p.status !== "active" && p.status !== "resolved") {
		return { ok: false, error: `invalid status: ${p.status}` };
	}

	const correlated = Array.isArray(p.correlated_symbols)
		? p.correlated_symbols.filter((s): s is string => typeof s === "string")
		: undefined;

	return {
		ok: true,
		value: {
			catalystSummary: p.catalyst_summary,
			directionalBias: p.directional_bias,
			horizon: p.horizon,
			status: p.status,
			correlatedSymbols: correlated,
		},
	};
}

function unwrapJson(raw: string): string | null {
	const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence?.[1]) return fence[1].trim();
	const trimmed = raw.trim();
	if (trimmed.startsWith("{")) return trimmed;
	// Attempt to find first { ... last }
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
	return null;
}
```

Run: `bun test tests/watchlist/enrich.test.ts --preload ./tests/preload.ts`
Expected: PASS (9 tests).

- [ ] **Step 3: Run verification gate**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
```

Test count: 773 + 9 = 782.

- [ ] **Step 4: Commit**

```bash
git add src/watchlist/enrich.ts tests/watchlist/enrich.test.ts
git commit -m "Universe Step 2 Task 5: enrichment prompt + response parser"
```

---

## Task 6: Enrichment orchestration — enrichOne

Adds `enrichOne(row, llmCall)` to `src/watchlist/enrich.ts`. Injectable LLM for testability.

**Files:**
- Modify: `src/watchlist/enrich.ts`
- Modify: `tests/watchlist/enrich.test.ts` (add orchestration tests)

- [ ] **Step 1: Write failing tests for enrichOne**

Append to `tests/watchlist/enrich.test.ts`:

```typescript
import { afterEach, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { watchlist } from "../../src/db/schema.ts";
import { enrichOne } from "../../src/watchlist/enrich.ts";

describe("enrichOne", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});
	afterEach(() => closeDb());

	function insert() {
		const db = getDb();
		const now = new Date().toISOString();
		const inserted = db
			.insert(watchlist)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				promotionReasons: "news",
				promotedAt: now,
				lastCatalystAt: now,
				expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
			})
			.returning({ id: watchlist.id })
			.get();
		return inserted?.id ?? 0;
	}

	test("on success: writes research_payload, directional_bias, horizon, catalyst_summary, enriched_at", async () => {
		const id = insert();
		const row = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		const llm = async () =>
			JSON.stringify({
				catalyst_summary: "Strong Q2",
				directional_bias: "long",
				horizon: "days",
				status: "active",
			});
		const result = await enrichOne(row!, llm);
		expect(result.status).toBe("enriched");

		const after = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		expect(after?.catalystSummary).toBe("Strong Q2");
		expect(after?.directionalBias).toBe("long");
		expect(after?.horizon).toBe("days");
		expect(after?.enrichedAt).not.toBeNull();
		expect(JSON.parse(after?.researchPayload ?? "null").status).toBe("active");
	});

	test("on malformed LLM response: row stays unenriched (no enriched_at), returns parse_failed", async () => {
		const id = insert();
		const row = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		const llm = async () => "not json";
		const result = await enrichOne(row!, llm);
		expect(result.status).toBe("parse_failed");

		const after = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		expect(after?.enrichedAt).toBeNull();
		expect(after?.enrichmentFailedAt).toBeNull();
	});

	test("on LLM throw: returns llm_failed, row unchanged", async () => {
		const id = insert();
		const row = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		const llm = async () => {
			throw new Error("503 unavailable");
		};
		const result = await enrichOne(row!, llm);
		expect(result.status).toBe("llm_failed");

		const after = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		expect(after?.enrichedAt).toBeNull();
	});

	test("passes recent events into the prompt", async () => {
		const id = insert();
		const row = getDb().select().from(watchlist).where(eq(watchlist.id, id)).get();
		let seenPrompt = "";
		const llm = async (prompt: string) => {
			seenPrompt = prompt;
			return JSON.stringify({
				catalyst_summary: "x",
				directional_bias: "long",
				horizon: "days",
				status: "active",
			});
		};
		await enrichOne(row!, llm);
		expect(seenPrompt).toContain("AAPL");
		expect(seenPrompt).toContain("news");
	});
});
```

Run: `bun test tests/watchlist/enrich.test.ts --preload ./tests/preload.ts`
Expected: FAIL (enrichOne not exported).

- [ ] **Step 2: Add enrichOne + recent-events loader to enrich.ts**

Append to `src/watchlist/enrich.ts`:

```typescript
import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { catalystEvents, watchlist } from "../db/schema.ts";

export type LLMCall = (prompt: string) => Promise<string>;

export type EnrichResult =
	| { status: "enriched" }
	| { status: "parse_failed"; error: string }
	| { status: "llm_failed"; error: string };

const RECENT_EVENTS_LOOKBACK_HOURS = 72;
const RECENT_EVENTS_LIMIT = 10;

export async function enrichOne(row: WatchlistRow, llm: LLMCall): Promise<EnrichResult> {
	const db = getDb();
	const cutoff = new Date(Date.now() - RECENT_EVENTS_LOOKBACK_HOURS * 3600_000).toISOString();
	const recentRaw = db
		.select()
		.from(catalystEvents)
		.where(
			and(
				eq(catalystEvents.symbol, row.symbol),
				eq(catalystEvents.exchange, row.exchange),
				gte(catalystEvents.firedAt, cutoff),
			),
		)
		.orderBy(desc(catalystEvents.firedAt))
		.limit(RECENT_EVENTS_LIMIT)
		.all();

	const recent: CatalystContext[] = recentRaw.map((e) => ({
		symbol: e.symbol,
		exchange: e.exchange,
		eventType: e.eventType,
		source: e.source,
		payload: e.payload ? JSON.parse(e.payload) : null,
		firedAt: e.firedAt,
	}));

	const prompt = buildEnrichmentPrompt(row, recent);

	let rawResponse: string;
	try {
		rawResponse = await llm(prompt);
	} catch (err) {
		return { status: "llm_failed", error: err instanceof Error ? err.message : String(err) };
	}

	const parsed = parseEnrichmentResponse(rawResponse);
	if (!parsed.ok) {
		return { status: "parse_failed", error: parsed.error };
	}

	db.update(watchlist)
		.set({
			catalystSummary: parsed.value.catalystSummary,
			directionalBias: parsed.value.directionalBias,
			horizon: parsed.value.horizon,
			researchPayload: JSON.stringify(parsed.value),
			enrichedAt: new Date().toISOString(),
		})
		.where(eq(watchlist.id, row.id))
		.run();

	return { status: "enriched" };
}

// Note: `WatchlistRow` is imported implicitly via the `parseEnrichmentResponse`
// test import path. If not already in scope in this file, add:
// import type { WatchlistRow } from "./repo.ts";
```

**Important:** the existing `src/watchlist/enrich.ts` already imports `WatchlistRow` in the pure-fn portion (from Task 5). Keep the single import statement at the top of the file — do NOT add a duplicate. If Task 5's skeleton didn't add it, add `import type { WatchlistRow } from "./repo.ts";` at the top now.

Run: `bun test tests/watchlist/enrich.test.ts --preload ./tests/preload.ts`
Expected: PASS (13 tests total — 9 from Task 5 + 4 here).

- [ ] **Step 3: Run verification gate**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
```

Test count: 782 + 4 = 786.

- [ ] **Step 4: Commit**

```bash
git add src/watchlist/enrich.ts tests/watchlist/enrich.test.ts
git commit -m "Universe Step 2 Task 6: enrichOne orchestration with injectable LLM"
```

---

## Task 7: News classifier integration

After tradeable classification succeeds, write a catalyst event + promote to watchlist. Symbol must be in `investable_universe` (enforced by `promoteToWatchlist` itself).

**Files:**
- Modify: `src/news/classifier.ts`
- Modify: `tests/news/classifier.test.ts`

- [ ] **Step 1: Write failing test — new describe block at end of classifier.test.ts**

Read `src/news/classifier.ts` first to understand where the tradeable classification lands (search for `tradeable: true` / `ClassificationResult`). You're looking for the function that finalizes a classification — add the hook there.

Append to `tests/news/classifier.test.ts`:

```typescript
describe("watchlist wiring", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
		// Seed investable_universe so promotion isn't rejected
		getDb()
			.insert(investableUniverse)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				indexSource: "russell_1000",
				active: true,
				lastRefreshed: new Date().toISOString(),
			})
			.run();
	});

	test("tradeable classification promotes to watchlist", async () => {
		await onTradeableClassification({
			newsEventId: 42,
			symbol: "AAPL",
			exchange: "NASDAQ",
			classification: { tradeable: true, urgency: "medium", sentiment: 0.7, confidence: 0.8 },
			headline: "Apple announces partnership",
		});
		const rows = getDb()
			.select()
			.from(watchlist)
			.where(eq(watchlist.symbol, "AAPL"))
			.all();
		expect(rows.length).toBe(1);
		expect(rows[0]?.promotionReasons).toBe("news");
	});

	test("tradeable classification writes catalyst event", async () => {
		await onTradeableClassification({
			newsEventId: 42,
			symbol: "AAPL",
			exchange: "NASDAQ",
			classification: { tradeable: true, urgency: "medium", sentiment: 0.7, confidence: 0.8 },
			headline: "Apple announces partnership",
		});
		const events = getDb()
			.select()
			.from(catalystEvents)
			.where(eq(catalystEvents.symbol, "AAPL"))
			.all();
		expect(events.length).toBe(1);
		expect(events[0]?.eventType).toBe("news");
		expect(events[0]?.ledToPromotion).toBe(true);
	});

	test("non-tradeable classification does not promote", async () => {
		await onTradeableClassification({
			newsEventId: 42,
			symbol: "AAPL",
			exchange: "NASDAQ",
			classification: { tradeable: false, urgency: "low", sentiment: 0.1, confidence: 0.5 },
			headline: "Minor news",
		});
		const rows = getDb().select().from(watchlist).all();
		expect(rows.length).toBe(0);
	});

	test("symbol not in investable_universe is rejected — catalyst event still written but led_to_promotion=false", async () => {
		await onTradeableClassification({
			newsEventId: 42,
			symbol: "ZZZZZ",
			exchange: "NASDAQ",
			classification: { tradeable: true, urgency: "medium", sentiment: 0.7, confidence: 0.8 },
			headline: "Unknown symbol news",
		});
		expect(getDb().select().from(watchlist).all().length).toBe(0);
		const events = getDb().select().from(catalystEvents).all();
		expect(events.length).toBe(1);
		expect(events[0]?.ledToPromotion).toBe(false);
	});
});
```

Add required imports at top of the test file if missing:

```typescript
import { investableUniverse, catalystEvents, watchlist } from "../../src/db/schema.ts";
import { onTradeableClassification } from "../../src/news/classifier.ts";
```

Run: `bun test tests/news/classifier.test.ts --preload ./tests/preload.ts`
Expected: FAIL (function not exported).

- [ ] **Step 2: Add onTradeableClassification hook to classifier.ts**

Add to `src/news/classifier.ts` (near the top of the module, exported):

```typescript
import { writeCatalystEvent, markLedToPromotion } from "../watchlist/catalyst-events.ts";
import { promoteToWatchlist } from "../watchlist/promote.ts";

export interface TradeableClassificationInput {
	newsEventId: number;
	symbol: string;
	exchange: string;
	classification: {
		tradeable: boolean;
		urgency: "low" | "medium" | "high";
		sentiment: number;
		confidence: number;
	};
	headline: string;
}

// Called AFTER a headline has been classified. Writes a catalyst event
// and attempts watchlist promotion when the classification is tradeable
// with urgency >= medium.
export async function onTradeableClassification(
	input: TradeableClassificationInput,
): Promise<void> {
	if (!input.classification.tradeable) return;
	if (input.classification.urgency === "low") return;

	const eventId = writeCatalystEvent({
		symbol: input.symbol,
		exchange: input.exchange,
		eventType: "news",
		source: `news_event_${input.newsEventId}`,
		payload: {
			headline: input.headline,
			urgency: input.classification.urgency,
			sentiment: input.classification.sentiment,
			confidence: input.classification.confidence,
		},
	});

	const result = await promoteToWatchlist({
		symbol: input.symbol,
		exchange: input.exchange,
		reason: "news",
		payload: { headline: input.headline, urgency: input.classification.urgency },
	});

	if (result.status === "inserted" || result.status === "updated") {
		markLedToPromotion(eventId);
	}
}
```

Then wire the hook into the existing classification-finalization path. Search `src/news/classifier.ts` for where a tradeable classification result is persisted (likely after a sentiment-writer or `saveClassification` call); add a call to `onTradeableClassification` with the relevant fields. Follow the surrounding async pattern.

Run: `bun test tests/news/classifier.test.ts --preload ./tests/preload.ts`
Expected: PASS. No regressions in existing classifier tests.

- [ ] **Step 3: Run verification gate**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
```

Test count: 786 + 4 = 790.

- [ ] **Step 4: Commit**

```bash
git add src/news/classifier.ts tests/news/classifier.test.ts
git commit -m "Universe Step 2 Task 7: news classifier writes catalyst events + promotes to watchlist"
```

---

## Task 8: Research-agent integration

Mirror of Task 7 in `src/news/research-agent.ts`. When agent confidence ≥ 0.75, write catalyst + promote with `reason="research"`.

**Files:**
- Modify: `src/news/research-agent.ts`
- Modify: `tests/news/research-agent.test.ts`

- [ ] **Step 1: Write failing test**

Append a `describe("watchlist wiring")` block to `tests/news/research-agent.test.ts`. Model its structure on Task 7's tests — three cases:

1. Research result with confidence ≥ 0.75 promotes with `reason="research"` and writes catalyst event
2. Research result with confidence < 0.75 does NOT promote and does NOT write a catalyst event
3. Symbol not in investable_universe: event still written, `ledToPromotion=false`

Use an exported helper `onResearchResult(input)` analogous to Task 7's `onTradeableClassification`.

Run: `bun test tests/news/research-agent.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Add onResearchResult hook to research-agent.ts**

Add to `src/news/research-agent.ts`:

```typescript
import { writeCatalystEvent, markLedToPromotion } from "../watchlist/catalyst-events.ts";
import { promoteToWatchlist } from "../watchlist/promote.ts";
import { RESEARCH_MIN_CONFIDENCE } from "../watchlist/constants.ts";

export interface ResearchResultInput {
	newsEventId: number;
	symbol: string;
	exchange: string;
	confidence: number;
	eventType: string;
	summary: string;
}

export async function onResearchResult(input: ResearchResultInput): Promise<void> {
	if (input.confidence < RESEARCH_MIN_CONFIDENCE) return;

	const eventId = writeCatalystEvent({
		symbol: input.symbol,
		exchange: input.exchange,
		eventType: "research",
		source: `research_event_${input.newsEventId}`,
		payload: { confidence: input.confidence, eventType: input.eventType, summary: input.summary },
	});

	const result = await promoteToWatchlist({
		symbol: input.symbol,
		exchange: input.exchange,
		reason: "research",
		payload: { confidence: input.confidence, summary: input.summary },
	});

	if (result.status === "inserted" || result.status === "updated") {
		markLedToPromotion(eventId);
	}
}
```

Wire the hook into the existing research-agent flow. Search for where `affected_symbols` get persisted (the spot that currently writes to `sentiment-writer` or equivalent). For each affected symbol with `confidence >= 0.75`, call `onResearchResult`.

Run: `bun test tests/news/research-agent.test.ts --preload ./tests/preload.ts`
Expected: PASS.

- [ ] **Step 3: Run verification gate + commit**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
git add src/news/research-agent.ts tests/news/research-agent.test.ts
git commit -m "Universe Step 2 Task 8: research-agent writes catalyst events + promotes"
```

Test count: 790 + 3 = 793.

---

## Task 9: Pattern-analysis feedback trigger

When the learning loop surfaces 3+ missed-opportunity insights with confidence ≥ 0.8 for the same symbol in a 14-day window, write a `feedback` catalyst + promote.

**Files:**
- Modify: `src/learning/pattern-analysis.ts`
- Modify: `tests/learning/pattern-analysis.test.ts`

- [ ] **Step 1: Write failing test**

Read `src/learning/pattern-analysis.ts` to find where insights are written / read. You're looking for the batch-completion path where we know the full set of insights from the current run (or recent window).

Append to `tests/learning/pattern-analysis.test.ts` a describe block testing:

1. Three insights with confidence ≥ 0.8 for same symbol in 14d → promotes with `reason="feedback"` + catalyst event
2. Two insights (below threshold) → no promotion
3. Three insights but one has confidence 0.7 (below min) → no promotion

Use exported helper `checkFeedbackPromotions()` which scans recent insights and triggers promotions as needed.

Run: `bun test tests/learning/pattern-analysis.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Add checkFeedbackPromotions to pattern-analysis.ts**

Add to `src/learning/pattern-analysis.ts`:

```typescript
import { and, gte, sql } from "drizzle-orm";
import { writeCatalystEvent, markLedToPromotion } from "../watchlist/catalyst-events.ts";
import { promoteToWatchlist } from "../watchlist/promote.ts";
import {
	FEEDBACK_INSIGHT_THRESHOLD,
	FEEDBACK_INSIGHT_WINDOW_DAYS,
	FEEDBACK_MIN_CONFIDENCE,
} from "../watchlist/constants.ts";

// Scans insights from the last FEEDBACK_INSIGHT_WINDOW_DAYS. For each
// (symbol, exchange) that has >= FEEDBACK_INSIGHT_THRESHOLD insights with
// confidence >= FEEDBACK_MIN_CONFIDENCE and kind="missed_opportunity",
// writes a catalyst event and promotes to the watchlist.
export async function checkFeedbackPromotions(): Promise<{ promoted: number }> {
	const db = getDb();
	const cutoff = new Date(
		Date.now() - FEEDBACK_INSIGHT_WINDOW_DAYS * 86_400_000,
	).toISOString();

	// Expected: `insights` table has columns symbol, exchange, confidence, kind,
	// created_at. Adjust column names to match actual schema — search
	// src/db/schema.ts for `insights` / `learningInsights` before implementing.
	const grouped = db
		.select({
			symbol: insights.symbol,
			exchange: insights.exchange,
			count: sql<number>`count(*)`,
		})
		.from(insights)
		.where(
			and(
				gte(insights.createdAt, cutoff),
				eq(insights.kind, "missed_opportunity"),
				gte(insights.confidence, FEEDBACK_MIN_CONFIDENCE),
			),
		)
		.groupBy(insights.symbol, insights.exchange)
		.all();

	let promoted = 0;
	for (const row of grouped) {
		if (row.count < FEEDBACK_INSIGHT_THRESHOLD) continue;
		if (!row.symbol || !row.exchange) continue;

		const eventId = writeCatalystEvent({
			symbol: row.symbol,
			exchange: row.exchange,
			eventType: "feedback",
			source: "pattern_analysis",
			payload: { insightCount: row.count },
		});

		const result = await promoteToWatchlist({
			symbol: row.symbol,
			exchange: row.exchange,
			reason: "feedback",
			payload: { insightCount: row.count },
		});

		if (result.status === "inserted" || result.status === "updated") {
			markLedToPromotion(eventId);
			promoted++;
		}
	}

	return { promoted };
}
```

**Column-name alignment:** before implementation, grep `src/db/schema.ts` for the insights table definition to confirm the real column names (e.g. `learningInsights` vs `insights`, `createdAt` vs `created_at`). Adjust imports and property references to match. Do NOT leave `insights` as an unresolved symbol.

Call `checkFeedbackPromotions()` at the end of the existing pattern-analysis job run (look for where pattern-analysis emits/persists its results and add the call after).

Run: `bun test tests/learning/pattern-analysis.test.ts --preload ./tests/preload.ts`
Expected: PASS.

- [ ] **Step 3: Run verification gate + commit**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
git add src/learning/pattern-analysis.ts tests/learning/pattern-analysis.test.ts
git commit -m "Universe Step 2 Task 9: pattern-analysis feedback trigger promotes to watchlist"
```

Test count: 793 + 3 = 796.

---

## Task 10: Earnings-catalyst-job

Daily job reads FMP `/v3/earning_calendar`, writes catalyst events + promotes for names reporting within next 5 trading days.

**Files:**
- Create: `src/scheduler/earnings-catalyst-job.ts`
- Create: `tests/scheduler/earnings-catalyst-job.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/scheduler/earnings-catalyst-job.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { catalystEvents, investableUniverse, watchlist } from "../../src/db/schema.ts";
import { runEarningsCatalystJob } from "../../src/scheduler/earnings-catalyst-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

function seedUniverse(symbol: string, exchange: string = "NASDAQ") {
	getDb()
		.insert(investableUniverse)
		.values({
			symbol,
			exchange,
			indexSource: "russell_1000",
			active: true,
			lastRefreshed: new Date().toISOString(),
		})
		.run();
}

describe("runEarningsCatalystJob", () => {
	test("promotes symbols reporting in next 5 trading days", async () => {
		seedUniverse("AAPL");
		const today = new Date();
		const inThreeDays = new Date(today.getTime() + 3 * 86400_000).toISOString().slice(0, 10);

		const fetchImpl = async () =>
			new Response(JSON.stringify([{ symbol: "AAPL", date: inThreeDays, epsEstimate: 1.5 }]));

		const result = await runEarningsCatalystJob({ fetchImpl, apiKey: "test-key", now: today });
		expect(result.promoted).toBe(1);

		const rows = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).all();
		expect(rows.length).toBe(1);
		expect(rows[0]?.promotionReasons).toContain("earnings");

		const events = getDb().select().from(catalystEvents).all();
		expect(events[0]?.eventType).toBe("earnings");
	});

	test("skips symbols reporting beyond 5 trading days", async () => {
		seedUniverse("AAPL");
		const farFuture = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
		const fetchImpl = async () =>
			new Response(JSON.stringify([{ symbol: "AAPL", date: farFuture, epsEstimate: 1.5 }]));
		const result = await runEarningsCatalystJob({
			fetchImpl,
			apiKey: "test-key",
			now: new Date(),
		});
		expect(result.promoted).toBe(0);
	});

	test("FMP fetch failure logs but does not throw", async () => {
		const fetchImpl = async () => {
			throw new Error("network");
		};
		const result = await runEarningsCatalystJob({
			fetchImpl,
			apiKey: "test-key",
			now: new Date(),
		});
		expect(result.promoted).toBe(0);
		expect(result.error).toBeDefined();
	});
});
```

Run: `bun test tests/scheduler/earnings-catalyst-job.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Implement earnings-catalyst-job.ts**

Create `src/scheduler/earnings-catalyst-job.ts`:

```typescript
import { createChildLogger } from "../utils/logger.ts";
import { writeCatalystEvent, markLedToPromotion } from "../watchlist/catalyst-events.ts";
import { EARNINGS_LOOKAHEAD_DAYS } from "../watchlist/constants.ts";
import { promoteToWatchlist } from "../watchlist/promote.ts";

const log = createChildLogger({ module: "earnings-catalyst-job" });

export interface EarningsCatalystJobInput {
	fetchImpl?: typeof fetch;
	apiKey: string;
	now: Date;
}

export interface EarningsCatalystJobResult {
	promoted: number;
	skipped: number;
	error?: string;
}

interface FmpEarningRow {
	symbol: string;
	date: string; // YYYY-MM-DD
	epsEstimate?: number | null;
}

export async function runEarningsCatalystJob(
	input: EarningsCatalystJobInput,
): Promise<EarningsCatalystJobResult> {
	const f = input.fetchImpl ?? fetch;
	const now = input.now;
	const from = now.toISOString().slice(0, 10);
	// Approximate trading-day lookahead with calendar days × 1.5 for weekend padding
	const toMs = now.getTime() + EARNINGS_LOOKAHEAD_DAYS * 1.5 * 86400_000;
	const to = new Date(toMs).toISOString().slice(0, 10);

	let rows: FmpEarningRow[];
	try {
		const res = await f(
			`https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${input.apiKey}`,
		);
		if (!res.ok) throw new Error(`FMP ${res.status}`);
		rows = (await res.json()) as FmpEarningRow[];
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.warn({ err: msg }, "Earnings calendar fetch failed");
		return { promoted: 0, skipped: 0, error: msg };
	}

	let promoted = 0;
	let skipped = 0;
	const cutoffMs = now.getTime() + EARNINGS_LOOKAHEAD_DAYS * 86400_000;

	for (const row of rows) {
		const reportMs = Date.parse(row.date);
		if (Number.isNaN(reportMs) || reportMs > cutoffMs) {
			skipped++;
			continue;
		}

		// FMP doesn't always return exchange. For v1 we attempt NASDAQ then NYSE.
		// promoteToWatchlist rejects if not in investable_universe on a given exchange.
		for (const exchange of ["NASDAQ", "NYSE"]) {
			const eventId = writeCatalystEvent({
				symbol: row.symbol,
				exchange,
				eventType: "earnings",
				source: "fmp_earning_calendar",
				payload: { date: row.date, epsEstimate: row.epsEstimate ?? null },
			});

			const result = await promoteToWatchlist({
				symbol: row.symbol,
				exchange,
				reason: "earnings",
				payload: { date: row.date },
			});

			if (result.status === "inserted" || result.status === "updated") {
				markLedToPromotion(eventId);
				promoted++;
				break; // Accept the first exchange that succeeds
			}
		}
	}

	log.info({ promoted, skipped, from, to }, "Earnings catalyst job complete");
	return { promoted, skipped };
}
```

Run: `bun test tests/scheduler/earnings-catalyst-job.test.ts --preload ./tests/preload.ts`
Expected: PASS.

- [ ] **Step 3: Run verification gate + commit**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
git add src/scheduler/earnings-catalyst-job.ts tests/scheduler/earnings-catalyst-job.test.ts
git commit -m "Universe Step 2 Task 10: earnings-catalyst-job"
```

Test count: 796 + 3 = 799.

---

## Task 11: Volume-catalyst-job

Session-boundary job that scans `quotes_cache` for `volume_ratio ≥ 3.0` and promotes qualifying symbols.

**Files:**
- Create: `src/scheduler/volume-catalyst-job.ts`
- Create: `tests/scheduler/volume-catalyst-job.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/scheduler/volume-catalyst-job.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { investableUniverse, quotesCache, watchlist } from "../../src/db/schema.ts";
import { runVolumeCatalystJob } from "../../src/scheduler/volume-catalyst-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

function seedQuote(symbol: string, exchange: string, lastVol: number, avgVol: number) {
	const now = new Date().toISOString();
	getDb()
		.insert(investableUniverse)
		.values({
			symbol,
			exchange,
			indexSource: exchange === "NASDAQ" ? "russell_1000" : "ftse_350",
			active: true,
			lastRefreshed: now,
		})
		.run();
	getDb()
		.insert(quotesCache)
		.values({
			symbol,
			exchange,
			last: 100,
			bid: 99.5,
			ask: 100.5,
			volume: lastVol,
			avgVolume: avgVol,
			updatedAt: now,
		})
		.run();
}

describe("runVolumeCatalystJob", () => {
	test("promotes US symbol with volume_ratio >= 3.0 when scope='us'", async () => {
		seedQuote("AAPL", "NASDAQ", 3_000_000, 1_000_000);
		const result = await runVolumeCatalystJob({ scope: "us", now: new Date() });
		expect(result.promoted).toBe(1);
		const rows = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).all();
		expect(rows[0]?.promotionReasons).toContain("volume");
	});

	test("skips US symbol with volume_ratio < 3.0", async () => {
		seedQuote("AAPL", "NASDAQ", 1_500_000, 1_000_000);
		const result = await runVolumeCatalystJob({ scope: "us", now: new Date() });
		expect(result.promoted).toBe(0);
	});

	test("scope='uk' only considers LSE/AIM", async () => {
		seedQuote("AAPL", "NASDAQ", 3_000_000, 1_000_000);
		seedQuote("GAW", "LSE", 3_000_000, 1_000_000);
		const result = await runVolumeCatalystJob({ scope: "uk", now: new Date() });
		expect(result.promoted).toBe(1);
		const rows = getDb().select().from(watchlist).all();
		expect(rows.map((r) => r.symbol)).toEqual(["GAW"]);
	});
});
```

Run: `bun test tests/scheduler/volume-catalyst-job.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Implement volume-catalyst-job.ts**

Create `src/scheduler/volume-catalyst-job.ts`:

```typescript
import { inArray } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { writeCatalystEvent, markLedToPromotion } from "../watchlist/catalyst-events.ts";
import { VOLUME_TRIGGER_RATIO } from "../watchlist/constants.ts";
import { promoteToWatchlist } from "../watchlist/promote.ts";

const log = createChildLogger({ module: "volume-catalyst-job" });

export interface VolumeCatalystJobInput {
	scope: "us" | "uk";
	now: Date;
}

export interface VolumeCatalystJobResult {
	scanned: number;
	promoted: number;
}

const SCOPE_EXCHANGES: Record<VolumeCatalystJobInput["scope"], string[]> = {
	us: ["NASDAQ", "NYSE"],
	uk: ["LSE", "AIM"],
};

export async function runVolumeCatalystJob(
	input: VolumeCatalystJobInput,
): Promise<VolumeCatalystJobResult> {
	const db = getDb();
	const exchanges = SCOPE_EXCHANGES[input.scope];

	const rows = db
		.select()
		.from(quotesCache)
		.where(inArray(quotesCache.exchange, exchanges))
		.all();

	let promoted = 0;
	for (const q of rows) {
		if (q.volume == null || q.avgVolume == null || q.avgVolume <= 0) continue;
		const ratio = q.volume / q.avgVolume;
		if (ratio < VOLUME_TRIGGER_RATIO) continue;

		const eventId = writeCatalystEvent({
			symbol: q.symbol,
			exchange: q.exchange,
			eventType: "volume",
			source: "volume_catalyst_job",
			payload: { volume: q.volume, avgVolume: q.avgVolume, ratio },
		});

		const result = await promoteToWatchlist({
			symbol: q.symbol,
			exchange: q.exchange,
			reason: "volume",
			payload: { ratio },
		});

		if (result.status === "inserted" || result.status === "updated") {
			markLedToPromotion(eventId);
			promoted++;
		}
	}

	log.info({ scope: input.scope, scanned: rows.length, promoted }, "Volume catalyst job complete");
	return { scanned: rows.length, promoted };
}
```

Run: `bun test tests/scheduler/volume-catalyst-job.test.ts --preload ./tests/preload.ts`
Expected: PASS.

- [ ] **Step 3: Run verification gate + commit**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
git add src/scheduler/volume-catalyst-job.ts tests/scheduler/volume-catalyst-job.test.ts
git commit -m "Universe Step 2 Task 11: volume-catalyst-job"
```

Test count: 799 + 3 = 802.

---

## Task 12: Watchlist-enrich-job

Every-15min + post-close job that batches up to `ENRICH_BATCH_SIZE` unenriched rows through Opus.

**Files:**
- Create: `src/scheduler/watchlist-enrich-job.ts`
- Create: `tests/scheduler/watchlist-enrich-job.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/scheduler/watchlist-enrich-job.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { watchlist } from "../../src/db/schema.ts";
import { runWatchlistEnrichJob } from "../../src/scheduler/watchlist-enrich-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

function insertUnenriched(symbol: string) {
	const now = new Date().toISOString();
	getDb()
		.insert(watchlist)
		.values({
			symbol,
			exchange: "NASDAQ",
			promotionReasons: "news",
			promotedAt: now,
			lastCatalystAt: now,
			expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
		})
		.run();
}

describe("runWatchlistEnrichJob", () => {
	test("enriches unenriched rows via injected LLM", async () => {
		insertUnenriched("AAPL");
		insertUnenriched("MSFT");

		const llm = async () =>
			JSON.stringify({
				catalyst_summary: "x",
				directional_bias: "long",
				horizon: "days",
				status: "active",
			});

		const result = await runWatchlistEnrichJob({ llm, budgetCheck: async () => true });
		expect(result.enriched).toBe(2);

		const rows = getDb().select().from(watchlist).all();
		expect(rows.every((r) => r.enrichedAt != null)).toBe(true);
	});

	test("skips entire batch when budget exhausted", async () => {
		insertUnenriched("AAPL");
		const llm = async () => "";
		const result = await runWatchlistEnrichJob({ llm, budgetCheck: async () => false });
		expect(result.enriched).toBe(0);
		expect(result.skippedDueToBudget).toBe(1);
	});

	test("marks enrichment_failed_at after retry window on sustained parse failure", async () => {
		insertUnenriched("AAPL");

		const llm = async () => "not json";
		await runWatchlistEnrichJob({ llm, budgetCheck: async () => true });

		// Simulate a row whose promotedAt is older than ENRICHMENT_RETRY_HOURS
		getDb()
			.update(watchlist)
			.set({
				promotedAt: new Date(Date.now() - 30 * 3600_000).toISOString(),
			})
			.where(eq(watchlist.symbol, "AAPL"))
			.run();

		await runWatchlistEnrichJob({ llm, budgetCheck: async () => true });

		const row = getDb().select().from(watchlist).where(eq(watchlist.symbol, "AAPL")).get();
		expect(row?.enrichmentFailedAt).not.toBeNull();
	});
});
```

Run: `bun test tests/scheduler/watchlist-enrich-job.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Implement watchlist-enrich-job.ts**

Create `src/scheduler/watchlist-enrich-job.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { watchlist } from "../db/schema.ts";
import { canAffordCall } from "../utils/budget.ts";
import { config } from "../utils/config.ts";
import { createChildLogger } from "../utils/logger.ts";
import {
	ENRICH_BATCH_SIZE,
	ENRICHMENT_RETRY_HOURS,
} from "../watchlist/constants.ts";
import { enrichOne, type LLMCall } from "../watchlist/enrich.ts";
import { getUnenrichedRows } from "../watchlist/repo.ts";

const log = createChildLogger({ module: "watchlist-enrich-job" });

const OPUS_MODEL = "claude-opus-4-7";
const ESTIMATED_COST_USD = 0.05; // ~1500 input + 500 output tokens on Opus 4.7

export interface WatchlistEnrichJobInput {
	llm?: LLMCall;
	budgetCheck?: () => Promise<boolean>;
}

export interface WatchlistEnrichJobResult {
	enriched: number;
	parseFailed: number;
	llmFailed: number;
	skippedDueToBudget: number;
	markedPermanentlyFailed: number;
}

export async function runWatchlistEnrichJob(
	input: WatchlistEnrichJobInput = {},
): Promise<WatchlistEnrichJobResult> {
	const rows = getUnenrichedRows(ENRICH_BATCH_SIZE);
	const result: WatchlistEnrichJobResult = {
		enriched: 0,
		parseFailed: 0,
		llmFailed: 0,
		skippedDueToBudget: 0,
		markedPermanentlyFailed: 0,
	};
	if (rows.length === 0) {
		log.info("No unenriched rows to process");
		return result;
	}

	const budgetCheck = input.budgetCheck ?? (() => canAffordCall(ESTIMATED_COST_USD * rows.length));
	if (!(await budgetCheck())) {
		log.warn({ batchSize: rows.length }, "Enrichment skipped — daily budget exhausted");
		result.skippedDueToBudget = rows.length;
		return result;
	}

	const llm = input.llm ?? defaultOpusLlm();

	const now = Date.now();
	for (const row of rows) {
		const outcome = await enrichOne(row, llm);
		if (outcome.status === "enriched") {
			result.enriched++;
			continue;
		}

		// parse_failed or llm_failed: check retry window
		const ageHours = (now - Date.parse(row.promotedAt)) / 3600_000;
		if (ageHours > ENRICHMENT_RETRY_HOURS) {
			getDb()
				.update(watchlist)
				.set({ enrichmentFailedAt: new Date(now).toISOString() })
				.where(eq(watchlist.id, row.id))
				.run();
			result.markedPermanentlyFailed++;
			log.error(
				{ symbol: row.symbol, exchange: row.exchange, status: outcome.status },
				"Enrichment permanently failed after retry window",
			);
		}

		if (outcome.status === "parse_failed") result.parseFailed++;
		else result.llmFailed++;
	}

	log.info({ ...result }, "Watchlist enrich job complete");
	return result;
}

function defaultOpusLlm(): LLMCall {
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
	return async (prompt: string) => {
		const msg = await client.messages.create({
			model: OPUS_MODEL,
			max_tokens: 1024,
			messages: [{ role: "user", content: prompt }],
		});
		const text = msg.content
			.filter((b): b is { type: "text"; text: string } => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		return text;
	};
}
```

Run: `bun test tests/scheduler/watchlist-enrich-job.test.ts --preload ./tests/preload.ts`
Expected: PASS.

- [ ] **Step 3: Run verification gate + commit**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
git add src/scheduler/watchlist-enrich-job.ts tests/scheduler/watchlist-enrich-job.test.ts
git commit -m "Universe Step 2 Task 12: watchlist-enrich-job"
```

Test count: 802 + 3 = 805.

---

## Task 13: Watchlist-demote-job

Thin wrapper around `runDemotionSweep`.

**Files:**
- Create: `src/scheduler/watchlist-demote-job.ts`
- Create: `tests/scheduler/watchlist-demote-job.test.ts`

- [ ] **Step 1: Write failing test**

Create `tests/scheduler/watchlist-demote-job.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { closeDb, getDb } from "../../src/db/client.ts";
import { investableUniverse, watchlist } from "../../src/db/schema.ts";
import { runWatchlistDemoteJob } from "../../src/scheduler/watchlist-demote-job.ts";

beforeEach(() => {
	closeDb();
	process.env.DB_PATH = ":memory:";
	migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
});
afterEach(() => closeDb());

describe("runWatchlistDemoteJob", () => {
	test("delegates to runDemotionSweep and returns summary", async () => {
		getDb()
			.insert(investableUniverse)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				indexSource: "russell_1000",
				active: true,
				lastRefreshed: new Date().toISOString(),
			})
			.run();
		const now = new Date();
		getDb()
			.insert(watchlist)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				promotionReasons: "news",
				promotedAt: new Date(now.getTime() - 200 * 3600_000).toISOString(),
				lastCatalystAt: new Date(now.getTime() - 100 * 3600_000).toISOString(),
				expiresAt: new Date(now.getTime() + 72 * 3600_000).toISOString(),
			})
			.run();
		const result = await runWatchlistDemoteJob({ now });
		expect(result.demoted).toBe(1);
		expect(result.byReason.stale).toBe(1);
	});
});
```

Run: `bun test tests/scheduler/watchlist-demote-job.test.ts --preload ./tests/preload.ts`
Expected: FAIL.

- [ ] **Step 2: Implement watchlist-demote-job.ts**

Create `src/scheduler/watchlist-demote-job.ts`:

```typescript
import { createChildLogger } from "../utils/logger.ts";
import { runDemotionSweep, type DemotionResult } from "../watchlist/demote.ts";

const log = createChildLogger({ module: "watchlist-demote-job" });

export async function runWatchlistDemoteJob(input: { now?: Date } = {}): Promise<DemotionResult> {
	const now = input.now ?? new Date();
	log.info({ job: "watchlist_demote" }, "Job starting");
	const start = Date.now();
	const result = await runDemotionSweep(now);
	log.info(
		{ job: "watchlist_demote", durationMs: Date.now() - start, ...result },
		"Job completed",
	);
	return result;
}
```

Run: `bun test tests/scheduler/watchlist-demote-job.test.ts --preload ./tests/preload.ts`
Expected: PASS.

- [ ] **Step 3: Run verification gate + commit**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
git add src/scheduler/watchlist-demote-job.ts tests/scheduler/watchlist-demote-job.test.ts
git commit -m "Universe Step 2 Task 13: watchlist-demote-job"
```

Test count: 805 + 1 = 806.

---

## Task 14: Cron wiring + schedule mirror

Register the four new jobs in `src/scheduler/cron.ts`, `src/scheduler/jobs.ts`, and mirror in `src/monitoring/cron-schedule.ts`.

**Files:**
- Modify: `src/scheduler/cron.ts`
- Modify: `src/scheduler/jobs.ts`
- Modify: `src/monitoring/cron-schedule.ts`
- Modify: `tests/scheduler/cron.test.ts` (or the equivalent test file)

- [ ] **Step 1: Extend the JobName union in jobs.ts**

In `src/scheduler/jobs.ts`, find the `JobName` type union (line ~34 per grep; adjust if shifted). Add four new members:

```typescript
	| "earnings_catalyst"
	| "volume_catalyst_us"
	| "volume_catalyst_uk"
	| "watchlist_enrich"
	| "watchlist_demote";
```

Add entries to the `LOCK_CATEGORY` map:

```typescript
	earnings_catalyst: "analysis",
	volume_catalyst_us: "catalyst_us",
	volume_catalyst_uk: "catalyst_uk",
	watchlist_enrich: "enrichment",
	watchlist_demote: "demotion",
```

Note: confirm existing values for known `LOCK_CATEGORY` keys (`analysis`, etc.) by reading the file. Create new category keys as bare strings; the locks module (`src/scheduler/locks.ts`) uses string keys so no additional registration is needed there.

Add switch cases for each new job in the dispatch function. Example for `earnings_catalyst`:

```typescript
case "earnings_catalyst": {
	const { runEarningsCatalystJob } = await import("./earnings-catalyst-job.ts");
	await runEarningsCatalystJob({ apiKey: config.FMP_API_KEY, now: new Date() });
	break;
}
case "volume_catalyst_us": {
	const { runVolumeCatalystJob } = await import("./volume-catalyst-job.ts");
	await runVolumeCatalystJob({ scope: "us", now: new Date() });
	break;
}
case "volume_catalyst_uk": {
	const { runVolumeCatalystJob } = await import("./volume-catalyst-job.ts");
	await runVolumeCatalystJob({ scope: "uk", now: new Date() });
	break;
}
case "watchlist_enrich": {
	const { runWatchlistEnrichJob } = await import("./watchlist-enrich-job.ts");
	await runWatchlistEnrichJob();
	break;
}
case "watchlist_demote": {
	const { runWatchlistDemoteJob } = await import("./watchlist-demote-job.ts");
	await runWatchlistDemoteJob();
	break;
}
```

Match the surrounding style — e.g. if other cases use top-of-file static imports instead of dynamic `await import`, follow that. Look at how `universe_refresh_weekly` (lines 65-66 of `jobs.ts` per grep) currently wires in; reuse its pattern.

- [ ] **Step 2: Add cron schedules to cron.ts**

In `src/scheduler/cron.ts`, inside `startScheduler()`, append:

```typescript
	// ── Watchlist jobs ──────────────────────────────────────────────────
	// Earnings catalyst — daily post-close
	tasks.push(
		cron.schedule("45 22 * * 1-5", () => runJob("earnings_catalyst"), {
			timezone: "Europe/London",
		}),
	);
	// Volume catalyst — per session boundary, split per market
	tasks.push(
		cron.schedule("5 8 * * 1-5", () => runJob("volume_catalyst_uk"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("35 14 * * 1-5", () => runJob("volume_catalyst_us"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("35 14 * * 1-5", () => runJob("volume_catalyst_uk"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("35 16 * * 1-5", () => runJob("volume_catalyst_us"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("0 18 * * 1-5", () => runJob("volume_catalyst_us"), {
			timezone: "Europe/London",
		}),
	);
	// Enrichment — every 15min during sessions + post-close sweep
	tasks.push(
		cron.schedule("*/15 8-20 * * 1-5", () => runJob("watchlist_enrich"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("50 22 * * 1-5", () => runJob("watchlist_enrich"), {
			timezone: "Europe/London",
		}),
	);
	// Demotion — after enrichment post-close
	tasks.push(
		cron.schedule("55 22 * * 1-5", () => runJob("watchlist_demote"), {
			timezone: "Europe/London",
		}),
	);
```

- [ ] **Step 3: Mirror in monitoring/cron-schedule.ts**

Open `src/monitoring/cron-schedule.ts` and add corresponding entries in the same format the file already uses. If the file represents schedules as an array of `{ name, cron, tz }` records, add one per new schedule line above. If it parses cron.ts directly (unlikely — check), this step is a no-op.

- [ ] **Step 4: Extend tests/scheduler/cron.test.ts**

Add assertions verifying each new job name is registered and each new cron expression is parseable (matching the pattern the existing tests use for `universe_refresh_weekly`).

Run: `bun test tests/scheduler/cron.test.ts --preload ./tests/preload.ts`
Expected: PASS.

- [ ] **Step 5: Run verification gate + commit**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
git add src/scheduler/ src/monitoring/cron-schedule.ts tests/scheduler/
git commit -m "Universe Step 2 Task 14: register watchlist cron jobs"
```

Test count: 806 + ~4 = ~810.

---

## Task 15: /health watchlist section

Extend `HealthData` and `getHealthData()` with a `watchlist` section.

**Files:**
- Modify: `src/monitoring/health.ts`
- Modify: `tests/monitoring/health.test.ts`

- [ ] **Step 1: Write failing test**

Open `tests/monitoring/health.test.ts` and add:

```typescript
describe("watchlist section", () => {
	beforeEach(() => {
		// existing setup...
	});

	test("exposes activeCount and byReason", async () => {
		const now = new Date().toISOString();
		getDb()
			.insert(watchlist)
			.values({
				symbol: "AAPL",
				exchange: "NASDAQ",
				promotionReasons: "news,earnings",
				promotedAt: now,
				lastCatalystAt: now,
				expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
			})
			.run();
		getDb()
			.insert(watchlist)
			.values({
				symbol: "MSFT",
				exchange: "NASDAQ",
				promotionReasons: "research",
				promotedAt: now,
				lastCatalystAt: now,
				expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
			})
			.run();

		const h = await getHealthData();
		expect(h.watchlist.activeCount).toBe(2);
		expect(h.watchlist.byReason.news).toBe(1);
		expect(h.watchlist.byReason.earnings).toBe(1);
		expect(h.watchlist.byReason.research).toBe(1);
		expect(h.watchlist.unenrichedCount).toBe(2);
	});
});
```

Add import if missing: `import { watchlist } from "../../src/db/schema.ts";`

Run: `bun test tests/monitoring/health.test.ts --preload ./tests/preload.ts`
Expected: FAIL (property missing).

- [ ] **Step 2: Extend HealthData interface and getHealthData**

Modify `src/monitoring/health.ts`:

Add to `HealthData`:

```typescript
	watchlist: {
		activeCount: number;
		byReason: Record<string, number>;
		unenrichedCount: number;
		oldestPromotionHours: number | null;
		enrichmentFailedCount: number;
	};
```

In `getHealthData()` (after the existing universe section), add:

```typescript
	// Watchlist stats
	const wlRows = db
		.select()
		.from(watchlist)
		.where(isNull(watchlist.demotedAt))
		.all();

	const byReason: Record<string, number> = {};
	let unenrichedCount = 0;
	let enrichmentFailedCount = 0;
	let oldestMs: number | null = null;
	const nowMs = Date.now();
	for (const r of wlRows) {
		for (const reason of r.promotionReasons.split(",")) {
			if (reason) byReason[reason] = (byReason[reason] ?? 0) + 1;
		}
		if (r.enrichedAt == null && r.enrichmentFailedAt == null) unenrichedCount++;
		if (r.enrichmentFailedAt != null) enrichmentFailedCount++;
		const promotedMs = Date.parse(r.promotedAt);
		if (oldestMs == null || promotedMs < oldestMs) oldestMs = promotedMs;
	}

	const oldestPromotionHours = oldestMs == null ? null : (nowMs - oldestMs) / 3600_000;
```

Then include the new fields in the returned object:

```typescript
		watchlist: {
			activeCount: wlRows.length,
			byReason,
			unenrichedCount,
			oldestPromotionHours,
			enrichmentFailedCount,
		},
```

Update imports: add `watchlist` to the `import from "../db/schema"` line. Add `isNull` to the `drizzle-orm` import.

Run: `bun test tests/monitoring/health.test.ts --preload ./tests/preload.ts`
Expected: PASS.

- [ ] **Step 3: Run verification gate + commit**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
git add src/monitoring/health.ts tests/monitoring/health.test.ts
git commit -m "Universe Step 2 Task 15: /health watchlist section"
```

Test count: ~810 + 1 = ~811.

---

## Task 16: Eval suite — watchlist enrichment prompt quality

Per CLAUDE.md, AI-facing features MUST include evaluations. Creates a small synthetic-task suite with code + LLM-as-judge graders. Run on deploy, not per-commit.

**Files:**
- Create: `src/evals/watchlist-enrichment/tasks.ts`
- Create: `src/evals/watchlist-enrichment/graders.ts`
- Create: `src/evals/watchlist-enrichment/harness.ts`
- Create: `src/evals/watchlist-enrichment/results/.gitkeep`
- Create: `tests/evals/watchlist-enrichment-graders.test.ts`

- [ ] **Step 1: Write eval tasks**

Create `src/evals/watchlist-enrichment/tasks.ts`:

```typescript
import type { CatalystContext } from "../../watchlist/enrich.ts";
import type { WatchlistRow } from "../../watchlist/repo.ts";

export interface EnrichmentEvalTask {
	id: string;
	row: Partial<WatchlistRow> & Pick<WatchlistRow, "symbol" | "exchange" | "promotionReasons">;
	events: CatalystContext[];
	expected: {
		directionalBias: "long" | "short" | "ambiguous";
		horizon: "intraday" | "days" | "weeks";
		status: "active" | "resolved";
	};
}

export const ENRICHMENT_TASKS: EnrichmentEvalTask[] = [
	{
		id: "aapl-q2-beat",
		row: { symbol: "AAPL", exchange: "NASDAQ", promotionReasons: "news,earnings" },
		events: [
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				eventType: "earnings",
				source: "fmp_earning_calendar",
				payload: { date: "2026-05-02", epsEstimate: 1.5 },
				firedAt: "2026-04-17T22:45:00Z",
			},
			{
				symbol: "AAPL",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Apple reports record Q2 revenue, raises guidance",
					urgency: "high",
					sentiment: 0.85,
				},
				firedAt: "2026-04-17T21:00:00Z",
			},
		],
		expected: { directionalBias: "long", horizon: "days", status: "active" },
	},
	{
		id: "tsla-recall",
		row: { symbol: "TSLA", exchange: "NASDAQ", promotionReasons: "news" },
		events: [
			{
				symbol: "TSLA",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "Tesla recalls 2M vehicles over autopilot defect",
					urgency: "high",
					sentiment: -0.8,
				},
				firedAt: "2026-04-17T18:00:00Z",
			},
		],
		expected: { directionalBias: "short", horizon: "days", status: "active" },
	},
	{
		id: "resolved-merger",
		row: { symbol: "ACQR", exchange: "NASDAQ", promotionReasons: "news" },
		events: [
			{
				symbol: "ACQR",
				exchange: "NASDAQ",
				eventType: "news",
				source: "finnhub",
				payload: {
					headline: "ACQR merger completed; delisting effective today",
					urgency: "medium",
					sentiment: 0,
				},
				firedAt: "2026-04-17T14:00:00Z",
			},
		],
		expected: { directionalBias: "ambiguous", horizon: "days", status: "resolved" },
	},
	// Add 12-17 more tasks covering: ambiguous/weak catalysts, intraday moves,
	// multi-week drift candidates, partnership/contract wins, analyst
	// downgrades, sector rotation, guidance cuts, etc. Each task should
	// have a clearly-correct expected answer that a reasonable analyst
	// would agree with.
];
```

Expand the `ENRICHMENT_TASKS` array to ≥15 tasks following the pattern. Draw from real classifier history on the VPS if easier than synthesizing — `scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db 'SELECT ...'"` can export recent tradeable classifications.

- [ ] **Step 2: Write graders**

Create `src/evals/watchlist-enrichment/graders.ts`:

```typescript
import type { EnrichmentPayload } from "../../watchlist/enrich.ts";
import type { EnrichmentEvalTask } from "./tasks.ts";

export interface GraderResult {
	passed: boolean;
	score: number; // 0-1
	details: string;
}

// Code grader: JSON shape + enum validity
export function gradeShape(payload: EnrichmentPayload | null): GraderResult {
	if (!payload) return { passed: false, score: 0, details: "parse failed" };
	const validBias = ["long", "short", "ambiguous"].includes(payload.directionalBias);
	const validHorizon = ["intraday", "days", "weeks"].includes(payload.horizon);
	const validStatus = ["active", "resolved"].includes(payload.status);
	const summaryLen = payload.catalystSummary.length;
	const summaryOk = summaryLen >= 10 && summaryLen <= 400;
	const passed = validBias && validHorizon && validStatus && summaryOk;
	return {
		passed,
		score: passed ? 1 : 0,
		details: `bias=${validBias} horizon=${validHorizon} status=${validStatus} summaryLen=${summaryLen}`,
	};
}

// Code grader: matches expected directional_bias / horizon / status
export function gradeAlignment(
	payload: EnrichmentPayload | null,
	expected: EnrichmentEvalTask["expected"],
): GraderResult {
	if (!payload) return { passed: false, score: 0, details: "parse failed" };
	let hits = 0;
	if (payload.directionalBias === expected.directionalBias) hits++;
	if (payload.horizon === expected.horizon) hits++;
	if (payload.status === expected.status) hits++;
	return {
		passed: hits === 3,
		score: hits / 3,
		details: `bias=${payload.directionalBias}/${expected.directionalBias} horizon=${payload.horizon}/${expected.horizon} status=${payload.status}/${expected.status}`,
	};
}

// LLM-as-judge: summary quality (run via separate Haiku call to minimize cost)
export async function gradeSummaryQuality(
	payload: EnrichmentPayload | null,
	task: EnrichmentEvalTask,
	judge: (prompt: string) => Promise<string>,
): Promise<GraderResult> {
	if (!payload) return { passed: false, score: 0, details: "no payload" };
	const prompt = [
		`You are a strict judge evaluating whether a catalyst summary accurately reflects the source events.`,
		`Symbol: ${task.row.symbol}`,
		`Source events:`,
		...task.events.map((e, i) => `[${i + 1}] ${e.eventType}: ${JSON.stringify(e.payload)}`),
		``,
		`Candidate summary: "${payload.catalystSummary}"`,
		``,
		`Score the summary on a scale of 1-5 where:`,
		`1 = contradicts the events or invents facts`,
		`3 = partially accurate, missing key nuance`,
		`5 = accurate, concise, uses only facts from the events`,
		``,
		`Return only the integer score, nothing else.`,
	].join("\n");
	const raw = await judge(prompt);
	const m = raw.match(/[1-5]/);
	const score = m ? parseInt(m[0]!, 10) : 0;
	return {
		passed: score >= 4,
		score: score / 5,
		details: `judge_score=${score}`,
	};
}
```

- [ ] **Step 3: Write harness**

Create `src/evals/watchlist-enrichment/harness.ts`:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildEnrichmentPrompt, parseEnrichmentResponse } from "../../watchlist/enrich.ts";
import { config } from "../../utils/config.ts";
import {
	gradeAlignment,
	gradeShape,
	gradeSummaryQuality,
	type GraderResult,
} from "./graders.ts";
import { ENRICHMENT_TASKS } from "./tasks.ts";

const OPUS_MODEL = "claude-opus-4-7";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

async function callModel(model: string, prompt: string, maxTokens: number): Promise<string> {
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
	const msg = await client.messages.create({
		model,
		max_tokens: maxTokens,
		messages: [{ role: "user", content: prompt }],
	});
	return msg.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text")
		.map((b) => b.text)
		.join("\n");
}

export async function runEvalHarness(): Promise<void> {
	const results: Array<{
		taskId: string;
		shape: GraderResult;
		alignment: GraderResult;
		summary: GraderResult;
	}> = [];

	for (const task of ENRICHMENT_TASKS) {
		const prompt = buildEnrichmentPrompt(task.row as any, task.events);
		const raw = await callModel(OPUS_MODEL, prompt, 1024);
		const parsed = parseEnrichmentResponse(raw);
		const payload = parsed.ok ? parsed.value : null;

		const shape = gradeShape(payload);
		const alignment = gradeAlignment(payload, task.expected);
		const summary = await gradeSummaryQuality(payload, task, (p) =>
			callModel(HAIKU_MODEL, p, 10),
		);

		results.push({ taskId: task.id, shape, alignment, summary });
	}

	const outDir = join(import.meta.dir, "results");
	mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	writeFileSync(
		join(outDir, `eval-${stamp}.json`),
		JSON.stringify(
			{
				totalTasks: results.length,
				shapePassRate: results.filter((r) => r.shape.passed).length / results.length,
				alignmentPassRate: results.filter((r) => r.alignment.passed).length / results.length,
				summaryPassRate: results.filter((r) => r.summary.passed).length / results.length,
				results,
			},
			null,
			2,
		),
	);

	console.log(`Eval complete: ${results.length} tasks. Results written to ${outDir}`);
}

if (import.meta.main) {
	await runEvalHarness();
}
```

- [ ] **Step 4: Write grader unit tests (not running Opus)**

Create `tests/evals/watchlist-enrichment-graders.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
	gradeAlignment,
	gradeShape,
} from "../../src/evals/watchlist-enrichment/graders.ts";
import type { EnrichmentPayload } from "../../src/watchlist/enrich.ts";

describe("gradeShape", () => {
	test("passes with valid payload", () => {
		const payload: EnrichmentPayload = {
			catalystSummary: "Apple beat Q2 earnings",
			directionalBias: "long",
			horizon: "days",
			status: "active",
		};
		expect(gradeShape(payload).passed).toBe(true);
	});

	test("fails with null payload", () => {
		expect(gradeShape(null).passed).toBe(false);
	});

	test("fails with short summary", () => {
		const payload: EnrichmentPayload = {
			catalystSummary: "x",
			directionalBias: "long",
			horizon: "days",
			status: "active",
		};
		expect(gradeShape(payload).passed).toBe(false);
	});
});

describe("gradeAlignment", () => {
	test("passes when all three fields match", () => {
		const payload: EnrichmentPayload = {
			catalystSummary: "ok",
			directionalBias: "long",
			horizon: "days",
			status: "active",
		};
		expect(
			gradeAlignment(payload, { directionalBias: "long", horizon: "days", status: "active" })
				.passed,
		).toBe(true);
	});

	test("scores 2/3 when one mismatched", () => {
		const payload: EnrichmentPayload = {
			catalystSummary: "ok",
			directionalBias: "long",
			horizon: "weeks",
			status: "active",
		};
		const r = gradeAlignment(payload, {
			directionalBias: "long",
			horizon: "days",
			status: "active",
		});
		expect(r.passed).toBe(false);
		expect(r.score).toBeCloseTo(2 / 3, 3);
	});
});
```

- [ ] **Step 5: Run verification gate**

```bash
bun run typecheck && bun test --preload ./tests/preload.ts && bun run lint
```

Test count: 811 + 5 = 816.

- [ ] **Step 6: Commit**

```bash
git add src/evals/watchlist-enrichment/ tests/evals/watchlist-enrichment-graders.test.ts
git commit -m "Universe Step 2 Task 16: watchlist enrichment eval suite"
```

---

## Final verification

After all 16 tasks:

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
bun run lint
```

Expected final test count: ~816 (from 751 baseline + ~65 new tests).

Open a PR via `gh pr create`, body referencing the spec at `docs/superpowers/specs/2026-04-17-universe-step2-watchlist-design.md`.

## Post-merge validation on VPS

1. Trigger a news classification that lands on an investable_universe name → confirm `watchlist` row inserted with `enriched_at=null`
2. Wait for next 15-min enrichment tick → confirm row populated with `research_payload`, `directional_bias`, `horizon`
3. Hit `/health` → confirm `watchlist` section populated
4. After 72h of no re-firing catalyst, confirm staleness demotion fires
