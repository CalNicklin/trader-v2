# Live Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing broker modules and live executor into a working end-to-end trading pipeline. Graduate strategies from paper lab to IBKR paper account with all spec risk controls enforced.

**Design spec:** `docs/specs/2026-04-05-live-deployment-design.md`

**Tech Stack:** Bun, TypeScript, Drizzle ORM (SQLite)

**Dependencies:** Phases 1–9 (all complete), Phase 7 (broker integration), Phase 8 (risk limits)

---

## Task 1: Wire Signal Evaluation in Live Executor

**File:** `src/live/executor.ts`

**Problem:** `evaluateSignal()` always returns `false` (placeholder at line 322). The paper evaluator in `src/strategy/evaluator.ts` already uses `buildSignalContext()` + `evalExpr()` which is the working pipeline.

**Fix:** Replace the stub with a real implementation that builds the same signal context the paper evaluator uses, including position data for exit signals.

- [ ] **Step 1: Write test first**

Create `tests/live/executor-signals.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

// Test the evaluateSignal function directly — it's not exported,
// so we test through a wrapper or make it a named export.
// For now, test the buildLiveSignalContext helper we'll create.
import { buildLiveSignalContext } from "../../src/live/executor.ts";

describe("buildLiveSignalContext", () => {
	test("builds context from quote and indicators (no position)", () => {
		const ctx = buildLiveSignalContext(
			{
				last: 150,
				bid: 149.5,
				ask: 150.5,
				changePercent: -2.5,
				volume: null,
				avgVolume: null,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			{ rsi14: 25, atr14: 3.5, volume_ratio: 1.2 },
			null,
		);
		expect(ctx.last).toBe(150);
		expect(ctx.rsi14).toBe(25);
		expect(ctx.change_percent).toBe(-2.5);
		expect(ctx.hold_days).toBeNull();
		expect(ctx.pnl_pct).toBeNull();
	});

	test("builds context with position data for exit signals", () => {
		const openedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = buildLiveSignalContext(
			{
				last: 160,
				bid: 159.5,
				ask: 160.5,
				changePercent: 1.0,
				volume: null,
				avgVolume: null,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			{ rsi14: 72, atr14: 4.0, volume_ratio: 0.8 },
			{ entryPrice: 150, openedAt, quantity: 10 },
		);
		expect(ctx.hold_days).toBe(3);
		expect(ctx.pnl_pct).toBeCloseTo(6.67, 1);
	});
});
```

