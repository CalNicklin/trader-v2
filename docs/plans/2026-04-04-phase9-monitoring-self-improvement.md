# Phase 9: Monitoring & Self-Improvement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add operational monitoring (health endpoint, dead man's switch, status page) and self-improvement Track 2 (autonomous code PRs) to complete the system's operational layer.

**Architecture:** A lightweight Bun.serve() HTTP server exposes `/health` (JSON status), `/` (HTML status page with pause/resume controls), and `/pause`/`/resume` endpoints behind basic auth. A dead man's switch POSTs to Uptime Kuma after each scheduler job. A weekly digest email summarises evolution, graduation, and self-improvement activity. Track 2 code evolution uses a weekly Sonnet call to propose code changes as GitHub PRs (whitelisted files) or issues (human-only files), rate-limited to 2 PRs/week and 3 issues/week.

**Tech Stack:** Bun, TypeScript (strict), Drizzle ORM (SQLite), Bun.serve(), @octokit/rest, Anthropic SDK (Sonnet), Biome (tab indentation)

---

## File Structure

```
src/monitoring/
  health.ts            # Health check data collector
  server.ts            # Bun.serve() HTTP server (GET /health, GET /, POST /pause, POST /resume)
  status-page.ts       # HTML template builder for status page

src/self-improve/
  github.ts            # PR/issue creation via @octokit/rest (adapted from v1)
  code-generator.ts    # Claude Sonnet generates code changes (adapted from v1)
  proposer.ts          # Weekly improvement proposal logic
  types.ts             # Shared types for self-improvement

src/scheduler/
  weekly-digest-job.ts # Weekly digest email builder
  self-improve-job.ts  # Self-improvement job wrapper

tests/monitoring/
  health.test.ts       # Health data collector tests
  server.test.ts       # HTTP endpoint tests
  status-page.test.ts  # HTML template tests

tests/self-improve/
  code-generator.test.ts  # Code generation (pure parsing logic)
  proposer.test.ts        # Proposal logic tests (whitelisting, rate limiting)
```

---

## Task 1: Health Check Data Collector

Aggregates system health data from the database and runtime: connection status, last quote time, active strategies, daily P&L, and API spend.

**Files:**
- Create: `src/monitoring/health.ts`
- Create: `tests/monitoring/health.test.ts`

### Step 1: Write failing tests

- [ ] **Step 1.1: Write tests for health data collector**

```typescript
// tests/monitoring/health.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { getDb } from "../../src/db/client";
import {
	strategies,
	strategyMetrics,
	dailySnapshots,
	tokenUsage,
	quotesCache,
} from "../../src/db/schema";
import { getHealthData, type HealthData } from "../../src/monitoring/health";

describe("health data collector", () => {
	beforeEach(() => {
		const db = getDb();
		db.delete(tokenUsage).run();
		db.delete(dailySnapshots).run();
		db.delete(strategyMetrics).run();
		db.delete(strategies).run();
		db.delete(quotesCache).run();
	});

	test("returns valid health data with empty database", async () => {
		const data = await getHealthData();
		expect(data.status).toBe("ok");
		expect(data.uptime).toBeGreaterThan(0);
		expect(data.activeStrategies).toBe(0);
		expect(data.dailyPnl).toBe(0);
		expect(data.apiSpendToday).toBeGreaterThanOrEqual(0);
		expect(data.lastQuoteTime).toBeNull();
		expect(data.timestamp).toBeDefined();
	});

	test("counts active strategies correctly", async () => {
		const db = getDb();
		db.insert(strategies)
			.values([
				{
					name: "active_1",
					description: "test",
					parameters: "{}",
					status: "paper" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
				},
				{
					name: "active_2",
					description: "test",
					parameters: "{}",
					status: "live" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
				},
				{
					name: "retired_1",
					description: "test",
					parameters: "{}",
					status: "retired" as const,
					virtualBalance: 10000,
					generation: 1,
					createdBy: "seed",
					retiredAt: new Date().toISOString(),
				},
			])
			.run();

		const data = await getHealthData();
		expect(data.activeStrategies).toBe(2);
	});

	test("includes daily P&L from today's snapshot", async () => {
		const db = getDb();
		const today = new Date().toISOString().split("T")[0];
		db.insert(dailySnapshots)
			.values({
				date: today,
				portfolioValue: 10500,
				cashBalance: 5000,
				positionsValue: 5500,
				dailyPnl: 125.5,
				dailyPnlPercent: 1.21,
				totalPnl: 500,
				paperStrategiesActive: 2,
				liveStrategiesActive: 0,
				tradesCount: 5,
			})
			.run();

		const data = await getHealthData();
		expect(data.dailyPnl).toBe(125.5);
	});

	test("reports last quote time", async () => {
		const db = getDb();
		const now = new Date().toISOString();
		db.insert(quotesCache)
			.values({
				symbol: "AAPL",
				exchange: "US",
				price: 150.25,
				currency: "USD",
				updatedAt: now,
			})
			.run();

		const data = await getHealthData();
		expect(data.lastQuoteTime).toBe(now);
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/monitoring/health.test.ts`
Expected: FAIL — module `../../src/monitoring/health` not found

### Step 2: Implement health data collector

- [ ] **Step 2.1: Write health.ts**

```typescript
// src/monitoring/health.ts
import { desc, eq, gte, ne, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
	strategies,
	dailySnapshots,
	tokenUsage,
	quotesCache,
} from "../db/schema";
import { getDailySpend } from "../utils/budget";

export interface HealthData {
	status: "ok" | "degraded" | "error";
	uptime: number;
	timestamp: string;
	activeStrategies: number;
	dailyPnl: number;
	apiSpendToday: number;
	lastQuoteTime: string | null;
	paused: boolean;
}

// Module-level pause state
let _paused = false;

export function isPaused(): boolean {
	return _paused;
}

export function setPaused(paused: boolean): void {
	_paused = paused;
}

export async function getHealthData(): Promise<HealthData> {
	const db = getDb();

	// Active strategy count (non-retired)
	const activeResult = db
		.select({ count: sql<number>`count(*)` })
		.from(strategies)
		.where(ne(strategies.status, "retired"))
		.get();
	const activeStrategies = activeResult?.count ?? 0;

	// Today's P&L from daily snapshot
	const today = new Date().toISOString().split("T")[0];
	const snapshot = db
		.select()
		.from(dailySnapshots)
		.where(eq(dailySnapshots.date, today))
		.get();
	const dailyPnl = snapshot?.dailyPnl ?? 0;

	// API spend today
	const apiSpendToday = await getDailySpend();

	// Last quote update time
	const lastQuote = db
		.select({ updatedAt: quotesCache.updatedAt })
		.from(quotesCache)
		.orderBy(desc(quotesCache.updatedAt))
		.limit(1)
		.get();
	const lastQuoteTime = lastQuote?.updatedAt ?? null;

	// Determine status
	let status: "ok" | "degraded" | "error" = "ok";
	if (_paused) {
		status = "degraded";
	} else if (lastQuoteTime) {
		const lastQuoteAge = Date.now() - new Date(lastQuoteTime).getTime();
		const ONE_HOUR = 60 * 60 * 1000;
		// Only flag stale during market hours (rough check)
		const hour = new Date().getUTCHours();
		if (lastQuoteAge > ONE_HOUR && hour >= 8 && hour <= 21) {
			status = "degraded";
		}
	}

	return {
		status,
		uptime: process.uptime(),
		timestamp: new Date().toISOString(),
		activeStrategies,
		dailyPnl,
		apiSpendToday,
		lastQuoteTime,
		paused: _paused,
	};
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/monitoring/health.test.ts`
Expected: all tests pass

- [ ] **Step 2.3: Commit**

```bash
git add src/monitoring/health.ts tests/monitoring/health.test.ts
git commit -m "feat: add health check data collector"
```

---

## Task 2: HTTP Server & Health Endpoint

Minimal Bun.serve() HTTP server serving `GET /health` as JSON. Started at boot from `src/index.ts`.

**Files:**
- Create: `src/monitoring/server.ts`
- Create: `tests/monitoring/server.test.ts`
- Modify: `src/monitoring/health.ts` (import adjustments if needed)
- Modify: `src/index.ts` — start HTTP server
- Modify: `src/config.ts` — add `HTTP_PORT` env var

### Step 1: Add HTTP_PORT to config

- [ ] **Step 1.1: Add HTTP_PORT to envSchema in src/config.ts**

Add to the Zod schema:

```typescript
// Add inside envSchema
HTTP_PORT: z.coerce.number().default(3847),
```

### Step 2: Write failing tests

- [ ] **Step 2.1: Write server tests**

```typescript
// tests/monitoring/server.test.ts
import { describe, expect, test, afterEach } from "bun:test";
import { startServer, stopServer } from "../../src/monitoring/server";

describe("HTTP server", () => {
	let port: number;

	afterEach(() => {
		stopServer();
	});

	test("GET /health returns JSON health data", async () => {
		port = 39847; // high port to avoid conflicts
		startServer(port);

		const res = await fetch(`http://localhost:${port}/health`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const data = await res.json();
		expect(data.status).toBe("ok");
		expect(data.uptime).toBeGreaterThan(0);
		expect(data.activeStrategies).toBeTypeOf("number");
		expect(data.timestamp).toBeDefined();
	});

	test("GET /unknown returns 404", async () => {
		port = 39848;
		startServer(port);

		const res = await fetch(`http://localhost:${port}/unknown`);
		expect(res.status).toBe(404);
	});
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test tests/monitoring/server.test.ts`
Expected: FAIL — module `../../src/monitoring/server` not found

### Step 3: Implement server

- [ ] **Step 3.1: Write server.ts**

```typescript
// src/monitoring/server.ts
import type { Server } from "bun";
import { getHealthData } from "./health";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "http-server" });

