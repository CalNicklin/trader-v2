# Insight Review Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six no-prerequisite proposals from `docs/insight-reviews/2026-04-17.md` as a single bundle of independent, testable changes to the paper-loop, population, and news pipeline.

**Architecture:** Six independent code paths, one TDD cycle each, one commit per task. No shared abstractions, no new subsystems. Three tasks (shared predicate, basket-cap, LSE cooldown) change existing behaviour; three (kill-event fields, USO universe, calibration table) are purely additive.

**Tech Stack:** Bun runtime, TypeScript (strict), Drizzle ORM + `bun:sqlite`, Biome formatter (tab indentation), `bun test --preload ./tests/preload.ts`. Migrations via Drizzle. No Node, no dotenv.

**Review source:** `docs/insight-reviews/2026-04-17.md` (commit `3baa884`). Proposals numbered per that doc — cite them in commit messages.

**Scope note on Risk #1 (basket-cap).** Initial review framing said `MAX_CONCURRENT_POSITIONS` was "defined but not consulted." Verified against `src/risk/limits.ts:46` and `src/strategy/evaluator.ts:316` — the constant IS consulted by `checkTradeRiskGate`, but the gate reads `openPositionCount` ONCE per strategy loop iteration and never increments it as trades open within the same tick. On 2026-04-08, all 7 shorts saw `openPositionCount=0` and passed the gate. The fix is a within-tick counter, not wiring up a dormant constant.

---

### Task 1: Shared `hasStableEdge` sample-quality predicate (Proposal #2)

**Why:** Strategy 3 has Sharpe 48.57 at n=3 (one AI-rally week) — a naive graduation check would promote it on lucky regime exposure. Strategies 1/4 have Sharpe -13.9 / -15.6 but small drawdowns, so `checkDrawdowns()` never fires. One predicate governs both promotion and expectancy-kill with the same evidence bar.

**Files:**
- Create: `src/evolution/has-stable-edge.ts`
- Modify: `src/strategy/graduation.ts` (consume predicate in `checkGraduation`)
- Modify: `src/evolution/population.ts` (add `checkExpectancyKill()` using predicate)
- Test: `tests/evolution/has-stable-edge.test.ts`
- Test: `tests/evolution/expectancy-kill.test.ts`

- [ ] **Step 1.1: Write the failing test for the predicate**

Create `tests/evolution/has-stable-edge.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { hasStableEdge } from "../../src/evolution/has-stable-edge.ts";

describe("hasStableEdge", () => {
	test("promote: returns false when sample size < 15", () => {
		expect(hasStableEdge({ sampleSize: 14, sharpeRatio: 2, backHalfPnl: 100 }, "promote")).toBe(false);
	});

	test("promote: returns true when sample >= 15 and signs match (both positive)", () => {
		expect(hasStableEdge({ sampleSize: 15, sharpeRatio: 1.5, backHalfPnl: 50 }, "promote")).toBe(true);
	});

	test("promote: returns false when back-half contradicts full-sample sign", () => {
		expect(hasStableEdge({ sampleSize: 20, sharpeRatio: 1.2, backHalfPnl: -10 }, "promote")).toBe(false);
	});

	test("retire: returns false when sample size < 20", () => {
		expect(hasStableEdge({ sampleSize: 19, sharpeRatio: -3, backHalfPnl: -50 }, "retire")).toBe(false);
	});

	test("retire: returns true when sample >= 20 and back-half confirms negative Sharpe", () => {
		expect(hasStableEdge({ sampleSize: 20, sharpeRatio: -3, backHalfPnl: -40 }, "retire")).toBe(true);
	});

	test("retire: returns false if back-half shows recent recovery", () => {
		expect(hasStableEdge({ sampleSize: 25, sharpeRatio: -2, backHalfPnl: 15 }, "retire")).toBe(false);
	});

	test("handles null Sharpe defensively (returns false for both)", () => {
		expect(hasStableEdge({ sampleSize: 20, sharpeRatio: null, backHalfPnl: 0 }, "promote")).toBe(false);
		expect(hasStableEdge({ sampleSize: 20, sharpeRatio: null, backHalfPnl: 0 }, "retire")).toBe(false);
	});
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/evolution/has-stable-edge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 1.3: Implement the predicate**

Create `src/evolution/has-stable-edge.ts`:

```typescript
export interface StableEdgeInput {
	sampleSize: number;
	sharpeRatio: number | null;
	backHalfPnl: number; // sum of pnl over most recent 50% of closed trades
}

export const MIN_SAMPLE_PROMOTE = 15;
export const MIN_SAMPLE_RETIRE = 20;

/**
 * Shared sample-quality predicate used by both the graduation gate and the
 * expectancy-kill path. Requires the back-half of the trade history to
 * confirm the full-sample Sharpe sign — this blocks regime-lucky promotion
 * (e.g. strategy 3's n=3 AI-rally wins) and regime-unlucky retirement
 * (e.g. strategy 1's n=7 shorts-into-rally losses).
 */
export function hasStableEdge(input: StableEdgeInput, direction: "promote" | "retire"): boolean {
	if (input.sharpeRatio == null) return false;

	const minSample = direction === "promote" ? MIN_SAMPLE_PROMOTE : MIN_SAMPLE_RETIRE;
	if (input.sampleSize < minSample) return false;

	const fullSignPositive = input.sharpeRatio > 0;
	const backHalfSignPositive = input.backHalfPnl > 0;

	if (direction === "promote") {
		return fullSignPositive && backHalfSignPositive;
	}
	return !fullSignPositive && !backHalfSignPositive;
}
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/evolution/has-stable-edge.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 1.5: Wire predicate into graduation gate**

