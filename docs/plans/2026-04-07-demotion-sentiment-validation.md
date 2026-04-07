# Demotion Wiring + Sentiment Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up dead demotion code into the live executor and validate whether news sentiment predicts price movements.

**Architecture:** Two independent fixes. Fix 1 adds a `checkTierBreach()` pure function to `demotion.ts` and a `runDemotionChecks()` orchestrator to `executor.ts` called at the end of each live execution cycle. Fix 2 adds schema columns for price capture, a CLI analysis script, and an eval suite for ongoing regression.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, SQLite, existing eval harness

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/risk/demotion.ts` | Add `checkTierBreach()` pure function |
| Modify | `src/live/executor.ts` | Add `runDemotionChecks()` orchestrator, call from `runLiveExecutor()` |
| Modify | `src/db/schema.ts` | Add `priceAtClassification`, `priceAfter1d` to `newsEvents` |
| Modify | `src/news/sentiment-writer.ts` | Capture price at classification time in `storeNewsEvent()` |
| Modify | `src/scheduler/quote-refresh.ts` | Backfill `priceAfter1d` for stale events |
| Modify | `src/evals/run.ts` | Register sentiment eval suite |
| Create | `scripts/analyze-sentiment.ts` | CLI diagnostic: sentiment → price correlation |
| Create | `src/evals/sentiment/tasks.ts` | Eval task definitions |
| Create | `src/evals/sentiment/graders.ts` | Code-based graders |
| Create | `src/evals/sentiment/suite.ts` | Eval suite runner |
| Test | `tests/risk/demotion.test.ts` | Add `checkTierBreach` tests |
| Test | `tests/live/demotion-orchestrator.test.ts` | Integration tests for orchestrator |
| Test | `tests/evals/sentiment-graders.test.ts` | Unit tests for sentiment graders |

---

### Task 1: Add `checkTierBreach` to demotion.ts

**Files:**
- Modify: `src/risk/demotion.ts`
- Test: `tests/risk/demotion.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the end of `tests/risk/demotion.test.ts`:

```typescript
import {
	type BehavioralComparison,
	checkBehavioralDivergence,
	checkKillCriteria,
	checkTierBreach,
	checkTwoStrikeDemotion,
	type DemotionEvent,
	type StrategyLiveStats,
	type TierBreachInput,
} from "../../src/risk/demotion.ts";

// ... existing tests stay ...

describe("checkTierBreach", () => {
	test("probation: breaches when rolling Sharpe < 0", () => {
		const input: TierBreachInput = {
			tier: "probation",
			rollingSharpe20: -0.1,
			currentDrawdownPct: 5,
			worstPaperDrawdownPct: 10,
			consecutiveNegativeSharpePeriods: 0,
		};
		const result = checkTierBreach(input);
		expect(result.breached).toBe(true);
		expect(result.reason).toContain("Sharpe");
	});

	test("probation: no breach when rolling Sharpe >= 0", () => {
		const input: TierBreachInput = {
			tier: "probation",
			rollingSharpe20: 0.5,
			currentDrawdownPct: 5,
			worstPaperDrawdownPct: 10,
			consecutiveNegativeSharpePeriods: 0,
		};
		const result = checkTierBreach(input);
		expect(result.breached).toBe(false);
	});

	test("active: breaches when drawdown > 1.5x worst paper drawdown", () => {
		const input: TierBreachInput = {
			tier: "active",
			rollingSharpe20: 0.5,
			currentDrawdownPct: 20,
			worstPaperDrawdownPct: 10,
			consecutiveNegativeSharpePeriods: 0,
		};
		const result = checkTierBreach(input);
		expect(result.breached).toBe(true);
		expect(result.reason).toContain("Drawdown");
	});

	test("active: breaches when Sharpe < 0 for 2 consecutive periods", () => {
		const input: TierBreachInput = {
			tier: "active",
			rollingSharpe20: -0.3,
			currentDrawdownPct: 5,
			worstPaperDrawdownPct: 10,
			consecutiveNegativeSharpePeriods: 2,
		};
		const result = checkTierBreach(input);
		expect(result.breached).toBe(true);
		expect(result.reason).toContain("consecutive");
	});

	test("active: no breach when drawdown within 1.5x and Sharpe negative for only 1 period", () => {
		const input: TierBreachInput = {
			tier: "active",
			rollingSharpe20: -0.1,
			currentDrawdownPct: 12,
			worstPaperDrawdownPct: 10,
			consecutiveNegativeSharpePeriods: 1,
		};
		const result = checkTierBreach(input);
		expect(result.breached).toBe(false);
	});

	test("core: same rules as active", () => {
		const input: TierBreachInput = {
			tier: "core",
			rollingSharpe20: 0.5,
			currentDrawdownPct: 20,
			worstPaperDrawdownPct: 10,
			consecutiveNegativeSharpePeriods: 0,
		};
		const result = checkTierBreach(input);
		expect(result.breached).toBe(true);
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/risk/demotion.test.ts`
Expected: FAIL — `checkTierBreach` is not exported from `demotion.ts`

- [ ] **Step 3: Implement `checkTierBreach`**

Add to the end of `src/risk/demotion.ts`:

```typescript
export interface TierBreachInput {
	tier: "probation" | "active" | "core";
	rollingSharpe20: number;
	currentDrawdownPct: number;
	worstPaperDrawdownPct: number;
	consecutiveNegativeSharpePeriods: number;
}

export interface TierBreachResult {
	breached: boolean;
	reason?: string;
}

/** Drawdown multiplier threshold for active/core tiers */
const DRAWDOWN_BREACH_MULT = 1.5;
/** Consecutive negative Sharpe periods required for active/core breach */
const CONSECUTIVE_NEG_SHARPE_PERIODS = 2;

export function checkTierBreach(input: TierBreachInput): TierBreachResult {
	if (input.tier === "probation") {
		if (input.rollingSharpe20 < 0) {
			return {
				breached: true,
				reason: `Rolling 20-trade Sharpe ${input.rollingSharpe20.toFixed(2)} < 0`,
			};
		}
		return { breached: false };
	}

	// Active and Core share the same rules
	const drawdownThreshold = input.worstPaperDrawdownPct * DRAWDOWN_BREACH_MULT;
	if (input.currentDrawdownPct > drawdownThreshold) {
		return {
			breached: true,
			reason: `Drawdown ${input.currentDrawdownPct.toFixed(1)}% > ${DRAWDOWN_BREACH_MULT}x worst paper drawdown (${drawdownThreshold.toFixed(1)}%)`,
		};
	}

	if (input.consecutiveNegativeSharpePeriods >= CONSECUTIVE_NEG_SHARPE_PERIODS) {
		return {
			breached: true,
			reason: `Sharpe < 0 for ${input.consecutiveNegativeSharpePeriods} consecutive weekly periods`,
		};
	}

	return { breached: false };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/risk/demotion.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/risk/demotion.ts tests/risk/demotion.test.ts
git commit -m "feat(risk): add checkTierBreach for tier-specific demotion triggers"
```

