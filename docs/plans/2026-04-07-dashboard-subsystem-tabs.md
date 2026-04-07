# Dashboard Subsystem Tabs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four tabbed views (News Pipeline, Guardian, Learning Loop, Trades) to the existing monitoring dashboard so subsystem activity already in the DB is surfaced.

**Architecture:** Extend the existing single-page HTML renderer with a `?tab=<name>` query parameter. Each tab has its own data-fetching function in `dashboard-data.ts` and its own content renderer in `status-page.ts`. The shared chrome (status bar, tab bar, CSS, footer) renders once; only the body swaps per tab.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, SQLite, server-rendered HTML

---

### Task 1: News Pipeline Data Fetcher

**Files:**
- Modify: `src/monitoring/dashboard-data.ts`
- Test: `tests/monitoring/dashboard-data.test.ts`

- [ ] **Step 1: Write the failing test for `getNewsPipelineData` with empty table**

Add to `tests/monitoring/dashboard-data.test.ts`:

```typescript
import {
	agentLogs,
	livePositions,
	liveTrades,
	newsEvents,
	paperTrades,
	riskState,
	strategies,
	strategyMetrics,
	tradeInsights,
} from "../../src/db/schema.ts";

// Add newsEvents to the beforeEach cleanup:
// db.delete(newsEvents).run();

describe("getNewsPipelineData", () => {
	test("returns zeroed stats with empty table", async () => {
		const { getNewsPipelineData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getNewsPipelineData();

		expect(data.totalArticles24h).toBe(0);
		expect(data.classifiedCount).toBe(0);
		expect(data.tradeableHighUrgency).toBe(0);
		expect(data.avgSentiment).toBe(0);
		expect(data.recentArticles).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "returns zeroed stats with empty table"`
Expected: FAIL — `getNewsPipelineData` is not exported.

- [ ] **Step 3: Implement `getNewsPipelineData`**

Add to `src/monitoring/dashboard-data.ts`:

```typescript
import {
	newsEvents,
	tradeInsights,
	paperTrades,
} from "../db/schema.ts";
// (add these to the existing import from ../db/schema.ts)
```

Add the interface and function:

```typescript
export interface NewsPipelineData {
	totalArticles24h: number;
	classifiedCount: number;
	tradeableHighUrgency: number;
	avgSentiment: number;
	recentArticles: Array<{
		time: string;
		symbols: string[];
		headline: string;
		sentiment: number | null;
		confidence: number | null;
		urgency: string | null;
		eventType: string | null;
		tradeable: boolean | null;
	}>;
}

export async function getNewsPipelineData(): Promise<NewsPipelineData> {
	const db = getDb();
	const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	const totalRow = db
		.select({ count: sql<number>`count(*)` })
		.from(newsEvents)
		.where(sql`${newsEvents.createdAt} >= ${cutoff}`)
		.get();
	const totalArticles24h = totalRow?.count ?? 0;

	const classifiedRow = db
		.select({ count: sql<number>`count(*)` })
		.from(newsEvents)
		.where(sql`${newsEvents.createdAt} >= ${cutoff} AND ${newsEvents.sentiment} IS NOT NULL`)
		.get();
	const classifiedCount = classifiedRow?.count ?? 0;

	const tradeableRow = db
		.select({ count: sql<number>`count(*)` })
		.from(newsEvents)
		.where(
			sql`${newsEvents.createdAt} >= ${cutoff} AND ${newsEvents.tradeable} = 1 AND ${newsEvents.urgency} = 'high'`,
		)
		.get();
	const tradeableHighUrgency = tradeableRow?.count ?? 0;

	const avgRow = db
		.select({ avg: sql<number | null>`avg(${newsEvents.sentiment})` })
		.from(newsEvents)
		.where(sql`${newsEvents.createdAt} >= ${cutoff} AND ${newsEvents.sentiment} IS NOT NULL`)
		.get();
	const avgSentiment = avgRow?.avg ?? 0;

	const recent = db
		.select({
			createdAt: newsEvents.createdAt,
			symbols: newsEvents.symbols,
			headline: newsEvents.headline,
			sentiment: newsEvents.sentiment,
			confidence: newsEvents.confidence,
			urgency: newsEvents.urgency,
			eventType: newsEvents.eventType,
			tradeable: newsEvents.tradeable,
		})
		.from(newsEvents)
		.orderBy(desc(newsEvents.createdAt))
		.limit(50)
		.all();

	const recentArticles = recent.map((r) => ({
		time: new Date(r.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		symbols: JSON.parse(r.symbols ?? "[]") as string[],
		headline: r.headline,
		sentiment: r.sentiment,
		confidence: r.confidence,
		urgency: r.urgency,
		eventType: r.eventType,
		tradeable: r.tradeable,
	}));

	return {
		totalArticles24h,
		classifiedCount,
		tradeableHighUrgency,
		avgSentiment,
		recentArticles,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "returns zeroed stats with empty table"`
Expected: PASS

- [ ] **Step 5: Write test with populated data**

Add to the `getNewsPipelineData` describe block:

```typescript
test("computes stats from news_events rows", async () => {
	const { getDb } = await import("../../src/db/client.ts");
	const { getNewsPipelineData } = await import("../../src/monitoring/dashboard-data.ts");
	const db = getDb();

	// Insert 3 articles: 2 classified, 1 tradeable+high-urgency
	db.insert(newsEvents)
		.values([
			{
				source: "finnhub",
				headline: "Shell raises dividend",
				symbols: '["SHEL.L"]',
				sentiment: 0.8,
				confidence: 0.9,
				tradeable: true,
				eventType: "dividend",
				urgency: "high",
			},
			{
				source: "finnhub",
				headline: "BP CEO comments",
				symbols: '["BP.L"]',
				sentiment: 0.1,
				confidence: 0.5,
				tradeable: false,
				eventType: "management",
				urgency: "low",
			},
			{
				source: "finnhub",
				headline: "Unclassified article",
				symbols: '["VOD.L"]',
				sentiment: null,
				confidence: null,
				tradeable: null,
				eventType: null,
				urgency: null,
			},
		])
		.run();

	const data = await getNewsPipelineData();
	expect(data.totalArticles24h).toBe(3);
	expect(data.classifiedCount).toBe(2);
	expect(data.tradeableHighUrgency).toBe(1);
	expect(data.avgSentiment).toBeCloseTo(0.45, 1);
	expect(data.recentArticles.length).toBe(3);
	expect(data.recentArticles[0]!.headline).toBe("Unclassified article"); // most recent first
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "computes stats from news_events"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/monitoring/dashboard-data.ts tests/monitoring/dashboard-data.test.ts
git commit -m "feat(monitoring): add getNewsPipelineData fetcher"
```

---

### Task 2: Guardian Data Fetcher

**Files:**
- Modify: `src/monitoring/dashboard-data.ts`
- Test: `tests/monitoring/dashboard-data.test.ts`

