# Ops Console Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the minimal status page with a dense Bloomberg-terminal-inspired operations console showing strategies, cron schedule, positions, risk, and activity.

**Architecture:** Server-rendered HTML from a single `buildConsolePage()` function. Data gathered by a new `getDashboardData()` function querying SQLite. Cron next-run times computed from a static schedule map using `cron-parser`. New `/api/dashboard` JSON endpoint. All served from the existing Bun HTTP server.

**Tech Stack:** Bun, Drizzle ORM, SQLite, `cron-parser` (new dep), JetBrains Mono (Google Fonts CDN)

**Spec:** `docs/superpowers/specs/2026-04-05-ops-console-design.md`

---

### File Structure

| File | Purpose |
|------|---------|
| `src/monitoring/dashboard-data.ts` | **Create** — `getDashboardData()` gathers all dashboard state from DB + runtime |
| `src/monitoring/cron-schedule.ts` | **Create** — Static cron map + `getNextCronOccurrences()` helper |
| `src/monitoring/status-page.ts` | **Rewrite** — New `buildConsolePage()` HTML builder |
| `src/monitoring/server.ts` | **Modify** — Add `/api/dashboard` route |
| `tests/monitoring/dashboard-data.test.ts` | **Create** — Tests for data gathering |
| `tests/monitoring/cron-schedule.test.ts` | **Create** — Tests for cron next-run computation |

---

### Task 1: Install `cron-parser` and create cron schedule module

**Files:**
- Create: `src/monitoring/cron-schedule.ts`
- Test: `tests/monitoring/cron-schedule.test.ts`

- [ ] **Step 1: Install cron-parser**

```bash
bun add cron-parser
```

- [ ] **Step 2: Write the failing test**