---

### Task 2: Add `runDemotionChecks` orchestrator to executor.ts

**Files:**
- Modify: `src/live/executor.ts`
- Test: `tests/live/demotion-orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/live/demotion-orchestrator.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getDb, initDb } from "../../src/db/client.ts";
import {
	graduationEvents,
	liveTrades,
	paperTrades,
	strategies,
	strategyMetrics,
} from "../../src/db/schema.ts";

// Import after DB is initialized
let runDemotionChecks: typeof import("../../src/live/executor.ts").runDemotionChecks;

beforeEach(async () => {
	await initDb();
	const mod = await import("../../src/live/executor.ts");
	runDemotionChecks = mod.runDemotionChecks;
});

describe("runDemotionChecks", () => {
	test("kills strategy when not profitable after 60 live trades", async () => {
		const db = getDb();

		// Insert a probation strategy
		await db.insert(strategies).values({
			id: 1,
			name: "test-strat",
			description: "test",
			parameters: '{"threshold": 0.5}',
			status: "probation",
			virtualBalance: 10000,
		});

		// Insert metrics with negative Sharpe
		await db.insert(strategyMetrics).values({
			strategyId: 1,
			sampleSize: 60,
			sharpeRatio: -0.5,
			maxDrawdownPct: 5,
		});

		// Insert 60 filled live trades with net negative PnL
		for (let i = 0; i < 60; i++) {
			await db.insert(liveTrades).values({
				strategyId: 1,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "BUY",
				quantity: 10,
				orderType: "LIMIT",
				status: "FILLED",
				fillPrice: 150,
				pnl: i < 35 ? -5 : 3, // 35 losses, 25 wins = net -50
				filledAt: new Date(Date.now() - (60 - i) * 86400000).toISOString(),
			});
		}

		await runDemotionChecks();

		// Strategy should be retired
		const [strat] = await db.select().from(strategies).where(eq(strategies.id, 1));
		expect(strat!.status).toBe("retired");
		expect(strat!.retiredAt).toBeTruthy();

		// Should have a graduation event
		const events = await db
			.select()
			.from(graduationEvents)
			.where(eq(graduationEvents.strategyId, 1));
		expect(events.length).toBe(1);
		expect(events[0]!.event).toBe("killed");
	});

	test("applies first strike on tier breach — reduces capital by 50%", async () => {
		const db = getDb();

		await db.insert(strategies).values({
			id: 1,
			name: "test-strat",
			description: "test",
			parameters: '{"threshold": 0.5}',
			status: "probation",
			virtualBalance: 10000,
		});

		await db.insert(strategyMetrics).values({
			strategyId: 1,
			sampleSize: 25,
			sharpeRatio: -0.3,
			maxDrawdownPct: 5,
		});

		// Insert 25 trades, net positive (not a kill candidate)
		for (let i = 0; i < 25; i++) {
			await db.insert(liveTrades).values({
				strategyId: 1,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "BUY",
				quantity: 10,
				orderType: "LIMIT",
				status: "FILLED",
				fillPrice: 150,
				pnl: 2,
				filledAt: new Date(Date.now() - (25 - i) * 86400000).toISOString(),
			});
		}

		await runDemotionChecks();

		// Strategy should still be probation but with halved capital
		const [strat] = await db.select().from(strategies).where(eq(strategies.id, 1));
		expect(strat!.status).toBe("probation");
		expect(strat!.virtualBalance).toBe(5000);
	});

	test("skips strategies with no live trades", async () => {
		const db = getDb();

		await db.insert(strategies).values({
			id: 1,
			name: "test-strat",
			description: "test",
			parameters: '{"threshold": 0.5}',
			status: "probation",
			virtualBalance: 10000,
		});

		await db.insert(strategyMetrics).values({
			strategyId: 1,
			sampleSize: 0,
			sharpeRatio: null,
			maxDrawdownPct: null,
		});

		await runDemotionChecks();

		// Strategy should be unchanged
		const [strat] = await db.select().from(strategies).where(eq(strategies.id, 1));
		expect(strat!.status).toBe("probation");
		expect(strat!.virtualBalance).toBe(10000);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/live/demotion-orchestrator.test.ts`
Expected: FAIL — `runDemotionChecks` is not exported from `executor.ts`

- [ ] **Step 3: Implement `runDemotionChecks`**

Add the following imports to the top of `src/live/executor.ts` (after existing imports):

```typescript
import { desc, sql } from "drizzle-orm";
import { graduationEvents, liveTrades as liveTradesTable, paperTrades, strategyMetrics } from "../db/schema.ts";
import {
	checkKillCriteria,
	checkTierBreach,
	checkTwoStrikeDemotion,
	checkBehavioralDivergence as checkBehavioralDivergenceAgg,
	type DemotionEvent,
	type StrategyLiveStats,
	type BehavioralComparison,
} from "../risk/demotion.ts";
```

Note: `liveTrades` is already imported in executor.ts at line 9 as part of `import { agentLogs, livePositions, liveTrades, strategies }`. The alias `liveTradesTable` avoids collision since the schema import is the same table. Actually, `liveTrades` is already imported — so we don't need the alias. We need to add `graduationEvents`, `paperTrades`, `strategyMetrics` to the existing schema import, and add `desc` to the drizzle-orm import.

Update the existing imports in `src/live/executor.ts`:

Line 1 — change:
```typescript
import { and, eq, inArray, isNotNull } from "drizzle-orm";
```
to:
```typescript
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
```

Line 9 — change:
```typescript
import { agentLogs, livePositions, liveTrades, strategies } from "../db/schema.ts";
```
to:
```typescript
import { agentLogs, graduationEvents, livePositions, liveTrades, paperTrades, strategies, strategyMetrics } from "../db/schema.ts";
```

Add after line 16 (after the `capital-allocator` import):
```typescript
import {
	type BehavioralComparison,
	checkBehavioralDivergence as checkDivergenceAgg,
	checkKillCriteria,
	checkTierBreach,
	checkTwoStrikeDemotion,
	type DemotionEvent,
	type StrategyLiveStats,
} from "../risk/demotion.ts";
```

Then add this function before the `buildLiveSignalContext` export (before line 387):

