# Session-Aware Scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat 08:00–20:59 CRON schedule with named trading sessions, per-market quote/eval pipelines, session-boundary dispatch, and per-category job locks — so UK and US markets are each served during their actual trading hours with independent polling cycles.

**Architecture:** A `sessions.ts` module defines the 7 named sessions (pre_market through off_hours) and a `getCurrentSession()` time lookup. A `locks.ts` module replaces the single global `jobRunning` boolean with per-category locks so UK and US pipelines run in parallel. The existing quote-refresh and strategy-eval jobs gain an `exchanges` filter parameter. The CRON schedule is rewritten with per-market jobs. The monitoring dashboard schedule is updated to match.

**Tech Stack:** Bun, TypeScript, node-cron, cron-parser, SQLite/Drizzle

**Spec reference:** `docs/specs/2026-04-07-session-aware-scheduling.md`

---

## File Structure

```
Create: src/scheduler/sessions.ts         — session definitions, getCurrentSession(), isExchangeOpen()
Create: src/scheduler/locks.ts            — per-category lock manager (replaces global jobRunning)
Modify: src/scheduler/quote-refresh.ts    — add exchanges filter parameter
Modify: src/scheduler/strategy-eval-job.ts — add exchanges filter, session-aware entries
Modify: src/scheduler/jobs.ts             — new job names, wire category locks, split per-market jobs
Modify: src/scheduler/cron.ts             — rewrite schedule with per-market jobs
Modify: src/monitoring/cron-schedule.ts   — update static schedule for dashboard
Create: tests/scheduler/sessions.test.ts  — session lookup tests
Create: tests/scheduler/locks.test.ts     — per-category lock tests
Modify: tests/scheduler/cron.test.ts      — update for new job names
```

---

### Task 1: Create Session Definitions

**Files:**
- Create: `src/scheduler/sessions.ts`
- Create: `tests/scheduler/sessions.test.ts`

- [ ] **Step 1: Write failing tests for session lookup**

```typescript
// tests/scheduler/sessions.test.ts
import { describe, test, expect } from "bun:test";
import {
	getCurrentSession,
	isExchangeOpen,
	type SessionName,
	UK_EXCHANGES,
	US_EXCHANGES,
} from "../../src/scheduler/sessions";

describe("getCurrentSession", () => {
	test("returns pre_market at 06:30 UK", () => {
		// 06:30 UK on a Wednesday
		const session = getCurrentSession(new Date("2026-04-08T06:30:00+01:00"));
		expect(session.name).toBe("pre_market");
		expect(session.exchanges).toEqual([]);
		expect(session.allowNewEntries).toBe(false);
	});

	test("returns uk_session at 09:00 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T09:00:00+01:00"));
		expect(session.name).toBe("uk_session");
		expect(session.exchanges).toEqual(UK_EXCHANGES);
		expect(session.allowNewEntries).toBe(true);
	});

	test("returns overlap at 15:00 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T15:00:00+01:00"));
		expect(session.name).toBe("overlap");
		expect(session.exchanges).toEqual([...UK_EXCHANGES, ...US_EXCHANGES]);
		expect(session.allowNewEntries).toBe(true);
	});

	test("returns us_session at 17:00 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T17:00:00+01:00"));
		expect(session.name).toBe("us_session");
		expect(session.exchanges).toEqual(US_EXCHANGES);
		expect(session.allowNewEntries).toBe(true);
	});

	test("returns us_close at 21:05 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T21:05:00+01:00"));
		expect(session.name).toBe("us_close");
		expect(session.exchanges).toEqual(US_EXCHANGES);
		expect(session.allowNewEntries).toBe(false);
	});

	test("returns post_close at 22:30 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T22:30:00+01:00"));
		expect(session.name).toBe("post_close");
		expect(session.exchanges).toEqual([]);
		expect(session.allowNewEntries).toBe(false);
	});

	test("returns off_hours at 03:00 UK", () => {
		const session = getCurrentSession(new Date("2026-04-08T03:00:00+01:00"));
		expect(session.name).toBe("off_hours");
		expect(session.exchanges).toEqual([]);
		expect(session.allowNewEntries).toBe(false);
	});

	test("returns off_hours on Saturday", () => {
		// 2026-04-11 is a Saturday
		const session = getCurrentSession(new Date("2026-04-11T10:00:00+01:00"));
		expect(session.name).toBe("off_hours");
	});

	test("returns off_hours on Sunday", () => {
		// 2026-04-12 is a Sunday
		const session = getCurrentSession(new Date("2026-04-12T10:00:00+01:00"));
		expect(session.name).toBe("off_hours");
	});

	test("boundary: 08:00 exactly is uk_session", () => {
		const session = getCurrentSession(new Date("2026-04-08T08:00:00+01:00"));
		expect(session.name).toBe("uk_session");
	});

	test("boundary: 14:30 exactly is overlap", () => {
		const session = getCurrentSession(new Date("2026-04-08T14:30:00+01:00"));
		expect(session.name).toBe("overlap");
	});

	test("boundary: 16:30 exactly is us_session", () => {
		const session = getCurrentSession(new Date("2026-04-08T16:30:00+01:00"));
		expect(session.name).toBe("us_session");
	});

	test("boundary: 21:00 exactly is us_close", () => {
		const session = getCurrentSession(new Date("2026-04-08T21:00:00+01:00"));
		expect(session.name).toBe("us_close");
	});

	test("boundary: 21:15 exactly is post_close (us_close ends)", () => {
		const session = getCurrentSession(new Date("2026-04-08T21:15:00+01:00"));
		expect(session.name).toBe("post_close");
	});

	test("boundary: 22:00 exactly is post_close", () => {
		const session = getCurrentSession(new Date("2026-04-08T22:00:00+01:00"));
		expect(session.name).toBe("post_close");
	});

	test("boundary: 22:46 exactly is off_hours", () => {
		const session = getCurrentSession(new Date("2026-04-08T22:46:00+01:00"));
		expect(session.name).toBe("off_hours");
	});

	test("uses current time when no argument given", () => {
		const session = getCurrentSession();
		expect(session.name).toBeDefined();
		expect(Array.isArray(session.exchanges)).toBe(true);
		expect(typeof session.allowNewEntries).toBe("boolean");
	});
});

describe("isExchangeOpen", () => {
	test("LSE is open during uk_session", () => {
		expect(isExchangeOpen("LSE", new Date("2026-04-08T09:00:00+01:00"))).toBe(true);
	});

	test("NASDAQ is not open during uk_session", () => {
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-08T09:00:00+01:00"))).toBe(false);
	});

	test("NASDAQ is open during overlap", () => {
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-08T15:00:00+01:00"))).toBe(true);
	});

	test("LSE is open during overlap", () => {
		expect(isExchangeOpen("LSE", new Date("2026-04-08T15:00:00+01:00"))).toBe(true);
	});

	test("NASDAQ is open during us_session", () => {
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-08T17:00:00+01:00"))).toBe(true);
	});

	test("LSE is not open during us_session", () => {
		expect(isExchangeOpen("LSE", new Date("2026-04-08T17:00:00+01:00"))).toBe(false);
	});

	test("NASDAQ is open during us_close", () => {
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-08T21:05:00+01:00"))).toBe(true);
	});

	test("nothing is open on weekends", () => {
		expect(isExchangeOpen("LSE", new Date("2026-04-11T10:00:00+01:00"))).toBe(false);
		expect(isExchangeOpen("NASDAQ", new Date("2026-04-11T10:00:00+01:00"))).toBe(false);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scheduler/sessions.test.ts`