- [ ] **Step 1: Write the failing test for `getGuardianData` with empty state**

Add to `tests/monitoring/dashboard-data.test.ts`:

```typescript
describe("getGuardianData", () => {
	test("returns defaults with empty risk_state", async () => {
		const { getGuardianData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getGuardianData();

		expect(data.circuitBreaker.active).toBe(false);
		expect(data.dailyHalt.active).toBe(false);
		expect(data.weeklyDrawdown.active).toBe(false);
		expect(data.peakBalance).toBe(0);
		expect(data.accountBalance).toBe(0);
		expect(data.checkHistory).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "returns defaults with empty risk_state"`
Expected: FAIL — `getGuardianData` not exported.

- [ ] **Step 3: Implement `getGuardianData`**

Add to `src/monitoring/dashboard-data.ts`:

```typescript
import {
	DAILY_LOSS_HALT_PCT,
	MAX_CONCURRENT_POSITIONS,
	MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT,
	WEEKLY_DRAWDOWN_LIMIT_PCT,
} from "../risk/constants.ts";
// (add MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT to the existing import)
```

```typescript
export interface GuardianData {
	circuitBreaker: { active: boolean; drawdownPct: number; limitPct: number };
	dailyHalt: { active: boolean; lossPct: number; limitPct: number };
	weeklyDrawdown: { active: boolean; lossPct: number; limitPct: number };
	peakBalance: number;
	accountBalance: number;
	checkHistory: Array<{
		time: string;
		level: string;
		message: string;
	}>;
}

export async function getGuardianData(): Promise<GuardianData> {
	const db = getDb();

	// Read all risk_state keys in one query
	const stateRows = db.select().from(riskState).all();
	const state = new Map(stateRows.map((r) => [r.key, r.value]));

	const circuitBreakerActive = state.get("circuit_breaker_tripped") === "true";
	const dailyHaltActive = state.get("daily_halt_active") === "true";
	const weeklyDrawdownActive = state.get("weekly_drawdown_active") === "true";
	const peakBalance = Number.parseFloat(state.get("peak_balance") ?? "0") || 0;
	const accountBalance = Number.parseFloat(state.get("account_balance") ?? "0") || 0;
	const dailyPnl = Number.parseFloat(state.get("daily_pnl") ?? "0") || 0;
	const weeklyPnl = Number.parseFloat(state.get("weekly_pnl") ?? "0") || 0;

	// Compute drawdown percentage
	const drawdownPct = peakBalance > 0 ? ((peakBalance - accountBalance) / peakBalance) * 100 : 0;

	// Compute daily/weekly loss as percentage of account balance
	const dailyLossPct = accountBalance > 0 ? (Math.abs(Math.min(0, dailyPnl)) / accountBalance) * 100 : 0;
	const weeklyLossPct = accountBalance > 0 ? (Math.abs(Math.min(0, weeklyPnl)) / accountBalance) * 100 : 0;

	// Guardian check history from agent_logs
	const logs = db
		.select({
			createdAt: agentLogs.createdAt,
			level: agentLogs.level,
			message: agentLogs.message,
		})
		.from(agentLogs)
		.where(eq(agentLogs.phase, "risk_guardian"))
		.orderBy(desc(agentLogs.createdAt))
		.limit(30)
		.all();

	const checkHistory = logs.map((l) => ({
		time: new Date(l.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		level: l.level,
		message: l.message,
	}));

	return {
		circuitBreaker: {
			active: circuitBreakerActive,
			drawdownPct: Math.round(drawdownPct * 10) / 10,
			limitPct: MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT * 100,
		},
		dailyHalt: {
			active: dailyHaltActive,
			lossPct: Math.round(dailyLossPct * 10) / 10,
			limitPct: DAILY_LOSS_HALT_PCT * 100,
		},
		weeklyDrawdown: {
			active: weeklyDrawdownActive,
			lossPct: Math.round(weeklyLossPct * 10) / 10,
			limitPct: WEEKLY_DRAWDOWN_LIMIT_PCT * 100,
		},
		peakBalance,
		accountBalance,
		checkHistory,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "returns defaults with empty risk_state"`
Expected: PASS

- [ ] **Step 5: Write test with populated state and logs**

```typescript
test("reads risk flags and guardian log history", async () => {
	const { getDb } = await import("../../src/db/client.ts");
	const { getGuardianData } = await import("../../src/monitoring/dashboard-data.ts");
	const db = getDb();

	db.insert(riskState)
		.values([
			{ key: "circuit_breaker_tripped", value: "false" },
			{ key: "daily_halt_active", value: "true" },
			{ key: "weekly_drawdown_active", value: "false" },
			{ key: "peak_balance", value: "10000" },
			{ key: "account_balance", value: "9700" },
			{ key: "daily_pnl", value: "-250" },
			{ key: "weekly_pnl", value: "-100" },
		])
		.run();

	db.insert(agentLogs)
		.values({
			level: "WARN",
			phase: "risk_guardian",
			message: "Daily loss approaching halt threshold",
		})
		.run();

	const data = await getGuardianData();
	expect(data.circuitBreaker.active).toBe(false);
	expect(data.dailyHalt.active).toBe(true);
	expect(data.weeklyDrawdown.active).toBe(false);
	expect(data.circuitBreaker.drawdownPct).toBe(3); // (10000-9700)/10000 * 100
	expect(data.dailyHalt.lossPct).toBe(2.6); // 250/9700 * 100 ≈ 2.6
	expect(data.peakBalance).toBe(10000);
	expect(data.accountBalance).toBe(9700);
	expect(data.checkHistory.length).toBe(1);
	expect(data.checkHistory[0]!.level).toBe("WARN");
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "reads risk flags and guardian log history"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/monitoring/dashboard-data.ts tests/monitoring/dashboard-data.test.ts
git commit -m "feat(monitoring): add getGuardianData fetcher"
```

---

### Task 3: Learning Loop Data Fetcher

**Files:**
- Modify: `src/monitoring/dashboard-data.ts`
- Test: `tests/monitoring/dashboard-data.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/monitoring/dashboard-data.test.ts`:

```typescript
// Add tradeInsights to the beforeEach cleanup:
// db.delete(tradeInsights).run();

describe("getLearningLoopData", () => {
	test("returns zeroed stats with empty table", async () => {
		const { getLearningLoopData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getLearningLoopData();

		expect(data.insightsCount7d).toBe(0);
		expect(data.ledToImprovement).toBe(0);
		expect(data.patternsFound).toBe(0);
		expect(data.recentInsights).toEqual([]);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "getLearningLoopData.*returns zeroed"`
Expected: FAIL — `getLearningLoopData` not exported.

- [ ] **Step 3: Implement `getLearningLoopData`**

Add to `src/monitoring/dashboard-data.ts`:

```typescript
export interface LearningLoopData {
	insightsCount7d: number;
	ledToImprovement: number;
	patternsFound: number;
	recentInsights: Array<{
		time: string;
		insightType: string;
		observation: string;
		suggestedAction: string | null;
		confidence: number | null;
		tags: string[];
		ledToImprovement: boolean | null;
	}>;
}

export async function getLearningLoopData(): Promise<LearningLoopData> {
	const db = getDb();
	const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

	const totalRow = db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(sql`${tradeInsights.createdAt} >= ${cutoff}`)
		.get();
	const insightsCount7d = totalRow?.count ?? 0;

	const improvedRow = db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(sql`${tradeInsights.createdAt} >= ${cutoff} AND ${tradeInsights.ledToImprovement} = 1`)
		.get();
	const ledToImprovement = improvedRow?.count ?? 0;

	const patternsRow = db
		.select({ count: sql<number>`count(*)` })
		.from(tradeInsights)
		.where(
			sql`${tradeInsights.createdAt} >= ${cutoff} AND ${tradeInsights.insightType} = 'pattern_analysis'`,
		)
		.get();
	const patternsFound = patternsRow?.count ?? 0;

	const recent = db
		.select({
			createdAt: tradeInsights.createdAt,
			insightType: tradeInsights.insightType,
			observation: tradeInsights.observation,
			suggestedAction: tradeInsights.suggestedAction,
			confidence: tradeInsights.confidence,
			tags: tradeInsights.tags,
			ledToImprovement: tradeInsights.ledToImprovement,
		})
		.from(tradeInsights)
		.orderBy(desc(tradeInsights.createdAt))
		.limit(30)
		.all();

	const recentInsights = recent.map((r) => ({
		time: new Date(r.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		insightType: r.insightType,
		observation: r.observation,
		suggestedAction: r.suggestedAction,
		confidence: r.confidence,
		tags: JSON.parse(r.tags ?? "[]") as string[],
		ledToImprovement: r.ledToImprovement,
	}));

	return { insightsCount7d, ledToImprovement, patternsFound, recentInsights };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "getLearningLoopData.*returns zeroed"`
Expected: PASS

- [ ] **Step 5: Write test with populated data**

```typescript
test("computes stats from trade_insights rows", async () => {
	const { getDb } = await import("../../src/db/client.ts");
	const { getLearningLoopData } = await import("../../src/monitoring/dashboard-data.ts");
	const db = getDb();

	db.insert(tradeInsights)
		.values([
			{
				strategyId: 1,
				insightType: "trade_review",
				observation: "Late exits on SHEL.L",
				confidence: 0.85,
				tags: '["timing","exits"]',
				ledToImprovement: true,
			},
			{
				strategyId: 1,
				insightType: "pattern_analysis",
				observation: "Monday underperformance in momentum",
				confidence: 0.72,
				tags: '["timing","momentum"]',
				ledToImprovement: false,
			},
			{
				strategyId: 2,
				insightType: "trade_review",
				observation: "Good entry on BP.L dip",
				confidence: 0.6,
				tags: '["entries"]',
				ledToImprovement: null,
			},
		])
		.run();

	const data = await getLearningLoopData();
	expect(data.insightsCount7d).toBe(3);
	expect(data.ledToImprovement).toBe(1);
	expect(data.patternsFound).toBe(1);
	expect(data.recentInsights.length).toBe(3);
	expect(data.recentInsights[0]!.tags).toEqual(["entries"]); // most recent
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "computes stats from trade_insights"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/monitoring/dashboard-data.ts tests/monitoring/dashboard-data.test.ts
git commit -m "feat(monitoring): add getLearningLoopData fetcher"
```

---

### Task 4: Trade Activity Data Fetcher

**Files:**
- Modify: `src/monitoring/dashboard-data.ts`
- Test: `tests/monitoring/dashboard-data.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/monitoring/dashboard-data.test.ts`:

```typescript
// Add paperTrades to the beforeEach cleanup:
// db.delete(paperTrades).run();

describe("getTradeActivityData", () => {
	test("returns empty data with no trades", async () => {
		const { getTradeActivityData } = await import("../../src/monitoring/dashboard-data.ts");
		const data = await getTradeActivityData();

		expect(data.trades).toEqual([]);
		expect(data.tradesToday).toBe(0);
		expect(data.winRateToday).toBeNull();
		expect(data.avgWinner).toBeNull();
		expect(data.avgLoser).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "returns empty data with no trades"`
Expected: FAIL — `getTradeActivityData` not exported.

- [ ] **Step 3: Implement `getTradeActivityData`**

Add to `src/monitoring/dashboard-data.ts`:

```typescript
export interface TradeActivityData {
	trades: Array<{
		time: string;
		symbol: string;
		exchange: string;
		side: string;
		price: number;
		pnl: number | null;
		strategyName: string;
		signalType: string;
		reasoning: string | null;
	}>;
	tradesToday: number;
	winRateToday: number | null;
	avgWinner: number | null;
	avgLoser: number | null;
}

export async function getTradeActivityData(): Promise<TradeActivityData> {
	const db = getDb();

	const recent = db
		.select({
			createdAt: paperTrades.createdAt,
			symbol: paperTrades.symbol,
			exchange: paperTrades.exchange,
			side: paperTrades.side,
			price: paperTrades.price,
			pnl: paperTrades.pnl,
			signalType: paperTrades.signalType,
			reasoning: paperTrades.reasoning,
			strategyName: strategies.name,
		})
		.from(paperTrades)
		.leftJoin(strategies, eq(paperTrades.strategyId, strategies.id))
		.orderBy(desc(paperTrades.createdAt))
		.limit(50)
		.all();

	const trades = recent.map((r) => ({
		time: new Date(r.createdAt).toLocaleTimeString("en-GB", {
			hour: "2-digit",
			minute: "2-digit",
			timeZone: "UTC",
		}),
		symbol: r.symbol,
		exchange: r.exchange,
		side: r.side,
		price: r.price,
		pnl: r.pnl,
		strategyName: r.strategyName ?? "unknown",
		signalType: r.signalType,
		reasoning: r.reasoning ? r.reasoning.substring(0, 80) : null,
	}));

	// Today's summary stats
	const today = new Date().toISOString().split("T")[0]!;

	const todayCountRow = db
		.select({ count: sql<number>`count(*)` })
		.from(paperTrades)
		.where(sql`date(${paperTrades.createdAt}) = ${today}`)
		.get();
	const tradesToday = todayCountRow?.count ?? 0;

	const todayWithPnl = db
		.select({ pnl: paperTrades.pnl })
		.from(paperTrades)
		.where(sql`date(${paperTrades.createdAt}) = ${today} AND ${paperTrades.pnl} IS NOT NULL`)
		.all();

	let winRateToday: number | null = null;
	let avgWinner: number | null = null;
	let avgLoser: number | null = null;

	if (todayWithPnl.length > 0) {
		const winners = todayWithPnl.filter((t) => t.pnl! > 0);
		const losers = todayWithPnl.filter((t) => t.pnl! < 0);
		winRateToday = winners.length / todayWithPnl.length;
		if (winners.length > 0) {
			avgWinner = winners.reduce((sum, t) => sum + t.pnl!, 0) / winners.length;
		}
		if (losers.length > 0) {
			avgLoser = losers.reduce((sum, t) => sum + t.pnl!, 0) / losers.length;
		}
	}

	return { trades, tradesToday, winRateToday, avgWinner, avgLoser };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "returns empty data with no trades"`