Modify `src/strategy/graduation.ts` — replace the `minSampleSize` and `walkForwardSplit` hardcoded checks (lines ~48 and ~101) with a single call to `hasStableEdge`. Add import at top:

```typescript
import { hasStableEdge, MIN_SAMPLE_PROMOTE } from "../evolution/has-stable-edge.ts";
```

Replace the sample-size block (around line 47):

```typescript
if (metrics.sampleSize < MIN_SAMPLE_PROMOTE) {
	failures.push(`Insufficient sample size: ${metrics.sampleSize} < ${MIN_SAMPLE_PROMOTE}`);
}
```

After the existing Sharpe check (around line 69), add:

```typescript
// Shared predicate: back-half must confirm full-sample Sharpe sign
const backHalfPnl = await getBackHalfPnl(strategyId);
if (!hasStableEdge(
	{ sampleSize: metrics.sampleSize, sharpeRatio: metrics.sharpeRatio, backHalfPnl },
	"promote",
)) {
	failures.push("hasStableEdge(promote) false — back-half Sharpe sign does not confirm full sample");
}
```

And add the helper at the bottom of the same file (replace the existing `checkWalkForward` — the back-half-pnl form is cleaner and the predicate subsumes its intent):

```typescript
async function getBackHalfPnl(strategyId: number): Promise<number> {
	const db = getDb();
	const trades = await db
		.select({ pnl: paperTrades.pnl })
		.from(paperTrades)
		.where(and(eq(paperTrades.strategyId, strategyId), isNotNull(paperTrades.pnl)))
		.orderBy(paperTrades.createdAt);

	if (trades.length === 0) return 0;
	const splitIdx = Math.floor(trades.length / 2);
	return trades.slice(splitIdx).reduce((sum, t) => sum + (t.pnl ?? 0), 0);
}
```

Delete `checkWalkForward` and the `walkForwardResult` block.

- [ ] **Step 1.6: Run the graduation test suite**

Run: `bun test --preload ./tests/preload.ts tests/strategy/graduation.test.ts`
Expected: PASS. If any test asserts on the old 0.8-split walk-forward wording, update its assertion to the new failure string: `hasStableEdge(promote) false …`. Do NOT weaken the predicate to make a test pass — the new semantics are the product, not an accident.

- [ ] **Step 1.7: Write failing test for expectancy-kill path**

Create `tests/evolution/expectancy-kill.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("checkExpectancyKill", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });

		const { graduationEvents, strategyMetrics, strategies, paperTrades } = await import(
			"../../src/db/schema.ts"
		);
		await db.delete(graduationEvents);
		await db.delete(strategyMetrics);
		await db.delete(paperTrades);
		await db.delete(strategies);
	});

	async function insertStrategyWithBackHalfPnl(sharpe: number, sampleSize: number, backHalfPnl: number) {
		const { strategies, strategyMetrics, paperTrades } = await import("../../src/db/schema.ts");
		const [row] = await db.insert(strategies).values({
			name: "bad_strat", description: "x", parameters: "{}",
			status: "paper" as const, virtualBalance: 10000, generation: 1,
		}).returning();
		const id = row!.id;
		await db.insert(strategyMetrics).values({
			strategyId: id,
			sampleSize,
			sharpeRatio: sharpe,
			maxDrawdownPct: 2, // low — below 15% kill threshold
		});
		// Insert N trades with the back-half summing to backHalfPnl
		const trades = Array.from({ length: sampleSize }, (_, i) => ({
			strategyId: id,
			symbol: "TEST", exchange: "NASDAQ", side: "BUY" as const,
			quantity: 1, price: 100, friction: 0,
			pnl: i >= Math.floor(sampleSize / 2) ? backHalfPnl / Math.ceil(sampleSize / 2) : -10,
			signalType: "exit",
		}));
		for (const t of trades) await db.insert(paperTrades).values(t);
		return id;
	}

	test("retires strategy with negative Sharpe and confirming back-half at n>=20", async () => {
		const { checkExpectancyKill } = await import("../../src/evolution/population.ts");
		const { strategies } = await import("../../src/db/schema.ts");
		const id = await insertStrategyWithBackHalfPnl(-3, 20, -40);

		const killed = await checkExpectancyKill();

		expect(killed).toEqual([id]);
		const [row] = await db.select().from(strategies).where(eq(strategies.id, id));
		expect(row?.status).toBe("retired");
	});

	test("does NOT retire when back-half shows recovery", async () => {
		const { checkExpectancyKill } = await import("../../src/evolution/population.ts");
		const id = await insertStrategyWithBackHalfPnl(-3, 25, 20);

		const killed = await checkExpectancyKill();

		expect(killed).toEqual([]);
	});

	test("does NOT retire at n<20 even with bad Sharpe", async () => {
		const { checkExpectancyKill } = await import("../../src/evolution/population.ts");
		const id = await insertStrategyWithBackHalfPnl(-15, 19, -50);

		const killed = await checkExpectancyKill();

		expect(killed).toEqual([]);
	});
});
```