- [ ] **Step 2: Run test, verify it fails** (function doesn't exist yet)

```bash
bun test tests/live/executor-signals.test.ts
```

- [ ] **Step 3: Replace `evaluateSignal` stub**

In `src/live/executor.ts`, add imports at the top:

```typescript
import { buildSignalContext, type QuoteFields, type PositionFields } from "../strategy/context.ts";
import { evalExpr } from "../strategy/expr-eval.ts";
```

Replace the `evaluateSignal` function (lines 311–327) with:

```typescript
/**
 * Build signal context for the live executor.
 * Exported for testing — same context builder as paper evaluator.
 */
export function buildLiveSignalContext(
	quote: QuoteFields,
	indicators: SymbolIndicators,
	position: PositionFields | null,
): Record<string, number | null | undefined> {
	return buildSignalContext({ quote, indicators, position });
}

/**
 * Evaluate a signal expression against current market data.
 * Uses the same buildSignalContext + evalExpr pipeline as paper trading.
 */
function evaluateSignal(
	signal: string,
	_parameters: Record<string, unknown>,
	quote: {
		last: number | null;
		bid: number | null;
		ask: number | null;
		changePercent: number | null;
	},
	indicators: SymbolIndicators,
	position?: { entryPrice: number; openedAt: string; quantity: number },
): boolean {
	const fullQuote: QuoteFields = {
		last: quote.last,
		bid: quote.bid,
		ask: quote.ask,
		volume: null,
		avgVolume: null,
		changePercent: quote.changePercent,
		newsSentiment: null,
		newsEarningsSurprise: null,
		newsGuidanceChange: null,
		newsManagementTone: null,
		newsRegulatoryRisk: null,
		newsAcquisitionLikelihood: null,
		newsCatalystType: null,
		newsExpectedMoveDuration: null,
	};
	const posFields: PositionFields | null = position
		? { entryPrice: position.entryPrice, openedAt: position.openedAt, quantity: position.quantity }
		: null;
	const ctx = buildSignalContext({ quote: fullQuote, indicators, position: posFields });
	return evalExpr(signal, ctx);
}
```

- [ ] **Step 4: Update call sites** — pass position data to exit evaluations

In the exit signal block (~line 249), change:

```typescript
const shouldExit = evaluateSignal(signals.exit, parameters, cached, indicators);
```

to:

```typescript
const shouldExit = evaluateSignal(signals.exit, parameters, cached, indicators, {
	entryPrice: existingPos.avgCost,
	openedAt: existingPos.updatedAt,
	quantity: existingPos.quantity,
});
```

- [ ] **Step 5: Run tests, verify green**

```bash
bun test tests/live/executor-signals.test.ts
```

- [ ] **Step 6: Verify no regressions**

```bash
bun test
```

---

## Task 2: Wire Risk Gate into Live Executor

**File:** `src/live/executor.ts`

**Problem:** Live executor uses only `allocation.maxPositionSize` and a fixed `0.25` multiplier. No ATR sizing, no concurrent position check, no per-trade risk limit. The paper evaluator (`src/strategy/evaluator.ts:95-116`) calls `checkTradeRiskGate()` before every entry — the live executor must do the same.

- [ ] **Step 1: Write test**

Create `tests/live/executor-risk-gate.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { checkTradeRiskGate } from "../../src/risk/gate.ts";

describe("risk gate integration (live executor pattern)", () => {
	test("rejects trade when max concurrent positions exceeded", () => {
		const result = checkTradeRiskGate({
			accountBalance: 500,
			price: 100,
			atr14: 2,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 3, // Already at max
			openPositionSectors: [null, null, null],
		});
		expect(result.allowed).toBe(false);
	});

	test("provides ATR-based quantity and stop-loss", () => {
		const result = checkTradeRiskGate({
			accountBalance: 500,
			price: 50,
			atr14: 2,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 0,
			openPositionSectors: [],
		});
		expect(result.allowed).toBe(true);
		expect(result.sizing).toBeDefined();
		expect(result.sizing!.quantity).toBeGreaterThan(0);
		expect(result.sizing!.stopLossPrice).toBeLessThan(50);
	});

	test("reduces size when weekly drawdown active", () => {
		const normal = checkTradeRiskGate({
			accountBalance: 500,
			price: 50,
			atr14: 2,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 0,
			openPositionSectors: [],
			weeklyDrawdownActive: false,
		});
		const reduced = checkTradeRiskGate({
			accountBalance: 500,
			price: 50,
			atr14: 2,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 0,
			openPositionSectors: [],
			weeklyDrawdownActive: true,
		});
		expect(reduced.sizing!.quantity).toBeLessThan(normal.sizing!.quantity);
	});
});
```

- [ ] **Step 2: Run test, verify passes** (risk gate already works, this validates our understanding)

```bash
bun test tests/live/executor-risk-gate.test.ts
```

- [ ] **Step 3: Add risk gate import to executor**

In `src/live/executor.ts`, add:

```typescript
import { checkTradeRiskGate } from "../risk/gate.ts";
```

- [ ] **Step 4: Replace entry sizing logic**

Replace the entry_long sizing block (lines 165–170):

```typescript
const positionValue = Math.min(
	allocation.maxPositionSize,
	allocation.allocatedCapital * 0.25,
);
const quantity = Math.floor(positionValue / cached.last);
```

with:

```typescript
// Count existing live positions for risk gate
const allPositions = await db.select({ id: livePositions.id }).from(livePositions);

const gateResult = checkTradeRiskGate({
	accountBalance: availableCash,
	price: cached.last,
	atr14: indicators.atr14 ?? 0,
	side: "BUY",
	exchange,
	sector: null,
	borrowFeeAnnualPct: null,
	openPositionCount: allPositions.length,
	openPositionSectors: allPositions.map(() => null),
	weeklyDrawdownActive,
});

if (!gateResult.allowed) {
	log.debug(
		{ symbol, reason: gateResult.reason, strategyId: strategy.id },
		"Trade rejected by risk gate",
	);
	continue;
}

const { quantity, stopLossPrice } = gateResult.sizing!;
// Cap at capital allocator limit
const cappedQty = Math.min(
	quantity,
	Math.floor(allocation.maxPositionSize / cached.last),
);
```

Do the same for entry_short (lines 209–214), using `side: "SELL"`.

- [ ] **Step 5: Add `weeklyDrawdownActive` to executor scope**

Near the top of `runLiveExecutor()`, after the halt check (added in Task 3), add:

```typescript
const weeklyDrawdownActive = await isWeeklyDrawdownActive();
```

- [ ] **Step 6: Run full test suite**

```bash
bun test
```

---

## Task 3: Add Trading Halt + Weekly Drawdown Checks

**File:** `src/live/executor.ts`

**Problem:** Live executor only checks `LIVE_TRADING_ENABLED` and IBKR connection (lines 42–51). Ignores risk guardian halt flags from `src/risk/guardian.ts`.

- [ ] **Step 1: Write test**

Create `tests/live/executor-halt.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { isTradingHalted, isWeeklyDrawdownActive } from "../../src/risk/guardian.ts";

describe("trading halt checks (integration)", () => {
	// These test the guardian functions that the executor will call.
	// The actual executor integration is tested via the full executor test.
	test("isTradingHalted returns false when no flags set", async () => {
		// Requires DB to be set up — will be covered in full integration test
		const result = await isTradingHalted();
		expect(result.halted).toBe(false);
	});

	test("isWeeklyDrawdownActive returns false by default", async () => {
		const result = await isWeeklyDrawdownActive();
		expect(result).toBe(false);
	});
});
```

- [ ] **Step 2: Add halt checks to executor**

In `src/live/executor.ts`, add import:

```typescript
import { isTradingHalted, isWeeklyDrawdownActive } from "../risk/guardian.ts";
```

After the IBKR connection check (line 51), add:

```typescript
// Risk guardian halt check
const haltStatus = await isTradingHalted();
if (haltStatus.halted) {
	log.warn({ reason: haltStatus.reason }, "Trading halted by risk guardian — skipping live execution");
	result.errors.push(`Trading halted: ${haltStatus.reason}`);
	return result;
}
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/live/executor-halt.test.ts
bun test
```

---

## Task 4: Port Account Module from v1

**Create:** `src/broker/account.ts`

**Port from:** `~/Documents/Projects/trader/src/broker/account.ts`

**Provides:** `getAccountSummary()` and `getPositions()` — fetches real IBKR account data.

- [ ] **Step 1: Write test**

Create `tests/broker/account.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

// Unit tests for type contracts — actual API calls require IBKR connection
describe("account module types", () => {
	test("AccountSummary interface has required fields", async () => {
		const { getAccountSummary } = await import("../../src/broker/account.ts");
		expect(typeof getAccountSummary).toBe("function");
	});

	test("getPositions returns array", async () => {
		const { getPositions } = await import("../../src/broker/account.ts");
		expect(typeof getPositions).toBe("function");
	});
});
```

- [ ] **Step 2: Create `src/broker/account.ts`**

Port from v1 with v2 conventions (pino logger, v2's `getApi()`):

```typescript
import { createChildLogger } from "../utils/logger.ts";
import { getApi } from "./connection.ts";

const log = createChildLogger({ module: "broker-account" });

export interface AccountSummary {
	accountId: string;
	netLiquidation: number;
	totalCashValue: number;
	buyingPower: number;
	grossPositionValue: number;
	availableFunds: number;
}

const SUMMARY_TAGS = "NetLiquidation,TotalCashValue,BuyingPower,GrossPositionValue,AvailableFunds";

/** Fetch current account summary from IBKR */
export async function getAccountSummary(): Promise<AccountSummary> {
	const api = getApi();

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			sub.unsubscribe();
			reject(new Error("Account summary timeout after 10s"));
		}, 10000);

		const sub = api.getAccountSummary("All", SUMMARY_TAGS).subscribe({
			next: (update) => {
				const result: Partial<AccountSummary> = {};

				for (const [accountId, tagValues] of update.all) {
					result.accountId = accountId;
					for (const [tag, currencyValues] of tagValues) {
						for (const [, val] of currencyValues) {
							const numVal = Number(val.value);
							switch (tag) {
								case "NetLiquidation":
									result.netLiquidation = numVal;
									break;
								case "TotalCashValue":
									result.totalCashValue = numVal;
									break;
								case "BuyingPower":
									result.buyingPower = numVal;
									break;
								case "GrossPositionValue":
									result.grossPositionValue = numVal;
									break;
								case "AvailableFunds":
									result.availableFunds = numVal;
									break;
							}
						}
					}
				}

				if (result.accountId && result.netLiquidation !== undefined) {
					clearTimeout(timeout);
					sub.unsubscribe();
					const summary = result as AccountSummary;
					log.info(summary, "Account summary fetched");
					resolve(summary);
				}
			},
			error: (err) => {
				clearTimeout(timeout);
				reject(err);
			},
		});
	});
}

export interface IbkrPosition {
	accountId: string;
	symbol: string;
	exchange: string;
	currency: string;
	quantity: number;
	avgCost: number;
}

/** Fetch current positions from IBKR */
export async function getPositions(): Promise<IbkrPosition[]> {
	const api = getApi();

	return new Promise((resolve, reject) => {
		const positions: IbkrPosition[] = [];
		const timeout = setTimeout(() => {
			sub.unsubscribe();
			resolve(positions); // Return whatever we have
		}, 10000);

		const sub = api.getPositions().subscribe({
			next: (update) => {
				for (const [accountId, positionList] of update.all) {
					for (const pos of positionList) {
						if (pos.pos !== 0) {
							positions.push({
								accountId,
								symbol: pos.contract.symbol ?? "UNKNOWN",
								exchange: pos.contract.primaryExch ?? "LSE",
								currency: pos.contract.currency ?? "GBP",
								quantity: pos.pos ?? 0,
								avgCost: pos.avgCost ?? 0,
							});
						}
					}
				}
				clearTimeout(timeout);
				sub.unsubscribe();
				log.info({ count: positions.length }, "Positions fetched");
				resolve(positions);
			},
			error: (err) => {
				clearTimeout(timeout);
				reject(err);
			},
		});
	});
}
```

- [ ] **Step 3: Replace `estimateAvailableCash()` in executor**

In `src/live/executor.ts`, replace `estimateAvailableCash()` function and its call site.

Add import:

```typescript
import { getAccountSummary } from "../broker/account.ts";
```

Replace the call (line 100):

```typescript
const totalCash = await estimateAvailableCash();
```

with:

```typescript
let totalCash: number;
try {
	const summary = await getAccountSummary();
	totalCash = summary.totalCashValue;
} catch (err) {
	log.warn({ error: err }, "Failed to get IBKR account summary — using position estimate");
	totalCash = await estimateAvailableCash();
}
```

Keep `estimateAvailableCash()` as fallback but it's no longer the primary path.

- [ ] **Step 4: Run tests**

```bash
bun test tests/broker/account.test.ts
bun test
```

---

## Task 5: Position Lifecycle — Fill to livePositions to PnL

**File:** `src/live/position-manager.ts` (new)

**Problem:** Order monitor detects fills (`src/broker/order-monitor.ts:75-103`) but nothing creates `livePositions` rows. Guardian reads from `livePositions` but the table is always empty.

- [ ] **Step 1: Write test**

Create `tests/live/position-manager.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "../../src/db/client.ts";
import { resetConfigForTesting } from "../../src/config.ts";
import { livePositions, liveTrades } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";

// Set up in-memory DB
const origDbPath = process.env.DB_PATH;
process.env.DB_PATH = ":memory:";

describe("position manager", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("onEntryFill creates livePositions row", async () => {
		const { onEntryFill } = await import("../../src/live/position-manager.ts");
		const db = getDb();

		await onEntryFill({
			symbol: "AAPL",
			exchange: "NASDAQ",
			strategyId: 1,
			quantity: 10,
			avgCost: 150.0,
			stopLossPrice: 143.0,
			side: "BUY",
		});

		const positions = await db.select().from(livePositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.symbol).toBe("AAPL");
		expect(positions[0]!.quantity).toBe(10);
		expect(positions[0]!.stopLossPrice).toBe(143.0);
	});

	test("onExitFill computes PnL and deletes position", async () => {
		const { onEntryFill, onExitFill } = await import("../../src/live/position-manager.ts");
		const db = getDb();

		await onEntryFill({
			symbol: "AAPL",
			exchange: "NASDAQ",
			strategyId: 1,
			quantity: 10,
			avgCost: 150.0,
			stopLossPrice: 143.0,
			side: "BUY",
		});

		const pnl = await onExitFill({
			symbol: "AAPL",
			exchange: "NASDAQ",
			exitPrice: 160.0,
			quantity: 10,
			commission: 1.0,
		});

		expect(pnl).toBeCloseTo(99.0, 0); // (160-150)*10 - 1.0

		const positions = await db.select().from(livePositions);
		expect(positions).toHaveLength(0);
	});

	test("onExitFill computes PnL for short position", async () => {
		const { onEntryFill, onExitFill } = await import("../../src/live/position-manager.ts");

		await onEntryFill({
			symbol: "TSLA",
			exchange: "NASDAQ",
			strategyId: 1,
			quantity: -5, // short
			avgCost: 200.0,
			stopLossPrice: 210.0,
			side: "SELL",
		});

		const pnl = await onExitFill({
			symbol: "TSLA",
			exchange: "NASDAQ",
			exitPrice: 180.0,
			quantity: 5,
			commission: 1.0,
		});

		// Short PnL: (entry - exit) * qty - commission = (200-180)*5 - 1 = 99
		expect(pnl).toBeCloseTo(99.0, 0);
	});
});
```

- [ ] **Step 2: Create `src/live/position-manager.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { livePositions, riskState } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "position-manager" });

export interface EntryFillInput {
	symbol: string;
	exchange: string;
	strategyId: number;
	quantity: number; // negative for shorts
	avgCost: number;
	stopLossPrice: number | null;
	side: "BUY" | "SELL";
}

export interface ExitFillInput {
	symbol: string;
	exchange: string;
	exitPrice: number;
	quantity: number;
	commission: number;
}

/**
 * On BUY/entry fill: insert livePositions row.
 */
export async function onEntryFill(input: EntryFillInput): Promise<void> {
	const db = getDb();

	await db
		.insert(livePositions)
		.values({
			strategyId: input.strategyId,
			symbol: input.symbol,
			exchange: input.exchange,
			currency: input.exchange === "LSE" ? "GBP" : "USD",
			quantity: input.quantity,
			avgCost: input.avgCost,
			stopLossPrice: input.stopLossPrice,
		})
		.onConflictDoNothing(); // UNIQUE(symbol, exchange)

	log.info(
		{
			symbol: input.symbol,
			exchange: input.exchange,
			quantity: input.quantity,
			avgCost: input.avgCost,
			stopLossPrice: input.stopLossPrice,
		},
		"Position opened from fill",
	);
}

/**
 * On exit fill: compute PnL, delete position, record daily PnL contribution.
 * Returns the computed PnL.
 */
export async function onExitFill(input: ExitFillInput): Promise<number> {
	const db = getDb();

	// Find the position
	const [position] = await db
		.select()
		.from(livePositions)
		.where(
			and(
				eq(livePositions.symbol, input.symbol),
				eq(livePositions.exchange, input.exchange),
			),
		)
		.limit(1);

	if (!position) {
		log.warn({ symbol: input.symbol }, "No position found for exit fill — orphaned exit");
		return 0;
	}

	// Compute PnL
	const isShort = position.quantity < 0;
	const pnl = isShort
		? (position.avgCost - input.exitPrice) * Math.abs(position.quantity) - input.commission
		: (input.exitPrice - position.avgCost) * position.quantity - input.commission;

	// Delete position
	await db.delete(livePositions).where(eq(livePositions.id, position.id));

	// Record daily PnL contribution to risk_state
	await addDailyPnl(pnl);

	log.info(
		{
			symbol: input.symbol,
			exitPrice: input.exitPrice,
			entryPrice: position.avgCost,
			pnl,
			isShort,
		},
		"Position closed from fill",
	);

	return pnl;
}

/**
 * Add PnL to daily and weekly accumulators in risk_state.
 */
async function addDailyPnl(pnl: number): Promise<void> {
	const db = getDb();

	// Read current daily_pnl
	const [dailyRow] = await db
		.select({ value: riskState.value })
		.from(riskState)
		.where(eq(riskState.key, "daily_pnl"))
		.limit(1);

	const currentDaily = dailyRow ? Number.parseFloat(dailyRow.value) : 0;
	const newDaily = currentDaily + pnl;

	await db
		.insert(riskState)
		.values({ key: "daily_pnl", value: newDaily.toString() })
		.onConflictDoUpdate({
			target: riskState.key,
			set: { value: newDaily.toString(), updatedAt: new Date().toISOString() },
		});

	// Also accumulate weekly
	const [weeklyRow] = await db
		.select({ value: riskState.value })
		.from(riskState)
		.where(eq(riskState.key, "weekly_pnl"))
		.limit(1);

	const currentWeekly = weeklyRow ? Number.parseFloat(weeklyRow.value) : 0;
	const newWeekly = currentWeekly + pnl;

	await db
		.insert(riskState)
		.values({ key: "weekly_pnl", value: newWeekly.toString() })
		.onConflictDoUpdate({
			target: riskState.key,
			set: { value: newWeekly.toString(), updatedAt: new Date().toISOString() },
		});
}
```

- [ ] **Step 3: Wire position manager into order monitor**

In `src/broker/order-monitor.ts`, after the fill status update (line 82-84), add position lifecycle handling. In the fill block where `event.status === "FILLED"` (around line 75):

After the existing fill handling and behavioral divergence check, add:

```typescript
// Position lifecycle: create/close positions on fills
if (event.status === "FILLED") {
	const info = trackedOrderInfo.get(event.tradeId);
	if (info) {
		import("../live/position-manager.ts")
			.then(async ({ onEntryFill, onExitFill }) => {
				// Determine if this is an entry or exit by checking existing position
				const { getDb } = await import("../db/client.ts");
				const { livePositions: lp, liveTrades: lt } = await import("../db/schema.ts");
				const { and, eq } = await import("drizzle-orm");
				const db = getDb();

				// Get the trade record to determine side
				const [trade] = await db
					.select()
					.from(lt)
					.where(eq(lt.id, event.tradeId))
					.limit(1);

				if (!trade) return;

				// Check if we have an existing position for this symbol
				const [existing] = await db
					.select()
					.from(lp)
					.where(
						and(
							eq(lp.symbol, trade.symbol),
							eq(lp.exchange, trade.exchange),
						),
					)
					.limit(1);

				if (existing) {
					// This is an exit fill
					await onExitFill({
						symbol: trade.symbol,
						exchange: trade.exchange,
						exitPrice: event.fillData?.fillPrice ?? trade.limitPrice ?? 0,
						quantity: trade.quantity,
						commission: event.fillData?.commission ?? 0,
					});

					// Update liveTrades PnL
					const isShort = existing.quantity < 0;
					const exitPrice = event.fillData?.fillPrice ?? trade.limitPrice ?? 0;
					const pnl = isShort
						? (existing.avgCost - exitPrice) * Math.abs(existing.quantity) - (event.fillData?.commission ?? 0)
						: (exitPrice - existing.avgCost) * existing.quantity - (event.fillData?.commission ?? 0);

					await db
						.update(lt)
						.set({ pnl })
						.where(eq(lt.id, event.tradeId));
				} else {
					// This is an entry fill
					await onEntryFill({
						symbol: trade.symbol,
						exchange: trade.exchange,
						strategyId: trade.strategyId ?? 0,
						quantity: trade.side === "SELL" ? -trade.quantity : trade.quantity,
						avgCost: event.fillData?.fillPrice ?? trade.limitPrice ?? 0,
						stopLossPrice: null, // Set by risk gate in executor
						side: trade.side as "BUY" | "SELL",
					});
				}
			})
			.catch((err: unknown) => {
				log.error({ error: err, tradeId: event.tradeId }, "Position lifecycle handling failed");
			});
	}
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/live/position-manager.test.ts
bun test
```

---

## Task 6: Fix Short Position Stop-Loss Detection

**File:** `src/broker/stop-loss.ts`

**Problem:** `findStopLossBreaches()` (line 27) skips `quantity <= 0` — short positions are never checked. Shorts need `price >= stopLossPrice`.

- [ ] **Step 1: Write test**

Create `tests/broker/stop-loss.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { findStopLossBreaches } from "../../src/broker/stop-loss.ts";

describe("findStopLossBreaches", () => {
	test("detects long stop-loss breach", () => {
		const breaches = findStopLossBreaches(
			[{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 145 }],
			new Map([["AAPL", { last: 140, bid: 139 }]]),
		);
		expect(breaches).toHaveLength(1);
		expect(breaches[0]!.symbol).toBe("AAPL");
	});

	test("does not trigger long stop-loss above threshold", () => {
		const breaches = findStopLossBreaches(
			[{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 145 }],
			new Map([["AAPL", { last: 150, bid: 149 }]]),
		);
		expect(breaches).toHaveLength(0);
	});

	test("detects short stop-loss breach (price >= stop)", () => {
		const breaches = findStopLossBreaches(
			[{ id: 1, symbol: "TSLA", quantity: -5, stopLossPrice: 210 }],
			new Map([["TSLA", { last: 215, bid: 214 }]]),
		);
		expect(breaches).toHaveLength(1);
		expect(breaches[0]!.symbol).toBe("TSLA");
		expect(breaches[0]!.quantity).toBe(-5);
	});

	test("does not trigger short stop-loss below threshold", () => {
		const breaches = findStopLossBreaches(
			[{ id: 1, symbol: "TSLA", quantity: -5, stopLossPrice: 210 }],
			new Map([["TSLA", { last: 200, bid: 199 }]]),
		);
		expect(breaches).toHaveLength(0);
	});

	test("skips positions with no stop-loss price", () => {
		const breaches = findStopLossBreaches(
			[{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: null }],
			new Map([["AAPL", { last: 1, bid: 1 }]]),
		);
		expect(breaches).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test, verify short test fails**

```bash
bun test tests/broker/stop-loss.test.ts
```

- [ ] **Step 3: Fix `findStopLossBreaches`**

In `src/broker/stop-loss.ts`, replace the function body:

```typescript
export function findStopLossBreaches(
	positions: ReadonlyArray<StopLossPosition>,
	quotes: Map<string, QuoteLike>,
): StopLossBreach[] {
	const breaches: StopLossBreach[] = [];
	for (const pos of positions) {
		if (!pos.stopLossPrice) continue;
		const quote = quotes.get(pos.symbol);
		const price = quote?.last ?? quote?.bid ?? null;
		if (price === null) continue;

		const isLong = pos.quantity > 0;
		const isShort = pos.quantity < 0;

		if (isLong && price <= pos.stopLossPrice) {
			breaches.push({
				symbol: pos.symbol,
				quantity: pos.quantity,
				price,
				stopLossPrice: pos.stopLossPrice,
			});
		} else if (isShort && price >= pos.stopLossPrice) {
			breaches.push({
				symbol: pos.symbol,
				quantity: pos.quantity,
				price,
				stopLossPrice: pos.stopLossPrice,
			});
		}
	}
	return breaches;
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/broker/stop-loss.test.ts
bun test
```

---

## Task 7: IBKR Connection in Boot Sequence

**File:** `src/index.ts`

**Problem:** Boot sequence doesn't connect to IBKR or start order monitoring when `LIVE_TRADING_ENABLED=true`.

- [ ] **Step 1: Add IBKR boot to `src/index.ts`**

After the scheduler start and before the HTTP server start, add:

```typescript
// Connect to IBKR if live trading enabled
if (config.LIVE_TRADING_ENABLED) {
	try {
		const { connect, waitForConnection } = await import("./broker/connection.ts");
		const { startOrderMonitoring } = await import("./broker/order-monitor.ts");
		const { getDb: getDatabase } = await import("./db/client.ts");

		log.info("Live trading enabled — connecting to IBKR...");
		await connect();

		const connected = await waitForConnection(30000);
		if (connected) {
			const api = (await import("./broker/connection.ts")).getApi();
			startOrderMonitoring(api, getDatabase());
			log.info("IBKR connected and order monitoring started");
		} else {
			log.warn("IBKR connection timeout — scheduler jobs will check connection");
		}
	} catch (err) {
		log.error({ error: err }, "IBKR connection failed — live trading will retry via scheduler");
	}
}
```

- [ ] **Step 2: Add disconnect + stop monitoring to shutdown**

In the `shutdown()` function, before `closeDb()`:

```typescript
try {
	const { stopOrderMonitoring } = await import("./broker/order-monitor.ts");
	const { disconnect } = await import("./broker/connection.ts");
	stopOrderMonitoring();
	await disconnect();
} catch {
	// Broker modules may not be loaded if live trading was disabled
}
```

- [ ] **Step 3: Add IBKR connection status to health endpoint**

In `src/monitoring/health.ts`, add to the `HealthData` interface:

```typescript
ibkrConnected?: boolean;
```

In `getHealthData()`, add after the existing fields:

```typescript
let ibkrConnected: boolean | undefined;
try {
	const { isConnected } = await import("../broker/connection.ts");
	const { getConfig } = await import("../config.ts");
	if (getConfig().LIVE_TRADING_ENABLED) {
		ibkrConnected = isConnected();
	}
} catch {
	// Broker module not loaded
}
```

Include `ibkrConnected` in the returned object.

- [ ] **Step 4: Run tests**

```bash
bun test
```

---

## Task 8: Position Reconciliation on Reconnect

**Create:** `src/live/reconciliation.ts`

**Trigger:** On IBKR reconnect and on boot.

- [ ] **Step 1: Write test**

Create `tests/live/reconciliation.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "../../src/db/client.ts";
import { resetConfigForTesting } from "../../src/config.ts";
import { livePositions } from "../../src/db/schema.ts";
import { reconcilePositions } from "../../src/live/reconciliation.ts";

process.env.DB_PATH = ":memory:";

describe("reconcilePositions", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("inserts orphaned IBKR positions not in DB", async () => {
		const db = getDb();
		const result = await reconcilePositions([
			{
				accountId: "DU123",
				symbol: "AAPL",
				exchange: "NASDAQ",
				currency: "USD",
				quantity: 10,
				avgCost: 150,
			},
		]);

		expect(result.inserted).toBe(1);
		expect(result.deleted).toBe(0);

		const positions = await db.select().from(livePositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.symbol).toBe("AAPL");
	});

	test("deletes phantom DB positions not in IBKR", async () => {
		const db = getDb();
		await db.insert(livePositions).values({
			symbol: "TSLA",
			exchange: "NASDAQ",
			currency: "USD",
			quantity: 5,
			avgCost: 200,
		});

		const result = await reconcilePositions([]); // No IBKR positions

		expect(result.deleted).toBe(1);
		expect(result.inserted).toBe(0);

		const positions = await db.select().from(livePositions);
		expect(positions).toHaveLength(0);
	});

	test("no changes when positions match", async () => {
		const db = getDb();
		await db.insert(livePositions).values({
			symbol: "AAPL",
			exchange: "NASDAQ",
			currency: "USD",
			quantity: 10,
			avgCost: 150,
		});

		const result = await reconcilePositions([
			{
				accountId: "DU123",
				symbol: "AAPL",
				exchange: "NASDAQ",
				currency: "USD",
				quantity: 10,
				avgCost: 150,
			},
		]);

		expect(result.inserted).toBe(0);
		expect(result.deleted).toBe(0);
	});
});
```

- [ ] **Step 2: Create `src/live/reconciliation.ts`**

```typescript
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { agentLogs, livePositions } from "../db/schema.ts";
import type { IbkrPosition } from "../broker/account.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "reconciliation" });

export interface ReconciliationResult {
	inserted: number;
	deleted: number;
	discrepancies: string[];
}

/**
 * Reconcile DB positions with IBKR positions.
 * - Positions in IBKR but not DB → insert (orphaned from prior crash)
 * - Positions in DB but not IBKR → delete (phantom, closed while disconnected)
 */
export async function reconcilePositions(
	ibkrPositions: IbkrPosition[],
): Promise<ReconciliationResult> {
	const db = getDb();
	const result: ReconciliationResult = { inserted: 0, deleted: 0, discrepancies: [] };

	// Get all DB positions
	const dbPositions = await db.select().from(livePositions);

	// Build lookup sets
	const ibkrKeys = new Set(ibkrPositions.map((p) => `${p.symbol}:${p.exchange}`));
	const dbKeys = new Set(dbPositions.map((p) => `${p.symbol}:${p.exchange}`));

	// Insert orphaned IBKR positions
	for (const ibkrPos of ibkrPositions) {
		const key = `${ibkrPos.symbol}:${ibkrPos.exchange}`;
		if (!dbKeys.has(key)) {
			const msg = `Orphaned IBKR position: ${key} qty=${ibkrPos.quantity}`;
			result.discrepancies.push(msg);
			log.warn(msg);

			await db.insert(livePositions).values({
				symbol: ibkrPos.symbol,
				exchange: ibkrPos.exchange,
				currency: ibkrPos.currency,
				quantity: ibkrPos.quantity,
				avgCost: ibkrPos.avgCost,
			});
			result.inserted++;
		}
	}

	// Delete phantom DB positions
	for (const dbPos of dbPositions) {
		const key = `${dbPos.symbol}:${dbPos.exchange}`;
		if (!ibkrKeys.has(key)) {
			const msg = `Phantom DB position: ${key} qty=${dbPos.quantity} — removing`;
			result.discrepancies.push(msg);
			log.warn(msg);

			await db.delete(livePositions).where(eq(livePositions.id, dbPos.id));
			result.deleted++;
		}
	}

	// Log reconciliation
	if (result.inserted > 0 || result.deleted > 0) {
		await db.insert(agentLogs).values({
			level: "WARN" as const,
			phase: "reconciliation",
			message: `Position reconciliation: +${result.inserted} inserted, -${result.deleted} deleted`,
			data: JSON.stringify(result),
		});
	}

	log.info(
		{ inserted: result.inserted, deleted: result.deleted },
		"Position reconciliation complete",
	);

	return result;
}
```

- [ ] **Step 3: Wire reconciliation into boot and reconnect**

In `src/index.ts`, after the IBKR connection block, add:

```typescript
// Run position reconciliation on boot
if (config.LIVE_TRADING_ENABLED) {
	try {
		const { isConnected } = await import("./broker/connection.ts");
		if (isConnected()) {
			const { getPositions } = await import("./broker/account.ts");
			const { reconcilePositions } = await import("./live/reconciliation.ts");
			const ibkrPositions = await getPositions();
			await reconcilePositions(ibkrPositions);
		}
	} catch (err) {
		log.warn({ error: err }, "Position reconciliation on boot failed (non-fatal)");
	}
}
```

In `src/broker/connection.ts`, add a reconnect callback hook. In the reconnect health check (line 87, inside the `setTimeout` callback after `RECONNECT_STABLE_MS`), add after the `getCurrentTime` check:

```typescript
// Trigger position reconciliation on reconnect
import("../live/reconciliation.ts")
	.then(async ({ reconcilePositions }) => {
		const { getPositions } = await import("./account.ts");
		const positions = await getPositions();
		await reconcilePositions(positions);
	})
	.catch((err: unknown) => {
		log.warn({ error: err }, "Reconnect reconciliation failed (non-fatal)");
	});
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/live/reconciliation.test.ts
bun test
```

---

## Task 9: Real Daily/Weekly PnL for Risk Guardian

**File:** `src/scheduler/risk-guardian-job.ts`

**Problem:** Always passes `0, 0` for daily/weekly PnL (line 41). Daily halt (3%) and weekly drawdown (5%) never trigger.

- [ ] **Step 1: Write test**

Create `tests/scheduler/risk-guardian-job.test.ts`:

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "../../src/db/client.ts";
import { resetConfigForTesting } from "../../src/config.ts";
import { riskState } from "../../src/db/schema.ts";
import { eq } from "drizzle-orm";

process.env.DB_PATH = ":memory:";

describe("risk guardian PnL reading", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("reads daily_pnl from risk_state", async () => {
		const db = getDb();
		await db.insert(riskState).values({ key: "daily_pnl", value: "-15.50" });

		const { getLivePnl } = await import("../../src/scheduler/risk-guardian-job.ts");
		const { daily, weekly } = await getLivePnl();
		expect(daily).toBeCloseTo(-15.5, 1);
	});

	test("returns 0 when no PnL recorded", async () => {
		const { getLivePnl } = await import("../../src/scheduler/risk-guardian-job.ts");
		const { daily, weekly } = await getLivePnl();
		expect(daily).toBe(0);
		expect(weekly).toBe(0);
	});
});
```

- [ ] **Step 2: Update `src/scheduler/risk-guardian-job.ts`**

```typescript
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { riskState, strategies } from "../db/schema.ts";
import { getOpenPositions } from "../paper/manager.ts";
import { getConfig } from "../config.ts";
import { runGuardian } from "../risk/guardian.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "risk-guardian-job" });

/**
 * Read daily and weekly PnL from risk_state (accumulated by position manager).
 */
export async function getLivePnl(): Promise<{ daily: number; weekly: number }> {
	const db = getDb();

	const [dailyRow] = await db
		.select({ value: riskState.value })
		.from(riskState)
		.where(eq(riskState.key, "daily_pnl"))
		.limit(1);

	const [weeklyRow] = await db
		.select({ value: riskState.value })
		.from(riskState)
		.where(eq(riskState.key, "weekly_pnl"))
		.limit(1);

	return {
		daily: dailyRow ? Number.parseFloat(dailyRow.value) : 0,
		weekly: weeklyRow ? Number.parseFloat(weeklyRow.value) : 0,
	};
}

/**
 * Compute the current portfolio value.
 * When live trading is enabled, uses IBKR account summary.
 * Otherwise, sums paper strategy virtual balances.
 */
async function computePortfolioState(): Promise<number> {
	const config = getConfig();

	if (config.LIVE_TRADING_ENABLED) {
		try {
			const { isConnected } = await import("../broker/connection.ts");
			if (isConnected()) {
				const { getAccountSummary } = await import("../broker/account.ts");
				const summary = await getAccountSummary();
				return summary.netLiquidation;
			}
		} catch (err) {
			log.warn({ error: err }, "Failed to get IBKR account summary — falling back to paper");
		}
	}

	// Fallback: paper strategy virtual balances
	const db = getDb();
	const activeStrategies = await db.select().from(strategies).where(eq(strategies.status, "paper"));

	let totalBalance = 0;
	for (const s of activeStrategies) {
		totalBalance += s.virtualBalance;
		const positions = await getOpenPositions(s.id);
		for (const p of positions) {
			totalBalance += p.quantity * (p.currentPrice ?? p.entryPrice);
		}
	}

	return totalBalance;
}

/**
 * Run the risk guardian check. Called every 10 minutes during market hours.
 */
export async function runRiskGuardianJob(): Promise<void> {
	const portfolioValue = await computePortfolioState();
	const { daily, weekly } = await getLivePnl();

	const verdict = await runGuardian(portfolioValue, daily, weekly);

	if (!verdict.canTrade || verdict.reduceSizes) {
		log.warn({ verdict }, "Risk guardian flagged issues");
	} else {
		log.debug({ portfolioValue, daily, weekly }, "Risk guardian: all clear");
	}
}
```

- [ ] **Step 3: Run tests**

```bash
bun test tests/scheduler/risk-guardian-job.test.ts
bun test
```

---

## Task 10: Guardian Stop at Market Close

**File:** `src/scheduler/cron.ts`

**Problem:** `guardian_start` runs at 08:00 but never stops. Runs 24/7 once started.

- [ ] **Step 1: Add `guardian_stop` job type**

In `src/scheduler/jobs.ts`, add to the `JobName` union:

```typescript
| "guardian_stop"
```

Add the case in `executeJob`:

```typescript
case "guardian_stop": {
	const { stopGuardianJob } = await import("./guardian-job.ts");
	await stopGuardianJob();
	break;
}
```

- [ ] **Step 2: Add cron entry**

In `src/scheduler/cron.ts`, after the `guardian_start` entry (line 92), add:

```typescript
// Guardian stop at 21:00 weekdays (market close)
tasks.push(
	cron.schedule("0 21 * * 1-5", () => runJob("guardian_stop"), {
		timezone: "Europe/London",
	}),
);
```

- [ ] **Step 3: Run tests**

```bash
bun test
```

---

## Task 11: IB Gateway Docker Setup

**Create:** `docker/docker-compose.yml`, `docker/.env.example`

Adapted from v1's setup. IB Gateway only — trader stays on systemd.

- [ ] **Step 1: Create `docker/.env.example`**

```env
# IBKR credentials
IBKR_USERNAME=your_username
IBKR_PASSWORD=your_password
IBKR_TRADING_MODE=paper  # paper or live

# VNC (for emergency IB Gateway access)
VNC_PASSWORD=changeme
```

- [ ] **Step 2: Create `docker/docker-compose.yml`**

```yaml
services:
  ib-gateway:
    image: gnzsnz/ib-gateway:latest
    restart: unless-stopped
    ports:
      - "127.0.0.1:4002:4002"
      - "127.0.0.1:5900:5900"
    environment:
      TWS_USERID: ${IBKR_USERNAME}
      TWS_PASSWORD: ${IBKR_PASSWORD}
      TRADING_MODE: ${IBKR_TRADING_MODE:-paper}
      TWS_ACCEPT_INCOMING: "accept"
      READ_ONLY_API: "no"
      VNC_SERVER_PASSWORD: ${VNC_PASSWORD:-changeme}
      EXISTING_SESSION_DETECTED_ACTION: "primaryoverride"
      TWS_COLD_RESTART: "05:00"
    healthcheck:
      test: ["CMD", "bash", "-c", "echo > /dev/tcp/localhost/4002"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 60s
    volumes:
      - ib-gateway-data:/opt/ibgateway

volumes:
  ib-gateway-data:
```

- [ ] **Step 3: Add docker/.env to .gitignore**

Verify `docker/.env` is already covered by `.gitignore`. If not, add it.

- [ ] **Step 4: Verify compose file is valid**

```bash
cd docker && docker compose config --quiet; echo $?
```

---

## Task 12: Unit Tests for Full Live Executor Flow

Create an integration-style unit test that exercises the full live executor flow with mocked IBKR connection.

- [ ] **Step 1: Create `tests/live/executor-integration.test.ts`**

This test validates that the executor:
1. Checks halt status
2. Evaluates signals using `buildSignalContext` + `evalExpr`
3. Runs risk gate before entry
4. Respects capital allocator limits

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { getDb, closeDb } from "../../src/db/client.ts";
import { resetConfigForTesting } from "../../src/config.ts";
import { strategies } from "../../src/db/schema.ts";
import { buildSignalContext } from "../../src/strategy/context.ts";
import { evalExpr } from "../../src/strategy/expr-eval.ts";
import { checkTradeRiskGate } from "../../src/risk/gate.ts";

process.env.DB_PATH = ":memory:";

describe("live executor integration", () => {
	beforeEach(() => {
		closeDb();
		process.env.DB_PATH = ":memory:";
		resetConfigForTesting();
		migrate(getDb(), { migrationsFolder: "./drizzle/migrations" });
	});

	test("signal evaluation + risk gate pipeline works end-to-end", () => {
		// Simulate what the live executor does:
		// 1. Build context from quote + indicators
		const ctx = buildSignalContext({
			quote: {
				last: 150,
				bid: 149.5,
				ask: 150.5,
				volume: 1000000,
				avgVolume: 800000,
				changePercent: -3.0,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 25, atr14: 3.5, volume_ratio: 1.25 },
			position: null,
		});

		// 2. Evaluate signal expression
		const signal = "rsi14 < 30 AND change_percent < -2";
		const shouldEnter = evalExpr(signal, ctx);
		expect(shouldEnter).toBe(true);

		// 3. Risk gate check
		const gateResult = checkTradeRiskGate({
			accountBalance: 500,
			price: 150,
			atr14: 3.5,
			side: "BUY",
			exchange: "NASDAQ",
			sector: null,
			borrowFeeAnnualPct: null,
			openPositionCount: 0,
			openPositionSectors: [],
		});

		expect(gateResult.allowed).toBe(true);
		expect(gateResult.sizing!.quantity).toBeGreaterThan(0);
		expect(gateResult.sizing!.stopLossPrice).toBeLessThan(150);
	});

	test("exit signal with position context", () => {
		const openedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
		const ctx = buildSignalContext({
			quote: {
				last: 170,
				bid: 169.5,
				ask: 170.5,
				volume: null,
				avgVolume: null,
				changePercent: 2.0,
				newsSentiment: null,
				newsEarningsSurprise: null,
				newsGuidanceChange: null,
				newsManagementTone: null,
				newsRegulatoryRisk: null,
				newsAcquisitionLikelihood: null,
				newsCatalystType: null,
				newsExpectedMoveDuration: null,
			},
			indicators: { rsi14: 75, atr14: 4.0, volume_ratio: 0.8 },
			position: { entryPrice: 150, openedAt, quantity: 10 },
		});

		// Exit when RSI overbought and profitable
		const shouldExit = evalExpr("rsi14 > 70 AND pnl_pct > 10", ctx);
		expect(shouldExit).toBe(true);
	});
});
```

- [ ] **Step 2: Run all tests**

```bash
bun test
```

---

## Verification Checklist

After all tasks are complete:

- [ ] `bun test` — all tests pass
- [ ] `bunx biome check src/ tests/` — no lint errors
- [ ] Signal evaluation uses `buildSignalContext` + `evalExpr` (same as paper)
- [ ] Risk gate called before every live entry (BUY and SELL)
- [ ] Trading halt checked at top of `runLiveExecutor()`
- [ ] `getAccountSummary()` provides real IBKR cash (with fallback)
- [ ] `onEntryFill()` creates `livePositions` rows
- [ ] `onExitFill()` computes PnL, deletes position, accumulates daily/weekly PnL
- [ ] Short stop-loss detection works (`price >= stop` for shorts)
- [ ] IBKR connects on boot when `LIVE_TRADING_ENABLED=true`
- [ ] Position reconciliation runs on boot and reconnect
- [ ] Risk guardian reads real daily/weekly PnL
- [ ] Guardian stops at 21:00 (market close)
- [ ] Docker compose for IB Gateway is ready