Create `tests/monitoring/cron-schedule.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { CRON_SCHEDULE, getNextCronOccurrences } from "../../src/monitoring/cron-schedule.ts";

describe("cron-schedule", () => {
	test("CRON_SCHEDULE contains all 17 jobs", () => {
		expect(Object.keys(CRON_SCHEDULE).length).toBe(17);
	});

	test("CRON_SCHEDULE has required fields", () => {
		for (const [name, entry] of Object.entries(CRON_SCHEDULE)) {
			expect(entry.cron).toBeDefined();
			expect(typeof entry.cron).toBe("string");
			expect(name.length).toBeGreaterThan(0);
		}
	});

	test("getNextCronOccurrences returns sorted results", () => {
		const results = getNextCronOccurrences();
		expect(results.length).toBe(17);

		// Should be sorted by nextRun ascending
		for (let i = 1; i < results.length; i++) {
			expect(new Date(results[i]!.nextRun).getTime()).toBeGreaterThanOrEqual(
				new Date(results[i - 1]!.nextRun).getTime(),
			);
		}
	});

	test("each result has name, nextRun, and nextRunIn", () => {
		const results = getNextCronOccurrences();
		for (const r of results) {
			expect(r.name).toBeDefined();
			expect(r.nextRun).toBeDefined();
			expect(r.nextRunIn).toBeDefined();
			// nextRunIn should be a human-readable string like "2h 15m"
			expect(r.nextRunIn).toMatch(/\d+[hm]/);
		}
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test tests/monitoring/cron-schedule.test.ts --preload ./tests/preload.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement cron schedule module**

Create `src/monitoring/cron-schedule.ts`:

```typescript
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
	quote_refresh: { cron: "*/10 8-20 * * 1-5" },
	heartbeat: { cron: "0 7 * * 1-5" },
	strategy_evaluation: { cron: "5,15,25,35,45,55 8-20 * * 1-5" },
	daily_summary: { cron: "5 21 * * 1-5" },
	strategy_evolution: { cron: "0 18 * * 0" },
	trade_review: { cron: "15 21 * * 1-5" },
	pattern_analysis: { cron: "30 21 * * 2,5" },
	weekly_digest: { cron: "30 17 * * 0" },
	news_poll: { cron: "2,12,22,32,42,52 8-20 * * 1-5" },
	earnings_calendar_sync: { cron: "0 6 * * 1-5" },
	self_improvement: { cron: "0 19 * * 0" },
	guardian_start: { cron: "0 8 * * 1-5" },
	guardian_stop: { cron: "0 21 * * 1-5" },
	live_evaluation: { cron: "7,17,27,37,47,57 8-20 * * 1-5" },
	risk_guardian: { cron: "4,14,24,34,44,54 8-20 * * 1-5" },
	risk_daily_reset: { cron: "55 7 * * 1-5" },
	risk_weekly_reset: { cron: "50 7 * * 1" },
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
		const interval = CronExpressionParser.parseExpression(entry.cron, {
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

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test tests/monitoring/cron-schedule.test.ts --preload ./tests/preload.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/monitoring/cron-schedule.ts tests/monitoring/cron-schedule.test.ts package.json bun.lockb
git commit -m "feat(monitoring): add cron schedule module with next-run computation"
```

---

### Task 2: Create dashboard data module

**Files:**
- Create: `src/monitoring/dashboard-data.ts`
- Test: `tests/monitoring/dashboard-data.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/monitoring/dashboard-data.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { getDashboardData, type DashboardData } from "../../src/monitoring/dashboard-data.ts";
import { getDb } from "../../src/db/client.ts";
import { strategies, strategyMetrics, livePositions, liveTrades, agentLogs, riskState } from "../../src/db/schema.ts";

describe("getDashboardData", () => {
	beforeEach(async () => {
		const db = getDb();
		// Clean tables for isolation
		db.delete(strategies).run();
		db.delete(livePositions).run();
		db.delete(liveTrades).run();
		db.delete(agentLogs).run();
		db.delete(riskState).run();
		db.delete(strategyMetrics).run();
	});

	test("returns valid DashboardData shape with empty tables", async () => {
		const data = await getDashboardData();

		expect(data.status).toBeDefined();
		expect(data.uptime).toBeGreaterThan(0);
		expect(data.timestamp).toBeDefined();
		expect(typeof data.paused).toBe("boolean");
		expect(typeof data.ibkrConnected).toBe("boolean");
		expect(Array.isArray(data.strategies)).toBe(true);
		expect(Array.isArray(data.positions)).toBe(true);
		expect(Array.isArray(data.cronJobs)).toBe(true);
		expect(Array.isArray(data.recentLogs)).toBe(true);
		expect(typeof data.gitHash).toBe("string");
	});

	test("includes strategies with metrics", async () => {
		const db = getDb();
		const [s] = await db
			.insert(strategies)
			.values({
				name: "test_strat",
				description: "desc",
				parameters: "{}",
				signals: '{"entry_long":"price>0"}',
				universe: '["AAPL","MSFT"]',
				status: "paper",
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: s!.id,
			sampleSize: 10,
			winRate: 0.55,
			sharpeRatio: 1.2,
		});

		const data = await getDashboardData();
		expect(data.strategies.length).toBe(1);
		expect(data.strategies[0]!.name).toBe("test_strat");
		expect(data.strategies[0]!.winRate).toBe(0.55);
		expect(data.strategies[0]!.sharpeRatio).toBe(1.2);
		expect(data.strategies[0]!.universe).toEqual(["AAPL", "MSFT"]);
	});

	test("includes live positions", async () => {
		const db = getDb();
		await db.insert(livePositions).values({
			symbol: "HSBA",
			exchange: "LSE",
			quantity: -3909,
			avgCost: 13.91,
		});

		const data = await getDashboardData();
		expect(data.positions.length).toBe(1);
		expect(data.positions[0]!.symbol).toBe("HSBA");
		expect(data.positions[0]!.quantity).toBe(-3909);
	});

	test("counts trades today", async () => {
		const db = getDb();
		await db.insert(liveTrades).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			quantity: 10,
			orderType: "LIMIT",
			status: "FILLED",
		});

		const data = await getDashboardData();
		expect(data.tradesToday).toBe(1);
	});

	test("reads PnL from risk_state", async () => {
		const db = getDb();
		await db.insert(riskState).values({ key: "daily_pnl", value: "42.5" });
		await db.insert(riskState).values({ key: "weekly_pnl", value: "-10.0" });

		const data = await getDashboardData();
		expect(data.dailyPnl).toBe(42.5);
		expect(data.weeklyPnl).toBe(-10.0);
	});

	test("includes recent agent logs", async () => {
		const db = getDb();
		await db.insert(agentLogs).values({
			level: "WARN",
			phase: "reconciliation",
			message: "Orphaned position found",
		});

		const data = await getDashboardData();
		expect(data.recentLogs.length).toBe(1);
		expect(data.recentLogs[0]!.level).toBe("WARN");
		expect(data.recentLogs[0]!.message).toBe("Orphaned position found");
	});

	test("cronJobs has 17 entries sorted by nextRun", async () => {
		const data = await getDashboardData();
		expect(data.cronJobs.length).toBe(17);
		for (let i = 1; i < data.cronJobs.length; i++) {
			expect(new Date(data.cronJobs[i]!.nextRun).getTime()).toBeGreaterThanOrEqual(
				new Date(data.cronJobs[i - 1]!.nextRun).getTime(),
			);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test tests/monitoring/dashboard-data.test.ts --preload ./tests/preload.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement dashboard data module**

Create `src/monitoring/dashboard-data.ts`:

```typescript
import { desc, eq, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import {
	agentLogs,
	livePositions,
	liveTrades,
	quotesCache,
	riskState,
	strategies,
	strategyMetrics,
	paperTrades,
} from "../db/schema.ts";
import { getDailySpend } from "../utils/budget.ts";
import { isPaused } from "./health.ts";
import { getNextCronOccurrences } from "./cron-schedule.ts";

export interface DashboardData {
	status: "ok" | "degraded" | "error";
	uptime: number;
	timestamp: string;
	paused: boolean;
	ibkrConnected: boolean;
	ibkrAccount: string | null;

	dailyPnl: number;
	weeklyPnl: number;
	dailyPnlLimit: number;
	weeklyPnlLimit: number;
	openPositionCount: number;
	tradesToday: number;
	apiSpendToday: number;
	apiBudget: number;
	lastQuoteTime: string | null;

	strategies: Array<{
		id: number;
		name: string;
		status: string;
		winRate: number | null;
		sharpeRatio: number | null;
		tradeCount: number;
		universe: string[];
	}>;

	positions: Array<{
		symbol: string;
		exchange: string;
		quantity: number;
		avgCost: number;
		unrealizedPnl: number | null;
		strategyId: number | null;
	}>;

	cronJobs: Array<{
		name: string;
		nextRun: string;
		nextRunIn: string;
		lastStatus: "ok" | "error" | "never";
	}>;

	recentLogs: Array<{
		time: string;
		level: string;
		phase: string | null;
		message: string;
	}>;

	gitHash: string;
}

/** Cached at boot — doesn't change during runtime. */
let _gitHash: string | null = null;

function getGitHash(): string {
	if (_gitHash) return _gitHash;
	try {
		const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"]);
		_gitHash = result.stdout.toString().trim() || "unknown";
	} catch {
		_gitHash = "unknown";
	}
	return _gitHash;
}

/** Cached IBKR account ID — fetched once. */
let _ibkrAccount: string | null = null;
let _ibkrAccountFetched = false;

async function getIbkrAccount(): Promise<string | null> {
	if (_ibkrAccountFetched) return _ibkrAccount;
	try {
		const { getAccountSummary } = await import("../broker/account.ts");
		const summary = await getAccountSummary();
		_ibkrAccount = summary.accountId;
	} catch {
		_ibkrAccount = null;
	}
	_ibkrAccountFetched = true;
	return _ibkrAccount;
}

export async function getDashboardData(): Promise<DashboardData> {
	const db = getDb();

	// IBKR connection
	let ibkrConnected = false;
	try {
		const { isConnected } = await import("../broker/connection.ts");
		const { getConfig } = await import("../config.ts");
		if (getConfig().LIVE_TRADING_ENABLED) {
			ibkrConnected = isConnected();
		}
	} catch {
		// Broker module not loaded
	}

	// P&L from risk_state
	const dailyRow = db.select().from(riskState).where(eq(riskState.key, "daily_pnl")).get();
	const weeklyRow = db.select().from(riskState).where(eq(riskState.key, "weekly_pnl")).get();
	const dailyPnl = dailyRow ? Number.parseFloat(dailyRow.value) || 0 : 0;
	const weeklyPnl = weeklyRow ? Number.parseFloat(weeklyRow.value) || 0 : 0;

	// Risk limits from constants
	const { DAILY_LOSS_HALT_PCT, WEEKLY_DRAWDOWN_LIMIT_PCT, MAX_CONCURRENT_POSITIONS } =
		await import("../risk/constants.ts");

	// Positions
	const positions = db.select().from(livePositions).all();

	// Trades today
	const today = new Date().toISOString().split("T")[0]!;
	const tradesTodayResult = db
		.select({ count: sql<number>`count(*)` })
		.from(liveTrades)
		.where(sql`date(${liveTrades.createdAt}) = ${today}`)
		.get();
	const tradesToday = tradesTodayResult?.count ?? 0;

	// API spend
	const apiSpendToday = await getDailySpend();
	let apiBudget = 0;
	try {
		const { getConfig } = await import("../config.ts");
		apiBudget = getConfig().DAILY_API_BUDGET_USD;
	} catch {
		// Config not available
	}

	// Last quote
	const lastQuote = db
		.select({ updatedAt: quotesCache.updatedAt })
		.from(quotesCache)
		.orderBy(desc(quotesCache.updatedAt))
		.limit(1)
		.get();

	// Strategies with metrics
	const allStrategies = db
		.select({
			id: strategies.id,
			name: strategies.name,
			status: strategies.status,
			universe: strategies.universe,
			winRate: strategyMetrics.winRate,
			sharpeRatio: strategyMetrics.sharpeRatio,
		})
		.from(strategies)
		.leftJoin(strategyMetrics, eq(strategies.id, strategyMetrics.strategyId))
		.where(ne(strategies.status, "retired"))
		.all();

	// Trade counts per strategy
	const tradeCounts = db
		.select({
			strategyId: paperTrades.strategyId,
			count: sql<number>`count(*)`,
		})
		.from(paperTrades)
		.groupBy(paperTrades.strategyId)
		.all();
	const tradeCountMap = new Map(tradeCounts.map((t) => [t.strategyId, t.count]));

	const tierOrder: Record<string, number> = { core: 0, active: 1, probation: 2, paper: 3 };
	const strategyData = allStrategies
		.map((s) => ({
			id: s.id,
			name: s.name,
			status: s.status,
			winRate: s.winRate,
			sharpeRatio: s.sharpeRatio,
			tradeCount: tradeCountMap.get(s.id) ?? 0,
			universe: JSON.parse(s.universe ?? "[]") as string[],
		}))
		.sort((a, b) => (tierOrder[a.status] ?? 99) - (tierOrder[b.status] ?? 99));

	// Cron schedule with last run status
	const cronOccurrences = getNextCronOccurrences();
	const cronJobs = cronOccurrences.map((occ) => {
		const lastLog = db
			.select({ level: agentLogs.level })
			.from(agentLogs)
			.where(eq(agentLogs.phase, occ.name))
			.orderBy(desc(agentLogs.createdAt))
			.limit(1)
			.get();

		let lastStatus: "ok" | "error" | "never" = "never";
		if (lastLog) {
			lastStatus = lastLog.level === "ERROR" ? "error" : "ok";
		}

		return { ...occ, lastStatus };
	});

	// Recent logs
	const logs = db
		.select({
			createdAt: agentLogs.createdAt,
			level: agentLogs.level,
			phase: agentLogs.phase,
			message: agentLogs.message,
		})
		.from(agentLogs)
		.orderBy(desc(agentLogs.createdAt))
		.limit(20)
		.all();

	const recentLogs = logs.map((l) => ({
		time: new Date(l.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		level: l.level,
		phase: l.phase,
		message: l.message,
	}));

	// Status determination
	let status: "ok" | "degraded" | "error" = "ok";
	if (isPaused()) {
		status = "degraded";
	} else if (lastQuote?.updatedAt) {
		const lastQuoteAge = Date.now() - new Date(lastQuote.updatedAt).getTime();
		const hour = new Date().getUTCHours();
		if (lastQuoteAge > 3_600_000 && hour >= 8 && hour <= 21) {
			status = "degraded";
		}
	}

	const ibkrAccount = await getIbkrAccount();

	return {
		status,
		uptime: process.uptime(),
		timestamp: new Date().toISOString(),
		paused: isPaused(),
		ibkrConnected,
		ibkrAccount: ibkrConnected ? ibkrAccount : null,
		dailyPnl,
		weeklyPnl,
		dailyPnlLimit: DAILY_LOSS_HALT_PCT * 100,
		weeklyPnlLimit: WEEKLY_DRAWDOWN_LIMIT_PCT * 100,
		openPositionCount: positions.length,
		tradesToday,
		apiSpendToday,
		apiBudget,
		lastQuoteTime: lastQuote?.updatedAt ?? null,
		strategies: strategyData,
		positions: positions.map((p) => ({
			symbol: p.symbol,
			exchange: p.exchange,
			quantity: p.quantity,
			avgCost: p.avgCost,
			unrealizedPnl: p.unrealizedPnl,
			strategyId: p.strategyId,
		})),
		cronJobs,
		recentLogs,
		gitHash: getGitHash(),
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test tests/monitoring/dashboard-data.test.ts --preload ./tests/preload.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitoring/dashboard-data.ts tests/monitoring/dashboard-data.test.ts
git commit -m "feat(monitoring): add dashboard data gathering module"
```

---

### Task 3: Rewrite status page HTML builder

**Files:**
- Rewrite: `src/monitoring/status-page.ts`

- [ ] **Step 1: Rewrite `status-page.ts` with terminal console HTML**

Replace the entire contents of `src/monitoring/status-page.ts` with the new console builder. This is a large file — the HTML template with embedded CSS. Use the `DashboardData` interface from `dashboard-data.ts`.

The function signature changes from `buildStatusPageHtml(data: HealthData)` to `buildConsolePage(data: DashboardData)`.

Create `src/monitoring/status-page.ts`:

```typescript
import type { DashboardData } from "./dashboard-data.ts";

function formatUptime(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

function escHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function kpiColor(value: number, limit: number, invert = false): string {
	if (value === 0) return "#666";
	if (invert) {
		const pct = Math.abs(value) / limit;
		if (pct >= 0.8) return "#ef4444";
		if (pct >= 0.5) return "#f59e0b";
		return "#22c55e";
	}
	return value >= 0 ? "#22c55e" : "#ef4444";
}

function riskBarPct(value: number, max: number): number {
	if (max === 0) return 0;
	return Math.min(100, Math.max(0, (Math.abs(value) / max) * 100));
}

function riskBarColor(pct: number): string {
	if (pct >= 80) return "#ef4444";
	if (pct >= 50) return "#f59e0b";
	return "#22c55e";
}

function statusDot(connected: boolean): string {
	const color = connected ? "#22c55e" : "#ef4444";
	return `<span style="width:7px;height:7px;border-radius:50%;display:inline-block;background:${color};box-shadow:0 0 6px ${color}88;"></span>`;
}

export function buildConsolePage(data: DashboardData): string {
	const utcTime = new Date(data.timestamp).toLocaleString("en-GB", {
		day: "2-digit",
		month: "short",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "UTC",
	});

	// Strategy tier counts
	const tierCounts: Record<string, number> = { paper: 0, probation: 0, active: 0, core: 0, retired: 0 };
	for (const s of data.strategies) {
		tierCounts[s.status] = (tierCounts[s.status] ?? 0) + 1;
	}
	const liveCount = tierCounts.probation + tierCounts.active + tierCounts.core;

	// KPIs
	const lastQuoteDisplay = data.lastQuoteTime
		? new Date(data.lastQuoteTime).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"
		: "—";
	const lastQuoteSub = (() => {
		if (!data.lastQuoteTime) return "no data";
		const age = Date.now() - new Date(data.lastQuoteTime).getTime();
		if (age > 3_600_000) return "stale";
		return "live";
	})();

	// Pause button
	const pauseBtn = data.paused
		? `<form method="POST" action="/resume" style="display:inline"><button type="submit" class="pause-btn" style="border-color:#22c55e;color:#22c55e;">▶ RESUME</button></form>`
		: `<form method="POST" action="/pause" style="display:inline"><button type="submit" class="pause-btn">⏸ PAUSE</button></form>`;

	// Positions HTML
	const positionsHtml = data.positions.length === 0
		? `<div style="color:#333;padding:8px 0;">No positions</div>`
		: data.positions
				.map((p) => {
					const isShort = p.quantity < 0;
					const sideClass = isShort ? "short" : "long";
					const sideLabel = isShort ? "SHORT" : "LONG";
					const pnlStr = p.unrealizedPnl != null ? `${p.unrealizedPnl >= 0 ? "+" : ""}${p.unrealizedPnl.toFixed(2)}` : "—";
					const orphanTag = p.strategyId == null ? `<span class="orphan-tag">orphan</span>` : "";
					return `<div class="position-row">
						<span class="symbol">${escHtml(p.symbol)}:${escHtml(p.exchange)}</span>
						<span class="${sideClass}">${sideLabel}</span>
						<span>${Math.abs(p.quantity).toLocaleString()}</span>
						<span>${p.avgCost.toFixed(2)}p</span>
						<span style="color:${p.unrealizedPnl != null && p.unrealizedPnl >= 0 ? "#22c55e" : "#ef4444"}">${pnlStr}</span>
						<span>${orphanTag}</span>
					</div>`;
				})
				.join("\n");

	// Strategy rows
	const strategyRows = data.strategies
		.map((s) => {
			const statusClass = `status-${s.status}`;
			const winRate = s.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : "—";
			const sharpe = s.sharpeRatio != null ? s.sharpeRatio.toFixed(2) : "—";
			const universe = s.universe.slice(0, 3).join(", ") + (s.universe.length > 3 ? "…" : "");
			return `<div class="strategy-row">
				<span class="name">${escHtml(s.name)}</span>
				<span class="${statusClass}">${s.status}</span>
				<span>${winRate}</span>
				<span>${sharpe}</span>
				<span>${s.tradeCount}</span>
				<span>${escHtml(universe)}</span>
			</div>`;
		})
		.join("\n");

	// Cron rows
	const cronRows = data.cronJobs
		.map((j, i) => {
			const isUpcoming = i < 3;
			const rowClass = isUpcoming ? "cron-row upcoming" : "cron-row";
			const nextTime = new Date(j.nextRun).toLocaleTimeString("en-GB", {
				hour: "2-digit",
				minute: "2-digit",
				timeZone: "Europe/London",
			});
			const lastHtml =
				j.lastStatus === "ok"
					? `<span class="last-ok">✓ ok</span>`
					: j.lastStatus === "error"
						? `<span class="last-err">✗ err</span>`
						: `<span style="color:#333;">—</span>`;
			return `<div class="${rowClass}">
				<span class="time">${nextTime}</span>
				<span class="job">${escHtml(j.name)}</span>
				<span>${lastHtml}</span>
				<span class="countdown">${j.nextRunIn}</span>
			</div>`;
		})
		.join("\n");

	// Log entries
	const logEntries = data.recentLogs.length === 0
		? `<div style="color:#333;padding:8px 0;">No activity logged</div>`
		: data.recentLogs
				.map((l) => {
					const levelClass = `level-${l.level.toLowerCase()}`;
					const levelLabel = l.level === "ACTION" ? "ACTN" : l.level === "DECISION" ? "DCSN" : l.level;
					return `<div class="log-entry">
						<span class="ts">${l.time}</span>
						<span class="${levelClass}">${levelLabel}</span>
						<span class="phase">${escHtml(l.phase ?? "")}</span>
						<span class="msg">${escHtml(l.message.substring(0, 120))}</span>
					</div>`;
				})
				.join("\n");

	// Risk bars
	const dailyPct = riskBarPct(data.dailyPnl, data.dailyPnlLimit);
	const weeklyPct = riskBarPct(data.weeklyPnl, data.weeklyPnlLimit);
	const posPct = riskBarPct(data.openPositionCount, 3); // MAX_CONCURRENT_POSITIONS

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="refresh" content="30" />
<title>Trader v2 — Console</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'JetBrains Mono','Courier New',monospace;background:#050505;color:#b0b0b0;min-height:100vh;font-size:12px;line-height:1.5}
.status-bar{display:flex;justify-content:space-between;align-items:center;padding:8px 16px;background:#0a0a0a;border-bottom:1px solid #1a1a1a}
.status-bar .left{display:flex;align-items:center;gap:16px}
.status-bar .title{color:#f59e0b;font-weight:700;font-size:13px;letter-spacing:2px}
.status-tag{display:inline-flex;align-items:center;gap:5px;color:#888;font-size:11px}
.meta{color:#555;font-size:11px}
.console{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1px;background:#1a1a1a;min-height:calc(100vh - 37px)}
.panel{background:#0a0a0a;padding:12px 14px}
.panel-header{color:#555;font-size:10px;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center}
.panel-header .count{color:#444}
.kpi-strip{grid-column:1/-1;display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:#1a1a1a}
.kpi{background:#0a0a0a;padding:10px 14px}
.kpi-label{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.kpi-value{font-size:16px;font-weight:600}
.kpi-sub{color:#333;font-size:9px;margin-top:2px}
.pipeline{grid-column:1/-1;background:#0a0a0a;padding:12px 14px}
.pipeline-row{display:flex;align-items:center;gap:6px;margin-top:8px;flex-wrap:wrap}
.tier{display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid #1a1a1a;border-radius:3px;min-width:110px}
.tier .tc{font-size:14px;font-weight:700}
.tier .tl{font-size:10px;color:#555;text-transform:uppercase}
.tier.paper{border-color:#334155}.tier.paper .tc{color:#94a3b8}
.tier.probation{border-color:#92400e}.tier.probation .tc{color:#f59e0b}
.tier.active{border-color:#166534}.tier.active .tc{color:#22c55e}
.tier.core{border-color:#14532d}.tier.core .tc{color:#15803d}
.tier.retired{border-color:#1a1a1a}.tier.retired .tc{color:#333}
.arrow{color:#333;font-size:16px}
.strategy-list{margin-top:10px;border-top:1px solid #151515;padding-top:8px}
.strategy-row{display:grid;grid-template-columns:200px 80px 70px 70px 60px 1fr;gap:12px;padding:4px 0;color:#666;font-size:11px}
.strategy-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.strategy-row .name{color:#94a3b8}
.status-paper{color:#64748b}.status-probation{color:#f59e0b}.status-active{color:#22c55e}.status-core{color:#15803d}
.position-row{display:grid;grid-template-columns:100px 55px 65px 65px 65px 1fr;gap:8px;padding:4px 0;font-size:11px;color:#666}
.position-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.position-row .symbol{color:#e2e8f0;font-weight:500}
.short{color:#ef4444}.long{color:#22c55e}
.orphan-tag{color:#f59e0b;font-size:9px;background:#f59e0b11;padding:1px 5px;border-radius:2px}
.risk-meter{margin:6px 0}
.risk-bar{height:4px;background:#1a1a1a;border-radius:2px;overflow:hidden;margin-top:4px}
.risk-fill{height:100%;border-radius:2px}
.risk-label{display:flex;justify-content:space-between;font-size:10px;color:#555}
.cron-row{display:grid;grid-template-columns:50px 170px 55px 1fr;gap:8px;padding:4px 0;font-size:11px;color:#555}
.cron-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.cron-row .time{color:#94a3b8}.cron-row .job{color:#888}
.cron-row .countdown{color:#333;font-size:10px}
.cron-row.upcoming{color:#888}.cron-row.upcoming .time{color:#f59e0b}
.last-ok{color:#22c55e44}.last-err{color:#ef4444}
.log-entry{padding:3px 0;font-size:11px;color:#555;display:flex;gap:8px}
.log-entry .ts{color:#333;min-width:45px}
.log-entry .phase{color:#444;min-width:50px}
.log-entry .msg{color:#777}
.level-info{color:#3b82f6}.level-warn{color:#f59e0b}.level-error{color:#ef4444}.level-action{color:#22c55e}.level-decision{color:#a855f7}
.scroll-panel{max-height:300px;overflow-y:auto}
.scroll-panel::-webkit-scrollbar{width:3px}.scroll-panel::-webkit-scrollbar-track{background:transparent}.scroll-panel::-webkit-scrollbar-thumb{background:#222;border-radius:2px}
.pause-btn{margin-top:12px;padding:6px 14px;background:transparent;border:1px solid #333;color:#888;font-family:inherit;font-size:11px;cursor:pointer;border-radius:3px}
.pause-btn:hover{border-color:#f59e0b;color:#f59e0b}
.footer-bar{grid-column:1/-1;background:#0a0a0a;padding:6px 14px;color:#333;font-size:10px;display:flex;justify-content:space-between;border-top:1px solid #1a1a1a}
</style>
</head>
<body>
<div class="status-bar">
<div class="left">
<span class="title">TRADER V2</span>
<span class="status-tag">${statusDot(data.ibkrConnected)} ${data.ibkrConnected ? `IBKR ${escHtml(data.ibkrAccount ?? "")}` : "IBKR OFF"}</span>
<span class="status-tag">${statusDot(data.status === "ok")} ${data.status.toUpperCase()}</span>
<span class="status-tag">${statusDot(liveCount > 0)} ${liveCount} LIVE</span>
${data.paused ? `<span class="status-tag" style="color:#f59e0b;">⏸ PAUSED</span>` : ""}
</div>
<div class="meta">UP ${formatUptime(data.uptime)} &middot; ${utcTime} UTC</div>
</div>

<div class="console">
<div class="kpi-strip">
<div class="kpi"><div class="kpi-label">Daily P&amp;L</div><div class="kpi-value" style="color:${kpiColor(data.dailyPnl, data.dailyPnlLimit)}">${data.dailyPnl >= 0 ? "+" : ""}${data.dailyPnl.toFixed(2)}p</div><div class="kpi-sub">limit: ${data.dailyPnlLimit.toFixed(0)}%</div></div>
<div class="kpi"><div class="kpi-label">Weekly P&amp;L</div><div class="kpi-value" style="color:${kpiColor(data.weeklyPnl, data.weeklyPnlLimit)}">${data.weeklyPnl >= 0 ? "+" : ""}${data.weeklyPnl.toFixed(2)}p</div><div class="kpi-sub">limit: ${data.weeklyPnlLimit.toFixed(0)}%</div></div>
<div class="kpi"><div class="kpi-label">Open Positions</div><div class="kpi-value" style="color:${data.openPositionCount > 0 ? "#f59e0b" : "#666"}">${data.openPositionCount}</div><div class="kpi-sub">${data.positions[0] ? escHtml(data.positions[0].symbol) : "—"}</div></div>
<div class="kpi"><div class="kpi-label">Trades Today</div><div class="kpi-value" style="color:${data.tradesToday > 0 ? "#e2e8f0" : "#666"}">${data.tradesToday}</div><div class="kpi-sub">—</div></div>
<div class="kpi"><div class="kpi-label">API Spend</div><div class="kpi-value" style="color:${data.apiSpendToday > data.apiBudget * 0.8 ? "#ef4444" : "#666"}">$${data.apiSpendToday.toFixed(2)}</div><div class="kpi-sub">budget: $${data.apiBudget.toFixed(2)}</div></div>
<div class="kpi"><div class="kpi-label">Last Quote</div><div class="kpi-value" style="color:#666;font-size:12px">${lastQuoteDisplay}</div><div class="kpi-sub">${lastQuoteSub}</div></div>
</div>

<div class="pipeline">
<div class="panel-header">Strategy Pipeline<span class="count">${data.strategies.length} total</span></div>
<div class="pipeline-row">
<div class="tier paper"><span class="tc">${tierCounts.paper}</span><span class="tl">Paper</span></div>
<span class="arrow">→</span>
<div class="tier probation"><span class="tc">${tierCounts.probation}</span><span class="tl">Probation</span></div>
<span class="arrow">→</span>
<div class="tier active"><span class="tc">${tierCounts.active}</span><span class="tl">Active</span></div>
<span class="arrow">→</span>
<div class="tier core"><span class="tc">${tierCounts.core}</span><span class="tl">Core</span></div>
<span style="flex:1"></span>
<div class="tier retired"><span class="tc">${tierCounts.retired}</span><span class="tl">Retired</span></div>
</div>
<div class="strategy-list">
<div class="strategy-row header"><span>Name</span><span>Status</span><span>Win Rate</span><span>Sharpe</span><span>Trades</span><span>Universe</span></div>
${strategyRows}
</div>
</div>

<div class="panel">
<div class="panel-header">Live Positions<span class="count">${data.openPositionCount}</span></div>
<div class="scroll-panel">
<div class="position-row header"><span>Symbol</span><span>Side</span><span>Qty</span><span>Avg</span><span>P&amp;L</span><span></span></div>
${positionsHtml}
</div>
<div style="border-top:1px solid #151515;margin-top:12px;padding-top:10px;">
<div class="panel-header" style="margin-bottom:8px;">Risk Limits</div>
<div class="risk-meter"><div class="risk-label"><span>Daily P&amp;L</span><span>${data.dailyPnl.toFixed(1)} / ${data.dailyPnlLimit.toFixed(0)}%</span></div><div class="risk-bar"><div class="risk-fill" style="width:${dailyPct}%;background:${riskBarColor(dailyPct)}"></div></div></div>
<div class="risk-meter"><div class="risk-label"><span>Weekly P&amp;L</span><span>${data.weeklyPnl.toFixed(1)} / ${data.weeklyPnlLimit.toFixed(0)}%</span></div><div class="risk-bar"><div class="risk-fill" style="width:${weeklyPct}%;background:${riskBarColor(weeklyPct)}"></div></div></div>
<div class="risk-meter"><div class="risk-label"><span>Max Positions</span><span>${data.openPositionCount} / 3</span></div><div class="risk-bar"><div class="risk-fill" style="width:${posPct}%;background:${riskBarColor(posPct)}"></div></div></div>
</div>
${pauseBtn}
</div>

<div class="panel">
<div class="panel-header">Cron Schedule<span class="count">${data.cronJobs.length} jobs</span></div>
<div class="scroll-panel">
<div class="cron-row header"><span>Time</span><span>Job</span><span>Last</span><span>Next In</span></div>
${cronRows}
</div>
</div>

<div class="panel">
<div class="panel-header">Activity Log<span class="count">recent</span></div>
<div class="scroll-panel">
${logEntries}
</div>
</div>

<div class="footer-bar">
<span>Auto-refreshes every 30s &middot; All times Europe/London</span>
<span>trader-v2 @ ${escHtml(data.gitHash)}</span>
</div>
</div>
</body>
</html>`;
}
```

- [ ] **Step 2: Run typecheck to verify no errors**

```bash
bunx tsc --noEmit
```

Expected: PASS (no type errors)

- [ ] **Step 3: Commit**

```bash
git add src/monitoring/status-page.ts
git commit -m "feat(monitoring): rewrite status page as terminal ops console"
```

---

### Task 4: Wire up server routes

**Files:**
- Modify: `src/monitoring/server.ts`

- [ ] **Step 1: Update server.ts to use new dashboard data and console page**

Replace the status page handler and add the `/api/dashboard` route in `src/monitoring/server.ts`.

Replace the import at the top:

```typescript
import { getHealthData, setPaused } from "./health";
import { buildStatusPageHtml } from "./status-page";
```

With:

```typescript
import { getHealthData, setPaused } from "./health";
import { buildConsolePage } from "./status-page";
import { getDashboardData } from "./dashboard-data";
```

Replace the `GET /` handler block:

```typescript
	// Status page
	if (req.method === "GET" && url.pathname === "/") {
		try {
			const data = await getHealthData();
			const html = buildStatusPageHtml(data);
			return new Response(html, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		} catch (err) {
			log.error({ err }, "Status page failed");
			return new Response("Internal Server Error", { status: 500 });
		}
	}
```

With:

```typescript
	// Dashboard console
	if (req.method === "GET" && url.pathname === "/") {
		try {
			const data = await getDashboardData();
			const html = buildConsolePage(data);
			return new Response(html, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		} catch (err) {
			log.error({ err }, "Dashboard page failed");
			return new Response("Internal Server Error", { status: 500 });
		}
	}

	// Dashboard API (JSON)
	if (req.method === "GET" && url.pathname === "/api/dashboard") {
		try {
			const data = await getDashboardData();
			return Response.json(data);
		} catch (err) {
			log.error({ err }, "Dashboard API failed");
			return Response.json({ error: "internal" }, { status: 500 });
		}
	}
```

- [ ] **Step 2: Run typecheck**

```bash
bunx tsc --noEmit
```

Expected: PASS

- [ ] **Step 3: Run all tests to verify nothing broke**

```bash
bun test --preload ./tests/preload.ts
```

Expected: All tests PASS.

- [ ] **Step 4: Run biome check**

```bash
bunx biome check --write src/monitoring/status-page.ts src/monitoring/server.ts src/monitoring/dashboard-data.ts src/monitoring/cron-schedule.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/monitoring/server.ts
git commit -m "feat(monitoring): wire dashboard console and /api/dashboard endpoint"
```

---

### Task 5: Deploy and verify

- [ ] **Step 1: Push to remote**

```bash
git push
```

- [ ] **Step 2: Monitor CI**

Wait for GitHub Actions to pass (lint → typecheck → test → deploy).

- [ ] **Step 3: Verify on VPS**

After deploy, check the dashboard loads:

```bash
./scripts/vps-ssh.sh "curl -s -u admin:\$(grep ADMIN_PASSWORD /opt/trader-v2/.env | cut -d= -f2) http://localhost:3847/ 2>&1 | head -5"
```

Expected: HTML starting with `<!DOCTYPE html>` containing "TRADER V2".

Verify the JSON API:

```bash
./scripts/vps-ssh.sh "curl -s -u admin:\$(grep ADMIN_PASSWORD /opt/trader-v2/.env | cut -d= -f2) http://localhost:3847/api/dashboard 2>&1 | head -3"
```

Expected: JSON with `strategies`, `positions`, `cronJobs`, `recentLogs` fields.

- [ ] **Step 4: Commit any fixes if needed, push again**