- [ ] **Step 1.8: Run test to verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/evolution/expectancy-kill.test.ts`
Expected: FAIL — `checkExpectancyKill` not exported.

- [ ] **Step 1.9: Implement `checkExpectancyKill`**

Modify `src/evolution/population.ts`. Add imports at top:

```typescript
import { and, eq, isNotNull } from "drizzle-orm";
import { paperTrades } from "../db/schema";
import { hasStableEdge } from "./has-stable-edge.ts";
```

Add constant next to the existing ones:

```typescript
export const EXPECTANCY_KILL_SHARPE_FLOOR = -2;
```

Add the new function (after `checkDrawdowns`):

```typescript
export async function checkExpectancyKill(): Promise<number[]> {
	const db = getDb();

	const paperStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"))
		.all();

	const killed: number[] = [];

	for (const strategy of paperStrategies) {
		const metrics = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strategy.id))
			.get();

		if (!metrics || metrics.sharpeRatio == null) continue;
		if (metrics.sharpeRatio >= EXPECTANCY_KILL_SHARPE_FLOOR) continue;

		const trades = await db
			.select({ pnl: paperTrades.pnl })
			.from(paperTrades)
			.where(and(eq(paperTrades.strategyId, strategy.id), isNotNull(paperTrades.pnl)))
			.orderBy(paperTrades.createdAt);

		if (trades.length === 0) continue;
		const splitIdx = Math.floor(trades.length / 2);
		const backHalfPnl = trades.slice(splitIdx).reduce((s, t) => s + (t.pnl ?? 0), 0);

		if (
			hasStableEdge(
				{ sampleSize: metrics.sampleSize, sharpeRatio: metrics.sharpeRatio, backHalfPnl },
				"retire",
			)
		) {
			await retireStrategy(
				strategy.id,
				`Expectancy kill: Sharpe ${metrics.sharpeRatio.toFixed(2)} at n=${metrics.sampleSize} with confirming back-half (${backHalfPnl.toFixed(2)})`,
			);
			killed.push(strategy.id);
		}
	}

	return killed;
}
```

- [ ] **Step 1.10: Run all tests**

Run: `bun test --preload ./tests/preload.ts tests/evolution/ tests/strategy/graduation.test.ts`
Expected: all PASS.

- [ ] **Step 1.11: Wire `checkExpectancyKill` into the scheduler**

Find where `checkDrawdowns` is invoked by the scheduler:

Run: `grep -rn "checkDrawdowns" src/`

In the same cron job (likely `src/scheduler/` — check the grep output), add a sibling call:

```typescript
const expectancyKilled = await checkExpectancyKill();
```

Commit if this file exists and the grep finds a clear caller. If not found, note in commit message as follow-up and keep the function dormant (it's still available for manual call).

- [ ] **Step 1.12: Commit**

```bash
git add src/evolution/has-stable-edge.ts src/evolution/population.ts src/strategy/graduation.ts tests/evolution/has-stable-edge.test.ts tests/evolution/expectancy-kill.test.ts
git commit -m "Proposal #2: shared hasStableEdge predicate for graduate/kill"
```

---

### Task 2: MAX_CONCURRENT_POSITIONS within-tick enforcement (Proposal #3)

**Why:** Strategy 2 opened 7 correlated shorts inside ~200ms on 2026-04-08, bypassing the declared `MAX_CONCURRENT_POSITIONS=3` cap. Root cause: the evaluator reads `openPositionCount` once per strategy loop and passes a stale count to the risk gate for every symbol in the tick. Fix: increment a local counter as opens succeed within the tick, and reject the ENTIRE tick (not 3-of-N) when the cap would be breached.

**Files:**
- Modify: `src/strategy/evaluator.ts` (around the per-symbol loop, lines ~316–400)
- Create: `src/risk/basket-cap.ts` (new file — basket-over-cap detector)
- Test: `tests/strategy/evaluator-basket-cap.test.ts`

- [ ] **Step 2.1: Write the failing test**

Create `tests/strategy/evaluator-basket-cap.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("evaluator basket-cap enforcement", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("tickWouldBreachCap returns true when proposed opens + existing > cap", async () => {
		const { tickWouldBreachCap } = await import("../../src/risk/basket-cap.ts");
		expect(tickWouldBreachCap(0, 7, 3)).toBe(true);
		expect(tickWouldBreachCap(2, 2, 3)).toBe(true);
		expect(tickWouldBreachCap(0, 3, 3)).toBe(false);
		expect(tickWouldBreachCap(1, 2, 3)).toBe(false);
	});
});
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/strategy/evaluator-basket-cap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 2.3: Create the basket-cap helper**

Create `src/risk/basket-cap.ts`:

```typescript
import { MAX_CONCURRENT_POSITIONS } from "./constants.ts";

/**
 * Check whether a single dispatch tick's proposed opens would breach the
 * concurrent-position cap. On 2026-04-08 strategy 2 opened 7 correlated shorts
 * in one tick because the gate read openPositionCount once up-front and
 * never incremented it as opens succeeded. This helper lets the evaluator
 * reject the entire tick when a basket would breach, rather than silently
 * admitting 3 of N by insert-order.
 */
export function tickWouldBreachCap(
	existingOpen: number,
	proposedOpens: number,
	cap: number = MAX_CONCURRENT_POSITIONS,
): boolean {
	return existingOpen + proposedOpens > cap;
}
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/strategy/evaluator-basket-cap.test.ts`
Expected: PASS.

- [ ] **Step 2.5: Wire the cap enforcement into the evaluator loop**

Modify `src/strategy/evaluator.ts`. Find the per-strategy block (around line 316) where `openPositions` is fetched. Restructure the symbol loop into two passes:

Pass 1 — collect proposed entries (do not open yet):

```typescript
const proposedEntries: Array<{
	symbol: string; exchange: string; side: "BUY" | "SELL";
	price: number; quantity: number; stopLossPrice: number | undefined;
	signalType: "entry_long" | "entry_short"; reasoning: string;
}> = [];
// ... existing symbol loop, but inside each entry_long / entry_short branch,
// replace `await openPaperPosition({...})` with `proposedEntries.push({...})`.
// Exit signals continue to fire immediately (they reduce exposure, not increase).
```