Expected: FAIL — module `../../src/scheduler/sessions` not found

- [ ] **Step 3: Implement sessions module**

```typescript
// src/scheduler/sessions.ts
import type { Exchange } from "../broker/contracts.ts";

export type SessionName =
	| "pre_market"
	| "uk_session"
	| "overlap"
	| "us_session"
	| "us_close"
	| "post_close"
	| "off_hours";

export interface Session {
	name: SessionName;
	exchanges: Exchange[];
	allowNewEntries: boolean;
}

export const UK_EXCHANGES: Exchange[] = ["LSE"];
export const US_EXCHANGES: Exchange[] = ["NASDAQ", "NYSE"];

interface SessionDef {
	name: SessionName;
	startHour: number;
	startMinute: number;
	endHour: number;
	endMinute: number;
	exchanges: Exchange[];
	allowNewEntries: boolean;
}

/**
 * Sessions ordered by start time. Checked sequentially —
 * first match wins, so order matters.
 * Times are UK (Europe/London).
 */
const SESSION_DEFS: SessionDef[] = [
	{
		name: "pre_market",
		startHour: 6,
		startMinute: 0,
		endHour: 8,
		endMinute: 0,
		exchanges: [],
		allowNewEntries: false,
	},
	{
		name: "uk_session",
		startHour: 8,
		startMinute: 0,
		endHour: 14,
		endMinute: 30,
		exchanges: [...UK_EXCHANGES],
		allowNewEntries: true,
	},
	{
		name: "overlap",
		startHour: 14,
		startMinute: 30,
		endHour: 16,
		endMinute: 30,
		exchanges: [...UK_EXCHANGES, ...US_EXCHANGES],
		allowNewEntries: true,
	},
	{
		name: "us_session",
		startHour: 16,
		startMinute: 30,
		endHour: 21,
		endMinute: 0,
		exchanges: [...US_EXCHANGES],
		allowNewEntries: true,
	},
	{
		name: "us_close",
		startHour: 21,
		startMinute: 0,
		endHour: 21,
		endMinute: 15,
		exchanges: [...US_EXCHANGES],
		allowNewEntries: false,
	},
	{
		name: "post_close",
		startHour: 21,
		startMinute: 15,
		endHour: 22,
		endMinute: 46,
		exchanges: [],
		allowNewEntries: false,
	},
];

/** Convert a Date to UK hours and minutes using Europe/London timezone */
function toUkTime(date: Date): { hour: number; minute: number; dayOfWeek: number } {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/London",
		hour: "numeric",
		minute: "numeric",
		hour12: false,
	}).formatToParts(date);

	const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
	const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);

	// Get UK day of week
	const dayStr = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/London",
		weekday: "short",
	}).format(date);
	const dayMap: Record<string, number> = {
		Sun: 0,
		Mon: 1,
		Tue: 2,
		Wed: 3,
		Thu: 4,
		Fri: 5,
		Sat: 6,
	};
	const dayOfWeek = dayMap[dayStr] ?? 0;

	return { hour, minute, dayOfWeek };
}

function timeToMinutes(hour: number, minute: number): number {
	return hour * 60 + minute;
}

/**
 * Get the current trading session based on UK time.
 * @param now - Date to check (defaults to current time)
 */
export function getCurrentSession(now?: Date): Session {
	const date = now ?? new Date();
	const { hour, minute, dayOfWeek } = toUkTime(date);

	// Weekends are always off_hours
	if (dayOfWeek === 0 || dayOfWeek === 6) {
		return { name: "off_hours", exchanges: [], allowNewEntries: false };
	}

	const currentMinutes = timeToMinutes(hour, minute);

	for (const def of SESSION_DEFS) {
		const start = timeToMinutes(def.startHour, def.startMinute);
		const end = timeToMinutes(def.endHour, def.endMinute);
		if (currentMinutes >= start && currentMinutes < end) {
			return {
				name: def.name,
				exchanges: def.exchanges,
				allowNewEntries: def.allowNewEntries,
			};
		}
	}

	return { name: "off_hours", exchanges: [], allowNewEntries: false };
}

/**
 * Check if a specific exchange is currently open.
 * @param exchange - The exchange to check
 * @param now - Date to check (defaults to current time)
 */
export function isExchangeOpen(exchange: Exchange, now?: Date): boolean {
	const session = getCurrentSession(now);
	return session.exchanges.includes(exchange);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scheduler/sessions.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/sessions.ts tests/scheduler/sessions.test.ts
git commit -m "feat(scheduler): add trading session definitions and getCurrentSession lookup"
```

---

### Task 2: Create Per-Category Lock Manager

**Files:**
- Create: `src/scheduler/locks.ts`
- Create: `tests/scheduler/locks.test.ts`

- [ ] **Step 1: Write failing tests for per-category locks**

```typescript
// tests/scheduler/locks.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { acquireLock, releaseLock, isLocked, resetAllLocks, type LockCategory } from "../../src/scheduler/locks";

describe("per-category locks", () => {
	beforeEach(() => {
		resetAllLocks();
	});

	test("lock is not held initially", () => {
		expect(isLocked("quotes_uk")).toBe(false);
	});

	test("acquireLock returns true when lock is free", () => {
		expect(acquireLock("quotes_uk")).toBe(true);
		expect(isLocked("quotes_uk")).toBe(true);
	});

	test("acquireLock returns false when lock is already held", () => {
		acquireLock("quotes_uk");
		expect(acquireLock("quotes_uk")).toBe(false);
	});

	test("releaseLock frees the lock", () => {
		acquireLock("quotes_uk");
		releaseLock("quotes_uk");
		expect(isLocked("quotes_uk")).toBe(false);
	});

	test("different categories are independent", () => {
		acquireLock("quotes_uk");
		expect(acquireLock("quotes_us")).toBe(true);
		expect(isLocked("quotes_uk")).toBe(true);
		expect(isLocked("quotes_us")).toBe(true);
	});

	test("UK quotes lock does not block US eval", () => {
		acquireLock("quotes_uk");
		expect(acquireLock("eval_us")).toBe(true);
	});

	test("same category blocks: two UK quote jobs cannot overlap", () => {
		acquireLock("quotes_uk");
		expect(acquireLock("quotes_uk")).toBe(false);
	});

	test("resetAllLocks clears all held locks", () => {
		acquireLock("quotes_uk");
		acquireLock("quotes_us");
		acquireLock("news");
		resetAllLocks();
		expect(isLocked("quotes_uk")).toBe(false);
		expect(isLocked("quotes_us")).toBe(false);
		expect(isLocked("news")).toBe(false);
	});

	test("all lock categories can be acquired independently", () => {
		const categories: LockCategory[] = [
			"quotes_uk",
			"quotes_us",
			"news",
			"eval_uk",
			"eval_us",
			"dispatch",
			"analysis",
			"risk",
			"maintenance",
		];
		for (const cat of categories) {
			expect(acquireLock(cat)).toBe(true);
		}
		// All held simultaneously
		for (const cat of categories) {
			expect(isLocked(cat)).toBe(true);
		}
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scheduler/locks.test.ts`
Expected: FAIL — module `../../src/scheduler/locks` not found

- [ ] **Step 3: Implement locks module**