```typescript
/**
 * Run demotion checks on all graduated strategies.
 * Called at the end of runLiveExecutor().
 *
 * Order: kill checks first (immediate), then tier breach → two-strike,
 * then behavioral divergence (advisory only).
 */
export async function runDemotionChecks(): Promise<void> {
	const db = getDb();

	const graduatedStrategies = await db
		.select()
		.from(strategies)
		.where(inArray(strategies.status, LIVE_TIERS));

	for (const strategy of graduatedStrategies) {
		try {
			// Get all filled live trades for this strategy
			const trades = await db
				.select({
					pnl: liveTrades.pnl,
					fillPrice: liveTrades.fillPrice,
					limitPrice: liveTrades.limitPrice,
					friction: liveTrades.friction,
					filledAt: liveTrades.filledAt,
				})
				.from(liveTrades)
				.where(and(eq(liveTrades.strategyId, strategy.id), eq(liveTrades.status, "FILLED")))
				.orderBy(desc(liveTrades.filledAt));

			// Skip if no live trades yet
			if (trades.length === 0) continue;

			const pnls = trades.filter((t) => t.pnl != null).map((t) => t.pnl!);
			const totalPnl = pnls.reduce((sum, p) => sum + p, 0);

			// Compute current loss streak (from most recent trades)
			let currentLossStreak = 0;
			for (const pnl of pnls) {
				if (pnl < 0) currentLossStreak++;
				else break;
			}

			// Compute expected loss streak stats from all trades
			const lossSeries: number[] = [];
			let streak = 0;
			// Iterate oldest to newest for streak calculation
			for (let i = pnls.length - 1; i >= 0; i--) {
				if (pnls[i]! < 0) {
					streak++;
				} else {
					if (streak > 0) lossSeries.push(streak);
					streak = 0;
				}
			}
			if (streak > 0) lossSeries.push(streak);

			const expectedMean =
				lossSeries.length > 0
					? lossSeries.reduce((s, v) => s + v, 0) / lossSeries.length
					: 2;
			const expectedStdDev =
				lossSeries.length > 1
					? Math.sqrt(
							lossSeries.reduce((s, v) => s + (v - expectedMean) ** 2, 0) /
								lossSeries.length,
						)
					: 1;

			// Get demotion history from graduation_events
			const demotionHistory = await db
				.select({ event: graduationEvents.event, createdAt: graduationEvents.createdAt })
				.from(graduationEvents)
				.where(
					and(
						eq(graduationEvents.strategyId, strategy.id),
						inArray(graduationEvents.event, ["demoted", "killed"]),
					),
				);

			const demotionEvents: DemotionEvent[] = demotionHistory.map((e) => ({
				date: new Date(e.createdAt),
				type: e.event === "demoted" ? "demotion" : "strike",
			}));

			const now = new Date();

			// --- 1. Kill criteria check ---
			const stats: StrategyLiveStats = {
				liveTradeCount: pnls.length,
				totalPnl,
				currentLossStreak,
				expectedLossStreakMean: expectedMean,
				expectedLossStreakStdDev: expectedStdDev,
				demotionCount: demotionHistory.filter((e) => e.event === "demoted").length,
				demotionDates: demotionHistory
					.filter((e) => e.event === "demoted")
					.map((e) => new Date(e.createdAt)),
			};

			const killResult = checkKillCriteria(stats, now);
			if (killResult.shouldKill) {
				await retireStrategy(db, strategy.id, strategy.status!, killResult.reason!);
				continue;
			}

			// --- 2. Tier breach → two-strike check ---
			const [metrics] = await db
				.select()
				.from(strategyMetrics)
				.where(eq(strategyMetrics.strategyId, strategy.id))
				.limit(1);

			if (metrics) {
				// Compute rolling 20-trade Sharpe from most recent 20 trades
				const recent20 = pnls.slice(0, 20);
				const mean20 =
					recent20.length > 0 ? recent20.reduce((s, p) => s + p, 0) / recent20.length : 0;
				const var20 =
					recent20.length > 0
						? recent20.reduce((s, p) => s + (p - mean20) ** 2, 0) / recent20.length
						: 0;
				const std20 = Math.sqrt(var20);
				const rollingSharpe20 = std20 > 0 ? (mean20 / std20) * Math.sqrt(252) : 0;

				// Get worst paper drawdown for this strategy
				const [paperMetrics] = await db
					.select({ maxDrawdownPct: strategyMetrics.maxDrawdownPct })
					.from(strategyMetrics)
					.where(eq(strategyMetrics.strategyId, strategy.id))
					.limit(1);
				const worstPaperDrawdownPct = paperMetrics?.maxDrawdownPct ?? 15;

				// Count consecutive negative Sharpe periods from graduation_events
				// (we track strikes as proxies for negative Sharpe periods)
				const recentStrikes = demotionHistory
					.filter((e) => e.event === "demoted")
					.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
				let consecutiveNegSharpePeriods = 0;
				if (rollingSharpe20 < 0) {
					consecutiveNegSharpePeriods = 1;
					// Check if the last recorded event was also a negative period
					for (const strike of recentStrikes) {
						const daysSince =
							(now.getTime() - new Date(strike.createdAt).getTime()) / (24 * 60 * 60 * 1000);
						if (daysSince <= 14) {
							consecutiveNegSharpePeriods++;
						} else break;
					}
				}

				const tier = strategy.status as "probation" | "active" | "core";
				const breachResult = checkTierBreach({
					tier,
					rollingSharpe20,
					currentDrawdownPct: metrics.maxDrawdownPct ?? 0,
					worstPaperDrawdownPct,
					consecutiveNegativeSharpePeriods: consecutiveNegSharpePeriods,
				});

				if (breachResult.breached) {
					const strikeResult = checkTwoStrikeDemotion(demotionEvents, now);

					if (strikeResult.action === "kill") {
						await retireStrategy(db, strategy.id, strategy.status!, strikeResult.reason);
					} else if (strikeResult.action === "demote") {
						await db
							.update(strategies)
							.set({ status: "paper" })
							.where(eq(strategies.id, strategy.id));
						await db.insert(graduationEvents).values({
							strategyId: strategy.id,
							event: "demoted" as const,
							fromTier: strategy.status,
							toTier: "paper",
							evidence: JSON.stringify({ breach: breachResult.reason, action: strikeResult.reason }),
						});
						log.warn(
							{ strategyId: strategy.id, reason: strikeResult.reason },
							"Strategy demoted to paper",
						);
					} else if (strikeResult.action === "first_strike") {
						const newBalance = strategy.virtualBalance * (strikeResult.capitalMultiplier ?? 0.5);
						await db
							.update(strategies)
							.set({ virtualBalance: newBalance })
							.where(eq(strategies.id, strategy.id));
						await db.insert(graduationEvents).values({
							strategyId: strategy.id,
							event: "demoted" as const,
							fromTier: strategy.status,
							toTier: strategy.status,
							evidence: JSON.stringify({
								breach: breachResult.reason,
								action: strikeResult.reason,
								capitalReduced: newBalance,
							}),
						});
						log.warn(
							{ strategyId: strategy.id, newBalance, reason: breachResult.reason },
							"First strike — capital reduced",
						);
					}
				}
			}

			// --- 3. Behavioral divergence check (advisory only) ---
			const paperTradesForStrat = await db
				.select({ friction: paperTrades.friction, price: paperTrades.price })
				.from(paperTrades)
				.where(eq(paperTrades.strategyId, strategy.id));

			if (paperTradesForStrat.length > 0 && trades.length > 0) {
				const paperAvgFriction =
					paperTradesForStrat.reduce((s, t) => s + t.friction, 0) / paperTradesForStrat.length;
				const liveAvgFriction =
					trades.reduce((s, t) => s + (t.friction ?? 0), 0) / trades.length;

				// Compute slippage as |fillPrice - limitPrice| / limitPrice
				const liveSlippages = trades
					.filter((t) => t.fillPrice != null && t.limitPrice != null && t.limitPrice > 0)
					.map((t) => Math.abs(t.fillPrice! - t.limitPrice!) / t.limitPrice!);
				const liveAvgSlippage =
					liveSlippages.length > 0
						? liveSlippages.reduce((s, v) => s + v, 0) / liveSlippages.length
						: 0;

				const comparison: BehavioralComparison = {
					paperAvgSlippage: 0, // Paper has no slippage by definition
					liveAvgSlippage,
					paperFillRate: 1, // Paper always fills
					liveFillRate: 1, // TODO: track partial fills in future
					paperAvgFriction,
					liveAvgFriction,
				};

				const divResult = checkDivergenceAgg(comparison);
				if (divResult.diverged) {
					log.warn(
						{ strategyId: strategy.id, reasons: divResult.reasons },
						"Behavioral divergence detected (advisory)",
					);
					await db.insert(agentLogs).values({
						level: "WARN" as const,
						phase: "demotion-check",
						message: `Behavioral divergence: strategy ${strategy.id} — ${divResult.reasons.join("; ")}`,
						data: JSON.stringify({ strategyId: strategy.id, comparison, reasons: divResult.reasons }),
					});
				}
			}
		} catch (error) {
			log.error({ strategyId: strategy.id, error }, "Demotion check failed for strategy");
		}
	}
}

async function retireStrategy(
	db: ReturnType<typeof getDb>,
	strategyId: number,
	fromTier: string,
	reason: string,
): Promise<void> {
	await db
		.update(strategies)
		.set({ status: "retired", retiredAt: new Date().toISOString() })
		.where(eq(strategies.id, strategyId));
	await db.insert(graduationEvents).values({
		strategyId,
		event: "killed" as const,
		fromTier,
		toTier: "retired",
		evidence: JSON.stringify({ reason }),
	});
	log.warn({ strategyId, reason }, "Strategy killed and retired");
}
```