Pass 2 — apply basket-cap, then open:

```typescript
import { tickWouldBreachCap } from "../risk/basket-cap.ts";
import { MAX_CONCURRENT_POSITIONS } from "../risk/constants.ts";

if (tickWouldBreachCap(openPositions.length, proposedEntries.length)) {
	log.warn(
		{
			strategy: strategy.name,
			existing: openPositions.length,
			proposed: proposedEntries.length,
			symbols: proposedEntries.map((e) => `${e.symbol}:${e.exchange}`),
			cap: MAX_CONCURRENT_POSITIONS,
		},
		"basket_over_cap: rejecting entire tick",
	);
	// Skip opens; diagnostic event logged above.
} else {
	for (const entry of proposedEntries) {
		await openPaperPosition({
			strategyId: strategy.id,
			symbol: entry.symbol,
			exchange: entry.exchange,
			side: entry.side,
			price: entry.price,
			quantity: entry.quantity,
			signalType: entry.signalType,
			reasoning: entry.reasoning,
		});
	}
}
```

- [ ] **Step 2.6: Add an integration test simulating the 2026-04-08 basket**

Append to `tests/strategy/evaluator-basket-cap.test.ts`:

```typescript
test("evaluator rejects tick when 7 entries are proposed simultaneously", async () => {
	// Seed a strategy with entry_short signal that fires on all 7 symbols
	const { strategies } = await import("../../src/db/schema.ts");
	await db.insert(strategies).values({
		name: "basket_fire",
		description: "fires short on every tick",
		parameters: JSON.stringify({ position_size_pct: 5 }),
		signals: JSON.stringify({
			entry_long: "false",
			entry_short: "true", // fires unconditionally for test
			exit: "false",
		}),
		universe: JSON.stringify(["AMD", "META", "TSLA", "NVDA", "GOOGL", "AVGO", "AAPL"]),
		status: "paper" as const,
		virtualBalance: 10000,
		generation: 1,
	});

	// Stub quote provider returning valid quotes for all 7 symbols
	const { evaluateAllStrategies } = await import("../../src/strategy/evaluator.ts");
	const stubGetQuote = async (symbol: string, exchange: string) => ({
		quote: { symbol, exchange, last: 100, bid: 99.9, ask: 100.1, volume: 1_000_000, avgVolume: 1_000_000, changePercent: 0, newsSentiment: -0.5 } as any,
		indicators: { atr14: 2, rsi14: 60, volume_ratio: 1.5 } as any,
	});

	await evaluateAllStrategies(stubGetQuote);

	const { paperPositions } = await import("../../src/db/schema.ts");
	const openPositions = await db.select().from(paperPositions);
	// All 7 should be rejected as a basket — none should open
	expect(openPositions.length).toBe(0);
});
```

- [ ] **Step 2.7: Run the test**

Run: `bun test --preload ./tests/preload.ts tests/strategy/evaluator-basket-cap.test.ts`
Expected: PASS for both tests. Iterate on the evaluator changes if the integration test fails — the unit test for `tickWouldBreachCap` should remain green.

- [ ] **Step 2.8: Commit**

```bash
git add src/risk/basket-cap.ts src/strategy/evaluator.ts tests/strategy/evaluator-basket-cap.test.ts
git commit -m "Proposal #3: reject entire tick when basket would breach MAX_CONCURRENT_POSITIONS"
```

---

### Task 3: LSE same-symbol BUY cooldown (Proposal #5)

**Why:** Strategy 2 cycled HSBA three times in one session 2026-04-08 (short → cover → short → cover → short → cover). Each BUY-to-cover paid ~£8 stamp duty (0.5%) + commission = ~£9.34 round-trip, accounting for ~36% of the realised loss. Block LSE BUYs on the same symbol+strategy within a 4h window.

**Files:**
- Modify: `src/paper/manager.ts` (entry guard inside `openPaperPosition`)
- Test: `tests/paper/lse-cooldown.test.ts`

- [ ] **Step 3.1: Write the failing test**

Create `tests/paper/lse-cooldown.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("LSE same-symbol BUY cooldown", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	async function insertStrategy() {
		const { strategies } = await import("../../src/db/schema.ts");
		const [row] = await db.insert(strategies).values({
			name: "lse_test", description: "x", parameters: "{}",
			status: "paper" as const, virtualBalance: 10000, generation: 1,
		}).returning();
		return row!;
	}

	test("second LSE BUY within 4h is rejected with WouldBreachCooldownError", async () => {
		const { openPaperPosition, WouldBreachCooldownError } = await import("../../src/paper/manager.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id, symbol: "HSBA", exchange: "LSE",
			side: "BUY", price: 1350, quantity: 1,
			signalType: "entry_long", reasoning: "test",
		});

		await expect(
			openPaperPosition({
				strategyId: strat.id, symbol: "HSBA", exchange: "LSE",
				side: "BUY", price: 1340, quantity: 1,
				signalType: "entry_long", reasoning: "test",
			}),
		).rejects.toBeInstanceOf(WouldBreachCooldownError);
	});

	test("NASDAQ BUYs are unaffected (cooldown is LSE-only)", async () => {
		const { openPaperPosition } = await import("../../src/paper/manager.ts");
		const { paperPositions } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id, symbol: "AAPL", exchange: "NASDAQ",
			side: "BUY", price: 250, quantity: 1,
			signalType: "entry_long", reasoning: "test",
		});
		await openPaperPosition({
			strategyId: strat.id, symbol: "AAPL", exchange: "NASDAQ",
			side: "BUY", price: 251, quantity: 1,
			signalType: "entry_long", reasoning: "test",
		});

		const positions = await db.select().from(paperPositions).where(eq(paperPositions.strategyId, strat.id));
		expect(positions.length).toBe(2);
	});

	test("SELL-to-cover on LSE is NOT blocked (only BUYs are)", async () => {
		const { openPaperPosition } = await import("../../src/paper/manager.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id, symbol: "HSBA", exchange: "LSE",
			side: "SELL", price: 1350, quantity: 1,
			signalType: "entry_short", reasoning: "test",
		});
		// A subsequent SELL (short-cover or new short) must NOT throw
		await openPaperPosition({
			strategyId: strat.id, symbol: "HSBA", exchange: "LSE",
			side: "SELL", price: 1330, quantity: 1,
			signalType: "entry_short", reasoning: "test",
		});
	});
});
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/paper/lse-cooldown.test.ts`
Expected: FAIL — `WouldBreachCooldownError` not exported.