```typescript
// src/scheduler/locks.ts

export type LockCategory =
	| "quotes_uk"
	| "quotes_us"
	| "news"
	| "eval_uk"
	| "eval_us"
	| "dispatch"
	| "analysis"
	| "risk"
	| "maintenance";

const locks = new Map<LockCategory, boolean>();

/**
 * Try to acquire a lock for the given category.
 * Returns true if acquired, false if already held.
 */
export function acquireLock(category: LockCategory): boolean {
	if (locks.get(category)) {
		return false;
	}
	locks.set(category, true);
	return true;
}

/**
 * Release the lock for the given category.
 */
export function releaseLock(category: LockCategory): void {
	locks.set(category, false);
}

/**
 * Check if a lock is currently held.
 */
export function isLocked(category: LockCategory): boolean {
	return locks.get(category) === true;
}

/**
 * Reset all locks. Used in tests.
 */
export function resetAllLocks(): void {
	locks.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scheduler/locks.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/locks.ts tests/scheduler/locks.test.ts
git commit -m "feat(scheduler): add per-category job lock manager"
```

---

### Task 3: Add Exchange Filter to Quote Refresh

**Files:**
- Modify: `src/scheduler/quote-refresh.ts`
- Create: `tests/scheduler/quote-refresh-filter.test.ts`

- [ ] **Step 1: Write failing tests for exchange-filtered quote refresh**

```typescript
// tests/scheduler/quote-refresh-filter.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "../../src/db/client";
import { quotesCache } from "../../src/db/schema";

describe("quote refresh exchange filter", () => {
	beforeEach(async () => {
		closeDb();
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		// Seed quotes cache with UK and US symbols
		await db.insert(quotesCache).values([
			{ symbol: "VOD", exchange: "LSE", last: 100, updatedAt: new Date().toISOString() },
			{ symbol: "AAPL", exchange: "NASDAQ", last: 200, updatedAt: new Date().toISOString() },
			{ symbol: "MSFT", exchange: "NASDAQ", last: 300, updatedAt: new Date().toISOString() },
			{ symbol: "BARC", exchange: "LSE", last: 150, updatedAt: new Date().toISOString() },
		]);
	});

	test("getSymbolsToRefresh returns all symbols when no filter", async () => {
		const { getSymbolsToRefresh } = await import("../../src/scheduler/quote-refresh");
		const symbols = await getSymbolsToRefresh();
		expect(symbols.length).toBe(4);
	});

	test("getSymbolsToRefresh filters to UK exchanges only", async () => {
		const { getSymbolsToRefresh } = await import("../../src/scheduler/quote-refresh");
		const symbols = await getSymbolsToRefresh(["LSE"]);
		expect(symbols.length).toBe(2);
		expect(symbols.every((s) => s.exchange === "LSE")).toBe(true);
	});

	test("getSymbolsToRefresh filters to US exchanges only", async () => {
		const { getSymbolsToRefresh } = await import("../../src/scheduler/quote-refresh");
		const symbols = await getSymbolsToRefresh(["NASDAQ", "NYSE"]);
		expect(symbols.length).toBe(2);
		expect(symbols.every((s) => s.exchange === "NASDAQ" || s.exchange === "NYSE")).toBe(true);
	});

	test("getSymbolsToRefresh returns empty for exchange with no symbols", async () => {
		const { getSymbolsToRefresh } = await import("../../src/scheduler/quote-refresh");
		const symbols = await getSymbolsToRefresh(["NYSE"]);
		expect(symbols.length).toBe(0);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scheduler/quote-refresh-filter.test.ts`
Expected: FAIL — `getSymbolsToRefresh` is not exported

- [ ] **Step 3: Refactor quote-refresh to accept exchange filter**

Replace the contents of `src/scheduler/quote-refresh.ts`. The key change: extract `getSymbolsToRefresh()` as a public function with an optional `exchanges` filter, and make `refreshQuotesForAllCached()` accept the same parameter.

```typescript
// src/scheduler/quote-refresh.ts
import { and, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { refreshQuote } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { newsEvents, quotesCache } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "quote-refresh" });

/** Get symbols to refresh, optionally filtered by exchange */
export async function getSymbolsToRefresh(
	exchanges?: Exchange[],
): Promise<Array<{ symbol: string; exchange: string }>> {
	const db = getDb();
	if (exchanges && exchanges.length > 0) {
		return db
			.select({ symbol: quotesCache.symbol, exchange: quotesCache.exchange })
			.from(quotesCache)
			.where(inArray(quotesCache.exchange, exchanges));
	}
	return db
		.select({ symbol: quotesCache.symbol, exchange: quotesCache.exchange })
		.from(quotesCache);
}

/** Refresh quotes for symbols in the cache, optionally filtered by exchange */
export async function refreshQuotesForAllCached(exchanges?: Exchange[]): Promise<void> {
	const cached = await getSymbolsToRefresh(exchanges);

	if (cached.length === 0) {
		log.info(
			{ exchanges: exchanges ?? "all" },
			"No symbols to refresh",
		);
		return;
	}

	let refreshed = 0;
	for (const { symbol, exchange } of cached) {
		const result = await refreshQuote(symbol, exchange);
		if (result) refreshed++;
		await Bun.sleep(200);
	}

	await backfillSentimentPrices();
	log.info({ total: cached.length, refreshed, exchanges: exchanges ?? "all" }, "Quote refresh complete");
}

/**
 * Backfill priceAfter1d for classified news events that are >24h old
 * and haven't been backfilled yet. Piggybacks on quote refresh cycle.
 */
export async function backfillSentimentPrices(): Promise<void> {
	const db = getDb();
	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const staleEvents = await db
		.select({
			id: newsEvents.id,
			symbols: newsEvents.symbols,
		})
		.from(newsEvents)
		.where(
			and(
				isNotNull(newsEvents.priceAtClassification),
				isNull(newsEvents.priceAfter1d),
				lt(newsEvents.classifiedAt, oneDayAgo),
			),
		)
		.limit(50);

	if (staleEvents.length === 0) return;

	let filled = 0;
	for (const event of staleEvents) {
		const symbols: string[] = JSON.parse(event.symbols ?? "[]");
		const primarySymbol = symbols[0];
		if (!primarySymbol) continue;

		const [cached] = await db
			.select({ last: quotesCache.last })
			.from(quotesCache)
			.where(eq(quotesCache.symbol, primarySymbol))
			.limit(1);

		if (cached?.last != null) {
			await db
				.update(newsEvents)
				.set({ priceAfter1d: cached.last })
				.where(eq(newsEvents.id, event.id));
			filled++;
		}
	}

	if (filled > 0) {
		log.info(
			{ filled, total: staleEvents.length },
			"Backfilled priceAfter1d for sentiment validation",
		);
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scheduler/quote-refresh-filter.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run existing tests to verify no regressions**

Run: `bun test tests/scheduler/`
Expected: All existing tests still PASS (refreshQuotesForAllCached() with no args still refreshes all)

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/quote-refresh.ts tests/scheduler/quote-refresh-filter.test.ts
git commit -m "feat(scheduler): add exchange filter to quote refresh"
```

---

### Task 4: Add Exchange Filter to Strategy Evaluation

**Files:**
- Modify: `src/scheduler/strategy-eval-job.ts`
- Create: `tests/scheduler/strategy-eval-filter.test.ts`

- [ ] **Step 1: Write failing tests for exchange-filtered strategy evaluation**