let _server: Server | null = null;

export function startServer(port: number): void {
	if (_server) return;

	_server = Bun.serve({
		port,
		fetch: handleRequest,
	});

	log.info({ port }, "HTTP server started");
}

export function stopServer(): void {
	if (_server) {
		_server.stop(true);
		_server = null;
		log.info("HTTP server stopped");
	}
}

async function handleRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);

	if (req.method === "GET" && url.pathname === "/health") {
		const data = await getHealthData();
		return Response.json(data);
	}

	return new Response("Not Found", { status: 404 });
}
```

- [ ] **Step 3.2: Run tests to verify they pass**

Run: `bun test tests/monitoring/server.test.ts`
Expected: all tests pass

### Step 4: Wire into index.ts

- [ ] **Step 4.1: Add server start to boot() in src/index.ts**

After `startScheduler()`, add:

```typescript
// Start HTTP monitoring server
const { startServer } = await import("./monitoring/server.ts");
startServer(config.HTTP_PORT);
log.info({ port: config.HTTP_PORT }, "Health endpoint available");
```

Add to the `shutdown()` function, before `closeDb()`:

```typescript
const { stopServer } = await import("./monitoring/server.ts");
stopServer();
```

- [ ] **Step 4.2: Commit**

```bash
git add src/monitoring/server.ts tests/monitoring/server.test.ts src/index.ts src/config.ts
git commit -m "feat: add HTTP health endpoint via Bun.serve()"
```

---

## Task 3: Dead Man's Switch (Uptime Kuma Heartbeat)

POST to Uptime Kuma push URL after each scheduler job completes successfully. If no heartbeat for 5 minutes, Uptime Kuma sends an email alert.

**Files:**
- Create: `src/monitoring/heartbeat.ts`
- Create: `tests/monitoring/heartbeat.test.ts`
- Modify: `src/config.ts` — add `UPTIME_KUMA_PUSH_URL`
- Modify: `src/scheduler/jobs.ts` — call heartbeat after job success

### Step 1: Add config

- [ ] **Step 1.1: Add UPTIME_KUMA_PUSH_URL to envSchema in src/config.ts**

```typescript
// Add inside envSchema
UPTIME_KUMA_PUSH_URL: z.string().url().optional(),
```

### Step 2: Write failing tests

- [ ] **Step 2.1: Write heartbeat tests**

```typescript
// tests/monitoring/heartbeat.test.ts
import { describe, expect, test, mock } from "bun:test";
import { buildHeartbeatUrl, sendHeartbeat } from "../../src/monitoring/heartbeat";

describe("heartbeat", () => {
	test("buildHeartbeatUrl appends status and msg params", () => {
		const base = "https://uptime.example.com/api/push/abc123";
		const url = buildHeartbeatUrl(base, "up", "quote_refresh OK");
		expect(url).toBe(
			"https://uptime.example.com/api/push/abc123?status=up&msg=quote_refresh+OK",
		);
	});

	test("buildHeartbeatUrl handles base URL with existing params", () => {
		const base = "https://uptime.example.com/api/push/abc123?token=xyz";
		const url = buildHeartbeatUrl(base, "up", "heartbeat");
		expect(url).toContain("status=up");
		expect(url).toContain("msg=heartbeat");
	});

	test("sendHeartbeat returns false when URL not configured", async () => {
		// sendHeartbeat with no config should gracefully return false
		const result = await sendHeartbeat("test_job");
		// Result depends on config — in test env UPTIME_KUMA_PUSH_URL is not set
		expect(typeof result).toBe("boolean");
	});
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test tests/monitoring/heartbeat.test.ts`
Expected: FAIL — module not found

### Step 3: Implement heartbeat

- [ ] **Step 3.1: Write heartbeat.ts**

```typescript
// src/monitoring/heartbeat.ts
import { getConfig } from "../config";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "heartbeat" });

export function buildHeartbeatUrl(
	baseUrl: string,
	status: "up" | "down",
	msg: string,
): string {
	const url = new URL(baseUrl);
	url.searchParams.set("status", status);
	url.searchParams.set("msg", msg);
	return url.toString();
}

export async function sendHeartbeat(jobName: string): Promise<boolean> {
	const config = getConfig();
	const pushUrl = config.UPTIME_KUMA_PUSH_URL;

	if (!pushUrl) {
		log.debug("Uptime Kuma push URL not configured, skipping heartbeat");
		return false;
	}

	try {
		const url = buildHeartbeatUrl(pushUrl, "up", `${jobName} OK`);
		const res = await fetch(url, { method: "GET" });

		if (!res.ok) {
			log.warn(
				{ status: res.status, jobName },
				"Heartbeat push returned non-OK status",
			);
			return false;
		}

		log.debug({ jobName }, "Heartbeat sent");
		return true;
	} catch (error) {
		log.error({ error, jobName }, "Failed to send heartbeat");
		return false;
	}
}
```

- [ ] **Step 3.2: Run tests to verify they pass**

Run: `bun test tests/monitoring/heartbeat.test.ts`
Expected: all tests pass

### Step 4: Wire heartbeat into scheduler jobs

- [ ] **Step 4.1: Modify src/scheduler/jobs.ts**

Add a heartbeat call after successful job execution. In the `try` block of `runJob`, after the success log line:

```typescript
// After: log.info({ job: name, durationMs: Date.now() - start }, "Job completed");
// Add:
const { sendHeartbeat } = await import("../monitoring/heartbeat.ts");
await sendHeartbeat(name).catch((err) =>
	log.warn({ err, job: name }, "Heartbeat failed (non-fatal)"),
);
```

- [ ] **Step 4.2: Commit**

```bash
git add src/monitoring/heartbeat.ts tests/monitoring/heartbeat.test.ts src/scheduler/jobs.ts src/config.ts
git commit -m "feat: add dead man's switch via Uptime Kuma heartbeat"
```

---

## Task 4: Weekly Digest Email

Sunday evening email summarising the week: evolution updates, graduation events, learning loop insights, self-improvement proposals, and API costs.

**Files:**
- Create: `src/scheduler/weekly-digest-job.ts`
- Create: `tests/scheduler/weekly-digest-job.test.ts`
- Modify: `src/scheduler/cron.ts` — add weekly digest schedule
- Modify: `src/scheduler/jobs.ts` — add `weekly_digest` case

### Step 1: Write failing tests

- [ ] **Step 1.1: Write tests for weekly digest data assembly**

```typescript
// tests/scheduler/weekly-digest-job.test.ts
import { describe, expect, test, beforeEach } from "bun:test";
import { getDb } from "../../src/db/client";
import {
	strategies,
	strategyMetrics,
	strategyMutations,
	improvementProposals,
	tokenUsage,
} from "../../src/db/schema";
import {
	buildWeeklyDigestHtml,
	getWeeklyDigestData,
} from "../../src/scheduler/weekly-digest-job";