- [ ] **Step 3.3: Implement cooldown in `openPaperPosition`**

Modify `src/paper/manager.ts`. Add imports at top:

```typescript
import { gt } from "drizzle-orm";
```

Add constant and error class near the other exports:

```typescript
export const LSE_SAME_SYMBOL_BUY_COOLDOWN_HOURS = 4;

export class WouldBreachCooldownError extends Error {
	constructor(symbol: string, exchange: string, hoursRemaining: number) {
		super(`LSE cooldown: ${symbol}:${exchange} has ${hoursRemaining.toFixed(1)}h cooldown remaining`);
		this.name = "WouldBreachCooldownError";
	}
}
```

Insert cooldown check at the top of `openPaperPosition`, before the DB writes:

```typescript
export async function openPaperPosition(input: OpenPositionInput): Promise<void> {
	const db = getDb();

	if (input.exchange === "LSE" && input.side === "BUY") {
		const cutoff = new Date(
			Date.now() - LSE_SAME_SYMBOL_BUY_COOLDOWN_HOURS * 60 * 60 * 1000,
		).toISOString();
		const [recent] = await db
			.select({ createdAt: paperTrades.createdAt })
			.from(paperTrades)
			.where(
				and(
					eq(paperTrades.strategyId, input.strategyId),
					eq(paperTrades.symbol, input.symbol),
					eq(paperTrades.exchange, "LSE"),
					eq(paperTrades.side, "BUY"),
					gt(paperTrades.createdAt, cutoff),
				),
			)
			.orderBy(paperTrades.createdAt)
			.limit(1);

		if (recent) {
			const ageHours = (Date.now() - new Date(recent.createdAt).getTime()) / 3_600_000;
			const remaining = LSE_SAME_SYMBOL_BUY_COOLDOWN_HOURS - ageHours;
			throw new WouldBreachCooldownError(input.symbol, input.exchange, remaining);
		}
	}

	// ... existing implementation continues unchanged
```

- [ ] **Step 3.4: Update the evaluator caller to swallow the cooldown error**

Modify `src/strategy/evaluator.ts` — wrap each `openPaperPosition` call site (in the proposed-entries execution from Task 2, or directly if Task 2 not yet merged) in a try/catch that logs and continues:

```typescript
try {
	await openPaperPosition({ ... });
} catch (err) {
	if (err instanceof WouldBreachCooldownError) {
		log.info({ strategy: strategy.name, err: err.message }, "lse_cooldown_block");
		continue; // or skip this entry — do not rethrow
	}
	throw err;
}
```

Add `WouldBreachCooldownError` to the `src/paper/manager.ts` import at the top of `evaluator.ts`.

- [ ] **Step 3.5: Run tests**

Run: `bun test --preload ./tests/preload.ts tests/paper/ tests/strategy/evaluator-basket-cap.test.ts`
Expected: all PASS.

- [ ] **Step 3.6: Commit**

```bash
git add src/paper/manager.ts src/strategy/evaluator.ts tests/paper/lse-cooldown.test.ts
git commit -m "Proposal #5: LSE same-symbol BUY cooldown (4h) in paper manager"
```

---

### Task 4: Add USO to baseline universe (Proposal #8)