```typescript
// tests/scheduler/strategy-eval-filter.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "../../src/db/client";
import { strategies, quotesCache } from "../../src/db/schema";
import { resetConfigForTesting } from "../../src/config";

describe("strategy eval exchange filter", () => {
	beforeEach(async () => {
		closeDb();
		resetConfigForTesting();
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		// Seed a paper strategy with mixed universe
		await db.insert(strategies).values({
			name: "test_strat",
			description: "test",
			parameters: JSON.stringify({ threshold: 0.5 }),
			signals: JSON.stringify({ entry_long: "last > 0", exit: "hold_days >= 1" }),
			universe: JSON.stringify(["AAPL:NASDAQ", "VOD:LSE", "MSFT:NASDAQ"]),
			status: "paper",
			virtualBalance: 10000,
			generation: 1,
		});

		// Seed quotes
		await db.insert(quotesCache).values([
			{ symbol: "AAPL", exchange: "NASDAQ", last: 200, volume: 1000000, avgVolume: 900000, updatedAt: new Date().toISOString() },
			{ symbol: "VOD", exchange: "LSE", last: 100, volume: 500000, avgVolume: 600000, updatedAt: new Date().toISOString() },
			{ symbol: "MSFT", exchange: "NASDAQ", last: 300, volume: 800000, avgVolume: 700000, updatedAt: new Date().toISOString() },
		]);
	});

	test("filterUniverseByExchanges keeps only matching exchanges", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const universe = ["AAPL:NASDAQ", "VOD:LSE", "MSFT:NASDAQ"];

		const usOnly = filterUniverseByExchanges(universe, ["NASDAQ", "NYSE"]);
		expect(usOnly).toEqual(["AAPL:NASDAQ", "MSFT:NASDAQ"]);

		const ukOnly = filterUniverseByExchanges(universe, ["LSE"]);
		expect(ukOnly).toEqual(["VOD:LSE"]);
	});

	test("filterUniverseByExchanges returns all when no filter", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const universe = ["AAPL:NASDAQ", "VOD:LSE"];

		const all = filterUniverseByExchanges(universe);
		expect(all).toEqual(["AAPL:NASDAQ", "VOD:LSE"]);
	});

	test("filterUniverseByExchanges handles bare symbols (default NASDAQ)", async () => {
		const { filterUniverseByExchanges } = await import("../../src/scheduler/strategy-eval-job");
		const universe = ["AAPL", "VOD:LSE"];

		const usOnly = filterUniverseByExchanges(universe, ["NASDAQ"]);
		expect(usOnly).toEqual(["AAPL"]);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scheduler/strategy-eval-filter.test.ts`
Expected: FAIL — `filterUniverseByExchanges` not exported

- [ ] **Step 3: Add exchange filter to strategy-eval-job**

Modify `src/scheduler/strategy-eval-job.ts` — add the `filterUniverseByExchanges` helper and an `exchanges` parameter to `runStrategyEvaluation`:

```typescript
// src/scheduler/strategy-eval-job.ts
import { eq } from "drizzle-orm";
import type { Exchange } from "../broker/contracts.ts";
import { getQuoteFromCache } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import type { QuoteFields } from "../strategy/context.ts";
import { evaluateAllStrategies } from "../strategy/evaluator.ts";
import { runGraduationGate } from "../strategy/graduation.ts";
import { getIndicators } from "../strategy/historical.ts";
import { recalculateMetrics } from "../strategy/metrics.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "strategy-eval-job" });

/**
 * Filter a universe list (["AAPL:NASDAQ", "VOD:LSE"]) to only include
 * symbols on the given exchanges. If no exchanges given, return all.
 */
export function filterUniverseByExchanges(
	universe: string[],
	exchanges?: Exchange[],
): string[] {
	if (!exchanges || exchanges.length === 0) return universe;

	const exchangeSet = new Set(exchanges);
	return universe.filter((spec) => {
		const exchange = spec.includes(":") ? spec.split(":")[1]! : "NASDAQ";
		return exchangeSet.has(exchange as Exchange);
	});
}

export async function runStrategyEvaluation(options?: {
	exchanges?: Exchange[];
	allowNewEntries?: boolean;
}): Promise<void> {
	const exchangeFilter = options?.exchanges;
	const allowNewEntries = options?.allowNewEntries ?? true;

	await evaluateAllStrategies(
		async (symbol, exchange) => {
			const cached = await getQuoteFromCache(symbol, exchange);
			if (!cached || cached.last == null) return null;

			const indicators = await getIndicators(symbol, exchange);

			const quote: QuoteFields = {
				last: cached.last,
				bid: cached.bid,
				ask: cached.ask,
				volume: cached.volume,
				avgVolume: cached.avgVolume,
				changePercent: cached.changePercent,
				newsSentiment: cached.newsSentiment,
				newsEarningsSurprise: cached.newsEarningsSurprise,
				newsGuidanceChange: cached.newsGuidanceChange,
				newsManagementTone: cached.newsManagementTone,
				newsRegulatoryRisk: cached.newsRegulatoryRisk,
				newsAcquisitionLikelihood: cached.newsAcquisitionLikelihood,
				newsCatalystType: cached.newsCatalystType,
				newsExpectedMoveDuration: cached.newsExpectedMoveDuration,
			};

			return { quote, indicators };
		},
		{ exchanges: exchangeFilter, allowNewEntries },
	);

	// After evaluation, recalculate metrics for all paper strategies
	const db = getDb();
	const paperStrategies = await db
		.select({ id: strategies.id })
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	for (const strat of paperStrategies) {
		await recalculateMetrics(strat.id);
		await runGraduationGate(strat.id);
	}

	log.info({ exchanges: exchangeFilter ?? "all" }, "Strategy evaluation cycle complete");
}
```

Note: This changes the `evaluateAllStrategies` call to pass an options object. That function in `src/strategy/evaluator.ts` will need a matching change — see Task 5.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/scheduler/strategy-eval-filter.test.ts`
Expected: The `filterUniverseByExchanges` tests PASS. The full `runStrategyEvaluation` may fail until Task 5 updates the evaluator.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/strategy-eval-job.ts tests/scheduler/strategy-eval-filter.test.ts
git commit -m "feat(scheduler): add exchange filter to strategy evaluation job"
```

---

### Task 5: Update Evaluator to Accept Exchange and Entry Filters

**Files:**
- Modify: `src/strategy/evaluator.ts`
- Create: `tests/strategy/evaluator-filter.test.ts`

- [ ] **Step 1: Write failing tests for evaluator exchange filtering**