Expected: PASS

- [ ] **Step 5: Write test with populated trades**

```typescript
test("computes trade stats with populated data", async () => {
	const { getDb } = await import("../../src/db/client.ts");
	const { getTradeActivityData } = await import("../../src/monitoring/dashboard-data.ts");
	const db = getDb();

	const [s] = db
		.insert(strategies)
		.values({
			name: "mom_v3",
			description: "momentum",
			parameters: "{}",
			signals: '{"entry_long":"price>0"}',
			universe: '["SHEL.L"]',
			status: "paper",
		})
		.returning()
		.all();

	db.insert(paperTrades)
		.values([
			{
				strategyId: s!.id,
				symbol: "SHEL.L",
				exchange: "LSE",
				side: "BUY",
				quantity: 100,
				price: 2340,
				signalType: "entry_long",
				reasoning: "News catalyst: dividend raise",
				pnl: 170,
			},
			{
				strategyId: s!.id,
				symbol: "LLOY.L",
				exchange: "LSE",
				side: "BUY",
				quantity: 1000,
				price: 54.2,
				signalType: "entry_long",
				reasoning: "Momentum breakout",
				pnl: -14,
			},
		])
		.run();

	const data = await getTradeActivityData();
	expect(data.trades.length).toBe(2);
	expect(data.trades[0]!.strategyName).toBe("mom_v3");
	expect(data.tradesToday).toBe(2);
	expect(data.winRateToday).toBe(0.5);
	expect(data.avgWinner).toBe(170);
	expect(data.avgLoser).toBe(-14);
});
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/monitoring/dashboard-data.test.ts --test-name-pattern "computes trade stats with populated"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/monitoring/dashboard-data.ts tests/monitoring/dashboard-data.test.ts
git commit -m "feat(monitoring): add getTradeActivityData fetcher"
```

---

### Task 5: Server Tab Routing

**Files:**
- Modify: `src/monitoring/server.ts`
- Test: `tests/monitoring/server.test.ts`

- [ ] **Step 1: Write failing tests for tab routing**

Add to `tests/monitoring/server.test.ts`:

```typescript
test("GET /?tab=news returns HTML with news tab active", async () => {
	const port = 39853;
	startServer(port);

	const res = await fetch(`http://localhost:${port}/?tab=news`);
	expect(res.status).toBe(200);
	expect(res.headers.get("content-type")).toContain("text/html");

	const html = await res.text();
	expect(html).toContain("News Pipeline");
});

test("POST /pause redirects back to current tab", async () => {
	const port = 39854;
	startServer(port);

	const res = await fetch(`http://localhost:${port}/pause?tab=guardian`, {
		method: "POST",
		redirect: "manual",
	});
	expect(res.status).toBe(303);
	expect(res.headers.get("location")).toBe("/?tab=guardian");
});