**Why:** No energy/commodity coverage in the current universe. USO (United States Oil Fund ETF) moved -7.8% on the Iran ceasefire event (insight #235) — the one symbol where `commodity_price_impact` maps mechanically to the underlying. Adding it gives the desk an instrument the next catalyst-momentum seed can trade; zero cost if no seed fires on it.

**Files:**
- Modify: `src/strategy/seed.ts` (append `USO` to each seed's `universe` array)
- Test: `tests/strategy/seed-universe.test.ts`

- [ ] **Step 4.1: Write the failing test**

Create `tests/strategy/seed-universe.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

describe("seed universes include USO (Proposal #8)", () => {
	test("every seed's universe includes USO", async () => {
		const seedModule = await import("../../src/strategy/seed.ts");
		const seeds = (seedModule as any).SEED_STRATEGIES ?? seedModule.default;
		expect(Array.isArray(seeds)).toBe(true);
		for (const seed of seeds) {
			const universe: string[] = JSON.parse(seed.universe);
			expect(universe).toContain("USO");
		}
	});
});
```

- [ ] **Step 4.2: Run the test**

Run: `bun test --preload ./tests/preload.ts tests/strategy/seed-universe.test.ts`
Expected: FAIL OR pass depending on whether `SEED_STRATEGIES` is exported. If the test errors because the constant isn't exported, add `export` in front of `const SEED_STRATEGIES` in `src/strategy/seed.ts` and re-run. Expected then: FAIL because no seed yet contains `USO`.

- [ ] **Step 4.3: Add USO to each seed's universe**

Modify `src/strategy/seed.ts`. For each of the three (or more) seed objects, append `"USO"` to the `universe` JSON array. Example for the first seed:

```typescript
universe: JSON.stringify([
	"AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "TSLA", "META", "JPM", "V", "JNJ",
	"USO", // Proposal #8 — energy/commodity proxy
	"SHEL:LSE", "BP.:LSE", "HSBA:LSE", "VOD:LSE", "RIO:LSE",
	"GAW:AIM", "FDEV:AIM", "TET:AIM", "JET2:AIM", "BOWL:AIM",
]),
```

Repeat for `gap_fade_v1`, `earnings_drift_v1`, and any further seeds. USO is a NYSE/NASDAQ-traded ETF — no exchange suffix needed (default NASDAQ handling applies as with AAPL/MSFT). Note: per NYSE Arca it trades under NYSE — if tests later fail on exchange resolution, switch to `"USO:NYSE"`.

- [ ] **Step 4.4: Run the test to verify it passes**

Run: `bun test --preload ./tests/preload.ts tests/strategy/seed-universe.test.ts`
Expected: PASS.

- [ ] **Step 4.5: Commit**

```bash
git add src/strategy/seed.ts tests/strategy/seed-universe.test.ts
git commit -m "Proposal #8: add USO to seed universes for commodity catalyst coverage"
```

---

### Task 5: Kill-event instrumentation fields (Proposal #12)

**Why:** Only 1 kill event in the 30-day snapshot — too thin to size the original staggered-exit proposal, and paper slippage is modelled not measured. Adding `killFillDurationMs` and `killLegsCount` to the kill-event evidence unblocks a future decision without committing to it. Proposal #12 is pure telemetry.

**Files:**
- Modify: `src/evolution/population.ts` (`retireStrategy` — capture timing + leg count, include in `evidence`)
- Modify: `src/paper/manager.ts` (`closeAllPositions` — return leg count and elapsed ms)
- Test: `tests/evolution/kill-instrumentation.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `tests/evolution/kill-instrumentation.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("kill-event instrumentation (Proposal #12)", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("kill evidence JSON contains killFillDurationMs and killLegsCount", async () => {
		const { strategies, strategyMetrics, paperPositions, graduationEvents } = await import(
			"../../src/db/schema.ts"
		);
		const [strat] = await db.insert(strategies).values({
			name: "bad", description: "x", parameters: "{}",
			status: "paper" as const, virtualBalance: 10000, generation: 1,
		}).returning();
		const id = strat!.id;
		await db.insert(strategyMetrics).values({ strategyId: id, sampleSize: 15, maxDrawdownPct: 20 });
		// Insert two open positions so kill has legs to close
		for (let i = 0; i < 2; i++) {
			await db.insert(paperPositions).values({
				strategyId: id,
				symbol: `SYM${i}`, exchange: "NASDAQ", side: "BUY",
				quantity: 1, entryPrice: 100, currentPrice: 95,
			});
		}

		const { checkDrawdowns } = await import("../../src/evolution/population.ts");
		await checkDrawdowns();

		const [event] = await db.select().from(graduationEvents).where(eq(graduationEvents.strategyId, id));
		expect(event).toBeTruthy();
		const evidence = JSON.parse(event!.evidence!);
		expect(evidence).toHaveProperty("killFillDurationMs");
		expect(evidence).toHaveProperty("killLegsCount");
		expect(evidence.killLegsCount).toBe(2);
		expect(typeof evidence.killFillDurationMs).toBe("number");
	});
});
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `bun test --preload ./tests/preload.ts tests/evolution/kill-instrumentation.test.ts`
Expected: FAIL — evidence lacks the two fields.

- [ ] **Step 5.3: Update `retireStrategy` to capture timing and legs**

Modify `src/evolution/population.ts`. Find `retireStrategy` (top of file). Update signature + body:

```typescript
import { closeAllPositions } from "../paper/manager.ts";

async function retireStrategy(strategyId: number, reason: string): Promise<void> {
	const db = getDb();
	const killStart = Date.now();

	const legsClosed = await closeAllPositions(strategyId, reason);

	const killFillDurationMs = Date.now() - killStart;

	await db
		.update(strategies)
		.set({ status: "retired" as const, retiredAt: new Date().toISOString() })
		.where(eq(strategies.id, strategyId));

	await db.insert(graduationEvents).values({
		strategyId,
		event: "killed" as const,
		evidence: JSON.stringify({
			reason,
			killFillDurationMs,
			killLegsCount: legsClosed,
		}),
	});

	log.warn(
		{ strategyId, killFillDurationMs, killLegsCount: legsClosed },
		`Strategy ${strategyId} retired: ${reason}`,
	);
}
```

Note: `closeAllPositions` already returns a number (verified in `src/paper/manager.ts:138`). If tests show positions weren't being closed before this change, the original `retireStrategy` was leaving orphans — flag that in the commit.

- [ ] **Step 5.4: Run the test**

Run: `bun test --preload ./tests/preload.ts tests/evolution/kill-instrumentation.test.ts tests/evolution/population.test.ts`
Expected: all PASS. If `population.test.ts` now fails because an existing test asserted on the old evidence shape, update that test to match the new JSON structure (same `reason`, plus the two new fields).

- [ ] **Step 5.5: Commit**

```bash
git add src/evolution/population.ts tests/evolution/kill-instrumentation.test.ts tests/evolution/population.test.ts
git commit -m "Proposal #12: instrument kill events with killFillDurationMs and killLegsCount"
```

---

### Task 6: News research calibration log (Proposal #4)

**Why:** The `news_research` job fires 798 calls / $7.14 / 30d (top cost line) but Alpha #4 and Opp #1 both depend on a precision measurement to size safely — and the snapshot's `missed_opportunity` table is winner-filtered (only logs correct predictions). Add a `research_outcome` table that captures every call's prediction and the realised move 24h/48h later. Zero gating, pure telemetry. Unblocks Wave 3.

**Files:**
- Create: `drizzle/migrations/0011_research_outcome.sql`
- Modify: `src/db/schema.ts` (add `researchOutcome` table)
- Create: `src/news/research-calibration.ts` (`recordOutcome`, `backfillOutcomes`)
- Modify: `src/news/research-agent.ts` (call `recordOutcome` at write time)
- Test: `tests/news/research-calibration.test.ts`

- [ ] **Step 6.1: Add schema**

Append to `src/db/schema.ts` (after `newsAnalyses`, before `tokenUsage`):

```typescript
// Proposal #4 — news_research calibration log.
// Records every research call's prediction and T+24h / T+48h realised move so
// precision can be computed across the FULL fired set, not just the surfaced
// missed_opportunity subset.
export const researchOutcome = sqliteTable(
	"research_outcome",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		newsAnalysisId: integer("news_analysis_id").notNull(),
		symbol: text("symbol").notNull(),
		exchange: text("exchange").notNull(),
		predictedDirection: text("predicted_direction", { enum: ["long", "short", "avoid"] }).notNull(),
		confidence: real("confidence").notNull(),
		eventType: text("event_type").notNull(),
		priceAtCall: real("price_at_call"),
		realisedMove24h: real("realised_move_24h"),
		realisedMove48h: real("realised_move_48h"),
		filled24hAt: text("filled_24h_at"),
		filled48hAt: text("filled_48h_at"),
		createdAt: text("created_at")
			.notNull()
			.$defaultFn(() => new Date().toISOString()),
	},
	(table) => ({
		analysisIdx: index("research_outcome_analysis_idx").on(table.newsAnalysisId),
		symbolIdx: index("research_outcome_symbol_idx").on(table.symbol, table.exchange),
	}),
);
```

- [ ] **Step 6.2: Generate the migration**

Run: `bunx drizzle-kit generate`
Expected: creates `drizzle/migrations/0011_*.sql` (name will be auto-generated). Verify the SQL contains `CREATE TABLE research_outcome` with matching columns. Commit the generated file as-is — do not hand-rename.

- [ ] **Step 6.3: Write failing tests**

Create `tests/news/research-calibration.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";

describe("news research calibration (Proposal #4)", () => {
	let db: ReturnType<typeof import("../../src/db/client.ts").getDb>;

	beforeEach(async () => {
		const { resetConfigForTesting } = await import("../../src/config.ts");
		resetConfigForTesting();
		const { closeDb, getDb } = await import("../../src/db/client.ts");
		closeDb();
		db = getDb();
		const { migrate } = await import("drizzle-orm/bun-sqlite/migrator");
		migrate(db, { migrationsFolder: "./drizzle/migrations" });
	});

	test("recordOutcome inserts a row with null realised fields at call time", async () => {
		const { recordOutcome } = await import("../../src/news/research-calibration.ts");
		const { researchOutcome } = await import("../../src/db/schema.ts");

		await recordOutcome({
			newsAnalysisId: 42,
			symbol: "ANET", exchange: "NASDAQ",
			predictedDirection: "long",
			confidence: 0.92,
			eventType: "analyst_upgrade",
			priceAtCall: 150,
		});

		const rows = await db.select().from(researchOutcome);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.predictedDirection).toBe("long");
		expect(rows[0]!.realisedMove24h).toBeNull();
		expect(rows[0]!.realisedMove48h).toBeNull();
	});

	test("backfillOutcomes fills realised moves from quotes_cache", async () => {
		const { recordOutcome, backfillOutcomes } = await import("../../src/news/research-calibration.ts");
		const { researchOutcome, quotesCache } = await import("../../src/db/schema.ts");
		const { eq } = await import("drizzle-orm");

		await recordOutcome({
			newsAnalysisId: 1, symbol: "ANET", exchange: "NASDAQ",
			predictedDirection: "long", confidence: 0.9, eventType: "analyst_upgrade",
			priceAtCall: 100,
		});

		// Stub current price 3% above priceAtCall
		await db.insert(quotesCache).values({ symbol: "ANET", exchange: "NASDAQ", last: 103 });

		await backfillOutcomes({ window: "24h" });

		const [row] = await db.select().from(researchOutcome);
		expect(row?.realisedMove24h).toBeCloseTo(0.03, 3);
		expect(row?.filled24hAt).toBeTruthy();
	});
});
```

- [ ] **Step 6.4: Run tests to verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/news/research-calibration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6.5: Implement the calibration module**

Create `src/news/research-calibration.ts`:

```typescript
import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { quotesCache, researchOutcome } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "research-calibration" });

export interface RecordOutcomeInput {
	newsAnalysisId: number;
	symbol: string;
	exchange: string;
	predictedDirection: "long" | "short" | "avoid";
	confidence: number;
	eventType: string;
	priceAtCall: number | null;
}

export async function recordOutcome(input: RecordOutcomeInput): Promise<void> {
	const db = getDb();
	await db.insert(researchOutcome).values({
		newsAnalysisId: input.newsAnalysisId,
		symbol: input.symbol,
		exchange: input.exchange,
		predictedDirection: input.predictedDirection,
		confidence: input.confidence,
		eventType: input.eventType,
		priceAtCall: input.priceAtCall,
	});
}

const MS_PER_HOUR = 3_600_000;

/** Fill realised-move columns by comparing priceAtCall against latest quote.
 * Run as a batch job T+24h and T+48h post-call. */
export async function backfillOutcomes(opts: { window: "24h" | "48h" }): Promise<number> {
	const db = getDb();
	const thresholdMs = opts.window === "24h" ? 24 * MS_PER_HOUR : 48 * MS_PER_HOUR;
	const cutoff = new Date(Date.now() - thresholdMs).toISOString();

	const filledColumn = opts.window === "24h" ? "filled24hAt" : "filled48hAt";
	const moveColumn = opts.window === "24h" ? "realisedMove24h" : "realisedMove48h";

	const pending = await db
		.select()
		.from(researchOutcome)
		.where(
			and(
				lt(researchOutcome.createdAt, cutoff),
				isNull((researchOutcome as any)[filledColumn]),
			),
		)
		.all();

	let filled = 0;
	for (const row of pending) {
		if (row.priceAtCall == null) continue;
		const [quote] = await db
			.select({ last: quotesCache.last })
			.from(quotesCache)
			.where(and(eq(quotesCache.symbol, row.symbol), eq(quotesCache.exchange, row.exchange)))
			.limit(1);
		if (!quote?.last) continue;

		const move = (quote.last - row.priceAtCall) / row.priceAtCall;
		await db
			.update(researchOutcome)
			.set({
				[moveColumn]: move,
				[filledColumn]: new Date().toISOString(),
			} as any)
			.where(eq(researchOutcome.id, row.id));
		filled++;
	}

	log.info({ window: opts.window, filled, considered: pending.length }, "calibration_backfill");
	return filled;
}
```

- [ ] **Step 6.6: Run the tests**

Run: `bun test --preload ./tests/preload.ts tests/news/research-calibration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6.7: Wire `recordOutcome` into the research agent write path**

Modify `src/news/research-agent.ts`. Find the spot where each analysis is persisted to `newsAnalyses`. After the insert returns an id, call `recordOutcome` for each analysis whose `direction !== "avoid"`:

```typescript
import { recordOutcome } from "./research-calibration.ts";
// ...
// After: await db.insert(newsAnalyses).values({...}).returning({ id: newsAnalyses.id })
for (const analysis of analyses) {
	if (analysis.direction === "avoid") continue;
	const [priceRow] = await db
		.select({ last: quotesCache.last })
		.from(quotesCache)
		.where(and(eq(quotesCache.symbol, analysis.symbol), eq(quotesCache.exchange, analysis.exchange)))
		.limit(1);
	await recordOutcome({
		newsAnalysisId: analysis.id, // or whatever the returned id variable is named
		symbol: analysis.symbol,
		exchange: analysis.exchange,
		predictedDirection: analysis.direction,
		confidence: analysis.confidence,
		eventType: analysis.eventType,
		priceAtCall: priceRow?.last ?? null,
	});
}
```

Exact placement depends on the existing structure of `research-agent.ts`; keep the call narrow and defensive (if it throws, log and continue — calibration must never break classification).

- [ ] **Step 6.8: Register the backfill job on the scheduler**

Find the scheduler's cron registration file:

Run: `grep -rn "cron" src/scheduler/ | grep -i "schedule\|register"`

Add two cron entries that call `backfillOutcomes({ window: "24h" })` and `backfillOutcomes({ window: "48h" })` — run daily at, say, 22:50 UTC (post-market, outside the existing `post_close` session but before any overnight batch). Follow the file's existing pattern for cron registration. If the pattern is unclear, leave this step for a follow-up commit — the `backfillOutcomes` function is callable manually from a REPL.

- [ ] **Step 6.9: Commit**

```bash
git add drizzle/migrations/0011_*.sql src/db/schema.ts src/news/research-calibration.ts src/news/research-agent.ts tests/news/research-calibration.test.ts
git commit -m "Proposal #4: research_outcome calibration log + backfill job"
```

---

## Post-merge sanity

After all 6 tasks land:

- [ ] **Run full test suite:** `bun test --preload ./tests/preload.ts`. Expected: all green.
- [ ] **Biome format check:** `bunx biome check --write src/ tests/`. Expected: no errors after auto-fixes.
- [ ] **Push to `main`:** deploys automatically via GitHub Actions (see CLAUDE.md). Monitor via `./scripts/vps-status.sh` for ~5 minutes post-push.
- [ ] **Verify behaviour on the VPS health endpoint** once the deploy settles — no regressions in the paper loop, scheduler cron still ticking.

## Notes for the executing agent

- **Order matters only between Task 1 and downstream work.** Task 1 adds exports (`WouldBreachCooldownError`, `hasStableEdge`) that Tasks 2, 3, 5 reference indirectly via shared modules. Complete Task 1 first, then 2–6 can be executed in any order.
- **Don't refactor adjacent code.** If you notice an unrelated smell while editing, leave it alone — file a follow-up issue instead. Wave 1 is scoped to the six proposals, nothing else.
- **Use `grep -rn` before editing unfamiliar files.** The codebase is largeish (100+ test files); specific patterns like "where does the scheduler actually register cron?" deserve a search before you guess.
- **LSE prices are in pence (GBp), not pounds** — see CLAUDE.md. Task 3's HSBA references assume pence.
- **Every commit message must cite the proposal number** (`Proposal #N: …`) so the next insight review can cross-reference easily.