```typescript
// tests/strategy/evaluator-filter.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "../../src/db/client";
import { strategies, quotesCache } from "../../src/db/schema";
import { resetConfigForTesting } from "../../src/config";
import { filterUniverseByExchanges } from "../../src/scheduler/strategy-eval-job";

describe("evaluator exchange filtering", () => {
	beforeEach(async () => {
		closeDb();
		resetConfigForTesting();
		const db = getDb();
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("evaluateAllStrategies filters universe by exchanges when provided", async () => {
		const db = getDb();
		await db.insert(strategies).values({
			name: "mixed_strat",
			description: "test",
			parameters: JSON.stringify({ threshold: 0.5 }),
			signals: JSON.stringify({ entry_long: "last > 0", exit: "hold_days >= 1" }),
			universe: JSON.stringify(["AAPL:NASDAQ", "VOD:LSE"]),
			status: "paper",
			virtualBalance: 10000,
			generation: 1,
		});

		// Track which symbols were requested
		const requestedSymbols: string[] = [];
		const { evaluateAllStrategies } = await import("../../src/strategy/evaluator");
		await evaluateAllStrategies(
			async (symbol, _exchange) => {
				requestedSymbols.push(symbol);
				return null; // No quote data — just tracking calls
			},
			{ exchanges: ["NASDAQ", "NYSE"] },
		);

		expect(requestedSymbols).toContain("AAPL");
		expect(requestedSymbols).not.toContain("VOD");
	});

	test("evaluateAllStrategies does not filter when no exchanges given", async () => {
		const db = getDb();
		await db.insert(strategies).values({
			name: "mixed_strat",
			description: "test",
			parameters: JSON.stringify({ threshold: 0.5 }),
			signals: JSON.stringify({ entry_long: "last > 0", exit: "hold_days >= 1" }),
			universe: JSON.stringify(["AAPL:NASDAQ", "VOD:LSE"]),
			status: "paper",
			virtualBalance: 10000,
			generation: 1,
		});

		const requestedSymbols: string[] = [];
		const { evaluateAllStrategies } = await import("../../src/strategy/evaluator");
		await evaluateAllStrategies(async (symbol, _exchange) => {
			requestedSymbols.push(symbol);
			return null;
		});

		expect(requestedSymbols).toContain("AAPL");
		expect(requestedSymbols).toContain("VOD");
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/strategy/evaluator-filter.test.ts`
Expected: FAIL — `evaluateAllStrategies` doesn't accept options parameter

- [ ] **Step 3: Update evaluateAllStrategies to accept options**

Modify `src/strategy/evaluator.ts`. The change is minimal: add an optional second parameter to `evaluateAllStrategies` and apply exchange filtering to the universe before evaluating. Add the `allowNewEntries` flag to skip entry signals during `us_close`.

In the function signature, change:

```typescript
export async function evaluateAllStrategies(
	getQuoteAndIndicators: (
		symbol: string,
		exchange: string,
	) => Promise<{ quote: QuoteFields; indicators: SymbolIndicators } | null>,
): Promise<void> {
```

To:

```typescript
export async function evaluateAllStrategies(
	getQuoteAndIndicators: (
		symbol: string,
		exchange: string,
	) => Promise<{ quote: QuoteFields; indicators: SymbolIndicators } | null>,
	options?: {
		exchanges?: Exchange[];
		allowNewEntries?: boolean;
	},
): Promise<void> {
```

Add the import at the top:

```typescript
import type { Exchange } from "../broker/contracts.ts";
```

Then, in the paper strategies loop, after the line:

```typescript
const universe = await filterByLiquidity(withInjections, defaultExchange);
```

Add exchange filtering:

```typescript
// Apply exchange filter if provided (session-aware scheduling)
const exchangeFiltered = options?.exchanges
	? universe.filter((spec) => {
			const ex = spec.includes(":") ? spec.split(":")[1]! : "NASDAQ";
			return options.exchanges!.includes(ex as Exchange);
		})
	: universe;
```

Then replace `universe` with `exchangeFiltered` in the for-loop:

```typescript
for (const symbolSpec of exchangeFiltered) {
```

In `evaluateStrategyForSymbol`, the entry signal block needs to check `allowNewEntries`. In the `evaluateAllStrategies` function, pass `allowNewEntries` into the per-symbol evaluation. The simplest way: skip entry evaluation at the universe loop level. After the `const data = await getQuoteAndIndicators(...)` block, before calling `evaluateStrategyForSymbol`, add:

Actually, the cleaner approach is to not change `evaluateStrategyForSymbol` at all. Instead, in the universe loop, if `allowNewEntries` is false and the symbol has no open position, skip it (since we'd only be looking for exits):

After the `if (!data) continue;` line, add:

```typescript
// In exit-only mode (us_close), skip symbols with no open position
if (options?.allowNewEntries === false) {
	const { getOpenPositionForSymbol } = await import("../paper/manager.ts");
	const pos = await getOpenPositionForSymbol(strategy.id, symbol!, exchange!);
	if (!pos) continue;
}
```

Wait — this adds a dynamic import in a hot loop. Better approach: check open positions once per strategy. Refactor: after getting `openPositions` for the strategy, build a set of open symbols, then skip non-open symbols when `allowNewEntries` is false.

After the existing `riskState` block:

```typescript
// In exit-only mode (us_close), only evaluate symbols with open positions
const openSymbols = new Set(openPositions.map((p) => `${p.symbol}:${p.exchange}`));
```

Then in the for-loop:

```typescript
for (const symbolSpec of exchangeFiltered) {
	const [symbol, exchange] = symbolSpec.includes(":")
		? symbolSpec.split(":")
		: [symbolSpec, "NASDAQ"];

	// Skip symbols with no open position when entries are disallowed
	if (options?.allowNewEntries === false && !openSymbols.has(`${symbol}:${exchange}`)) {
		continue;
	}

	// ... rest unchanged
```

Apply the same exchange filtering and allowNewEntries logic to the graduated strategies loop below it.

For graduated strategies, after the `filteredUniverse` line:

```typescript
const exchangeFilteredGrad = options?.exchanges
	? filteredUniverse.filter((spec) => {
			const ex = spec.includes(":") ? spec.split(":")[1]! : "NASDAQ";
			return options.exchanges!.includes(ex as Exchange);
		})
	: filteredUniverse;
```

And use `exchangeFilteredGrad` in that loop, with the same `openSymbols` check for `allowNewEntries`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/strategy/evaluator-filter.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full strategy test suite for regressions**

Run: `bun test tests/strategy/`
Expected: All existing tests PASS (evaluateAllStrategies with no options behaves identically to before)

- [ ] **Step 6: Commit**

```bash
git add src/strategy/evaluator.ts tests/strategy/evaluator-filter.test.ts
git commit -m "feat(strategy): add exchange and entry filtering to evaluateAllStrategies"
```

---

### Task 6: Rewrite Jobs and CRON Schedule

**Files:**
- Modify: `src/scheduler/jobs.ts`
- Modify: `src/scheduler/cron.ts`
- Modify: `tests/scheduler/cron.test.ts`

This is the wiring task: replace the global job lock with per-category locks, add the new per-market job names, and rewrite the CRON schedule.

- [ ] **Step 1: Write tests for the new job runner with category locks**

```typescript
// tests/scheduler/cron.test.ts — rewrite
import { describe, expect, test, beforeEach } from "bun:test";
import { resetAllLocks, isLocked } from "../../src/scheduler/locks";

describe("scheduler", () => {
	beforeEach(() => {
		resetAllLocks();
	});

	test("jobs module exports runJob function", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		expect(typeof runJob).toBe("function");
	});

	test("runJob acquires and releases category lock", async () => {
		const { runJob } = await import("../../src/scheduler/jobs.ts");
		// quote_refresh_uk uses "quotes_uk" category — should not be locked after completion
		await runJob("quote_refresh_uk");
		expect(isLocked("quotes_uk")).toBe(false);
	});

	test("runJob skips if category lock is held", async () => {
		const { acquireLock } = await import("../../src/scheduler/locks");
		const { runJob } = await import("../../src/scheduler/jobs.ts");

		// Simulate a running quotes_uk job
		acquireLock("quotes_uk");

		// This should skip — the lock is already held
		// It should not throw
		await runJob("quote_refresh_uk");

		// Lock should still be held (we didn't release it)
		expect(isLocked("quotes_uk")).toBe(true);
	});

	test("jobs in different categories can run concurrently", async () => {
		const { acquireLock } = await import("../../src/scheduler/locks");
		const { runJob } = await import("../../src/scheduler/jobs.ts");

		// Hold the UK quotes lock
		acquireLock("quotes_uk");

		// US quotes should still run fine (different category)
		await runJob("quote_refresh_us");
		expect(isLocked("quotes_us")).toBe(false); // released after completion
		expect(isLocked("quotes_uk")).toBe(true); // still held
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/scheduler/cron.test.ts`
Expected: FAIL — `quote_refresh_uk` not a valid JobName

- [ ] **Step 3: Rewrite `src/scheduler/jobs.ts`**

Replace the global `jobRunning` lock with per-category lock usage. Add all new job names. Map each job to its lock category.

```typescript
// src/scheduler/jobs.ts
import { createChildLogger } from "../utils/logger.ts";
import { acquireLock, releaseLock, type LockCategory } from "./locks.ts";

const log = createChildLogger({ module: "scheduler-jobs" });

export type JobName =
	| "quote_refresh_uk"
	| "quote_refresh_us"
	| "quote_refresh_us_close"
	| "strategy_eval_uk"
	| "strategy_eval_us"
	| "news_poll"
	| "dispatch"
	| "daily_summary"
	| "weekly_digest"
	| "strategy_evolution"
	| "trade_review"
	| "pattern_analysis"
	| "earnings_calendar_sync"
	| "heartbeat"
	| "self_improvement"
	| "guardian_start"
	| "guardian_stop"
	| "live_evaluation"
	| "risk_guardian"
	| "risk_daily_reset"
	| "risk_weekly_reset"
	| "daily_tournament"
	| "missed_opportunity_daily"
	| "missed_opportunity_weekly";

const JOB_LOCK_CATEGORY: Record<JobName, LockCategory> = {
	quote_refresh_uk: "quotes_uk",
	quote_refresh_us: "quotes_us",
	quote_refresh_us_close: "quotes_us",
	strategy_eval_uk: "eval_uk",
	strategy_eval_us: "eval_us",
	news_poll: "news",
	dispatch: "dispatch",
	daily_summary: "analysis",
	weekly_digest: "analysis",
	strategy_evolution: "analysis",
	trade_review: "analysis",
	pattern_analysis: "analysis",
	earnings_calendar_sync: "maintenance",
	heartbeat: "maintenance",
	self_improvement: "analysis",
	guardian_start: "risk",
	guardian_stop: "risk",
	live_evaluation: "eval_us",
	risk_guardian: "risk",
	risk_daily_reset: "maintenance",
	risk_weekly_reset: "maintenance",
	daily_tournament: "analysis",
	missed_opportunity_daily: "analysis",
	missed_opportunity_weekly: "analysis",
};

const JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function runJob(name: JobName): Promise<void> {
	const category = JOB_LOCK_CATEGORY[name];

	if (!acquireLock(category)) {
		const level =
			name === "trade_review" || name === "pattern_analysis" ? "warn" : "debug";
		log[level]({ job: name, category }, "Skipping — category lock held");
		return;
	}

	const start = Date.now();
	log.info({ job: name, category }, "Job starting");

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const jobPromise = executeJob(name);
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeoutId = setTimeout(
			() => reject(new Error(`Job ${name} timed out after ${JOB_TIMEOUT_MS / 60000}min`)),
			JOB_TIMEOUT_MS,
		);
	});

	try {
		await Promise.race([jobPromise, timeoutPromise]);
		log.info({ job: name, durationMs: Date.now() - start }, "Job completed");
		const { sendHeartbeat } = await import("../monitoring/heartbeat.ts");
		await sendHeartbeat(name).catch((err) =>
			log.warn({ err, job: name }, "Heartbeat failed (non-fatal)"),
		);
	} catch (error) {
		log.error({ job: name, error, durationMs: Date.now() - start }, "Job failed");
	} finally {
		clearTimeout(timeoutId);
		releaseLock(category);
	}
}

async function executeJob(name: JobName): Promise<void> {
	const TRADE_JOBS: JobName[] = ["strategy_eval_uk", "strategy_eval_us", "trade_review"];
	if (TRADE_JOBS.includes(name)) {
		const { isPaused } = await import("../monitoring/health.ts");
		if (isPaused()) {
			log.info({ job: name }, "Skipping — trading is paused");
			return;
		}
	}

	switch (name) {
		case "quote_refresh_uk": {
			const { refreshQuotesForAllCached } = await import("./quote-refresh.ts");
			await refreshQuotesForAllCached(["LSE"]);
			break;
		}

		case "quote_refresh_us": {
			const { refreshQuotesForAllCached } = await import("./quote-refresh.ts");
			await refreshQuotesForAllCached(["NASDAQ", "NYSE"]);
			break;
		}

		case "quote_refresh_us_close": {
			const { getCurrentSession } = await import("./sessions.ts");
			const session = getCurrentSession();
			if (session.name !== "us_close") {
				log.debug({ session: session.name }, "Not in us_close session — skipping us_close quote refresh");
				break;
			}
			const { refreshQuotesForAllCached } = await import("./quote-refresh.ts");
			await refreshQuotesForAllCached(["NASDAQ", "NYSE"]);
			break;
		}

		case "strategy_eval_uk": {
			const { runStrategyEvaluation } = await import("./strategy-eval-job.ts");
			await runStrategyEvaluation({ exchanges: ["LSE"] });
			break;
		}

		case "strategy_eval_us": {
			const { runStrategyEvaluation } = await import("./strategy-eval-job.ts");
			const { getCurrentSession } = await import("./sessions.ts");
			const session = getCurrentSession();
			await runStrategyEvaluation({
				exchanges: ["NASDAQ", "NYSE"],
				allowNewEntries: session.allowNewEntries,
			});
			break;
		}

		case "heartbeat": {
			const { sendEmail } = await import("../reporting/email.ts");
			const uptimeHrs = (process.uptime() / 3600).toFixed(1);
			await sendEmail({
				subject: `Heartbeat: Trader v2 alive — uptime ${uptimeHrs}h`,
				html: `<p>Trader v2 is running. Uptime: ${uptimeHrs} hours. Time: ${new Date().toISOString()}</p>`,
			});
			break;
		}

		case "daily_summary": {
			const { runDailySummary } = await import("./daily-summary-job.ts");
			await runDailySummary();
			break;
		}

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

		case "strategy_evolution": {
			const { runEvolutionJob } = await import("./evolution-job.ts");
			await runEvolutionJob();
			break;
		}

		case "trade_review": {
			const { runTradeReviewJob } = await import("./trade-review-job.ts");
			await runTradeReviewJob();
			break;
		}

		case "pattern_analysis": {
			const { runPatternAnalysisJob } = await import("./pattern-analysis-job.ts");
			await runPatternAnalysisJob();
			break;
		}

		case "weekly_digest": {
			const { runWeeklyDigest } = await import("./weekly-digest-job.ts");
			await runWeeklyDigest();
			break;
		}

		case "self_improvement": {
			const { runSelfImproveJob } = await import("./self-improve-job.ts");
			await runSelfImproveJob();
			break;
		}

		case "guardian_start": {
			const { startGuardianJob } = await import("./guardian-job.ts");
			await startGuardianJob();
			break;
		}

		case "guardian_stop": {
			const { stopGuardianJob } = await import("./guardian-job.ts");
			await stopGuardianJob();
			break;
		}

		case "live_evaluation": {
			const { runLiveEvalJob } = await import("./live-eval-job.ts");
			await runLiveEvalJob();
			break;
		}

		case "risk_guardian": {
			const { runRiskGuardianJob } = await import("./risk-guardian-job.ts");
			await runRiskGuardianJob();
			break;
		}

		case "risk_daily_reset": {
			const { resetDailyState } = await import("../risk/guardian.ts");
			await resetDailyState();
			break;
		}

		case "risk_weekly_reset": {
			const { resetWeeklyState } = await import("../risk/guardian.ts");
			await resetWeeklyState();
			break;
		}

		case "daily_tournament": {
			const { runDailyTournaments } = await import("../evolution/tournament");
			await runDailyTournaments();
			break;
		}

		case "dispatch": {
			const { runDispatch } = await import("../strategy/dispatch.ts");
			await runDispatch();
			break;
		}

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
	}
}
```

- [ ] **Step 4: Rewrite `src/scheduler/cron.ts`**

```typescript
// src/scheduler/cron.ts
import cron, { type ScheduledTask } from "node-cron";
import { createChildLogger } from "../utils/logger.ts";
import { runJob } from "./jobs.ts";

const log = createChildLogger({ module: "scheduler" });

const tasks: ScheduledTask[] = [];

export function startScheduler(): void {
	// ── Per-market quote refresh ────────────────────────────────────────
	// UK quotes: every 10 min, 08:00–16:59 UK (covers uk_session + overlap)
	tasks.push(
		cron.schedule("*/10 8-16 * * 1-5", () => runJob("quote_refresh_uk"), {
			timezone: "Europe/London",
		}),
	);

	// US quotes: every 10 min offset by 5, 14:00–20:59 UK (covers overlap + us_session)
	tasks.push(
		cron.schedule("5,15,25,35,45,55 14-20 * * 1-5", () => runJob("quote_refresh_us"), {
			timezone: "Europe/London",
		}),
	);

	// US close: tight 5-min polling during 21:xx hour (job checks session at runtime)
	tasks.push(
		cron.schedule("*/5 21 * * 1-5", () => runJob("quote_refresh_us_close"), {
			timezone: "Europe/London",
		}),
	);

	// ── Per-market strategy evaluation ──────────────────────────────────
	// UK eval: 3 min after UK quotes, 08:00–16:59 UK
	tasks.push(
		cron.schedule("3,13,23,33,43,53 8-16 * * 1-5", () => runJob("strategy_eval_uk"), {
			timezone: "Europe/London",
		}),
	);

	// US eval: 3 min after US quotes, 14:00–20:59 UK
	tasks.push(
		cron.schedule("8,18,28,38,48,58 14-20 * * 1-5", () => runJob("strategy_eval_us"), {
			timezone: "Europe/London",
		}),
	);

	// ── News polling ────────────────────────────────────────────────────
	// Pre-market through end of US session
	tasks.push(
		cron.schedule("*/10 6-20 * * 1-5", () => runJob("news_poll"), {
			timezone: "Europe/London",
		}),
	);

	// ── Dispatch at session boundaries ──────────────────────────────────
	// UK open
	tasks.push(
		cron.schedule("5 8 * * 1-5", () => runJob("dispatch"), {
			timezone: "Europe/London",
		}),
	);
	// US open / overlap start
	tasks.push(
		cron.schedule("35 14 * * 1-5", () => runJob("dispatch"), {
			timezone: "Europe/London",
		}),
	);
	// UK close / US-only handoff
	tasks.push(
		cron.schedule("35 16 * * 1-5", () => runJob("dispatch"), {
			timezone: "Europe/London",
		}),
	);
	// Mid US afternoon
	tasks.push(
		cron.schedule("0 18 * * 1-5", () => runJob("dispatch"), {
			timezone: "Europe/London",
		}),
	);

	// ── Risk & guardian ─────────────────────────────────────────────────
	tasks.push(
		cron.schedule("0 8 * * 1-5", () => runJob("guardian_start"), {
			timezone: "Europe/London",
		}),
	);
	// Extended to 21:15 to cover US close
	tasks.push(
		cron.schedule("15 21 * * 1-5", () => runJob("guardian_stop"), {
			timezone: "Europe/London",
		}),
	);
	// Risk guardian through full trading window including us_close
	tasks.push(
		cron.schedule("*/10 8-21 * * 1-5", () => runJob("risk_guardian"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("55 7 * * 1-5", () => runJob("risk_daily_reset"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("50 7 * * 1", () => runJob("risk_weekly_reset"), {
			timezone: "Europe/London",
		}),
	);

	// ── Live evaluation (US markets, same cadence as US eval) ───────────
	tasks.push(
		cron.schedule("7,17,27,37,47,57 14-20 * * 1-5", () => runJob("live_evaluation"), {
			timezone: "Europe/London",
		}),
	);

	// ── Post-close analysis (pushed to 22:00+) ─────────────────────────
	tasks.push(
		cron.schedule("0 22 * * 1-5", () => runJob("daily_summary"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("15 22 * * 1-5", () => runJob("trade_review"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("25 22 * * 1-5", () => runJob("missed_opportunity_daily"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("35 22 * * 1-5", () => runJob("daily_tournament"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("45 22 * * 2,5", () => runJob("pattern_analysis"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("45 22 * * 3", () => runJob("missed_opportunity_weekly"), {
			timezone: "Europe/London",
		}),
	);

	// ── Pre-market & maintenance ────────────────────────────────────────
	tasks.push(
		cron.schedule("0 6 * * 1-5", () => runJob("earnings_calendar_sync"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("0 7 * * 1-5", () => runJob("heartbeat"), {
			timezone: "Europe/London",
		}),
	);

	// ── Weekend ─────────────────────────────────────────────────────────
	tasks.push(
		cron.schedule("30 17 * * 0", () => runJob("weekly_digest"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("0 18 * * 0", () => runJob("strategy_evolution"), {
			timezone: "Europe/London",
		}),
	);
	tasks.push(
		cron.schedule("0 19 * * 0", () => runJob("self_improvement"), {
			timezone: "Europe/London",
		}),
	);

	log.info({ jobCount: tasks.length }, "Scheduler started");
}

export function stopScheduler(): void {
	for (const task of tasks) {
		task.stop();
	}
	tasks.length = 0;
	log.info("Scheduler stopped");
}
```

- [ ] **Step 5: Run tests**

Run: `bun test tests/scheduler/cron.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite for regressions**

Run: `bun test`
Expected: All tests PASS. Any tests referencing old job names like `"quote_refresh"` or `"strategy_evaluation"` will need updating — check failures and fix.

Note: If any other files import old job names (e.g., `"quote_refresh"` or `"strategy_evaluation"` as a `JobName`), those references will produce type errors. Search for these with:

```bash
bun run --bun biome check src/ tests/ --diagnostic-level=error
```

Fix any references:
- `"quote_refresh"` → `"quote_refresh_uk"` or `"quote_refresh_us"` depending on context
- `"strategy_evaluation"` → `"strategy_eval_uk"` or `"strategy_eval_us"` depending on context

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/jobs.ts src/scheduler/cron.ts tests/scheduler/cron.test.ts
git commit -m "feat(scheduler): rewrite CRON schedule with per-market jobs and category locks"
```

---

### Task 7: Update Monitoring Dashboard Schedule

**Files:**
- Modify: `src/monitoring/cron-schedule.ts`

- [ ] **Step 1: Update the static CRON_SCHEDULE record**

Replace the `CRON_SCHEDULE` in `src/monitoring/cron-schedule.ts` to match the new schedule:

```typescript
// src/monitoring/cron-schedule.ts
import { CronExpressionParser } from "cron-parser";

export interface CronEntry {
	cron: string;
}

export interface CronOccurrence {
	name: string;
	nextRun: string; // ISO string
	nextRunIn: string; // human-readable "2h 15m"
}

/**
 * Static map of all cron jobs — mirrors src/scheduler/cron.ts.
 * Maintained manually; if a job is added/removed in cron.ts, update here.
 */
export const CRON_SCHEDULE: Record<string, CronEntry> = {
	// Per-market quote refresh
	quote_refresh_uk: { cron: "*/10 8-16 * * 1-5" },
	quote_refresh_us: { cron: "5,15,25,35,45,55 14-20 * * 1-5" },
	quote_refresh_us_close: { cron: "*/5 21 * * 1-5" },

	// Per-market strategy evaluation
	strategy_eval_uk: { cron: "3,13,23,33,43,53 8-16 * * 1-5" },
	strategy_eval_us: { cron: "8,18,28,38,48,58 14-20 * * 1-5" },

	// News polling (pre-market through US session)
	news_poll: { cron: "*/10 6-20 * * 1-5" },

	// Dispatch at session boundaries
	dispatch_uk_open: { cron: "5 8 * * 1-5" },
	dispatch_us_open: { cron: "35 14 * * 1-5" },
	dispatch_uk_close: { cron: "35 16 * * 1-5" },
	dispatch_us_afternoon: { cron: "0 18 * * 1-5" },

	// Risk & guardian
	guardian_start: { cron: "0 8 * * 1-5" },
	guardian_stop: { cron: "15 21 * * 1-5" },
	risk_guardian: { cron: "*/10 8-21 * * 1-5" },
	risk_daily_reset: { cron: "55 7 * * 1-5" },
	risk_weekly_reset: { cron: "50 7 * * 1" },

	// Live evaluation
	live_evaluation: { cron: "7,17,27,37,47,57 14-20 * * 1-5" },

	// Post-close analysis (22:00+)
	daily_summary: { cron: "0 22 * * 1-5" },
	trade_review: { cron: "15 22 * * 1-5" },
	missed_opportunity_daily: { cron: "25 22 * * 1-5" },
	daily_tournament: { cron: "35 22 * * 1-5" },
	pattern_analysis: { cron: "45 22 * * 2,5" },
	missed_opportunity_weekly: { cron: "45 22 * * 3" },

	// Pre-market & maintenance
	earnings_calendar_sync: { cron: "0 6 * * 1-5" },
	heartbeat: { cron: "0 7 * * 1-5" },

	// Weekend
	weekly_digest: { cron: "30 17 * * 0" },
	strategy_evolution: { cron: "0 18 * * 0" },
	self_improvement: { cron: "0 19 * * 0" },
};

function formatDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	return `${minutes}m`;
}

export function getNextCronOccurrences(): CronOccurrence[] {
	const now = new Date();
	const results: CronOccurrence[] = [];

	for (const [name, entry] of Object.entries(CRON_SCHEDULE)) {
		const interval = CronExpressionParser.parse(entry.cron, {
			currentDate: now,
			tz: "Europe/London",
		});
		const next = interval.next().toDate();
		const diffMs = next.getTime() - now.getTime();

		results.push({
			name,
			nextRun: next.toISOString(),
			nextRunIn: formatDuration(diffMs),
		});
	}

	results.sort((a, b) => new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime());
	return results;
}
```

- [ ] **Step 2: Check for any other references to old CRON_SCHEDULE keys**

Search for references to old job names in the monitoring/dashboard code:

```bash
grep -r "quote_refresh\b" src/monitoring/ src/reporting/
grep -r "strategy_evaluation" src/monitoring/ src/reporting/
```

Fix any references found.

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/monitoring/cron-schedule.ts
git commit -m "feat(monitoring): update dashboard CRON schedule to match session-aware jobs"
```

---

### Task 8: Fix Remaining References to Old Job Names

**Files:**
- Various files that may reference old job names

After Tasks 6 and 7, there may be remaining references to the old job names `"quote_refresh"` and `"strategy_evaluation"` across the codebase. These will surface as type errors or test failures.

- [ ] **Step 1: Search for all old job name references**

```bash
grep -rn '"quote_refresh"' src/ tests/ --include="*.ts" | grep -v "quote_refresh_uk\|quote_refresh_us"
grep -rn '"strategy_evaluation"' src/ tests/ --include="*.ts" | grep -v "strategy_eval_uk\|strategy_eval_us"
```

- [ ] **Step 2: Fix each reference**

For each file found:
- If it's a heartbeat or monitoring reference that just uses the name as a string label, update to the appropriate new name
- If it's a `JobName` type reference, update to the new name
- If it's a test that invokes `runJob("quote_refresh")`, update to `runJob("quote_refresh_uk")` or `runJob("quote_refresh_us")`

- [ ] **Step 3: Run typecheck and full test suite**

```bash
bun run --bun biome check src/ tests/
bun test
```

Expected: No type errors, all tests PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: update remaining references to old job names"
```

---

### Task 9: Final Verification

- [ ] **Step 1: Run the full test suite**

```bash
bun test
```

Expected: All tests PASS

- [ ] **Step 2: Run typecheck and linter**

```bash
bun run --bun biome check src/ tests/
```

Expected: No errors

- [ ] **Step 3: Verify session boundaries manually**

Open a Bun REPL or write a quick verification script:

```bash
bun -e "
const { getCurrentSession } = require('./src/scheduler/sessions.ts');
const times = [
  '2026-04-08T05:00:00+01:00',
  '2026-04-08T06:30:00+01:00',
  '2026-04-08T08:00:00+01:00',
  '2026-04-08T14:30:00+01:00',
  '2026-04-08T16:30:00+01:00',
  '2026-04-08T21:00:00+01:00',
  '2026-04-08T21:15:00+01:00',
  '2026-04-08T22:46:00+01:00',
  '2026-04-11T10:00:00+01:00',
];
for (const t of times) {
  const s = getCurrentSession(new Date(t));
  console.log(t, '->', s.name, s.exchanges, 'entries:', s.allowNewEntries);
}
"
```

Expected output:
```
05:00 -> off_hours [] entries: false
06:30 -> pre_market [] entries: false
08:00 -> uk_session [LSE] entries: true
14:30 -> overlap [LSE, NASDAQ, NYSE] entries: true
16:30 -> us_session [NASDAQ, NYSE] entries: true
21:00 -> us_close [NASDAQ, NYSE] entries: false
21:15 -> post_close [] entries: false
22:46 -> off_hours [] entries: false
Saturday 10:00 -> off_hours [] entries: false
```

- [ ] **Step 4: Verify lock isolation with a quick test**

```bash
bun -e "
const { acquireLock, isLocked, releaseLock } = require('./src/scheduler/locks.ts');
acquireLock('quotes_uk');
console.log('quotes_uk locked:', isLocked('quotes_uk'));
console.log('quotes_us locked:', isLocked('quotes_us'));
console.log('Can acquire quotes_us:', acquireLock('quotes_us'));
releaseLock('quotes_uk');
releaseLock('quotes_us');
console.log('All released');
"
```

Expected: quotes_uk locked, quotes_us not locked, can acquire quotes_us independently.