test("GET /?tab=invalid falls back to overview", async () => {
	const port = 39855;
	startServer(port);

	const res = await fetch(`http://localhost:${port}/?tab=invalid`);
	expect(res.status).toBe(200);

	const html = await res.text();
	expect(html).toContain("Strategy Pipeline"); // overview content
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/monitoring/server.test.ts --test-name-pattern "tab"`
Expected: FAIL — current server doesn't handle tabs.

- [ ] **Step 3: Update server to handle tab routing**

Replace the dashboard and pause/resume handlers in `src/monitoring/server.ts`:

Update the imports at the top of the file:

```typescript
import { getDashboardData, getGuardianData, getLearningLoopData, getNewsPipelineData, getTradeActivityData } from "./dashboard-data";
import { buildConsolePage, buildGuardianTab, buildLearningLoopTab, buildNewsPipelineTab, buildTradeActivityTab } from "./status-page";
```

Replace the dashboard handler (the `GET /` block):

```typescript
// Dashboard console
if (req.method === "GET" && url.pathname === "/") {
	try {
		const validTabs = ["overview", "news", "guardian", "learning", "trades"];
		const tab = validTabs.includes(url.searchParams.get("tab") ?? "")
			? (url.searchParams.get("tab") as string)
			: "overview";

		let tabHtml: string;
		if (tab === "news") {
			const tabData = await getNewsPipelineData();
			tabHtml = buildNewsPipelineTab(tabData);
		} else if (tab === "guardian") {
			const tabData = await getGuardianData();
			tabHtml = buildGuardianTab(tabData);
		} else if (tab === "learning") {
			const tabData = await getLearningLoopData();
			tabHtml = buildLearningLoopTab(tabData);
		} else if (tab === "trades") {
			const tabData = await getTradeActivityData();
			tabHtml = buildTradeActivityTab(tabData);
		} else {
			tabHtml = ""; // overview uses buildConsolePage directly
		}

		const data = await getDashboardData();
		const html = buildConsolePage(data, tab, tabHtml);
		return new Response(html, {
			headers: { "content-type": "text/html; charset=utf-8" },
		});
	} catch (err) {
		log.error({ err }, "Dashboard page failed");
		return new Response("Internal Server Error", { status: 500 });
	}
}
```

Replace the pause handler:

```typescript
// Pause trading
if (req.method === "POST" && url.pathname === "/pause") {
	setPaused(true);
	log.warn("Trading paused via HTTP");
	const tab = url.searchParams.get("tab");
	const redirect = tab ? `/?tab=${tab}` : "/";
	return new Response(null, {
		status: 303,
		headers: { location: redirect },
	});
}

// Resume trading
if (req.method === "POST" && url.pathname === "/resume") {
	setPaused(false);
	log.info("Trading resumed via HTTP");
	const tab = url.searchParams.get("tab");
	const redirect = tab ? `/?tab=${tab}` : "/";
	return new Response(null, {
		status: 303,
		headers: { location: redirect },
	});
}
```

Note: The `buildConsolePage` signature change and tab renderers are implemented in Task 6. This task will fail to compile until Task 6 is done — that's expected. The tests validate the routing logic once both tasks are complete.

- [ ] **Step 4: Commit (server routing changes)**

```bash
git add src/monitoring/server.ts tests/monitoring/server.test.ts
git commit -m "feat(monitoring): add tab routing to HTTP server"
```

---

### Task 6: Tab Bar and Tab Content Renderers in status-page.ts

**Files:**
- Modify: `src/monitoring/status-page.ts`
- Test: `tests/monitoring/status-page.test.ts`

- [ ] **Step 1: Write failing tests for the updated `buildConsolePage` signature**

Add to `tests/monitoring/status-page.test.ts`:

```typescript
import type { GuardianData, LearningLoopData, NewsPipelineData, TradeActivityData } from "../../src/monitoring/dashboard-data";

test("renders tab bar with overview active by default", () => {
	const html = buildConsolePage(baseData, "overview", "");
	expect(html).toContain("tab-bar");
	expect(html).toContain('href="/"');
	expect(html).toContain('href="/?tab=news"');
	expect(html).toContain('href="/?tab=guardian"');
	expect(html).toContain('href="/?tab=learning"');
	expect(html).toContain('href="/?tab=trades"');
});

test("preserves tab in meta refresh tag", () => {
	const html = buildConsolePage(baseData, "news", "<div>news content</div>");
	expect(html).toContain('content="30;url=/?tab=news"');
});

test("renders tab content instead of overview when tab is not overview", () => {
	const html = buildConsolePage(baseData, "news", "<div>NEWS_TAB_CONTENT</div>");
	expect(html).toContain("NEWS_TAB_CONTENT");
	expect(html).not.toContain("Strategy Pipeline");
});

test("preserves tab in pause/resume form action", () => {
	const html = buildConsolePage(baseData, "guardian", "<div>guardian</div>");
	expect(html).toContain('action="/pause?tab=guardian"');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "tab"`
Expected: FAIL — `buildConsolePage` doesn't accept `tab` and `tabHtml` params.

- [ ] **Step 3: Update `buildConsolePage` to accept tab params and render tab bar**

In `src/monitoring/status-page.ts`, update the function signature:

```typescript
export function buildConsolePage(data: DashboardData, tab = "overview", tabHtml = ""): string {
```

Add a tab bar builder function:

```typescript
function buildTabBar(activeTab: string): string {
	const tabs = [
		{ id: "overview", label: "Overview", href: "/" },
		{ id: "news", label: "News Pipeline", href: "/?tab=news" },
		{ id: "guardian", label: "Guardian", href: "/?tab=guardian" },
		{ id: "learning", label: "Learning Loop", href: "/?tab=learning" },
		{ id: "trades", label: "Trades", href: "/?tab=trades" },
	];
	const links = tabs
		.map((t) => {
			const cls = t.id === activeTab ? "tab-link active" : "tab-link";
			return `<a href="${t.href}" class="${cls}">${t.label}</a>`;
		})
		.join("\n");
	return `<div class="tab-bar">${links}</div>`;
}
```

Add the new CSS classes inside the `<style>` block (after the `.footer-bar` rule):

```css
.tab-bar{display:flex;gap:0;background:#0a0a0a;border-bottom:1px solid #1a1a1a;padding:0 16px}
.tab-link{padding:10px 20px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#555;border-bottom:2px solid transparent;text-decoration:none;font-family:inherit}
.tab-link:hover{color:#888}
.tab-link.active{color:#f59e0b;border-bottom-color:#f59e0b}
.stat-cards{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#1a1a1a;margin-bottom:16px}
.stat-card{background:#0a0a0a;padding:10px 14px}
.stat-card .sc-label{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}
.stat-card .sc-value{font-size:16px;font-weight:600}
.stat-card .sc-sub{color:#333;font-size:9px;margin-top:2px}
.insight-card{padding:10px;background:#0a0a0a;border:1px solid #1a1a1a;border-radius:3px;margin-bottom:6px}
.insight-card .ic-header{display:flex;justify-content:space-between;margin-bottom:4px}
.insight-card .ic-body{color:#888;font-size:11px}
.insight-card .ic-meta{color:#444;font-size:9px;margin-top:4px}
.type-badge{font-size:9px;text-transform:uppercase;padding:1px 6px;border-radius:2px}
.type-trade_review{color:#3b82f6;background:#3b82f611}
.type-pattern_analysis{color:#a855f7;background:#a855f711}
.type-graduation{color:#22c55e;background:#22c55e11}
.tab-content{padding:16px 14px;background:#0a0a0a;min-height:calc(100vh - 120px)}
.news-row{display:grid;grid-template-columns:45px 65px 1fr 60px 50px;gap:8px;padding:5px 0;font-size:11px;color:#666;border-bottom:1px solid #0f0f0f}
.news-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
.guardian-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:16px}
.guardian-card{background:#0a0a0a;padding:12px;border:1px solid #166534;border-radius:3px}
.guardian-card.tripped{border-color:#ef4444}
.guardian-log-row{display:grid;grid-template-columns:45px 1fr;gap:8px;padding:5px 0;font-size:11px;color:#666;border-bottom:1px solid #0f0f0f}
.trade-row{display:grid;grid-template-columns:45px 65px 42px 60px 60px 80px 70px 1fr;gap:6px;padding:5px 0;font-size:11px;color:#666;border-bottom:1px solid #0f0f0f}
.trade-row.header{color:#444;font-size:9px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #151515;padding-bottom:6px;margin-bottom:4px}
```

In the HTML template, insert the tab bar after the status bar closing `</div>` and before `<div class="console">`:

```
${buildTabBar(tab)}
```

Update the `<meta http-equiv="refresh">` tag:

```html
<meta http-equiv="refresh" content="30${tab !== "overview" ? `;url=/?tab=${tab}` : ""}" />
```

Update the pause/resume button to include tab:

```typescript
const pauseAction = tab !== "overview" ? `/pause?tab=${tab}` : "/pause";
const resumeAction = tab !== "overview" ? `/resume?tab=${tab}` : "/resume";
const pauseBtn = data.paused
	? `<form method="POST" action="${resumeAction}" style="display:inline"><button type="submit" class="pause-btn" style="border-color:#22c55e;color:#22c55e;">▶ RESUME</button></form>`
	: `<form method="POST" action="${pauseAction}" style="display:inline"><button type="submit" class="pause-btn">⏸ PAUSE</button></form>`;
```

Wrap the existing overview content (everything between `<div class="console">` and the footer) in a conditional:

```typescript
// Replace the <div class="console">...</div> section with:
${tab === "overview" ? `<div class="console">
... existing KPI strip, pipeline, positions, cron, log panels ...
</div>` : `<div class="tab-content">${tabHtml}</div>`}
```

The footer should remain outside the conditional so it always renders.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/monitoring/status-page.test.ts`
Expected: All tests PASS (existing tests need the new params — update them to pass `"overview"` and `""` or rely on the defaults).

- [ ] **Step 5: Verify existing tests still pass with default params**

The existing tests call `buildConsolePage(baseData)` without the new params. Because they default to `"overview"` and `""`, existing tests should still pass unchanged.

Run: `bun test tests/monitoring/status-page.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add src/monitoring/status-page.ts tests/monitoring/status-page.test.ts
git commit -m "feat(monitoring): add tab bar and tab shell to status page"
```

---

### Task 7: News Pipeline Tab Renderer

**Files:**
- Modify: `src/monitoring/status-page.ts`
- Test: `tests/monitoring/status-page.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/monitoring/status-page.test.ts`:

```typescript
import { buildNewsPipelineTab } from "../../src/monitoring/status-page";

describe("buildNewsPipelineTab", () => {
	test("renders summary stats and article rows", () => {
		const data: NewsPipelineData = {
			totalArticles24h: 47,
			classifiedCount: 12,
			tradeableHighUrgency: 3,
			avgSentiment: 0.12,
			recentArticles: [
				{
					time: "14:22",
					symbols: ["SHEL.L"],
					headline: "Shell raises dividend 15%",
					sentiment: 0.82,
					confidence: 0.9,
					urgency: "high",
					eventType: "dividend",
					tradeable: true,
				},
			],
		};
		const html = buildNewsPipelineTab(data);
		expect(html).toContain("47");
		expect(html).toContain("12");
		expect(html).toContain("3");
		expect(html).toContain("+0.12");
		expect(html).toContain("Shell raises dividend 15%");
		expect(html).toContain("SHEL.L");
		expect(html).toContain("+0.82");
		expect(html).toContain("HIGH");
	});

	test("renders empty state when no articles", () => {
		const data: NewsPipelineData = {
			totalArticles24h: 0,
			classifiedCount: 0,
			tradeableHighUrgency: 0,
			avgSentiment: 0,
			recentArticles: [],
		};
		const html = buildNewsPipelineTab(data);
		expect(html).toContain("0");
		expect(html).toContain("No articles");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "buildNewsPipelineTab"`
Expected: FAIL — `buildNewsPipelineTab` not exported.

- [ ] **Step 3: Implement `buildNewsPipelineTab`**

Add to `src/monitoring/status-page.ts`:

```typescript
import type { DashboardData, GuardianData, LearningLoopData, NewsPipelineData, TradeActivityData } from "./dashboard-data.ts";

export function buildNewsPipelineTab(data: NewsPipelineData): string {
	const sentimentColor = data.avgSentiment >= 0 ? "#22c55e" : "#ef4444";
	const sentimentStr = `${data.avgSentiment >= 0 ? "+" : ""}${data.avgSentiment.toFixed(2)}`;

	const articleRows =
		data.recentArticles.length === 0
			? `<div style="color:#333;padding:8px 0;">No articles in last 24h</div>`
			: data.recentArticles
					.map((a) => {
						const sym = a.symbols.slice(0, 2).join(", ");
						const sentColor =
							a.sentiment != null ? (a.sentiment >= 0 ? "#22c55e" : "#ef4444") : "#666";
						const sentStr =
							a.sentiment != null
								? `${a.sentiment >= 0 ? "+" : ""}${a.sentiment.toFixed(2)}`
								: "—";
						const urgencyColor =
							a.urgency === "high" ? "#f59e0b" : a.urgency === "medium" ? "#888" : "#555";
						const urgencyLabel = a.urgency ? a.urgency.toUpperCase() : "—";
						return `<div class="news-row">
	<span style="color:#333;">${a.time}</span>
	<span style="color:#94a3b8;font-weight:500;">${escHtml(sym)}</span>
	<span style="color:#777;">${escHtml(a.headline)}</span>
	<span style="color:${sentColor};">${sentStr}</span>
	<span style="color:${urgencyColor};">${urgencyLabel}</span>
</div>`;
					})
					.join("\n");

	return `
<div class="stat-cards">
	<div class="stat-card"><div class="sc-label">Articles (24h)</div><div class="sc-value" style="color:#e2e8f0;">${data.totalArticles24h}</div><div class="sc-sub">stored from Finnhub</div></div>
	<div class="stat-card"><div class="sc-label">Classified</div><div class="sc-value" style="color:#3b82f6;">${data.classifiedCount}</div><div class="sc-sub">passed pre-filter</div></div>
	<div class="stat-card"><div class="sc-label">Tradeable</div><div class="sc-value" style="color:#22c55e;">${data.tradeableHighUrgency}</div><div class="sc-sub">high-urgency signals</div></div>
	<div class="stat-card"><div class="sc-label">Avg Sentiment</div><div class="sc-value" style="color:${sentimentColor};">${sentimentStr}</div><div class="sc-sub">across classified</div></div>
</div>
<div class="panel-header">Recent Classifications<span class="count">${data.recentArticles.length}</span></div>
<div class="scroll-panel" style="max-height:500px;">
	<div class="news-row header"><span>Time</span><span>Symbol</span><span>Headline</span><span>Sentiment</span><span>Urgency</span></div>
	${articleRows}
</div>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "buildNewsPipelineTab"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitoring/status-page.ts tests/monitoring/status-page.test.ts
git commit -m "feat(monitoring): add News Pipeline tab renderer"
```

---

### Task 8: Guardian Tab Renderer

**Files:**
- Modify: `src/monitoring/status-page.ts`
- Test: `tests/monitoring/status-page.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/monitoring/status-page.test.ts`:

```typescript
import { buildGuardianTab } from "../../src/monitoring/status-page";

describe("buildGuardianTab", () => {
	test("renders state cards and check history", () => {
		const data: GuardianData = {
			circuitBreaker: { active: false, drawdownPct: 2.1, limitPct: 10 },
			dailyHalt: { active: true, lossPct: 3.2, limitPct: 3 },
			weeklyDrawdown: { active: false, lossPct: 1.2, limitPct: 5 },
			peakBalance: 10240,
			accountBalance: 10025,
			checkHistory: [
				{ time: "14:34", level: "INFO", message: "All clear" },
				{ time: "14:24", level: "WARN", message: "Daily loss approaching halt" },
			],
		};
		const html = buildGuardianTab(data);
		expect(html).toContain("CLEAR");
		expect(html).toContain("ACTIVE");
		expect(html).toContain("2.1%");
		expect(html).toContain("10%");
		expect(html).toContain("3.2%");
		expect(html).toContain("All clear");
		expect(html).toContain("Daily loss approaching halt");
	});

	test("shows tripped styling when circuit breaker active", () => {
		const data: GuardianData = {
			circuitBreaker: { active: true, drawdownPct: 11.5, limitPct: 10 },
			dailyHalt: { active: false, lossPct: 0, limitPct: 3 },
			weeklyDrawdown: { active: false, lossPct: 0, limitPct: 5 },
			peakBalance: 10000,
			accountBalance: 8850,
			checkHistory: [],
		};
		const html = buildGuardianTab(data);
		expect(html).toContain("tripped");
		expect(html).toContain("ACTIVE");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "buildGuardianTab"`
Expected: FAIL — `buildGuardianTab` not exported.

- [ ] **Step 3: Implement `buildGuardianTab`**

Add to `src/monitoring/status-page.ts`:

```typescript
export function buildGuardianTab(data: GuardianData): string {
	function guardianCard(
		label: string,
		active: boolean,
		valuePct: number,
		limitPct: number,
	): string {
		const dotColor = active ? "#ef4444" : "#22c55e";
		const statusLabel = active ? "ACTIVE" : "CLEAR";
		const statusColor = active ? "#ef4444" : "#22c55e";
		const cardClass = active ? "guardian-card tripped" : "guardian-card";
		return `<div class="${cardClass}">
	<div style="display:flex;justify-content:space-between;align-items:center;">
		<span style="color:#444;font-size:9px;text-transform:uppercase;">${label}</span>
		${statusDot(!active)}
	</div>
	<div style="font-size:13px;font-weight:600;color:${statusColor};margin-top:6px;">${statusLabel}</div>
	<div style="color:#333;font-size:9px;margin-top:2px;">${valuePct}% / ${limitPct}%</div>
</div>`;
	}

	const logRows =
		data.checkHistory.length === 0
			? `<div style="color:#333;padding:8px 0;">No guardian checks logged</div>`
			: data.checkHistory
					.map((l) => {
						const msgColor =
							l.level === "ERROR"
								? "#ef4444"
								: l.level === "WARN"
									? "#f59e0b"
									: "#22c55e";
						return `<div class="guardian-log-row">
	<span style="color:#333;">${l.time}</span>
	<span style="color:${msgColor};">${escHtml(l.message)}</span>
</div>`;
					})
					.join("\n");

	return `
<div class="guardian-cards">
	${guardianCard("Circuit Breaker", data.circuitBreaker.active, data.circuitBreaker.drawdownPct, data.circuitBreaker.limitPct)}
	${guardianCard("Daily Halt", data.dailyHalt.active, data.dailyHalt.lossPct, data.dailyHalt.limitPct)}
	${guardianCard("Weekly Drawdown", data.weeklyDrawdown.active, data.weeklyDrawdown.lossPct, data.weeklyDrawdown.limitPct)}
</div>
<div style="margin-bottom:8px;display:flex;justify-content:space-between;font-size:10px;color:#444;">
	<span>Peak: £${data.peakBalance.toLocaleString()}</span>
	<span>Current: £${data.accountBalance.toLocaleString()}</span>
</div>
<div class="panel-header">Guardian Check History<span class="count">${data.checkHistory.length}</span></div>
<div class="scroll-panel" style="max-height:500px;">
	${logRows}
</div>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "buildGuardianTab"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitoring/status-page.ts tests/monitoring/status-page.test.ts
git commit -m "feat(monitoring): add Guardian tab renderer"
```

---

### Task 9: Learning Loop Tab Renderer

**Files:**
- Modify: `src/monitoring/status-page.ts`
- Test: `tests/monitoring/status-page.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/monitoring/status-page.test.ts`:

```typescript
import { buildLearningLoopTab } from "../../src/monitoring/status-page";

describe("buildLearningLoopTab", () => {
	test("renders summary and insight cards", () => {
		const data: LearningLoopData = {
			insightsCount7d: 8,
			ledToImprovement: 3,
			patternsFound: 2,
			recentInsights: [
				{
					time: "21:30",
					insightType: "pattern_analysis",
					observation: "Monday underperformance in momentum",
					suggestedAction: null,
					confidence: 0.72,
					tags: ["timing", "momentum"],
					ledToImprovement: false,
				},
				{
					time: "21:15",
					insightType: "trade_review",
					observation: "Tightened stop-loss on mean-reversion-v4",
					suggestedAction: '{"parameter":"stop_loss","direction":"decrease"}',
					confidence: 0.85,
					tags: ["exits"],
					ledToImprovement: true,
				},
			],
		};
		const html = buildLearningLoopTab(data);
		expect(html).toContain("8");
		expect(html).toContain("3");
		expect(html).toContain("2");
		expect(html).toContain("Monday underperformance");
		expect(html).toContain("pattern_analysis");
		expect(html).toContain("0.72");
		expect(html).toContain("timing");
	});

	test("renders empty state", () => {
		const data: LearningLoopData = {
			insightsCount7d: 0,
			ledToImprovement: 0,
			patternsFound: 0,
			recentInsights: [],
		};
		const html = buildLearningLoopTab(data);
		expect(html).toContain("No insights");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "buildLearningLoopTab"`
Expected: FAIL — `buildLearningLoopTab` not exported.

- [ ] **Step 3: Implement `buildLearningLoopTab`**

Add to `src/monitoring/status-page.ts`:

```typescript
export function buildLearningLoopTab(data: LearningLoopData): string {
	const insightCards =
		data.recentInsights.length === 0
			? `<div style="color:#333;padding:8px 0;">No insights recorded yet</div>`
			: data.recentInsights
					.map((i) => {
						const typeClass = `type-${i.insightType}`;
						const checkmark = i.ledToImprovement ? ` · Led to improvement: ✓` : "";
						const confStr = i.confidence != null ? i.confidence.toFixed(2) : "—";
						const tagsStr = i.tags.length > 0 ? i.tags.join(", ") : "—";
						return `<div class="insight-card">
	<div class="ic-header">
		<span class="type-badge ${typeClass}">${escHtml(i.insightType)}</span>
		<span style="color:#333;font-size:9px;">${i.time}</span>
	</div>
	<div class="ic-body">${escHtml(i.observation)}</div>
	<div class="ic-meta">Confidence: ${confStr} · Tags: ${escHtml(tagsStr)}${checkmark}</div>
</div>`;
					})
					.join("\n");

	return `
<div class="stat-cards" style="grid-template-columns:repeat(3,1fr);">
	<div class="stat-card"><div class="sc-label">Insights (7d)</div><div class="sc-value" style="color:#e2e8f0;">${data.insightsCount7d}</div><div class="sc-sub">from trade reviews</div></div>
	<div class="stat-card"><div class="sc-label">Led to Change</div><div class="sc-value" style="color:#22c55e;">${data.ledToImprovement}</div><div class="sc-sub">parameter updates</div></div>
	<div class="stat-card"><div class="sc-label">Patterns Found</div><div class="sc-value" style="color:#a855f7;">${data.patternsFound}</div><div class="sc-sub">this week</div></div>
</div>
<div class="panel-header">Recent Insights<span class="count">${data.recentInsights.length}</span></div>
<div class="scroll-panel" style="max-height:500px;">
	${insightCards}
</div>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "buildLearningLoopTab"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitoring/status-page.ts tests/monitoring/status-page.test.ts
git commit -m "feat(monitoring): add Learning Loop tab renderer"
```

---

### Task 10: Trade Activity Tab Renderer

**Files:**
- Modify: `src/monitoring/status-page.ts`
- Test: `tests/monitoring/status-page.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tests/monitoring/status-page.test.ts`:

```typescript
import { buildTradeActivityTab } from "../../src/monitoring/status-page";

describe("buildTradeActivityTab", () => {
	test("renders trade table and summary stats", () => {
		const data: TradeActivityData = {
			trades: [
				{
					time: "14:10",
					symbol: "SHEL.L",
					exchange: "LSE",
					side: "BUY",
					price: 2340,
					pnl: null,
					strategyName: "mom-v3",
					signalType: "entry_long",
					reasoning: "News catalyst: dividend raise",
				},
				{
					time: "13:45",
					symbol: "AZN.L",
					exchange: "LSE",
					side: "SELL",
					price: 10620,
					pnl: 170,
					strategyName: "mr-v4",
					signalType: "exit",
					reasoning: "Target hit (1.5R)",
				},
			],
			tradesToday: 5,
			winRateToday: 0.6,
			avgWinner: 142,
			avgLoser: -68,
		};
		const html = buildTradeActivityTab(data);
		expect(html).toContain("SHEL.L");
		expect(html).toContain("BUY");
		expect(html).toContain("2,340");
		expect(html).toContain("+170");
		expect(html).toContain("mom-v3");
		expect(html).toContain("5");
		expect(html).toContain("60%");
		expect(html).toContain("+142");
		expect(html).toContain("-68");
	});

	test("renders empty state", () => {
		const data: TradeActivityData = {
			trades: [],
			tradesToday: 0,
			winRateToday: null,
			avgWinner: null,
			avgLoser: null,
		};
		const html = buildTradeActivityTab(data);
		expect(html).toContain("No trades");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "buildTradeActivityTab"`
Expected: FAIL — `buildTradeActivityTab` not exported.

- [ ] **Step 3: Implement `buildTradeActivityTab`**

Add to `src/monitoring/status-page.ts`:

```typescript
export function buildTradeActivityTab(data: TradeActivityData): string {
	const tradeRows =
		data.trades.length === 0
			? `<div style="color:#333;padding:8px 0;">No trades recorded</div>`
			: data.trades
					.map((t) => {
						const sideColor = t.side === "BUY" ? "#22c55e" : "#ef4444";
						const pnlStr =
							t.pnl != null
								? `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(0)}`
								: "—";
						const pnlColor =
							t.pnl != null ? (t.pnl >= 0 ? "#22c55e" : "#ef4444") : "#666";
						return `<div class="trade-row">
	<span style="color:#333;">${t.time}</span>
	<span style="color:#94a3b8;font-weight:500;">${escHtml(t.symbol)}</span>
	<span style="color:${sideColor};">${t.side}</span>
	<span style="color:#666;">${t.price.toLocaleString()}p</span>
	<span style="color:${pnlColor};">${pnlStr}</span>
	<span style="color:#555;font-size:10px;">${escHtml(t.strategyName)}</span>
	<span style="color:#444;font-size:10px;">${escHtml(t.signalType)}</span>
	<span style="color:#444;font-size:10px;">${escHtml(t.reasoning ?? "")}</span>
</div>`;
					})
					.join("\n");

	const winRateStr = data.winRateToday != null ? `${(data.winRateToday * 100).toFixed(0)}%` : "—";
	const avgWinStr = data.avgWinner != null ? `+${data.avgWinner.toFixed(0)}` : "—";
	const avgLoseStr = data.avgLoser != null ? `${data.avgLoser.toFixed(0)}` : "—";

	return `
<div class="panel-header">Recent Trades<span class="count">${data.trades.length}</span></div>
<div class="scroll-panel" style="max-height:500px;">
	<div class="trade-row header"><span>Time</span><span>Symbol</span><span>Side</span><span>Price</span><span>P&amp;L</span><span>Strategy</span><span>Signal</span><span>Reason</span></div>
	${tradeRows}
</div>
<div class="stat-cards" style="margin-top:16px;">
	<div class="stat-card"><div class="sc-label">Today</div><div class="sc-value" style="color:#e2e8f0;">${data.tradesToday}</div><div class="sc-sub">trades</div></div>
	<div class="stat-card"><div class="sc-label">Win Rate</div><div class="sc-value" style="color:${data.winRateToday != null && data.winRateToday >= 0.5 ? "#22c55e" : "#ef4444"};">${winRateStr}</div><div class="sc-sub">today</div></div>
	<div class="stat-card"><div class="sc-label">Avg Winner</div><div class="sc-value" style="color:#22c55e;">${avgWinStr}</div><div class="sc-sub">pence</div></div>
	<div class="stat-card"><div class="sc-label">Avg Loser</div><div class="sc-value" style="color:#ef4444;">${avgLoseStr}</div><div class="sc-sub">pence</div></div>
</div>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/monitoring/status-page.test.ts --test-name-pattern "buildTradeActivityTab"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/monitoring/status-page.ts tests/monitoring/status-page.test.ts
git commit -m "feat(monitoring): add Trade Activity tab renderer"
```

---

### Task 11: Integration Test — Full Tab Rendering

**Files:**
- Test: `tests/monitoring/server.test.ts`

- [ ] **Step 1: Run the full server test suite to verify all routing + rendering works end-to-end**

Run: `bun test tests/monitoring/server.test.ts`
Expected: All tests PASS, including the new tab routing tests from Task 5.

- [ ] **Step 2: Run the full monitoring test suite**

Run: `bun test tests/monitoring/`
Expected: All tests PASS.

- [ ] **Step 3: Run the full project test suite**

Run: `bun test --preload ./tests/preload.ts`
Expected: All tests PASS with no regressions.

- [ ] **Step 4: Run Biome lint**

Run: `bunx biome check src/monitoring/ tests/monitoring/`
Expected: No errors. Fix any lint issues found.

- [ ] **Step 5: Commit any lint fixes**

If any fixes were needed:

```bash
git add -A
git commit -m "fix: lint fixes for dashboard tabs"
```

---

### Task 12: Final Verification

**Files:** None (verification only)

- [ ] **Step 1: Start the server locally and verify each tab renders**

Run: `bun run src/index.ts` (or however the app starts locally)

Visit in browser:
- `http://localhost:3847/` — Overview tab (existing dashboard)
- `http://localhost:3847/?tab=news` — News Pipeline tab
- `http://localhost:3847/?tab=guardian` — Guardian tab
- `http://localhost:3847/?tab=learning` — Learning Loop tab
- `http://localhost:3847/?tab=trades` — Trades tab

Verify:
- Tab bar appears on all pages
- Active tab is highlighted amber
- Auto-refresh preserves current tab
- Pause/resume buttons redirect back to current tab

- [ ] **Step 2: Stop local server**

Ctrl+C to stop.

- [ ] **Step 3: Final commit if any tweaks needed**

If any visual tweaks were made:

```bash
git add -A
git commit -m "fix: dashboard tab visual tweaks"
```