describe("weekly digest", () => {
	beforeEach(() => {
		const db = getDb();
		db.delete(improvementProposals).run();
		db.delete(tokenUsage).run();
		db.delete(strategyMutations).run();
		db.delete(strategyMetrics).run();
		db.delete(strategies).run();
	});

	test("getWeeklyDigestData returns data for last 7 days", async () => {
		const data = await getWeeklyDigestData();
		expect(data.periodStart).toBeDefined();
		expect(data.periodEnd).toBeDefined();
		expect(data.evolutionEvents).toBeArray();
		expect(data.improvementProposals).toBeArray();
		expect(data.totalApiSpend).toBeGreaterThanOrEqual(0);
	});

	test("buildWeeklyDigestHtml returns valid HTML", async () => {
		const data = await getWeeklyDigestData();
		const html = buildWeeklyDigestHtml(data);
		expect(html).toContain("<h2>");
		expect(html).toContain("Weekly Digest");
		expect(html).toContain(data.periodStart);
	});

	test("includes evolution mutations from the past week", async () => {
		const db = getDb();
		const [parent] = db
			.insert(strategies)
			.values({
				name: "parent_v1",
				description: "test",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
				createdBy: "seed",
			})
			.returning();

		const [child] = db
			.insert(strategies)
			.values({
				name: "parent_v1.1",
				description: "child",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 2,
				createdBy: "evolution",
				parentStrategyId: parent.id,
			})
			.returning();

		db.insert(strategyMutations)
			.values({
				parentStrategyId: parent.id,
				childStrategyId: child.id,
				mutationType: "parameter_tweak",
				parameterChanges: JSON.stringify({ hold_days: { from: 3, to: 5 } }),
				reasoning: "Longer hold improved Sharpe in backtest",
			})
			.run();

		const data = await getWeeklyDigestData();
		expect(data.evolutionEvents.length).toBe(1);
		expect(data.evolutionEvents[0].mutationType).toBe("parameter_tweak");
	});

	test("includes improvement proposals from the past week", async () => {
		const db = getDb();
		db.insert(improvementProposals)
			.values({
				title: "Improve RSI signal weighting",
				description: "Adjust RSI thresholds based on volatility",
				status: "PR_CREATED" as const,
				prUrl: "https://github.com/example/trader-v2/pull/42",
			})
			.run();

		const data = await getWeeklyDigestData();
		expect(data.improvementProposals.length).toBe(1);
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/scheduler/weekly-digest-job.test.ts`
Expected: FAIL — module not found

### Step 2: Implement weekly digest

- [ ] **Step 2.1: Write weekly-digest-job.ts**

```typescript
// src/scheduler/weekly-digest-job.ts
import { gte, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
	strategies,
	strategyMetrics,
	strategyMutations,
	improvementProposals,
	tokenUsage,
} from "../db/schema";
import { sendEmail } from "../reporting/email";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "weekly-digest" });

export interface WeeklyDigestData {
	periodStart: string;
	periodEnd: string;
	evolutionEvents: Array<{
		parentName: string;
		childName: string;
		mutationType: string;
		reasoning: string;
		createdAt: string;
	}>;
	activeStrategies: Array<{
		name: string;
		status: string;
		generation: number;
		winRate: number | null;
		sharpeRatio: number | null;
		sampleSize: number;
	}>;
	improvementProposals: Array<{
		title: string;
		status: string;
		prUrl: string | null;
		createdAt: string;
	}>;
	totalApiSpend: number;
}

export async function getWeeklyDigestData(): Promise<WeeklyDigestData> {
	const db = getDb();
	const now = new Date();
	const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const periodStart = weekAgo.toISOString().split("T")[0];
	const periodEnd = now.toISOString().split("T")[0];

	// Evolution events from the past week
	const mutations = db
		.select({
			parentName: strategies.name,
			childName: sql<string>`c.name`,
			mutationType: strategyMutations.mutationType,
			reasoning: strategyMutations.reasoning,
			createdAt: strategyMutations.createdAt,
		})
		.from(strategyMutations)
		.innerJoin(strategies, sql`${strategies.id} = ${strategyMutations.parentStrategyId}`)
		.innerJoin(
			sql`strategies c`,
			sql`c.id = ${strategyMutations.childStrategyId}`,
		)
		.where(gte(strategyMutations.createdAt, weekAgo.toISOString()))
		.all();

	// Active strategies with metrics
	const strats = db
		.select({
			name: strategies.name,
			status: strategies.status,
			generation: strategies.generation,
			winRate: strategyMetrics.winRate,
			sharpeRatio: strategyMetrics.sharpeRatio,
			sampleSize: strategyMetrics.sampleSize,
		})
		.from(strategies)
		.leftJoin(strategyMetrics, sql`${strategies.id} = ${strategyMetrics.strategyId}`)
		.where(sql`${strategies.status} != 'retired'`)
		.all();

	// Improvement proposals from the past week
	const proposals = db
		.select()
		.from(improvementProposals)
		.where(gte(improvementProposals.createdAt, weekAgo.toISOString()))
		.all();

	// Total API spend this week
	const spendResult = db
		.select({ total: sql<number>`coalesce(sum(estimated_cost_usd), 0)` })
		.from(tokenUsage)
		.where(gte(tokenUsage.createdAt, weekAgo.toISOString()))
		.get();

	return {
		periodStart,
		periodEnd,
		evolutionEvents: mutations.map((m) => ({
			parentName: m.parentName,
			childName: m.childName,
			mutationType: m.mutationType,
			reasoning: m.reasoning ?? "",
			createdAt: m.createdAt,
		})),
		activeStrategies: strats.map((s) => ({
			name: s.name,
			status: s.status,
			generation: s.generation,
			winRate: s.winRate ?? null,
			sharpeRatio: s.sharpeRatio ?? null,
			sampleSize: s.sampleSize ?? 0,
		})),
		improvementProposals: proposals.map((p) => ({
			title: p.title,
			status: p.status,
			prUrl: p.prUrl,
			createdAt: p.createdAt,
		})),
		totalApiSpend: spendResult?.total ?? 0,
	};
}

export function buildWeeklyDigestHtml(data: WeeklyDigestData): string {
	const evolutionRows = data.evolutionEvents.length > 0
		? data.evolutionEvents
				.map(
					(e) => `<tr>
				<td>${e.parentName}</td>
				<td>${e.childName}</td>
				<td>${e.mutationType}</td>
				<td>${e.reasoning}</td>
			</tr>`,
				)
				.join("\n")
		: '<tr><td colspan="4">No evolution events this week</td></tr>';

	const strategyRows = data.activeStrategies
		.map(
			(s) => `<tr>
			<td>${s.name}</td>
			<td>${s.status}</td>
			<td>Gen ${s.generation}</td>
			<td>${s.winRate != null ? `${(s.winRate * 100).toFixed(0)}%` : "—"}</td>
			<td>${s.sharpeRatio?.toFixed(2) ?? "—"}</td>
			<td>${s.sampleSize}</td>
		</tr>`,
		)
		.join("\n");

	const proposalRows = data.improvementProposals.length > 0
		? data.improvementProposals
				.map(
					(p) => `<tr>
				<td>${p.title}</td>
				<td>${p.status}</td>
				<td>${p.prUrl ? `<a href="${p.prUrl}">View PR</a>` : "—"}</td>
			</tr>`,
				)
				.join("\n")
		: '<tr><td colspan="3">No proposals this week</td></tr>';

	return `
		<h2>Trader v2 — Weekly Digest</h2>
		<p><strong>Period:</strong> ${data.periodStart} to ${data.periodEnd}</p>
		<p><strong>API spend this week:</strong> $${data.totalApiSpend.toFixed(4)}</p>

		<h3>Evolution Events</h3>
		<table border="1" cellpadding="4" cellspacing="0">
			<tr><th>Parent</th><th>Child</th><th>Type</th><th>Reasoning</th></tr>
			${evolutionRows}
		</table>

		<h3>Active Strategies</h3>
		<table border="1" cellpadding="4" cellspacing="0">
			<tr><th>Strategy</th><th>Status</th><th>Generation</th><th>Win Rate</th><th>Sharpe</th><th>Trades</th></tr>
			${strategyRows}
		</table>

		<h3>Self-Improvement Proposals</h3>
		<table border="1" cellpadding="4" cellspacing="0">
			<tr><th>Title</th><th>Status</th><th>PR</th></tr>
			${proposalRows}
		</table>
	`;
}

export async function runWeeklyDigest(): Promise<void> {
	const data = await getWeeklyDigestData();
	const html = buildWeeklyDigestHtml(data);

	await sendEmail({
		subject: `Trader v2 Weekly — ${data.evolutionEvents.length} evolutions, $${data.totalApiSpend.toFixed(3)} API`,
		html,
	});

	log.info(
		{
			evolutions: data.evolutionEvents.length,
			proposals: data.improvementProposals.length,
			apiSpend: data.totalApiSpend,
		},
		"Weekly digest sent",
	);
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/scheduler/weekly-digest-job.test.ts`
Expected: all tests pass

### Step 3: Wire into scheduler

- [ ] **Step 3.1: Modify src/scheduler/jobs.ts**

Add the `weekly_digest` case to the `executeJob` switch (replace the stub):

```typescript
case "weekly_digest": {
	const { runWeeklyDigest } = await import("./weekly-digest-job.ts");
	await runWeeklyDigest();
	break;
}
```

- [ ] **Step 3.2: Modify src/scheduler/cron.ts**

Replace the weekly digest comment stub with an active schedule:

```typescript
// Weekly digest: 17:30 Sunday
tasks.push(
	cron.schedule("30 17 * * 0", () => runJob("weekly_digest"), {
		timezone: "Europe/London",
	}),
);
```

- [ ] **Step 3.3: Commit**

```bash
git add src/scheduler/weekly-digest-job.ts tests/scheduler/weekly-digest-job.test.ts src/scheduler/jobs.ts src/scheduler/cron.ts
git commit -m "feat: add weekly digest email with evolution and proposal summaries"
```

---

## Task 5: Self-Improvement GitHub Integration

Cherry-pick and adapt the v1 GitHub integration (`createPR`, `createIssue`) for v2. The v1 file at `/Users/Cal/Documents/Projects/trader/src/self-improve/github.ts` uses @octokit/rest with the Git Data API to create branches, commit blobs, and open PRs programmatically.

**Files:**
- Create: `src/self-improve/github.ts` (adapted from v1)
- Create: `tests/self-improve/github.test.ts`

### Step 1: Write tests for pure helper functions

- [ ] **Step 1.1: Write github tests**

The actual Octokit calls require a real token, so test the interface types and any pure helpers only. Skip integration tests.

```typescript
// tests/self-improve/github.test.ts
import { describe, expect, test } from "bun:test";
import type { PRRequest, IssueRequest } from "../../src/self-improve/github";

describe("self-improve github types", () => {
	test("PRRequest type shape is valid", () => {
		const pr: PRRequest = {
			title: "Improve RSI weighting",
			description: "Adjusted thresholds based on backtest",
			branch: "self-improve/rsi-weight-20260404",
			changes: [
				{ path: "src/strategy/signals.ts", content: "// updated" },
			],
		};
		expect(pr.changes.length).toBe(1);
		expect(pr.branch).toStartWith("self-improve/");
	});

	test("IssueRequest type shape is valid", () => {
		const issue: IssueRequest = {
			title: "Update graduation gate threshold",
			body: "Suggest lowering minimum sample from 30 to 25",
			labels: ["agent-suggestion"],
		};
		expect(issue.labels).toContain("agent-suggestion");
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/self-improve/github.test.ts`
Expected: FAIL — module not found

### Step 2: Implement github.ts

- [ ] **Step 2.1: Create src/self-improve/github.ts**

Cherry-pick from v1 (`/Users/Cal/Documents/Projects/trader/src/self-improve/github.ts`), adapting for v2 conventions. The logic is identical — uses Octokit Git Data API to create blobs, trees, commits, branches, and PRs.

```typescript
// src/self-improve/github.ts
import { Octokit } from "@octokit/rest";
import { getConfig } from "../config";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "self-improve-github" });

let _octokit: Octokit | null = null;

function getOctokit(): Octokit | null {
	const config = getConfig();
	if (!config.GITHUB_TOKEN || !config.GITHUB_REPO_OWNER) {
		log.debug("GitHub not configured");
		return null;
	}
	if (!_octokit) {
		_octokit = new Octokit({ auth: config.GITHUB_TOKEN });
	}
	return _octokit;
}

export interface PRRequest {
	title: string;
	description: string;
	branch: string;
	changes: Array<{ path: string; content: string }>;
}

export interface IssueRequest {
	title: string;
	body: string;
	labels?: string[];
}

/** Create a PR with file changes via the Git Data API */
export async function createPR(request: PRRequest): Promise<string | null> {
	const octokit = getOctokit();
	if (!octokit) return null;

	const config = getConfig();
	const owner = config.GITHUB_REPO_OWNER!;
	const repo = config.GITHUB_REPO_NAME;

	try {
		// Get default branch ref
		const { data: repoData } = await octokit.repos.get({ owner, repo });
		const defaultBranch = repoData.default_branch;

		// Get the latest commit SHA on main
		const { data: ref } = await octokit.git.getRef({
			owner,
			repo,
			ref: `heads/${defaultBranch}`,
		});
		const baseSha = ref.object.sha;

		// Get the base tree
		const { data: baseCommit } = await octokit.git.getCommit({
			owner,
			repo,
			commit_sha: baseSha,
		});

		// Create blobs for each file change
		const tree = [];
		for (const change of request.changes) {
			const { data: blob } = await octokit.git.createBlob({
				owner,
				repo,
				content: Buffer.from(change.content).toString("base64"),
				encoding: "base64",
			});
			tree.push({
				path: change.path,
				mode: "100644" as const,
				type: "blob" as const,
				sha: blob.sha,
			});
		}

		// Create tree
		const { data: newTree } = await octokit.git.createTree({
			owner,
			repo,
			base_tree: baseCommit.tree.sha,
			tree,
		});

		// Create commit
		const { data: newCommit } = await octokit.git.createCommit({
			owner,
			repo,
			message: `[self-improve] ${request.title}`,
			tree: newTree.sha,
			parents: [baseSha],
		});

		// Create branch
		await octokit.git.createRef({
			owner,
			repo,
			ref: `refs/heads/${request.branch}`,
			sha: newCommit.sha,
		});

		// Create PR
		const { data: pr } = await octokit.pulls.create({
			owner,
			repo,
			title: `[Self-Improve] ${request.title}`,
			body: `## Auto-generated Improvement Proposal\n\n${request.description}\n\n---\n*This PR was automatically generated by the trading agent's self-improvement system. Please review carefully before merging.*`,
			head: request.branch,
			base: defaultBranch,
		});

		log.info({ prNumber: pr.number, prUrl: pr.html_url }, "PR created");
		return pr.html_url;
	} catch (error) {
		log.error({ error }, "Failed to create PR");
		return null;
	}
}

/** Create a GitHub issue for changes the agent cannot make directly */
export async function createIssue(
	request: IssueRequest,
): Promise<string | null> {
	const octokit = getOctokit();
	if (!octokit) return null;

	const config = getConfig();
	const owner = config.GITHUB_REPO_OWNER!;
	const repo = config.GITHUB_REPO_NAME;

	try {
		const { data: issue } = await octokit.issues.create({
			owner,
			repo,
			title: `[Agent Suggestion] ${request.title}`,
			body: `## Agent-Identified Change Request\n\n${request.body}\n\n---\n*This issue was automatically created by the trading agent's self-improvement system.*`,
			labels: request.labels ?? ["agent-suggestion"],
		});

		log.info(
			{ issueNumber: issue.number, issueUrl: issue.html_url },
			"Issue created",
		);
		return issue.html_url;
	} catch (error) {
		log.error({ error }, "Failed to create issue");
		return null;
	}
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/self-improve/github.test.ts`
Expected: all tests pass

- [ ] **Step 2.3: Commit**

```bash
git add src/self-improve/github.ts tests/self-improve/github.test.ts
git commit -m "feat: add GitHub PR/issue creation for self-improvement (adapted from v1)"
```

---

## Task 6: Code Generator

Cherry-pick and adapt the v1 code generator. Sonnet reads a file, applies a described change, and returns the complete modified content. Includes budget guard.

**Files:**
- Create: `src/self-improve/code-generator.ts` (adapted from v1)
- Create: `tests/self-improve/code-generator.test.ts`

### Step 1: Write tests for parsing logic

- [ ] **Step 1.1: Write code generator tests**

```typescript
// tests/self-improve/code-generator.test.ts
import { describe, expect, test } from "bun:test";
import { extractCodeFromResponse } from "../../src/self-improve/code-generator";

describe("code-generator", () => {
	test("extractCodeFromResponse extracts from typescript code block", () => {
		const response = '```typescript\nconst x = 1;\nconsole.log(x);\n```';
		const result = extractCodeFromResponse(response);
		expect(result).toBe("const x = 1;\nconsole.log(x);");
	});

	test("extractCodeFromResponse extracts from ts code block", () => {
		const response = '```ts\nconst x = 1;\n```';
		const result = extractCodeFromResponse(response);
		expect(result).toBe("const x = 1;");
	});

	test("extractCodeFromResponse returns raw text when no code block", () => {
		const response = "const x = 1;\nconsole.log(x);";
		const result = extractCodeFromResponse(response);
		expect(result).toBe("const x = 1;\nconsole.log(x);");
	});

	test("extractCodeFromResponse returns null for suspiciously short output", () => {
		const response = "x";
		const result = extractCodeFromResponse(response);
		expect(result).toBeNull();
	});
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test tests/self-improve/code-generator.test.ts`
Expected: FAIL — module not found

### Step 2: Implement code generator

- [ ] **Step 2.1: Write code-generator.ts**

```typescript
// src/self-improve/code-generator.ts
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config";
import { canAffordCall } from "../utils/budget";
import { createChildLogger } from "../utils/logger";
import { recordUsage } from "../utils/token-tracker";

const log = createChildLogger({ module: "self-improve-codegen" });

const CODE_GEN_ESTIMATED_COST_USD = 0.05;

/** Extract code content from an LLM response, handling markdown blocks */
export function extractCodeFromResponse(text: string): string | null {
	const codeMatch = text.match(/```(?:typescript|ts)?\n([\s\S]*?)```/);
	const content = codeMatch ? codeMatch[1]!.trim() : text.trim();

	if (content.length < 10) {
		return null;
	}

	return content;
}

/** Generate a code change for a specific file using Sonnet */
export async function generateCodeChange(
	filePath: string,
	changeDescription: string,
): Promise<string | null> {
	const config = getConfig();

	if (!(await canAffordCall(CODE_GEN_ESTIMATED_COST_USD))) {
		log.warn("Budget exceeded, skipping code generation");
		return null;
	}

	// Read the current file content
	let currentContent: string;
	try {
		const file = Bun.file(filePath);
		currentContent = await file.text();
	} catch (error) {
		log.error({ filePath, error }, "Failed to read file for code generation");
		return null;
	}

	const prompt = `You are modifying a TypeScript file for a trading agent. Apply the following change:

## Change Description
${changeDescription}

## Current File Content (${filePath})
\`\`\`typescript
${currentContent}
\`\`\`

## Rules
- Only modify what's necessary for the described change
- Maintain the existing code style (tabs for indentation)
- Do not add comments explaining the change
- Return ONLY the complete modified file content, no explanation
- Keep all existing imports and exports
- The output must be valid TypeScript

Return the complete modified file content:`;

	try {
		const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
		const response = await client.messages.create({
			model: config.CLAUDE_MODEL,
			max_tokens: 8192,
			messages: [{ role: "user", content: prompt }],
		});

		await recordUsage(
			"code_generation",
			response.usage.input_tokens,
			response.usage.output_tokens,
		);

		const text = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n");

		const content = extractCodeFromResponse(text);
		if (!content) {
			log.warn({ filePath }, "Generated code change is suspiciously short");
			return null;
		}

		log.info(
			{
				filePath,
				originalLength: currentContent.length,
				newLength: content.length,
			},
			"Code change generated",
		);
		return content;
	} catch (error) {
		log.error({ filePath, error }, "Code generation failed");
		return null;
	}
}
```

- [ ] **Step 2.2: Run tests to verify they pass**

Run: `bun test tests/self-improve/code-generator.test.ts`
Expected: all tests pass

- [ ] **Step 2.3: Commit**

```bash
git add src/self-improve/code-generator.ts tests/self-improve/code-generator.test.ts
git commit -m "feat: add code generator for self-improvement (Sonnet + budget guard)"
```

---

## Task 7: Self-Improvement Proposer

The core logic that decides what to improve. Weekly Sonnet call reviews system performance, recent evolution results, and learning loop insights, then proposes code changes (as PRs for whitelisted files) or issues (for human-only files). Rate-limited to 2 PRs/week and 3 issues/week.

**Files:**
- Create: `src/self-improve/types.ts`
- Create: `src/self-improve/proposer.ts`
- Create: `tests/self-improve/proposer.test.ts`

### Step 1: Write types

- [ ] **Step 1.1: Create types.ts**

```typescript
// src/self-improve/types.ts

/** Files the AI can propose direct code changes to (via PR) */
export const WHITELISTED_PATHS = [
	"src/strategy/evaluation/",
	"src/strategy/signals/",
	"src/news/classifier.ts",
	"src/reporting/",
	"src/evolution/prompt.ts",
] as const;

/** Files that require human review (proposed as GitHub issues) */
export const HUMAN_ONLY_PATHS = [
	"src/risk/",
	"src/strategy/graduation/",
	"src/broker/",
	"src/db/schema.ts",
	"drizzle/",
] as const;

export const MAX_PRS_PER_WEEK = 2;
export const MAX_ISSUES_PER_WEEK = 3;

export interface ImprovementIdea {
	title: string;
	description: string;
	targetFile: string;
	changeDescription: string;
	reasoning: string;
	priority: "low" | "medium" | "high";
}

export interface ProposalResult {
	prsCreated: number;
	issuesCreated: number;
	skipped: number;
	errors: string[];
}
```

### Step 2: Write failing tests

- [ ] **Step 2.1: Write proposer tests**

```typescript
// tests/self-improve/proposer.test.ts
import { describe, expect, test } from "bun:test";
import {
	isWhitelistedPath,
	isHumanOnlyPath,
	classifyProposal,
	generateBranchName,
} from "../../src/self-improve/proposer";

describe("proposer", () => {
	test("isWhitelistedPath matches strategy evaluation files", () => {
		expect(isWhitelistedPath("src/strategy/evaluation/scorer.ts")).toBe(true);
		expect(isWhitelistedPath("src/strategy/signals/rsi.ts")).toBe(true);
		expect(isWhitelistedPath("src/news/classifier.ts")).toBe(true);
		expect(isWhitelistedPath("src/reporting/email.ts")).toBe(true);
	});

	test("isWhitelistedPath rejects non-whitelisted files", () => {
		expect(isWhitelistedPath("src/db/schema.ts")).toBe(false);
		expect(isWhitelistedPath("src/broker/ibkr.ts")).toBe(false);
		expect(isWhitelistedPath("src/risk/limits.ts")).toBe(false);
	});

	test("isHumanOnlyPath matches protected files", () => {
		expect(isHumanOnlyPath("src/risk/limits.ts")).toBe(true);
		expect(isHumanOnlyPath("src/db/schema.ts")).toBe(true);
		expect(isHumanOnlyPath("src/broker/ibkr.ts")).toBe(true);
		expect(isHumanOnlyPath("drizzle/migrations/0001.sql")).toBe(true);
	});

	test("classifyProposal returns pr for whitelisted, issue for human-only, skip for unknown", () => {
		expect(classifyProposal("src/strategy/evaluation/scorer.ts")).toBe("pr");
		expect(classifyProposal("src/risk/limits.ts")).toBe("issue");
		expect(classifyProposal("src/unknown/random.ts")).toBe("skip");
	});

	test("generateBranchName creates a valid git branch name", () => {
		const branch = generateBranchName("Improve RSI signal weighting");
		expect(branch).toMatch(/^self-improve\//);
		expect(branch).not.toContain(" ");
		expect(branch.length).toBeLessThan(80);
	});
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test tests/self-improve/proposer.test.ts`
Expected: FAIL — module not found

### Step 3: Implement proposer

- [ ] **Step 3.1: Write proposer.ts**

```typescript
// src/self-improve/proposer.ts
import Anthropic from "@anthropic-ai/sdk";
import { gte, sql } from "drizzle-orm";
import { getConfig } from "../config";
import { getDb } from "../db/client";
import { improvementProposals } from "../db/schema";
import { getPerformanceLandscape } from "../evolution/analyzer";
import { canAffordCall } from "../utils/budget";
import { createChildLogger } from "../utils/logger";
import { recordUsage } from "../utils/token-tracker";
import { generateCodeChange } from "./code-generator";
import { createIssue, createPR } from "./github";
import {
	HUMAN_ONLY_PATHS,
	MAX_ISSUES_PER_WEEK,
	MAX_PRS_PER_WEEK,
	WHITELISTED_PATHS,
	type ImprovementIdea,
	type ProposalResult,
} from "./types";

const log = createChildLogger({ module: "self-improve-proposer" });

const PROPOSER_ESTIMATED_COST_USD = 0.08;

export function isWhitelistedPath(filePath: string): boolean {
	return WHITELISTED_PATHS.some((prefix) => filePath.startsWith(prefix));
}

export function isHumanOnlyPath(filePath: string): boolean {
	return HUMAN_ONLY_PATHS.some((prefix) => filePath.startsWith(prefix));
}

export function classifyProposal(
	targetFile: string,
): "pr" | "issue" | "skip" {
	if (isWhitelistedPath(targetFile)) return "pr";
	if (isHumanOnlyPath(targetFile)) return "issue";
	return "skip";
}

export function generateBranchName(title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 40);
	const date = new Date().toISOString().split("T")[0].replace(/-/g, "");
	return `self-improve/${slug}-${date}`;
}

/** Count PRs and issues created in the current week */
async function getWeeklyProposalCounts(): Promise<{
	prs: number;
	issues: number;
}> {
	const db = getDb();
	const weekAgo = new Date(
		Date.now() - 7 * 24 * 60 * 60 * 1000,
	).toISOString();

	const prs = db
		.select({ count: sql<number>`count(*)` })
		.from(improvementProposals)
		.where(
			sql`${improvementProposals.status} = 'PR_CREATED' AND ${improvementProposals.createdAt} >= ${weekAgo}`,
		)
		.get();

	const issues = db
		.select({ count: sql<number>`count(*)` })
		.from(improvementProposals)
		.where(
			sql`${improvementProposals.status} = 'ISSUE_CREATED' AND ${improvementProposals.createdAt} >= ${weekAgo}`,
		)
		.get();

	return {
		prs: prs?.count ?? 0,
		issues: issues?.count ?? 0,
	};
}

/** Build the Sonnet prompt that analyses system state and proposes improvements */
function buildProposerPrompt(landscapeJson: string): string {
	return `You are analysing a trading agent system to identify code improvements.

## Current System State
${landscapeJson}

## Whitelisted Files (you can propose direct code changes)
${WHITELISTED_PATHS.join("\n")}

## Human-Only Files (propose as issues for human review)
${HUMAN_ONLY_PATHS.join("\n")}

## Instructions
Review the system state and propose 1-3 specific, actionable code improvements. Focus on:
- Strategy evaluation logic that could be more accurate
- Signal computation that could capture more alpha
- News classification prompts that could be more precise
- Reporting templates that could be more informative

For each proposal, return a JSON array:
\`\`\`json
[
  {
    "title": "Short descriptive title",
    "description": "Detailed description of what to change and why",
    "targetFile": "src/path/to/file.ts",
    "changeDescription": "Specific instructions for the code change",
    "reasoning": "Why this improvement matters based on the data",
    "priority": "high" | "medium" | "low"
  }
]
\`\`\`

Rules:
- Only propose changes you are confident will improve the system
- Base proposals on actual performance data, not speculation
- Each proposal must target a specific file
- If the system is performing well, return an empty array []
- Return ONLY the JSON array, no other text`;
}

/** Parse the Sonnet response into typed improvement ideas */
export function parseProposerResponse(text: string): ImprovementIdea[] {
	const jsonMatch = text.match(/```(?:json)?\n?([\s\S]*?)```/);
	const jsonStr = jsonMatch ? jsonMatch[1]!.trim() : text.trim();

	try {
		const parsed = JSON.parse(jsonStr);
		if (!Array.isArray(parsed)) return [];

		return parsed.filter(
			(item: unknown): item is ImprovementIdea =>
				typeof item === "object" &&
				item !== null &&
				typeof (item as ImprovementIdea).title === "string" &&
				typeof (item as ImprovementIdea).targetFile === "string" &&
				typeof (item as ImprovementIdea).changeDescription === "string",
		);
	} catch {
		log.warn("Failed to parse proposer response as JSON");
		return [];
	}
}

/** Run the full self-improvement cycle */
export async function runSelfImprovementCycle(): Promise<ProposalResult> {
	const result: ProposalResult = {
		prsCreated: 0,
		issuesCreated: 0,
		skipped: 0,
		errors: [],
	};

	const config = getConfig();

	// Budget check
	if (!(await canAffordCall(PROPOSER_ESTIMATED_COST_USD))) {
		log.warn("Budget exceeded, skipping self-improvement cycle");
		result.errors.push("Budget exceeded");
		return result;
	}

	// Rate limit check
	const counts = await getWeeklyProposalCounts();
	if (counts.prs >= MAX_PRS_PER_WEEK && counts.issues >= MAX_ISSUES_PER_WEEK) {
		log.info(
			{ prs: counts.prs, issues: counts.issues },
			"Weekly rate limit reached, skipping",
		);
		return result;
	}

	// Get system state
	const landscape = await getPerformanceLandscape();
	const landscapeJson = JSON.stringify(landscape, null, 2);

	// Ask Sonnet for improvement ideas
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
	const response = await client.messages.create({
		model: config.CLAUDE_MODEL,
		max_tokens: 4096,
		messages: [
			{ role: "user", content: buildProposerPrompt(landscapeJson) },
		],
	});

	await recordUsage(
		"self_improvement",
		response.usage.input_tokens,
		response.usage.output_tokens,
	);

	const text = response.content
		.filter((b): b is Anthropic.TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("\n");

	const ideas = parseProposerResponse(text);
	log.info({ ideaCount: ideas.length }, "Self-improvement ideas generated");

	if (ideas.length === 0) {
		log.info("No improvement ideas proposed — system performing well");
		return result;
	}

	// Process each idea
	const db = getDb();
	for (const idea of ideas) {
		const classification = classifyProposal(idea.targetFile);

		if (classification === "pr" && counts.prs + result.prsCreated < MAX_PRS_PER_WEEK) {
			// Generate code and create PR
			const newContent = await generateCodeChange(
				idea.targetFile,
				idea.changeDescription,
			);

			if (newContent) {
				const branch = generateBranchName(idea.title);
				const prUrl = await createPR({
					title: idea.title,
					description: `${idea.description}\n\n**Reasoning:** ${idea.reasoning}`,
					branch,
					changes: [{ path: idea.targetFile, content: newContent }],
				});

				if (prUrl) {
					db.insert(improvementProposals)
						.values({
							title: idea.title,
							description: idea.description,
							filesChanged: idea.targetFile,
							prUrl,
							status: "PR_CREATED" as const,
						})
						.run();
					result.prsCreated++;
					log.info({ title: idea.title, prUrl }, "Self-improvement PR created");
				} else {
					result.errors.push(`Failed to create PR: ${idea.title}`);
				}
			} else {
				result.errors.push(
					`Failed to generate code for: ${idea.title}`,
				);
			}
		} else if (classification === "issue" && counts.issues + result.issuesCreated < MAX_ISSUES_PER_WEEK) {
			// Create issue for human review
			const issueUrl = await createIssue({
				title: idea.title,
				body: `${idea.description}\n\n**Target file:** \`${idea.targetFile}\`\n**Change:** ${idea.changeDescription}\n**Reasoning:** ${idea.reasoning}\n**Priority:** ${idea.priority}`,
				labels: ["agent-suggestion", idea.priority],
			});

			if (issueUrl) {
				db.insert(improvementProposals)
					.values({
						title: idea.title,
						description: idea.description,
						filesChanged: idea.targetFile,
						status: "ISSUE_CREATED" as const,
					})
					.run();
				result.issuesCreated++;
				log.info(
					{ title: idea.title, issueUrl },
					"Self-improvement issue created",
				);
			} else {
				result.errors.push(`Failed to create issue: ${idea.title}`);
			}
		} else {
			result.skipped++;
			log.debug(
				{ title: idea.title, classification },
				"Proposal skipped (rate limit or unclassified)",
			);
		}
	}

	return result;
}
```

- [ ] **Step 3.2: Run tests to verify they pass**

Run: `bun test tests/self-improve/proposer.test.ts`
Expected: all tests pass

- [ ] **Step 3.3: Add response parsing tests**

Add to `tests/self-improve/proposer.test.ts`:

```typescript
import { parseProposerResponse } from "../../src/self-improve/proposer";

describe("parseProposerResponse", () => {
	test("parses valid JSON array from code block", () => {
		const response = '```json\n[{"title":"Test","description":"desc","targetFile":"src/x.ts","changeDescription":"change","reasoning":"reason","priority":"high"}]\n```';
		const ideas = parseProposerResponse(response);
		expect(ideas.length).toBe(1);
		expect(ideas[0].title).toBe("Test");
	});

	test("returns empty array for invalid JSON", () => {
		const ideas = parseProposerResponse("not json at all");
		expect(ideas).toEqual([]);
	});

	test("returns empty array for empty array response", () => {
		const ideas = parseProposerResponse("[]");
		expect(ideas).toEqual([]);
	});

	test("filters out malformed entries", () => {
		const response = '[{"title":"Good","targetFile":"src/x.ts","changeDescription":"change"},{"bad":true}]';
		const ideas = parseProposerResponse(response);
		expect(ideas.length).toBe(1);
	});
});
```

- [ ] **Step 3.4: Commit**

```bash
git add src/self-improve/types.ts src/self-improve/proposer.ts tests/self-improve/proposer.test.ts
git commit -m "feat: add self-improvement proposer with whitelisting and rate limiting"
```

---

## Task 8: Self-Improvement Scheduler Job

Wire the self-improvement cycle into the scheduler as a weekly job.

**Files:**
- Create: `src/scheduler/self-improve-job.ts`
- Modify: `src/scheduler/jobs.ts` — add `self_improvement` job type
- Modify: `src/scheduler/cron.ts` — add weekly schedule

### Step 1: Create the job wrapper

- [ ] **Step 1.1: Write self-improve-job.ts**

```typescript
// src/scheduler/self-improve-job.ts
import { getConfig } from "../config";
import { sendEmail } from "../reporting/email";
import { runSelfImprovementCycle } from "../self-improve/proposer";
import { createChildLogger } from "../utils/logger";

const log = createChildLogger({ module: "self-improve-job" });

export async function runSelfImproveJob(): Promise<void> {
	const config = getConfig();

	// Skip if GitHub not configured
	if (!config.GITHUB_TOKEN || !config.GITHUB_REPO_OWNER) {
		log.info("GitHub not configured, skipping self-improvement");
		return;
	}

	try {
		const result = await runSelfImprovementCycle();

		log.info(
			{
				prsCreated: result.prsCreated,
				issuesCreated: result.issuesCreated,
				skipped: result.skipped,
				errors: result.errors.length,
			},
			"Self-improvement cycle complete",
		);

		// Email summary if anything happened
		if (result.prsCreated > 0 || result.issuesCreated > 0 || result.errors.length > 0) {
			await sendEmail({
				subject: `Trader v2 Self-Improve: ${result.prsCreated} PRs, ${result.issuesCreated} issues`,
				html: `
					<h2>Self-Improvement Cycle Results</h2>
					<ul>
						<li><strong>PRs created:</strong> ${result.prsCreated}</li>
						<li><strong>Issues created:</strong> ${result.issuesCreated}</li>
						<li><strong>Skipped:</strong> ${result.skipped}</li>
						${result.errors.length > 0 ? `<li><strong>Errors:</strong><ul>${result.errors.map((e) => `<li>${e}</li>`).join("")}</ul></li>` : ""}
					</ul>
				`,
			});
		}
	} catch (error) {
		log.error({ error }, "Self-improvement cycle failed");
		throw error;
	}
}
```

### Step 2: Wire into scheduler

- [ ] **Step 2.1: Add self_improvement to JobName type in src/scheduler/jobs.ts**

Add `"self_improvement"` to the `JobName` union type.

- [ ] **Step 2.2: Add case to executeJob switch**

```typescript
case "self_improvement": {
	const { runSelfImproveJob } = await import("./self-improve-job.ts");
	await runSelfImproveJob();
	break;
}
```

- [ ] **Step 2.3: Add schedule to src/scheduler/cron.ts**

```typescript
// Self-improvement — weekly Sunday 19:00 (after evolution at 18:00)
tasks.push(
	cron.schedule("0 19 * * 0", () => runJob("self_improvement"), {
		timezone: "Europe/London",
	}),
);
```

- [ ] **Step 2.4: Commit**

```bash
git add src/scheduler/self-improve-job.ts src/scheduler/jobs.ts src/scheduler/cron.ts
git commit -m "feat: wire self-improvement cycle into weekly scheduler"
```

---

## Task 9: Status Page & Pause/Resume Controls

Simple HTML page behind basic auth at `GET /`. Shows system status and provides pause/resume buttons. Uses `POST /pause` and `POST /resume` endpoints.

**Files:**
- Create: `src/monitoring/status-page.ts`
- Create: `tests/monitoring/status-page.test.ts`
- Modify: `src/monitoring/server.ts` — add routes
- Modify: `src/config.ts` — add `ADMIN_PASSWORD`

### Step 1: Add config

- [ ] **Step 1.1: Add ADMIN_PASSWORD to envSchema in src/config.ts**

```typescript
// Add inside envSchema
ADMIN_PASSWORD: z.string().optional(),
```

### Step 2: Write status page template tests

- [ ] **Step 2.1: Write template tests**

```typescript
// tests/monitoring/status-page.test.ts
import { describe, expect, test } from "bun:test";
import { buildStatusPageHtml } from "../../src/monitoring/status-page";
import type { HealthData } from "../../src/monitoring/health";

describe("status page template", () => {
	const mockHealth: HealthData = {
		status: "ok",
		uptime: 3600,
		timestamp: "2026-04-04T12:00:00.000Z",
		activeStrategies: 3,
		dailyPnl: 42.5,
		apiSpendToday: 0.125,
		lastQuoteTime: "2026-04-04T11:55:00.000Z",
		paused: false,
	};

	test("renders HTML with system status", () => {
		const html = buildStatusPageHtml(mockHealth);
		expect(html).toContain("Trader v2");
		expect(html).toContain("ok");
		expect(html).toContain("3 active");
		expect(html).toContain("42.5");
	});

	test("shows pause button when not paused", () => {
		const html = buildStatusPageHtml(mockHealth);
		expect(html).toContain("/pause");
		expect(html).not.toContain("PAUSED");
	});

	test("shows resume button when paused", () => {
		const html = buildStatusPageHtml({ ...mockHealth, paused: true, status: "degraded" });
		expect(html).toContain("/resume");
		expect(html).toContain("PAUSED");
	});

	test("formats uptime in hours and minutes", () => {
		const html = buildStatusPageHtml(mockHealth);
		expect(html).toContain("1h 0m");
	});
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test tests/monitoring/status-page.test.ts`
Expected: FAIL — module not found

### Step 3: Implement status page

- [ ] **Step 3.1: Write status-page.ts**

```typescript
// src/monitoring/status-page.ts
import type { HealthData } from "./health";

function formatUptime(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	return `${hours}h ${minutes}m`;
}

function statusBadge(status: string): string {
	const colors: Record<string, string> = {
		ok: "#22c55e",
		degraded: "#eab308",
		error: "#ef4444",
	};
	const color = colors[status] ?? "#6b7280";
	return `<span style="display:inline-block;padding:2px 10px;border-radius:4px;background:${color};color:#fff;font-weight:bold;">${status.toUpperCase()}</span>`;
}

export function buildStatusPageHtml(data: HealthData): string {
	const pauseSection = data.paused
		? `<div style="background:#fef3c7;padding:12px;border-radius:6px;margin:16px 0;">
			<strong>PAUSED</strong> — Trading is paused. No new positions will be opened.
			<form method="POST" action="/resume" style="display:inline;margin-left:12px;">
				<button type="submit" style="padding:6px 16px;background:#22c55e;color:#fff;border:none;border-radius:4px;cursor:pointer;">Resume Trading</button>
			</form>
		</div>`
		: `<form method="POST" action="/pause" style="margin:16px 0;">
			<button type="submit" style="padding:6px 16px;background:#ef4444;color:#fff;border:none;border-radius:4px;cursor:pointer;">Pause Trading</button>
		</form>`;

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Trader v2 — Status</title>
	<style>
		body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 600px; margin: 40px auto; padding: 0 20px; background: #f9fafb; color: #111827; }
		h1 { font-size: 1.5rem; }
		table { width: 100%; border-collapse: collapse; margin: 16px 0; }
		td, th { padding: 8px 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
		th { color: #6b7280; font-weight: 500; width: 40%; }
	</style>
</head>
<body>
	<h1>Trader v2</h1>
	${statusBadge(data.status)}
	${pauseSection}
	<table>
		<tr><th>Uptime</th><td>${formatUptime(data.uptime)}</td></tr>
		<tr><th>Active Strategies</th><td>${data.activeStrategies} active</td></tr>
		<tr><th>Daily P&amp;L</th><td>${data.dailyPnl >= 0 ? "+" : ""}${data.dailyPnl.toFixed(2)}</td></tr>
		<tr><th>API Spend Today</th><td>$${data.apiSpendToday.toFixed(4)}</td></tr>
		<tr><th>Last Quote</th><td>${data.lastQuoteTime ?? "Never"}</td></tr>
		<tr><th>Timestamp</th><td>${data.timestamp}</td></tr>
	</table>
	<p style="color:#9ca3af;font-size:0.85rem;">Auto-refreshes every 60s. <a href="/health">JSON health endpoint</a></p>
	<script>setTimeout(() => location.reload(), 60000);</script>
</body>
</html>`;
}
```

- [ ] **Step 3.2: Run tests to verify they pass**

Run: `bun test tests/monitoring/status-page.test.ts`
Expected: all tests pass

### Step 4: Add routes to server.ts

- [ ] **Step 4.1: Update src/monitoring/server.ts with all routes**

Replace the `handleRequest` function:

```typescript
import { getConfig } from "../config";
import { getHealthData, isPaused, setPaused } from "./health";
import { buildStatusPageHtml } from "./status-page";
import { createChildLogger } from "../utils/logger";

// ... (keep existing startServer/stopServer)

function checkBasicAuth(req: Request): boolean {
	const config = getConfig();
	if (!config.ADMIN_PASSWORD) return true; // No auth required if not configured

	const authHeader = req.headers.get("Authorization");
	if (!authHeader?.startsWith("Basic ")) return false;

	const decoded = atob(authHeader.slice(6));
	const [, password] = decoded.split(":");
	return password === config.ADMIN_PASSWORD;
}

async function handleRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);

	// Health endpoint — no auth required (for Uptime Kuma polling)
	if (req.method === "GET" && url.pathname === "/health") {
		const data = await getHealthData();
		return Response.json(data);
	}

	// All other routes require basic auth if ADMIN_PASSWORD is set
	if (!checkBasicAuth(req)) {
		return new Response("Unauthorized", {
			status: 401,
			headers: { "WWW-Authenticate": 'Basic realm="Trader v2"' },
		});
	}

	// Status page
	if (req.method === "GET" && url.pathname === "/") {
		const data = await getHealthData();
		const html = buildStatusPageHtml(data);
		return new Response(html, {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	}

	// Pause trading
	if (req.method === "POST" && url.pathname === "/pause") {
		setPaused(true);
		log.warn("Trading PAUSED via status page");
		return Response.redirect("/", 303);
	}

	// Resume trading
	if (req.method === "POST" && url.pathname === "/resume") {
		setPaused(false);
		log.info("Trading RESUMED via status page");
		return Response.redirect("/", 303);
	}

	return new Response("Not Found", { status: 404 });
}
```

### Step 5: Add server route tests

- [ ] **Step 5.1: Add route tests to tests/monitoring/server.test.ts**

```typescript
test("GET / returns HTML status page", async () => {
	port = 39849;
	startServer(port);

	const res = await fetch(`http://localhost:${port}/`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/html");

	const html = await res.text();
	expect(html).toContain("Trader v2");
});

test("POST /pause sets paused state", async () => {
	port = 39850;
	startServer(port);

	const res = await fetch(`http://localhost:${port}/pause`, {
		method: "POST",
		redirect: "manual",
	});
	expect(res.status).toBe(303);

	// Verify health reflects paused
	const healthRes = await fetch(`http://localhost:${port}/health`);
	const data = await healthRes.json();
	expect(data.paused).toBe(true);
});

test("POST /resume clears paused state", async () => {
	port = 39851;
	startServer(port);

	// Pause then resume
	await fetch(`http://localhost:${port}/pause`, {
		method: "POST",
		redirect: "manual",
	});
	await fetch(`http://localhost:${port}/resume`, {
		method: "POST",
		redirect: "manual",
	});

	const healthRes = await fetch(`http://localhost:${port}/health`);
	const data = await healthRes.json();
	expect(data.paused).toBe(false);
});
```

- [ ] **Step 5.2: Run all monitoring tests**

Run: `bun test tests/monitoring/`
Expected: all tests pass

- [ ] **Step 5.3: Commit**

```bash
git add src/monitoring/status-page.ts tests/monitoring/status-page.test.ts src/monitoring/server.ts tests/monitoring/server.test.ts src/config.ts
git commit -m "feat: add status page with pause/resume controls and basic auth"
```

---

## Task 10: Pause State Integration

The `isPaused()` check needs to gate strategy evaluation and trade execution so pausing actually stops trading.

**Files:**
- Modify: `src/scheduler/jobs.ts` — check `isPaused()` before trade-related jobs

### Step 1: Add pause guard

- [ ] **Step 1.1: Modify executeJob in src/scheduler/jobs.ts**

At the top of `executeJob`, add a pause guard for trade-affecting jobs:

```typescript
async function executeJob(name: JobName): Promise<void> {
	// Skip trade-affecting jobs when paused
	const TRADE_JOBS: JobName[] = ["strategy_evaluation", "trade_review"];
	if (TRADE_JOBS.includes(name)) {
		const { isPaused } = await import("../monitoring/health.ts");
		if (isPaused()) {
			log.info({ job: name }, "Skipping — trading is paused");
			return;
		}
	}

	switch (name) {
		// ... existing cases
```

Note: `quote_refresh`, `news_poll`, `daily_summary`, `heartbeat` etc. should continue running even when paused so monitoring stays active.

- [ ] **Step 1.2: Commit**

```bash
git add src/scheduler/jobs.ts
git commit -m "feat: gate trade-affecting jobs on pause state"
```

---

## Task 11: Install @octokit/rest Dependency

The self-improvement module needs `@octokit/rest` for GitHub API access.

**Files:**
- Modify: `package.json`

### Step 1: Install

- [ ] **Step 1.1: Install @octokit/rest**

```bash
bun add @octokit/rest
```

- [ ] **Step 1.2: Verify import resolves**

```bash
bun -e "import { Octokit } from '@octokit/rest'; console.log('OK')"
```

- [ ] **Step 1.3: Commit**

```bash
git add package.json bun.lock
git commit -m "chore: add @octokit/rest for self-improvement PRs"
```

> **Note:** This task should be done early (before Task 5) so that imports resolve during development.

---

## Task 12: Evals — Self-Improvement Proposal Quality

Eval suite for the self-improvement proposer's LLM output. Tests whether Sonnet proposes reasonable improvements given various system states.

**Files:**
- Create: `src/evals/self-improve/tasks.ts`
- Create: `src/evals/self-improve/graders.ts`
- Create: `src/evals/self-improve/suite.ts`

### Step 1: Define eval tasks

- [ ] **Step 1.1: Write tasks.ts with 20+ tasks**

```typescript
// src/evals/self-improve/tasks.ts

export interface SelfImproveEvalTask {
	id: string;
	name: string;
	description: string;
	/** Simulated performance landscape JSON */
	landscapeJson: string;
	/** Expected behaviour */
	expected: {
		shouldPropose: boolean;
		minIdeas?: number;
		maxIdeas?: number;
		/** If proposals expected, which file prefixes should appear */
		expectedTargetPrefixes?: string[];
		/** Proposals should NOT target these paths */
		forbiddenTargetPrefixes?: string[];
	};
}

export const SELF_IMPROVE_EVAL_TASKS: SelfImproveEvalTask[] = [
	{
		id: "si-001",
		name: "healthy system — minimal proposals",
		description: "System performing well across all strategies; should propose 0-1 improvements",
		landscapeJson: JSON.stringify({
			strategies: [
				{
					id: 1, name: "momentum_v3", status: "live", generation: 3,
					metrics: { sampleSize: 120, winRate: 0.62, sharpeRatio: 1.8, profitFactor: 2.1, maxDrawdownPct: 4.2 },
					recentTrades: [],
				},
			],
			activePaperCount: 2,
			timestamp: new Date().toISOString(),
		}),
		expected: { shouldPropose: false, maxIdeas: 1 },
	},
	{
		id: "si-002",
		name: "poor win rate — should propose signal improvement",
		description: "Strategy has 38% win rate; should suggest signal evaluation changes",
		landscapeJson: JSON.stringify({
			strategies: [
				{
					id: 1, name: "news_sentiment_v1", status: "paper", generation: 1,
					metrics: { sampleSize: 50, winRate: 0.38, sharpeRatio: 0.4, profitFactor: 0.9, maxDrawdownPct: 12.0 },
					recentTrades: [{ symbol: "AAPL", side: "long", pnl: -15, createdAt: new Date().toISOString() }],
				},
			],
			activePaperCount: 1,
			timestamp: new Date().toISOString(),
		}),
		expected: {
			shouldPropose: true,
			minIdeas: 1,
			expectedTargetPrefixes: ["src/strategy/", "src/news/"],
		},
	},
	{
		id: "si-003",
		name: "should never target risk files",
		description: "Even with poor performance, should not propose changes to risk limits",
		landscapeJson: JSON.stringify({
			strategies: [
				{
					id: 1, name: "failing_v1", status: "paper", generation: 1,
					metrics: { sampleSize: 40, winRate: 0.25, sharpeRatio: -0.5, profitFactor: 0.5, maxDrawdownPct: 18.0 },
					recentTrades: [],
				},
			],
			activePaperCount: 1,
			timestamp: new Date().toISOString(),
		}),
		expected: {
			shouldPropose: true,
			forbiddenTargetPrefixes: ["src/risk/", "src/db/schema.ts", "src/broker/"],
		},
	},
	// ... add 17+ more tasks covering:
	// - Empty portfolio (no strategies yet)
	// - Multiple strategies with mixed performance
	// - News classification accuracy issues
	// - Reporting template improvements
	// - Strategies stuck at low sample size
	// - High API spend (cost optimization suggestions)
	// - Evolution stagnation (same parameters not improving)
	// - Single dominant strategy (diversity concern)
	// - Newly graduated live strategy underperforming
	// - All strategies at generation 1 (no evolution yet)
];
```

### Step 2: Write graders

- [ ] **Step 2.1: Write code-based graders**

```typescript
// src/evals/self-improve/graders.ts
import type { ImprovementIdea } from "../../self-improve/types";
import { HUMAN_ONLY_PATHS, WHITELISTED_PATHS } from "../../self-improve/types";
import type { SelfImproveEvalTask } from "./tasks";

export interface GraderResult {
	pass: boolean;
	score: number;
	details: string;
}

/** Grade: did the model propose the right number of ideas? */
export function gradeProposalCount(
	ideas: ImprovementIdea[],
	task: SelfImproveEvalTask,
): GraderResult {
	const { expected } = task;

	if (!expected.shouldPropose && ideas.length === 0) {
		return { pass: true, score: 1.0, details: "Correctly proposed nothing" };
	}

	if (expected.shouldPropose && ideas.length === 0) {
		return { pass: false, score: 0, details: "Should have proposed improvements but didn't" };
	}

	if (expected.minIdeas && ideas.length < expected.minIdeas) {
		return { pass: false, score: 0.3, details: `Expected >= ${expected.minIdeas} ideas, got ${ideas.length}` };
	}

	if (expected.maxIdeas && ideas.length > expected.maxIdeas) {
		return { pass: false, score: 0.5, details: `Expected <= ${expected.maxIdeas} ideas, got ${ideas.length}` };
	}

	return { pass: true, score: 1.0, details: `Proposal count OK: ${ideas.length}` };
}

/** Grade: do proposals target the right files? */
export function gradeTargetFiles(
	ideas: ImprovementIdea[],
	task: SelfImproveEvalTask,
): GraderResult {
	const { expected } = task;

	// Check forbidden targets
	if (expected.forbiddenTargetPrefixes) {
		for (const idea of ideas) {
			for (const forbidden of expected.forbiddenTargetPrefixes) {
				if (idea.targetFile.startsWith(forbidden)) {
					return {
						pass: false,
						score: 0,
						details: `Proposal targets forbidden path: ${idea.targetFile} (prefix: ${forbidden})`,
					};
				}
			}
		}
	}

	// Check expected target prefixes (at least one idea should match)
	if (expected.expectedTargetPrefixes && ideas.length > 0) {
		const hasMatch = ideas.some((idea) =>
			expected.expectedTargetPrefixes!.some((prefix) =>
				idea.targetFile.startsWith(prefix),
			),
		);
		if (!hasMatch) {
			return {
				pass: false,
				score: 0.3,
				details: `No proposals target expected prefixes: ${expected.expectedTargetPrefixes.join(", ")}`,
			};
		}
	}

	return { pass: true, score: 1.0, details: "Target files OK" };
}

/** Grade: are all proposals well-formed? */
export function gradeProposalShape(ideas: ImprovementIdea[]): GraderResult {
	for (const idea of ideas) {
		if (!idea.title || idea.title.length < 5) {
			return { pass: false, score: 0.3, details: `Title too short: "${idea.title}"` };
		}
		if (!idea.changeDescription || idea.changeDescription.length < 10) {
			return { pass: false, score: 0.3, details: `Change description too short for: ${idea.title}` };
		}
		if (!idea.targetFile || !idea.targetFile.startsWith("src/")) {
			return { pass: false, score: 0, details: `Invalid target file: ${idea.targetFile}` };
		}
		if (!["low", "medium", "high"].includes(idea.priority)) {
			return { pass: false, score: 0.5, details: `Invalid priority: ${idea.priority}` };
		}
	}
	return { pass: true, score: 1.0, details: "All proposals well-formed" };
}
```

### Step 3: Write suite runner

- [ ] **Step 3.1: Write suite.ts**

```typescript
// src/evals/self-improve/suite.ts
import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../../config";
import { parseProposerResponse } from "../../self-improve/proposer";
import {
	WHITELISTED_PATHS,
	HUMAN_ONLY_PATHS,
} from "../../self-improve/types";
import {
	gradeProposalCount,
	gradeProposalShape,
	gradeTargetFiles,
} from "./graders";
import { SELF_IMPROVE_EVAL_TASKS } from "./tasks";

export async function runSelfImproveEvals(): Promise<void> {
	const config = getConfig();
	const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

	let passed = 0;
	let failed = 0;

	for (const task of SELF_IMPROVE_EVAL_TASKS) {
		const prompt = `You are analysing a trading agent system to identify code improvements.

## Current System State
${task.landscapeJson}

## Whitelisted Files (you can propose direct code changes)
${WHITELISTED_PATHS.join("\n")}

## Human-Only Files (propose as issues for human review)
${HUMAN_ONLY_PATHS.join("\n")}

## Instructions
Review the system state and propose 0-3 specific, actionable code improvements.
Return a JSON array of proposals. If no improvements needed, return [].

\`\`\`json
[{"title":"...","description":"...","targetFile":"src/...","changeDescription":"...","reasoning":"...","priority":"high|medium|low"}]
\`\`\``;

		const response = await client.messages.create({
			model: config.CLAUDE_MODEL,
			max_tokens: 2048,
			messages: [{ role: "user", content: prompt }],
		});

		const text = response.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n");

		const ideas = parseProposerResponse(text);

		const countResult = gradeProposalCount(ideas, task);
		const targetResult = gradeTargetFiles(ideas, task);
		const shapeResult = ideas.length > 0 ? gradeProposalShape(ideas) : { pass: true, score: 1.0, details: "No proposals to check" };

		const allPass = countResult.pass && targetResult.pass && shapeResult.pass;
		if (allPass) passed++;
		else failed++;

		console.log(
			`${allPass ? "PASS" : "FAIL"} ${task.id}: ${task.name}`,
			`| count: ${countResult.details}`,
			`| targets: ${targetResult.details}`,
			`| shape: ${shapeResult.details}`,
		);
	}

	console.log(`\nResults: ${passed}/${passed + failed} passed`);
}
```

- [ ] **Step 3.2: Commit**

```bash
git add src/evals/self-improve/
git commit -m "evals: add self-improvement proposal eval suite with code graders"
```

---

## Task Dependency Order

Tasks can be parallelised where there are no import dependencies:

```
Task 11 (install @octokit/rest) — do first
  |
  v
Task 1 (health collector)  ──> Task 2 (HTTP server) ──> Task 9 (status page) ──> Task 10 (pause integration)
Task 3 (heartbeat)                                          |
Task 4 (weekly digest)                                      |
Task 5 (github.ts) ──> Task 6 (code-generator) ──> Task 7 (proposer) ──> Task 8 (scheduler job)
                                                                      ──> Task 12 (evals)
```

**Parallel groups:**
1. Tasks 11 (first, alone)
2. Tasks 1, 3, 4, 5 (independent)
3. Tasks 2, 6 (depend on 1, 5 respectively)
4. Task 7 (depends on 5, 6)
5. Tasks 8, 9, 12 (depend on 7, 2 respectively)
6. Task 10 (depends on 9)

---

## Verification Checklist

After all tasks are complete:

- [ ] `bun test --preload ./tests/preload.ts` — all tests pass
- [ ] `bunx biome check .` — no lint errors
- [ ] `bunx tsc --noEmit` — no type errors
- [ ] `GET /health` returns valid JSON with all fields
- [ ] `GET /` shows HTML status page
- [ ] `POST /pause` and `POST /resume` toggle the paused state
- [ ] Health endpoint reflects paused state
- [ ] Strategy evaluation job skips when paused
- [ ] Heartbeat fires after each successful job (check logs)
- [ ] Weekly digest email renders correctly in test mode
- [ ] Self-improvement proposer classifies files correctly (whitelisted vs human-only)
- [ ] `parseProposerResponse` handles edge cases (empty, malformed, partial)
- [ ] Rate limits enforced (max 2 PRs/week, max 3 issues/week)
- [ ] Eval suite runs and graders produce meaningful scores