- [ ] **Step 4: Call `runDemotionChecks` from `runLiveExecutor`**

In `src/live/executor.ts`, find the end of `runLiveExecutor()` just before `return result;` (around line 380). Add:

```typescript
	// Run demotion checks after all evaluations
	try {
		await runDemotionChecks();
	} catch (error) {
		log.error({ error }, "Demotion checks failed (non-fatal)");
	}

	return result;
```

Remove the existing `return result;` that was there before — the new block includes it.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/live/demotion-orchestrator.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run all existing tests to check for regressions**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/live/executor.ts tests/live/demotion-orchestrator.test.ts
git commit -m "feat(live): wire up demotion checks in live executor cycle"
```

---

### Task 3: Add price capture columns to schema

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add columns to `newsEvents` table**

In `src/db/schema.ts`, find the `newsEvents` table definition (line 266). Add two new columns after `classifiedAt` (line 286):

```typescript
		priceAtClassification: real("price_at_classification"),
		priceAfter1d: real("price_after_1d"),
```

These go after the `classifiedAt` line and before the `createdAt` line.

- [ ] **Step 2: Run tests to check schema change doesn't break anything**

Run: `bun test`
Expected: ALL PASS (nullable columns, no migration needed for SQLite)

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(schema): add price capture columns to news_events for sentiment validation"
```

---

### Task 4: Capture price at classification time

**Files:**
- Modify: `src/news/sentiment-writer.ts`

- [ ] **Step 1: Update `storeNewsEvent` to capture price**

In `src/news/sentiment-writer.ts`, add the `quotesCache` query import and modify `storeNewsEvent`. Replace the existing function (lines 100–121):

```typescript
/**
 * Store a classified news event in the news_events table.
 * If classified (sentiment is not null), also captures the current price
 * from quotesCache for the primary symbol to enable sentiment → price validation.
 */
export async function storeNewsEvent(input: NewsEventInput): Promise<void> {
	const db = getDb();

	// Capture price at classification time for the primary symbol
	let priceAtClassification: number | null = null;
	if (input.sentiment != null && input.symbols.length > 0) {
		const primarySymbol = input.symbols[0]!;
		const [cached] = await db
			.select({ last: quotesCache.last })
			.from(quotesCache)
			.where(eq(quotesCache.symbol, primarySymbol))
			.limit(1);
		priceAtClassification = cached?.last ?? null;
	}

	await db.insert(newsEvents).values({
		source: input.source,
		headline: input.headline,
		url: input.url,
		symbols: JSON.stringify(input.symbols),
		sentiment: input.sentiment,
		confidence: input.confidence,
		tradeable: input.tradeable,
		eventType: input.eventType,
		urgency: input.urgency,
		earningsSurprise: input.signals?.earningsSurprise ?? null,
		guidanceChange: input.signals?.guidanceChange ?? null,
		managementTone: input.signals?.managementTone ?? null,
		regulatoryRisk: input.signals?.regulatoryRisk ?? null,
		acquisitionLikelihood: input.signals?.acquisitionLikelihood ?? null,
		catalystType: input.signals?.catalystType ?? null,
		expectedMoveDuration: input.signals?.expectedMoveDuration ?? null,
		classifiedAt: input.sentiment != null ? new Date().toISOString() : null,
		priceAtClassification,
	});
}
```

The existing `eq` import from `drizzle-orm` is not present — it's imported in `ingest.ts` but not in `sentiment-writer.ts`. Add to the top of the file:

```typescript
import { eq } from "drizzle-orm";
```

And ensure `quotesCache` is in the schema import — it's already imported on line 2: `import { newsEvents, quotesCache } from "../db/schema.ts";`.

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/news/sentiment-writer.ts
git commit -m "feat(news): capture price at classification time for sentiment validation"
```

---

### Task 5: Backfill `priceAfter1d` in quote refresh

**Files:**
- Modify: `src/scheduler/quote-refresh.ts`

- [ ] **Step 1: Add backfill logic to `refreshQuotesForAllCached`**

Add imports at the top of `src/scheduler/quote-refresh.ts`:

```typescript
import { and, eq, isNotNull, isNull, lt } from "drizzle-orm";
import { newsEvents } from "../db/schema.ts";
```

Add a new function after `refreshQuotesForAllCached`:

```typescript
/**
 * Backfill priceAfter1d for classified news events that are >24h old
 * and haven't been backfilled yet. Piggybacks on quote refresh cycle.
 */
export async function backfillSentimentPrices(): Promise<void> {
	const db = getDb();
	const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

	// Find events with a price at classification but no follow-up price, older than 24h
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
		.limit(50); // Cap to avoid slowing down the refresh cycle

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
		log.info({ filled, total: staleEvents.length }, "Backfilled priceAfter1d for sentiment validation");
	}
}
```

Then modify `refreshQuotesForAllCached` to call it at the end. Add before the final `log.info`:

```typescript
	// Backfill sentiment validation prices
	await backfillSentimentPrices();
```

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 3: Commit**

```bash
git add src/scheduler/quote-refresh.ts
git commit -m "feat(quotes): backfill priceAfter1d for sentiment validation during quote refresh"
```

---

### Task 6: Create sentiment eval graders

**Files:**
- Create: `src/evals/sentiment/graders.ts`
- Test: `tests/evals/sentiment-graders.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/evals/sentiment-graders.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
	directionAccuracyGrader,
	durationAccuracyGrader,
	magnitudeCalibrationGrader,
} from "../../src/evals/sentiment/graders.ts";
import type { SentimentEvalOutput, SentimentEvalReference } from "../../src/evals/sentiment/graders.ts";

describe("sentiment graders", () => {
	describe("directionAccuracyGrader", () => {
		test("scores 1 when positive sentiment matches price increase", async () => {
			const output: SentimentEvalOutput = { sentiment: 0.8, confidence: 0.9, expectedMoveDuration: "1-3d" };
			const ref: SentimentEvalReference = { actualPriceChangePct: 3.5, actualDirection: "up", actualMoveDurationDays: 2 };
			const result = await directionAccuracyGrader.grade(output, ref);
			expect(result.score).toBe(1);
			expect(result.pass).toBe(true);
		});

		test("scores 0 when positive sentiment but price drops", async () => {
			const output: SentimentEvalOutput = { sentiment: 0.8, confidence: 0.9, expectedMoveDuration: "1-3d" };
			const ref: SentimentEvalReference = { actualPriceChangePct: -2.0, actualDirection: "down", actualMoveDurationDays: 2 };
			const result = await directionAccuracyGrader.grade(output, ref);
			expect(result.score).toBe(0);
			expect(result.pass).toBe(false);
		});

		test("scores 0.5 when price is flat", async () => {
			const output: SentimentEvalOutput = { sentiment: 0.8, confidence: 0.9, expectedMoveDuration: "1-3d" };
			const ref: SentimentEvalReference = { actualPriceChangePct: 0.1, actualDirection: "flat", actualMoveDurationDays: 2 };
			const result = await directionAccuracyGrader.grade(output, ref);
			expect(result.score).toBe(0.5);
		});

		test("scores 1 when negative sentiment matches price drop", async () => {
			const output: SentimentEvalOutput = { sentiment: -0.7, confidence: 0.8, expectedMoveDuration: "1-3d" };
			const ref: SentimentEvalReference = { actualPriceChangePct: -4.0, actualDirection: "down", actualMoveDurationDays: 1 };
			const result = await directionAccuracyGrader.grade(output, ref);
			expect(result.score).toBe(1);
			expect(result.pass).toBe(true);
		});
	});

	describe("magnitudeCalibrationGrader", () => {
		test("scores high when high confidence matches large move", async () => {
			const output: SentimentEvalOutput = { sentiment: 0.9, confidence: 0.95, expectedMoveDuration: "1-3d" };
			const ref: SentimentEvalReference = { actualPriceChangePct: 8.0, actualDirection: "up", actualMoveDurationDays: 2 };
			const result = await magnitudeCalibrationGrader.grade(output, ref);
			expect(result.score).toBeGreaterThan(0.5);
		});

		test("scores low when high confidence but tiny move", async () => {
			const output: SentimentEvalOutput = { sentiment: 0.9, confidence: 0.95, expectedMoveDuration: "1-3d" };
			const ref: SentimentEvalReference = { actualPriceChangePct: 0.1, actualDirection: "flat", actualMoveDurationDays: 2 };
			const result = await magnitudeCalibrationGrader.grade(output, ref);
			expect(result.score).toBeLessThan(0.5);
		});
	});

	describe("durationAccuracyGrader", () => {
		test("passes when move completes within expected window", async () => {
			const output: SentimentEvalOutput = { sentiment: 0.8, confidence: 0.9, expectedMoveDuration: "1-3d" };
			const ref: SentimentEvalReference = { actualPriceChangePct: 5.0, actualDirection: "up", actualMoveDurationDays: 2 };
			const result = await durationAccuracyGrader.grade(output, ref);
			expect(result.pass).toBe(true);
			expect(result.score).toBe(1);
		});

		test("fails when move takes much longer than expected", async () => {
			const output: SentimentEvalOutput = { sentiment: 0.8, confidence: 0.9, expectedMoveDuration: "intraday" };
			const ref: SentimentEvalReference = { actualPriceChangePct: 5.0, actualDirection: "up", actualMoveDurationDays: 10 };
			const result = await durationAccuracyGrader.grade(output, ref);
			expect(result.pass).toBe(false);
		});
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/evals/sentiment-graders.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement graders**

Create `src/evals/sentiment/graders.ts`:

```typescript
import type { Grader } from "../types.ts";

export interface SentimentEvalOutput {
	sentiment: number;
	confidence: number;
	expectedMoveDuration: string;
}

export interface SentimentEvalReference {
	actualPriceChangePct: number;
	actualDirection: "up" | "down" | "flat";
	actualMoveDurationDays: number;
}

type SG = Grader<SentimentEvalOutput, SentimentEvalReference>;

/** Did sentiment polarity predict price direction? */
export const directionAccuracyGrader: SG = {
	name: "direction-accuracy",
	type: "code",
	grade: async (output, reference) => {
		if (reference.actualDirection === "flat") {
			return { score: 0.5, pass: true, reason: "Price flat — inconclusive" };
		}

		const sentimentDirection = output.sentiment > 0 ? "up" : "down";
		const match = sentimentDirection === reference.actualDirection;

		return {
			score: match ? 1 : 0,
			pass: match,
			reason: match
				? `Sentiment ${output.sentiment.toFixed(2)} correctly predicted ${reference.actualDirection} (${reference.actualPriceChangePct.toFixed(1)}%)`
				: `Sentiment ${output.sentiment.toFixed(2)} predicted ${sentimentDirection}, actual was ${reference.actualDirection} (${reference.actualPriceChangePct.toFixed(1)}%)`,
		};
	},
};

/**
 * Is confidence proportional to move magnitude?
 * High confidence should correlate with larger absolute moves.
 */
export const magnitudeCalibrationGrader: SG = {
	name: "magnitude-calibration",
	type: "code",
	grade: async (output, reference) => {
		const absMoveP = Math.abs(reference.actualPriceChangePct);

		// Bucket confidence: low (<0.6), medium (0.6-0.8), high (>0.8)
		// Expected move: low conf → 0-2%, medium → 2-5%, high → 5%+
		let expectedMinMove: number;
		if (output.confidence >= 0.8) {
			expectedMinMove = 3;
		} else if (output.confidence >= 0.6) {
			expectedMinMove = 1;
		} else {
			expectedMinMove = 0;
		}

		const calibrated = absMoveP >= expectedMinMove;

		// Score: how well does confidence predict magnitude?
		// Perfect calibration: score = 1 - |confidence - normalized_move|
		const normalizedMove = Math.min(absMoveP / 10, 1); // 10%+ → 1.0
		const score = Math.max(0, 1 - Math.abs(output.confidence - normalizedMove));

		return {
			score,
			pass: calibrated,
			reason: calibrated
				? `Confidence ${output.confidence.toFixed(2)} calibrated: move was ${absMoveP.toFixed(1)}%`
				: `Confidence ${output.confidence.toFixed(2)} too high for ${absMoveP.toFixed(1)}% move`,
		};
	},
};

/** Duration window mapping from classifier output to day ranges */
const DURATION_WINDOWS: Record<string, { min: number; max: number }> = {
	intraday: { min: 0, max: 1 },
	"1-3d": { min: 1, max: 3 },
	"1-2w": { min: 5, max: 14 },
	"1m+": { min: 20, max: 999 },
};

/** Did the price move occur within the predicted duration window? */
export const durationAccuracyGrader: SG = {
	name: "duration-accuracy",
	type: "code",
	grade: async (output, reference) => {
		const window = DURATION_WINDOWS[output.expectedMoveDuration];
		if (!window) {
			return {
				score: 0,
				pass: false,
				reason: `Unknown duration "${output.expectedMoveDuration}"`,
			};
		}

		const withinWindow =
			reference.actualMoveDurationDays >= window.min &&
			reference.actualMoveDurationDays <= window.max;

		return {
			score: withinWindow ? 1 : 0,
			pass: withinWindow,
			reason: withinWindow
				? `Move completed in ${reference.actualMoveDurationDays}d, within ${output.expectedMoveDuration} window`
				: `Move took ${reference.actualMoveDurationDays}d, outside ${output.expectedMoveDuration} window [${window.min}-${window.max}d]`,
		};
	},
};

export const allSentimentGraders: SG[] = [
	directionAccuracyGrader,
	magnitudeCalibrationGrader,
	durationAccuracyGrader,
];
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/evals/sentiment-graders.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/evals/sentiment/graders.ts tests/evals/sentiment-graders.test.ts
git commit -m "feat(evals): add sentiment signal quality graders"
```

---

### Task 7: Create sentiment eval tasks and suite

**Files:**
- Create: `src/evals/sentiment/tasks.ts`
- Create: `src/evals/sentiment/suite.ts`
- Modify: `src/evals/run.ts`

- [ ] **Step 1: Create task definitions**

Create `src/evals/sentiment/tasks.ts`:

```typescript
import type { EvalTask } from "../types.ts";
import type { SentimentEvalOutput, SentimentEvalReference } from "./graders.ts";

/**
 * Sentiment eval tasks.
 *
 * Each task represents a classified news event with known price outcome.
 * Seeded with synthetic examples initially — real data added as
 * priceAtClassification + priceAfter1d accumulates in news_events.
 *
 * Input = classifier output (what the system predicted).
 * Reference = what actually happened to the price.
 */
export const sentimentTasks: EvalTask<SentimentEvalOutput, SentimentEvalReference>[] = [
	// === CORRECT PREDICTIONS (classifier should get these right) ===
	{
		id: "sent-001",
		name: "Strong earnings beat → price up",
		input: { sentiment: 0.85, confidence: 0.9, expectedMoveDuration: "1-3d" },
		reference: { actualPriceChangePct: 6.2, actualDirection: "up", actualMoveDurationDays: 2 },
		tags: ["positive", "earnings", "correct"],
	},
	{
		id: "sent-002",
		name: "Profit warning → price down",
		input: { sentiment: -0.9, confidence: 0.85, expectedMoveDuration: "1-3d" },
		reference: { actualPriceChangePct: -8.5, actualDirection: "down", actualMoveDurationDays: 1 },
		tags: ["negative", "warning", "correct"],
	},
	{
		id: "sent-003",
		name: "FDA approval → price up sharply",
		input: { sentiment: 0.95, confidence: 0.92, expectedMoveDuration: "1-3d" },
		reference: { actualPriceChangePct: 15.0, actualDirection: "up", actualMoveDurationDays: 1 },
		tags: ["positive", "fda", "correct"],
	},
	{
		id: "sent-004",
		name: "Acquisition offer → price up to bid",
		input: { sentiment: 0.8, confidence: 0.88, expectedMoveDuration: "intraday" },
		reference: { actualPriceChangePct: 25.0, actualDirection: "up", actualMoveDurationDays: 0 },
		tags: ["positive", "acquisition", "correct"],
	},
	{
		id: "sent-005",
		name: "Weak guidance → modest decline",
		input: { sentiment: -0.5, confidence: 0.65, expectedMoveDuration: "1-3d" },
		reference: { actualPriceChangePct: -2.5, actualDirection: "down", actualMoveDurationDays: 3 },
		tags: ["negative", "guidance", "correct"],
	},

	// === CHALLENGING CASES (tests calibration and edge cases) ===
	{
		id: "sent-006",
		name: "Positive sentiment but price drops (market context)",
		input: { sentiment: 0.6, confidence: 0.7, expectedMoveDuration: "1-3d" },
		reference: { actualPriceChangePct: -1.5, actualDirection: "down", actualMoveDurationDays: 2 },
		tags: ["positive", "mismatch", "challenging"],
	},
	{
		id: "sent-007",
		name: "High confidence but flat price",
		input: { sentiment: 0.8, confidence: 0.9, expectedMoveDuration: "1-3d" },
		reference: { actualPriceChangePct: 0.2, actualDirection: "flat", actualMoveDurationDays: 3 },
		tags: ["positive", "flat", "calibration"],
	},
	{
		id: "sent-008",
		name: "Negative sentiment with delayed move",
		input: { sentiment: -0.7, confidence: 0.75, expectedMoveDuration: "intraday" },
		reference: { actualPriceChangePct: -5.0, actualDirection: "down", actualMoveDurationDays: 5 },
		tags: ["negative", "duration_miss", "challenging"],
	},
	{
		id: "sent-009",
		name: "Weak negative but strong price drop",
		input: { sentiment: -0.3, confidence: 0.5, expectedMoveDuration: "1-2w" },
		reference: { actualPriceChangePct: -12.0, actualDirection: "down", actualMoveDurationDays: 7 },
		tags: ["negative", "underconfident", "calibration"],
	},
	{
		id: "sent-010",
		name: "Moderate positive, price moves as expected",
		input: { sentiment: 0.5, confidence: 0.6, expectedMoveDuration: "1-2w" },
		reference: { actualPriceChangePct: 3.0, actualDirection: "up", actualMoveDurationDays: 8 },
		tags: ["positive", "moderate", "correct"],
	},
];
```

- [ ] **Step 2: Create suite runner**

Create `src/evals/sentiment/suite.ts`:

```typescript
import { runSuite } from "../harness.ts";
import { formatSuiteReport } from "../reporter.ts";
import type { SentimentEvalOutput, SentimentEvalReference } from "./graders.ts";
import { allSentimentGraders } from "./graders.ts";
import { sentimentTasks } from "./tasks.ts";

export async function runSentimentEvalSuite(
	options: { trials?: number; tags?: string[]; suiteName?: string } = {},
): Promise<void> {
	const { trials = 1, tags, suiteName = "sentiment" } = options;

	let tasks = sentimentTasks;
	if (tags && tags.length > 0) {
		tasks = tasks.filter((t) => tags.some((tag) => t.tags.includes(tag)));
	}

	console.log(`Running sentiment evals: ${tasks.length} tasks, ${trials} trials each\n`);

	// Sentiment evals are data-driven — the "function under test" is identity
	// because tasks already contain the classifier output as input.
	// We're grading whether the classifier's past predictions match outcomes.
	const results = await runSuite<SentimentEvalOutput, SentimentEvalOutput, SentimentEvalReference>(
		tasks,
		async (input) => input, // Pass-through: input IS the classifier output
		allSentimentGraders,
		{ trials, suiteName },
	);

	console.log(formatSuiteReport(results));

	await Bun.write(
		`src/evals/results/${suiteName}-latest.json`,
		JSON.stringify(results, null, 2),
	);
	console.log(`Results saved to src/evals/results/${suiteName}-latest.json`);
}
```

- [ ] **Step 3: Register in `run.ts`**

In `src/evals/run.ts`, add after the `self-improve` block (before the final `console.log`):

```typescript
if (suite === "all" || suite === "sentiment") {
	const { runSentimentEvalSuite } = await import("./sentiment/suite.ts");
	await runSentimentEvalSuite({ trials, suiteName: "sentiment" });
}
```

- [ ] **Step 4: Run the sentiment eval suite**

Run: `bun run src/evals/run.ts sentiment`
Expected: Outputs results table. The "correct" tagged tasks should mostly pass direction grader, "challenging" ones may fail (that's expected — they're calibration tests).

- [ ] **Step 5: Commit**

```bash
git add src/evals/sentiment/tasks.ts src/evals/sentiment/suite.ts src/evals/run.ts
git commit -m "feat(evals): add sentiment signal quality eval suite"
```

---

### Task 8: Create CLI analysis script

**Files:**
- Create: `scripts/analyze-sentiment.ts`

- [ ] **Step 1: Create the analysis script**

Create `scripts/analyze-sentiment.ts`:

```typescript
#!/usr/bin/env bun
/**
 * Sentiment → Price Correlation Analysis
 *
 * Queries news_events and paper_trades to measure whether
 * classifier sentiment predicts subsequent price movement.
 *
 * Run: bun run scripts/analyze-sentiment.ts
 */

import { and, eq, gte, isNotNull, lte } from "drizzle-orm";
import { getDb, initDb } from "../src/db/client.ts";
import { newsEvents, paperTrades, quotesCache } from "../src/db/schema.ts";

await initDb();
const db = getDb();

console.log("\n=== Sentiment → Price Correlation Analysis ===\n");

// --- Part A: Forward-looking data (priceAtClassification + priceAfter1d) ---

const forwardEvents = await db
	.select({
		id: newsEvents.id,
		headline: newsEvents.headline,
		sentiment: newsEvents.sentiment,
		confidence: newsEvents.confidence,
		eventType: newsEvents.eventType,
		urgency: newsEvents.urgency,
		expectedMoveDuration: newsEvents.expectedMoveDuration,
		priceAtClassification: newsEvents.priceAtClassification,
		priceAfter1d: newsEvents.priceAfter1d,
		classifiedAt: newsEvents.classifiedAt,
	})
	.from(newsEvents)
	.where(
		and(
			isNotNull(newsEvents.priceAtClassification),
			isNotNull(newsEvents.priceAfter1d),
			isNotNull(newsEvents.sentiment),
		),
	);

console.log(`Forward-looking events (with both prices): ${forwardEvents.length}`);

if (forwardEvents.length > 0) {
	analyzeEvents(
		forwardEvents.map((e) => ({
			sentiment: e.sentiment!,
			confidence: e.confidence!,
			eventType: e.eventType ?? "unknown",
			priceChangePct:
				((e.priceAfter1d! - e.priceAtClassification!) / e.priceAtClassification!) * 100,
		})),
		"Forward-Looking",
	);
}

// --- Part B: Backfill from paper trades ---

const classifiedEvents = await db
	.select({
		id: newsEvents.id,
		symbols: newsEvents.symbols,
		sentiment: newsEvents.sentiment,
		confidence: newsEvents.confidence,
		eventType: newsEvents.eventType,
		classifiedAt: newsEvents.classifiedAt,
	})
	.from(newsEvents)
	.where(
		and(
			isNotNull(newsEvents.sentiment),
			isNotNull(newsEvents.classifiedAt),
			eq(newsEvents.tradeable, true),
		),
	);

console.log(`\nClassified tradeable events: ${classifiedEvents.length}`);

interface TradeMatch {
	sentiment: number;
	confidence: number;
	eventType: string;
	priceChangePct: number;
}

const tradeMatches: TradeMatch[] = [];

for (const event of classifiedEvents) {
	const symbols: string[] = JSON.parse(event.symbols ?? "[]");
	const primarySymbol = symbols[0];
	if (!primarySymbol || !event.classifiedAt) continue;

	const classifiedTime = new Date(event.classifiedAt);
	const windowStart = new Date(classifiedTime.getTime() - 60 * 60 * 1000); // 1h before
	const windowEnd = new Date(classifiedTime.getTime() + 60 * 60 * 1000); // 1h after

	// Find entry trades for this symbol near classification time
	const entries = await db
		.select({
			id: paperTrades.id,
			price: paperTrades.price,
			pnl: paperTrades.pnl,
			strategyId: paperTrades.strategyId,
			createdAt: paperTrades.createdAt,
		})
		.from(paperTrades)
		.where(
			and(
				eq(paperTrades.symbol, primarySymbol),
				gte(paperTrades.createdAt, windowStart.toISOString()),
				lte(paperTrades.createdAt, windowEnd.toISOString()),
				isNotNull(paperTrades.pnl),
			),
		);

	for (const entry of entries) {
		if (entry.pnl != null && entry.price > 0) {
			tradeMatches.push({
				sentiment: event.sentiment!,
				confidence: event.confidence!,
				eventType: event.eventType ?? "unknown",
				priceChangePct: (entry.pnl / (entry.price * 10)) * 100, // rough estimate
			});
		}
	}
}

console.log(`Paper trade matches: ${tradeMatches.length}`);

if (tradeMatches.length > 0) {
	analyzeEvents(tradeMatches, "Paper Trade Backfill");
}

// --- Summary ---

const allData = [
	...forwardEvents.map((e) => ({
		sentiment: e.sentiment!,
		confidence: e.confidence!,
		eventType: e.eventType ?? "unknown",
		priceChangePct:
			((e.priceAfter1d! - e.priceAtClassification!) / e.priceAtClassification!) * 100,
	})),
	...tradeMatches,
];

if (allData.length === 0) {
	console.log("\n⚠ No data available yet. Let the system run to accumulate:");
	console.log("  - Forward-looking prices need ~24h after classification");
	console.log("  - Paper trade matches need classified events that triggered trades");
	console.log("\nRe-run this script after a few days of operation.");
} else {
	console.log(`\n--- Combined Analysis (${allData.length} data points) ---`);
	analyzeEvents(allData, "Combined");

	// Pearson correlation
	const corr = pearsonCorrelation(
		allData.map((d) => d.sentiment),
		allData.map((d) => d.priceChangePct),
	);
	console.log(`\nPearson correlation (sentiment vs price change): ${corr.toFixed(4)}`);
	console.log(
		corr > 0.3
			? "→ Moderate positive correlation — signal has predictive value"
			: corr > 0.1
				? "→ Weak positive correlation — some signal, needs more data"
				: corr > -0.1
					? "→ No meaningful correlation — signal may not predict price"
					: "→ Negative correlation — signal is inversely predictive (investigate)",
	);
}

// === Helper functions ===

function analyzeEvents(
	data: Array<{ sentiment: number; confidence: number; eventType: string; priceChangePct: number }>,
	label: string,
): void {
	console.log(`\n--- ${label} (${data.length} events) ---`);

	// Direction accuracy
	const correctDirection = data.filter(
		(d) =>
			(d.sentiment > 0 && d.priceChangePct > 0) || (d.sentiment < 0 && d.priceChangePct < 0),
	).length;
	const hitRate = data.length > 0 ? correctDirection / data.length : 0;
	console.log(`Direction hit rate: ${(hitRate * 100).toFixed(1)}% (${correctDirection}/${data.length})`);

	// By sentiment bucket
	const buckets = [
		{ label: "Strong negative (<-0.5)", filter: (d: { sentiment: number }) => d.sentiment < -0.5 },
		{ label: "Weak negative (-0.5 to 0)", filter: (d: { sentiment: number }) => d.sentiment >= -0.5 && d.sentiment < 0 },
		{ label: "Weak positive (0 to 0.5)", filter: (d: { sentiment: number }) => d.sentiment >= 0 && d.sentiment < 0.5 },
		{ label: "Strong positive (>0.5)", filter: (d: { sentiment: number }) => d.sentiment >= 0.5 },
	];

	console.log("\nBy sentiment bucket:");
	for (const bucket of buckets) {
		const items = data.filter(bucket.filter);
		if (items.length === 0) continue;
		const avgChange = items.reduce((s, d) => s + d.priceChangePct, 0) / items.length;
		const bucketHitRate =
			items.filter(
				(d) =>
					(d.sentiment > 0 && d.priceChangePct > 0) ||
					(d.sentiment < 0 && d.priceChangePct < 0),
			).length / items.length;
		console.log(
			`  ${bucket.label}: n=${items.length}, avg change=${avgChange.toFixed(2)}%, hit rate=${(bucketHitRate * 100).toFixed(0)}%`,
		);
	}

	// By event type
	const eventTypes = [...new Set(data.map((d) => d.eventType))];
	if (eventTypes.length > 1) {
		console.log("\nBy event type:");
		for (const et of eventTypes) {
			const items = data.filter((d) => d.eventType === et);
			const avgChange = items.reduce((s, d) => s + d.priceChangePct, 0) / items.length;
			const etHitRate =
				items.filter(
					(d) =>
						(d.sentiment > 0 && d.priceChangePct > 0) ||
						(d.sentiment < 0 && d.priceChangePct < 0),
				).length / items.length;
			console.log(
				`  ${et}: n=${items.length}, avg change=${avgChange.toFixed(2)}%, hit rate=${(etHitRate * 100).toFixed(0)}%`,
			);
		}
	}

	// Confidence calibration
	const highConf = data.filter((d) => d.confidence >= 0.8);
	const lowConf = data.filter((d) => d.confidence < 0.6);
	if (highConf.length > 0 && lowConf.length > 0) {
		const highAvgAbs = highConf.reduce((s, d) => s + Math.abs(d.priceChangePct), 0) / highConf.length;
		const lowAvgAbs = lowConf.reduce((s, d) => s + Math.abs(d.priceChangePct), 0) / lowConf.length;
		console.log(`\nConfidence calibration:`);
		console.log(`  High confidence (>=0.8): avg |move| = ${highAvgAbs.toFixed(2)}% (n=${highConf.length})`);
		console.log(`  Low confidence (<0.6): avg |move| = ${lowAvgAbs.toFixed(2)}% (n=${lowConf.length})`);
		console.log(
			highAvgAbs > lowAvgAbs
				? "  → Confidence is calibrated (higher confidence → larger moves)"
				: "  → Confidence is NOT calibrated (high confidence doesn't predict larger moves)",
		);
	}
}

function pearsonCorrelation(x: number[], y: number[]): number {
	const n = x.length;
	if (n < 2) return 0;

	const meanX = x.reduce((s, v) => s + v, 0) / n;
	const meanY = y.reduce((s, v) => s + v, 0) / n;

	let num = 0;
	let denomX = 0;
	let denomY = 0;

	for (let i = 0; i < n; i++) {
		const dx = x[i]! - meanX;
		const dy = y[i]! - meanY;
		num += dx * dy;
		denomX += dx * dx;
		denomY += dy * dy;
	}

	const denom = Math.sqrt(denomX * denomY);
	return denom > 0 ? num / denom : 0;
}
```

- [ ] **Step 2: Run the script**

Run: `bun run scripts/analyze-sentiment.ts`
Expected: Outputs analysis tables. If no data yet, shows the "no data available" message with guidance. This is expected on a fresh system — data accumulates over time.

- [ ] **Step 3: Commit**

```bash
git add scripts/analyze-sentiment.ts
git commit -m "feat: add sentiment-price correlation analysis script"
```

---

### Task 9: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: ALL PASS — no regressions

- [ ] **Step 2: Run linter**

Run: `bunx biome check src/ scripts/ tests/`
Expected: No errors (warnings OK)

- [ ] **Step 3: Final commit if any lint fixes needed**

```bash
git add -A
git commit -m "fix: lint fixes for demotion + sentiment validation"
```

(Skip this step if no lint fixes were needed.)
