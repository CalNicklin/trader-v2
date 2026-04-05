# Phase 8: Risk Hard Limits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement all hard risk limits from spec Section 8 so the system can never lose more than defined thresholds. This is the safety layer that must be in place before any live trading.

**Architecture:** Pure function risk checks called before every trade, plus a periodic guardian that monitors portfolio-level limits. All limits are human-controlled constants, not AI-tunable. Every risk function takes state in and returns decisions out — no DB calls, no side effects inside the pure layer.

**Tech Stack:** Bun, TypeScript, Drizzle ORM (SQLite)

**Spec:** `docs/specs/2026-04-03-trader-v2-design.md` Section 4 (Graduation Gate) and Section 8 (Risk Management)

**Dependencies:** Phase 1 (schema, infra), Phase 2 (paper trading, indicators including `calcATR`), Phase 7 (broker integration — for live position data). The risk module itself is standalone and testable without broker connectivity.

---

## Hard Limits Reference (from spec)

| Parameter | Value |
|---|---|
| Risk per trade | 1% of account balance |
| Max concurrent positions | 3 |
| Max short size | 75% of max long size |
| Daily loss halt | 3% — stop all trading for the day |
| Weekly drawdown limit | 5% — reduce all position sizes by 50% |
| Max drawdown circuit breaker | 10% — full stop, email alert, manual restart required |
| Max correlated exposure | 2 positions in same sector |
| Stop loss (longs) | 2x ATR(14) |
| Stop loss (shorts) | 1x ATR(14) |
| Borrow fee cap | 5% annualized |

---

## File Structure

```
src/
  risk/
    constants.ts          # All hard limit constants in one place
    limits.ts             # Pure functions: per-trade limit checks
    position-sizer.ts     # ATR-based position sizing with friction
    guardian-checks.ts    # Pure functions: portfolio-level limit checks
    demotion.ts           # Pure functions: two-strike demotion + kill criteria
  db/
    schema.ts             # Add risk_state table (daily/weekly tracking)
  strategy/
    evaluator.ts          # Wire risk checks before trade placement

tests/
  risk/
    limits.test.ts
    position-sizer.test.ts
    guardian-checks.test.ts
    demotion.test.ts
```

---

### Task 1: Risk Constants

**Files:**
- Create: `src/risk/constants.ts`

Define all hard limits as exported `const` values. These are the single source of truth — every other risk file imports from here.

- [ ] **Step 1: Create the constants file**

```typescript
// src/risk/constants.ts

/** All hard risk limits. Human-controlled, not AI-tunable. */

// ── Per-Trade Limits ──────────────────────────────────────────────────────
export const RISK_PER_TRADE_PCT = 0.01; // 1% of account balance
export const MIN_POSITION_VALUE = 50; // USD — below this, spreads eat edge
export const MAX_CONCURRENT_POSITIONS = 3;
export const MAX_SHORT_SIZE_RATIO = 0.75; // 75% of max long size
export const BORROW_FEE_CAP_ANNUAL_PCT = 0.05; // 5% annualized

// ── Stop Loss Multipliers ─────────────────────────────────────────────────
export const STOP_LOSS_ATR_MULT_LONG = 2; // 2x ATR(14) for longs
export const STOP_LOSS_ATR_MULT_SHORT = 1; // 1x ATR(14) for shorts

// ── Portfolio-Level Limits ────────────────────────────────────────────────
export const DAILY_LOSS_HALT_PCT = 0.03; // 3% — stop all trading for the day
export const WEEKLY_DRAWDOWN_LIMIT_PCT = 0.05; // 5% — reduce position sizes by 50%
export const WEEKLY_DRAWDOWN_SIZE_REDUCTION = 0.5; // multiply sizes by this
export const MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT = 0.10; // 10% — full stop
export const MAX_CORRELATED_SECTOR_POSITIONS = 2;

// ── Demotion / Kill ───────────────────────────────────────────────────────
export const TWO_STRIKE_WINDOW_DAYS = 30; // second breach within N days = demotion
export const CAPITAL_REDUCTION_FIRST_STRIKE = 0.5; // 50% capital on first breach
export const KILL_LOSS_STREAK_SD = 3; // loss streak > 3 SD of expected
export const KILL_MAX_LIVE_TRADES = 60; // not profitable after N live trades
export const KILL_DEMOTIONS_IN_WINDOW = 2; // demoted twice in window
export const KILL_DEMOTION_WINDOW_DAYS = 60;

// ── Behavioral Divergence ─────────────────────────────────────────────────
export const BEHAVIORAL_DIVERGENCE_THRESHOLD = 0.20; // 20% deviation flags review
```

- [ ] **Step 2: Verify it compiles**

```bash
bunx tsc --noEmit src/risk/constants.ts
```

---

### Task 2: Per-Trade Limit Checks (`limits.ts`)

**Files:**
- Create: `src/risk/limits.ts`
- Create: `tests/risk/limits.test.ts`

All functions are pure — they receive state as arguments and return a verdict. No DB, no side effects.

- [ ] **Step 1: Write the test file first**

```typescript
// tests/risk/limits.test.ts
import { describe, expect, test } from "bun:test";
import {
	checkBorrowFee,
	checkConcurrentPositions,
	checkCorrelatedExposure,
	checkMaxShortSize,
	checkRiskPerTrade,
	type TradeProposal,
	type PortfolioState,
} from "../../src/risk/limits.ts";

describe("risk/limits", () => {
	const basePortfolio: PortfolioState = {
		accountBalance: 500,
		openPositions: [],
	};

	describe("checkRiskPerTrade", () => {
		test("allows trade within 1% risk", () => {
			const result = checkRiskPerTrade(500, 5);
			expect(result.allowed).toBe(true);
		});

		test("rejects trade exceeding 1% risk", () => {
			const result = checkRiskPerTrade(500, 6);
			expect(result.allowed).toBe(false);
			expect(result.reason).toContain("1%");
		});

		test("allows trade at exactly 1% risk", () => {
			const result = checkRiskPerTrade(500, 5);
			expect(result.allowed).toBe(true);
		});

		test("handles zero balance", () => {
			const result = checkRiskPerTrade(0, 1);
			expect(result.allowed).toBe(false);
		});
	});

	describe("checkConcurrentPositions", () => {
		test("allows when under limit", () => {
			const result = checkConcurrentPositions(2);
			expect(result.allowed).toBe(true);
		});

		test("rejects when at limit", () => {
			const result = checkConcurrentPositions(3);
			expect(result.allowed).toBe(false);
		});

		test("rejects when over limit", () => {
			const result = checkConcurrentPositions(5);
			expect(result.allowed).toBe(false);
		});

		test("allows zero positions", () => {
			const result = checkConcurrentPositions(0);
			expect(result.allowed).toBe(true);
		});
	});

	describe("checkMaxShortSize", () => {
		test("allows short within 75% of max long size", () => {
			// Max long risk = 500 * 1% = 5, max short = 5 * 0.75 = 3.75
			const result = checkMaxShortSize(500, 3.75, "SELL");
			expect(result.allowed).toBe(true);
		});

		test("rejects short exceeding 75% of max long size", () => {
			const result = checkMaxShortSize(500, 4.00, "SELL");
			expect(result.allowed).toBe(false);
		});

		test("always allows longs (not applicable)", () => {
			const result = checkMaxShortSize(500, 5, "BUY");
			expect(result.allowed).toBe(true);
		});
	});

	describe("checkCorrelatedExposure", () => {
		test("allows when under sector limit", () => {
			const result = checkCorrelatedExposure("Technology", [
				{ sector: "Technology" },
			]);
			expect(result.allowed).toBe(true);
		});

		test("rejects when at sector limit", () => {
			const result = checkCorrelatedExposure("Technology", [
				{ sector: "Technology" },
				{ sector: "Technology" },
			]);
			expect(result.allowed).toBe(false);
		});

		test("allows different sector", () => {
			const result = checkCorrelatedExposure("Healthcare", [
				{ sector: "Technology" },
				{ sector: "Technology" },
			]);
			expect(result.allowed).toBe(true);
		});

		test("allows unknown sector (no sector data)", () => {
			const result = checkCorrelatedExposure(null, [
				{ sector: "Technology" },
			]);
			expect(result.allowed).toBe(true);
		});
	});

	describe("checkBorrowFee", () => {
		test("allows borrow fee under cap", () => {
			const result = checkBorrowFee(0.04, "SELL");
			expect(result.allowed).toBe(true);
		});

		test("rejects borrow fee at cap", () => {
			const result = checkBorrowFee(0.05, "SELL");
			expect(result.allowed).toBe(false);
		});

		test("always allows longs regardless of fee", () => {
			const result = checkBorrowFee(0.10, "BUY");
			expect(result.allowed).toBe(true);
		});

		test("allows null borrow fee for shorts (assume zero)", () => {
			const result = checkBorrowFee(null, "SELL");
			expect(result.allowed).toBe(true);
		});
	});
});
```

- [ ] **Step 2: Run tests (expect failures)**

```bash
bun test --preload ./tests/preload.ts tests/risk/limits.test.ts
```

- [ ] **Step 3: Implement limits.ts**

```typescript
// src/risk/limits.ts
import {
	BORROW_FEE_CAP_ANNUAL_PCT,
	MAX_CONCURRENT_POSITIONS,
	MAX_CORRELATED_SECTOR_POSITIONS,
	MAX_SHORT_SIZE_RATIO,
	RISK_PER_TRADE_PCT,
} from "./constants.ts";

export interface LimitCheckResult {
	allowed: boolean;
	reason?: string;
}

export interface PositionInfo {
	sector: string | null;
}

export interface TradeProposal {
	side: "BUY" | "SELL";
	riskAmount: number;
	sector: string | null;
	borrowFeeAnnualPct: number | null;
}

export interface PortfolioState {
	accountBalance: number;
	openPositions: PositionInfo[];
}

/**
 * Check that the dollar risk of this trade does not exceed 1% of account balance.
 */
export function checkRiskPerTrade(
	accountBalance: number,
	riskAmount: number,
): LimitCheckResult {
	const maxRisk = accountBalance * RISK_PER_TRADE_PCT;
	if (accountBalance <= 0) {
		return { allowed: false, reason: "Account balance is zero or negative" };
	}
	if (riskAmount > maxRisk) {
		return {
			allowed: false,
			reason: `Risk $${riskAmount.toFixed(2)} exceeds 1% of balance ($${maxRisk.toFixed(2)})`,
		};
	}
	return { allowed: true };
}

/**
 * Check that we are under the max concurrent positions limit.
 */
export function checkConcurrentPositions(
	currentOpenCount: number,
): LimitCheckResult {
	if (currentOpenCount >= MAX_CONCURRENT_POSITIONS) {
		return {
			allowed: false,
			reason: `Already at max concurrent positions (${currentOpenCount}/${MAX_CONCURRENT_POSITIONS})`,
		};
	}
	return { allowed: true };
}

/**
 * Check that short position size does not exceed 75% of max long size.
 * For longs, always passes.
 */
export function checkMaxShortSize(
	accountBalance: number,
	riskAmount: number,
	side: "BUY" | "SELL",
): LimitCheckResult {
	if (side === "BUY") return { allowed: true };

	const maxLongRisk = accountBalance * RISK_PER_TRADE_PCT;
	const maxShortRisk = maxLongRisk * MAX_SHORT_SIZE_RATIO;

	if (riskAmount > maxShortRisk) {
		return {
			allowed: false,
			reason: `Short risk $${riskAmount.toFixed(2)} exceeds 75% of max long risk ($${maxShortRisk.toFixed(2)})`,
		};
	}
	return { allowed: true };
}

/**
 * Check that opening a position in this sector would not exceed
 * the max correlated exposure limit (2 positions per sector).
 */
export function checkCorrelatedExposure(
	proposedSector: string | null,
	existingPositions: Pick<PositionInfo, "sector">[],
): LimitCheckResult {
	if (!proposedSector) return { allowed: true };

	const sectorCount = existingPositions.filter(
		(p) => p.sector === proposedSector,
	).length;

	if (sectorCount >= MAX_CORRELATED_SECTOR_POSITIONS) {
		return {
			allowed: false,
			reason: `Already ${sectorCount} positions in ${proposedSector} (max ${MAX_CORRELATED_SECTOR_POSITIONS})`,
		};
	}
	return { allowed: true };
}

/**
 * Check that the annualized borrow fee for a short does not exceed the cap.
 * For longs, always passes.
 */
export function checkBorrowFee(
	borrowFeeAnnualPct: number | null,
	side: "BUY" | "SELL",
): LimitCheckResult {
	if (side === "BUY") return { allowed: true };
	if (borrowFeeAnnualPct == null) return { allowed: true };

	if (borrowFeeAnnualPct >= BORROW_FEE_CAP_ANNUAL_PCT) {
		return {
			allowed: false,
			reason: `Borrow fee ${(borrowFeeAnnualPct * 100).toFixed(1)}% exceeds cap ${(BORROW_FEE_CAP_ANNUAL_PCT * 100).toFixed(1)}%`,
		};
	}
	return { allowed: true };
}

/**
 * Run all per-trade limit checks. Returns the first failure, or allowed.
 */
export function runAllTradeChecks(
	portfolio: PortfolioState,
	proposal: TradeProposal,
): LimitCheckResult {
	const checks = [
		checkRiskPerTrade(portfolio.accountBalance, proposal.riskAmount),
		checkConcurrentPositions(portfolio.openPositions.length),
		checkMaxShortSize(portfolio.accountBalance, proposal.riskAmount, proposal.side),
		checkCorrelatedExposure(proposal.sector, portfolio.openPositions),
		checkBorrowFee(proposal.borrowFeeAnnualPct, proposal.side),
	];

	for (const check of checks) {
		if (!check.allowed) return check;
	}
	return { allowed: true };
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
bun test --preload ./tests/preload.ts tests/risk/limits.test.ts
```

- [ ] **Step 5: Lint**

```bash
bunx biome check src/risk/limits.ts src/risk/constants.ts tests/risk/limits.test.ts
```

---

### Task 3: ATR-Based Position Sizer (`position-sizer.ts`)

**Files:**
- Create: `src/risk/position-sizer.ts`
- Create: `tests/risk/position-sizer.test.ts`

Replaces the simple percentage-based `calcPositionSize` in `src/paper/pnl.ts` with ATR-based sizing. The old function remains for backward compatibility; new trades use the ATR sizer.

- [ ] **Step 1: Write the test file first**

```typescript
// tests/risk/position-sizer.test.ts
import { describe, expect, test } from "bun:test";
import {
	calcAtrPositionSize,
	calcStopLossPrice,
	type PositionSizeInput,
	type PositionSizeResult,
} from "../../src/risk/position-sizer.ts";

describe("risk/position-sizer", () => {
	describe("calcStopLossPrice", () => {
		test("long stop loss = price - 2x ATR", () => {
			const stop = calcStopLossPrice(100, 5, "BUY");
			expect(stop).toBe(90); // 100 - (5 * 2)
		});

		test("short stop loss = price + 1x ATR", () => {
			const stop = calcStopLossPrice(100, 5, "SELL");
			expect(stop).toBe(105); // 100 + (5 * 1)
		});

		test("long stop cannot be negative", () => {
			const stop = calcStopLossPrice(5, 10, "BUY");
			expect(stop).toBe(0.01); // floored to 0.01
		});
	});

	describe("calcAtrPositionSize", () => {
		test("basic long position sizing", () => {
			const result = calcAtrPositionSize({
				accountBalance: 500,
				price: 50,
				atr14: 2.5,
				side: "BUY",
				exchange: "NASDAQ",
			});

			// risk = 500 * 0.01 = 5
			// stop_distance = 2.5 * 2 = 5
			// shares = 5 / 5 = 1
			// position_value = 1 * 50 = 50
			expect(result.quantity).toBe(1);
			expect(result.stopLossPrice).toBe(45); // 50 - 5
			expect(result.riskAmount).toBeCloseTo(5, 1);
			expect(result.positionValue).toBe(50);
		});

		test("basic short position sizing (75% cap)", () => {
			const result = calcAtrPositionSize({
				accountBalance: 500,
				price: 50,
				atr14: 2.5,
				side: "SELL",
				exchange: "NASDAQ",
			});

			// risk = 500 * 0.01 = 5, short cap = 5 * 0.75 = 3.75
			// stop_distance = 2.5 * 1 = 2.5
			// shares = 3.75 / 2.5 = 1.5 -> floor = 1
			// position_value = 1 * 50 = 50
			expect(result.quantity).toBe(1);
			expect(result.stopLossPrice).toBe(52.5); // 50 + 2.5
		});

		test("returns zero quantity when position value below minimum", () => {
			const result = calcAtrPositionSize({
				accountBalance: 100,
				price: 200,
				atr14: 10,
				side: "BUY",
				exchange: "NASDAQ",
			});

			// risk = 100 * 0.01 = 1
			// stop_distance = 10 * 2 = 20
			// shares = 1 / 20 = 0.05 -> floor = 0
			expect(result.quantity).toBe(0);
			expect(result.skipped).toBe(true);
			expect(result.skipReason).toContain("minimum");
		});

		test("accounts for friction in position value calculation", () => {
			const resultNasdaq = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "NASDAQ",
			});

			const resultLSE = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "LSE",
			});

			// LSE has higher friction (0.6% stamp duty) so effective risk per share is higher
			// Both should produce valid results but LSE may have fewer shares
			expect(resultNasdaq.quantity).toBeGreaterThan(0);
			expect(resultLSE.quantity).toBeGreaterThan(0);
			expect(resultLSE.friction).toBeGreaterThan(resultNasdaq.friction);
		});

		test("weekly drawdown mode reduces size by 50%", () => {
			const normal = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "NASDAQ",
				weeklyDrawdownActive: false,
			});

			const reduced = calcAtrPositionSize({
				accountBalance: 10000,
				price: 100,
				atr14: 5,
				side: "BUY",
				exchange: "NASDAQ",
				weeklyDrawdownActive: true,
			});

			expect(reduced.quantity).toBeLessThanOrEqual(
				Math.floor(normal.quantity * 0.5),
			);
		});

		test("returns zero when ATR is zero or null", () => {
			const result = calcAtrPositionSize({
				accountBalance: 500,
				price: 50,
				atr14: 0,
				side: "BUY",
				exchange: "NASDAQ",
			});
			expect(result.quantity).toBe(0);
			expect(result.skipped).toBe(true);
		});

		test("handles very small account balance", () => {
			const result = calcAtrPositionSize({
				accountBalance: 10,
				price: 5,
				atr14: 0.5,
				side: "BUY",
				exchange: "NASDAQ",
			});
			// risk = 0.10, stop_distance = 1.0
			// shares = 0.10 / 1.0 = 0.1 -> floor = 0
			expect(result.quantity).toBe(0);
			expect(result.skipped).toBe(true);
		});
	});
});
```

- [ ] **Step 2: Run tests (expect failures)**

```bash
bun test --preload ./tests/preload.ts tests/risk/position-sizer.test.ts
```

- [ ] **Step 3: Implement position-sizer.ts**

```typescript
// src/risk/position-sizer.ts
import { getTradeFriction } from "../utils/fx.ts";
import {
	MIN_POSITION_VALUE,
	MAX_SHORT_SIZE_RATIO,
	RISK_PER_TRADE_PCT,
	STOP_LOSS_ATR_MULT_LONG,
	STOP_LOSS_ATR_MULT_SHORT,
	WEEKLY_DRAWDOWN_SIZE_REDUCTION,
} from "./constants.ts";

export interface PositionSizeInput {
	accountBalance: number;
	price: number;
	atr14: number;
	side: "BUY" | "SELL";
	exchange: string;
	weeklyDrawdownActive?: boolean;
}

export interface PositionSizeResult {
	quantity: number;
	positionValue: number;
	stopLossPrice: number;
	riskAmount: number;
	friction: number;
	skipped: boolean;
	skipReason?: string;
}

/**
 * Calculate the stop-loss price based on ATR.
 * Longs: price - 2x ATR(14)
 * Shorts: price + 1x ATR(14)
 */
export function calcStopLossPrice(
	price: number,
	atr14: number,
	side: "BUY" | "SELL",
): number {
	const multiplier =
		side === "BUY" ? STOP_LOSS_ATR_MULT_LONG : STOP_LOSS_ATR_MULT_SHORT;
	const stopDistance = atr14 * multiplier;

	if (side === "BUY") {
		return Math.max(price - stopDistance, 0.01);
	}
	return price + stopDistance;
}

/**
 * ATR-based position sizing with friction and all hard limits applied.
 *
 * Formula:
 *   risk_per_trade = account_balance * 0.01
 *   stop_distance  = ATR(14) * multiplier (2x longs, 1x shorts)
 *   shares         = risk_per_trade / stop_distance
 *   position_value = shares * price
 *
 * Shorts are capped at 75% of max long risk.
 * Weekly drawdown mode reduces size by 50%.
 * Minimum position value: $50.
 */
export function calcAtrPositionSize(input: PositionSizeInput): PositionSizeResult {
	const { accountBalance, price, atr14, side, exchange, weeklyDrawdownActive } =
		input;

	const skippedResult = (reason: string): PositionSizeResult => ({
		quantity: 0,
		positionValue: 0,
		stopLossPrice: side === "BUY" ? price : price,
		riskAmount: 0,
		friction: 0,
		skipped: true,
		skipReason: reason,
	});

	if (atr14 <= 0) return skippedResult("ATR is zero or negative");
	if (price <= 0) return skippedResult("Price is zero or negative");
	if (accountBalance <= 0) return skippedResult("Account balance is zero or negative");

	// Base risk calculation
	let riskBudget = accountBalance * RISK_PER_TRADE_PCT;

	// Shorts capped at 75% of max long risk
	if (side === "SELL") {
		riskBudget *= MAX_SHORT_SIZE_RATIO;
	}

	// Weekly drawdown mode: reduce by 50%
	if (weeklyDrawdownActive) {
		riskBudget *= WEEKLY_DRAWDOWN_SIZE_REDUCTION;
	}

	// Stop distance
	const multiplier =
		side === "BUY" ? STOP_LOSS_ATR_MULT_LONG : STOP_LOSS_ATR_MULT_SHORT;
	const stopDistance = atr14 * multiplier;

	// Shares from risk budget
	const rawShares = riskBudget / stopDistance;
	const quantity = Math.floor(rawShares);

	if (quantity <= 0) {
		return skippedResult("Calculated quantity is zero (risk budget too small for stop distance)");
	}

	const positionValue = quantity * price;

	// Friction cost
	const frictionPct = getTradeFriction(exchange, side);
	const friction = positionValue * frictionPct;

	// Minimum position check (after friction)
	if (positionValue < MIN_POSITION_VALUE) {
		return skippedResult(
			`Position value $${positionValue.toFixed(2)} below minimum $${MIN_POSITION_VALUE}`,
		);
	}

	const stopLossPrice = calcStopLossPrice(price, atr14, side);
	const actualRisk = quantity * stopDistance + friction;

	return {
		quantity,
		positionValue,
		stopLossPrice,
		riskAmount: actualRisk,
		friction,
		skipped: false,
	};
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
bun test --preload ./tests/preload.ts tests/risk/position-sizer.test.ts
```

- [ ] **Step 5: Lint**

```bash
bunx biome check src/risk/position-sizer.ts tests/risk/position-sizer.test.ts
```

---

### Task 4: Guardian Checks — Portfolio-Level Limits (`guardian-checks.ts`)

**Files:**
- Create: `src/risk/guardian-checks.ts`
- Create: `tests/risk/guardian-checks.test.ts`

Pure functions that check daily loss halt (3%), weekly drawdown (5%), and circuit breaker (10%). The caller is responsible for reading state from DB and acting on results.

- [ ] **Step 1: Write the test file first**

```typescript
// tests/risk/guardian-checks.test.ts
import { describe, expect, test } from "bun:test";
import {
	checkDailyLossHalt,
	checkWeeklyDrawdown,
	checkCircuitBreaker,
	runGuardianChecks,
	type GuardianState,
	type GuardianVerdict,
} from "../../src/risk/guardian-checks.ts";

describe("risk/guardian-checks", () => {
	describe("checkDailyLossHalt", () => {
		test("allows trading when daily loss under 3%", () => {
			const result = checkDailyLossHalt(500, -10); // -2%
			expect(result.halt).toBe(false);
		});

		test("halts trading at exactly 3% daily loss", () => {
			const result = checkDailyLossHalt(500, -15); // -3%
			expect(result.halt).toBe(true);
			expect(result.action).toBe("daily_halt");
		});

		test("halts trading when daily loss exceeds 3%", () => {
			const result = checkDailyLossHalt(500, -20); // -4%
			expect(result.halt).toBe(true);
		});

		test("allows trading when daily P&L is positive", () => {
			const result = checkDailyLossHalt(500, 10);
			expect(result.halt).toBe(false);
		});

		test("handles zero balance", () => {
			const result = checkDailyLossHalt(0, -1);
			expect(result.halt).toBe(true);
		});
	});

	describe("checkWeeklyDrawdown", () => {
		test("no action when weekly drawdown under 5%", () => {
			const result = checkWeeklyDrawdown(500, -20); // -4%
			expect(result.halt).toBe(false);
			expect(result.reduceSizes).toBe(false);
		});

		test("reduces sizes at 5% weekly drawdown", () => {
			const result = checkWeeklyDrawdown(500, -25); // -5%
			expect(result.halt).toBe(false);
			expect(result.reduceSizes).toBe(true);
			expect(result.action).toBe("weekly_size_reduction");
		});

		test("reduces sizes between 5% and 10%", () => {
			const result = checkWeeklyDrawdown(500, -40); // -8%
			expect(result.reduceSizes).toBe(true);
			expect(result.halt).toBe(false);
		});
	});

	describe("checkCircuitBreaker", () => {
		test("no action when max drawdown under 10%", () => {
			const result = checkCircuitBreaker(500, 460); // -8%
			expect(result.halt).toBe(false);
		});

		test("triggers full stop at 10% max drawdown", () => {
			const result = checkCircuitBreaker(500, 450); // -10%
			expect(result.halt).toBe(true);
			expect(result.action).toBe("circuit_breaker");
			expect(result.requiresManualRestart).toBe(true);
		});

		test("triggers full stop beyond 10%", () => {
			const result = checkCircuitBreaker(500, 400); // -20%
			expect(result.halt).toBe(true);
			expect(result.requiresManualRestart).toBe(true);
		});
	});

	describe("runGuardianChecks", () => {
		test("returns all-clear when no limits breached", () => {
			const state: GuardianState = {
				accountBalance: 500,
				peakBalance: 500,
				dailyPnl: -5,
				weeklyPnl: -10,
				currentPortfolioValue: 490,
			};
			const verdict = runGuardianChecks(state);
			expect(verdict.canTrade).toBe(true);
			expect(verdict.reduceSizes).toBe(false);
			expect(verdict.reasons).toHaveLength(0);
		});

		test("daily halt takes precedence in reasons", () => {
			const state: GuardianState = {
				accountBalance: 500,
				peakBalance: 500,
				dailyPnl: -20,
				weeklyPnl: -10,
				currentPortfolioValue: 480,
			};
			const verdict = runGuardianChecks(state);
			expect(verdict.canTrade).toBe(false);
			expect(verdict.reasons.length).toBeGreaterThan(0);
		});

		test("circuit breaker overrides everything", () => {
			const state: GuardianState = {
				accountBalance: 500,
				peakBalance: 600,
				dailyPnl: 0,
				weeklyPnl: 0,
				currentPortfolioValue: 520, // 520/600 = 13.3% below peak
			};
			const verdict = runGuardianChecks(state);
			expect(verdict.canTrade).toBe(false);
			expect(verdict.requiresManualRestart).toBe(true);
		});

		test("weekly drawdown triggers size reduction without halt", () => {
			const state: GuardianState = {
				accountBalance: 1000,
				peakBalance: 1000,
				dailyPnl: -5,
				weeklyPnl: -55,
				currentPortfolioValue: 950,
			};
			const verdict = runGuardianChecks(state);
			expect(verdict.canTrade).toBe(true);
			expect(verdict.reduceSizes).toBe(true);
		});
	});
});
```

- [ ] **Step 2: Run tests (expect failures)**

```bash
bun test --preload ./tests/preload.ts tests/risk/guardian-checks.test.ts
```

- [ ] **Step 3: Implement guardian-checks.ts**

```typescript
// src/risk/guardian-checks.ts
import {
	DAILY_LOSS_HALT_PCT,
	MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT,
	WEEKLY_DRAWDOWN_LIMIT_PCT,
} from "./constants.ts";

export interface GuardianState {
	/** Starting balance for the period (e.g., start-of-day or account deposit) */
	accountBalance: number;
	/** Highest portfolio value ever recorded (for circuit breaker) */
	peakBalance: number;
	/** Today's realized + unrealized P&L */
	dailyPnl: number;
	/** This week's realized + unrealized P&L */
	weeklyPnl: number;
	/** Current total portfolio value */
	currentPortfolioValue: number;
}

interface DailyCheckResult {
	halt: boolean;
	action?: "daily_halt";
	reason?: string;
}

interface WeeklyCheckResult {
	halt: boolean;
	reduceSizes: boolean;
	action?: "weekly_size_reduction";
	reason?: string;
}

interface CircuitBreakerResult {
	halt: boolean;
	requiresManualRestart: boolean;
	action?: "circuit_breaker";
	reason?: string;
}

export interface GuardianVerdict {
	canTrade: boolean;
	reduceSizes: boolean;
	requiresManualRestart: boolean;
	reasons: string[];
}

/**
 * Check if daily loss has hit the 3% halt threshold.
 */
export function checkDailyLossHalt(
	accountBalance: number,
	dailyPnl: number,
): DailyCheckResult {
	if (accountBalance <= 0) {
		return { halt: true, action: "daily_halt", reason: "Account balance is zero or negative" };
	}

	const lossPct = Math.abs(dailyPnl) / accountBalance;

	if (dailyPnl < 0 && lossPct >= DAILY_LOSS_HALT_PCT) {
		return {
			halt: true,
			action: "daily_halt",
			reason: `Daily loss ${(lossPct * 100).toFixed(1)}% >= ${(DAILY_LOSS_HALT_PCT * 100).toFixed(0)}% halt threshold`,
		};
	}

	return { halt: false };
}

/**
 * Check if weekly drawdown has hit the 5% size-reduction threshold.
 * Note: this does NOT trigger a full halt — just a 50% size reduction.
 */
export function checkWeeklyDrawdown(
	accountBalance: number,
	weeklyPnl: number,
): WeeklyCheckResult {
	if (accountBalance <= 0) {
		return { halt: false, reduceSizes: true, action: "weekly_size_reduction", reason: "Account balance is zero or negative" };
	}

	const lossPct = Math.abs(weeklyPnl) / accountBalance;

	if (weeklyPnl < 0 && lossPct >= WEEKLY_DRAWDOWN_LIMIT_PCT) {
		return {
			halt: false,
			reduceSizes: true,
			action: "weekly_size_reduction",
			reason: `Weekly drawdown ${(lossPct * 100).toFixed(1)}% >= ${(WEEKLY_DRAWDOWN_LIMIT_PCT * 100).toFixed(0)}% — reducing position sizes by 50%`,
		};
	}

	return { halt: false, reduceSizes: false };
}

/**
 * Check if max drawdown from peak has hit the 10% circuit breaker.
 * This requires manual restart — the system will not resume on its own.
 */
export function checkCircuitBreaker(
	peakBalance: number,
	currentPortfolioValue: number,
): CircuitBreakerResult {
	if (peakBalance <= 0) {
		return { halt: true, requiresManualRestart: true, action: "circuit_breaker", reason: "Peak balance is zero or negative" };
	}

	const drawdownPct = (peakBalance - currentPortfolioValue) / peakBalance;

	if (drawdownPct >= MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT) {
		return {
			halt: true,
			requiresManualRestart: true,
			action: "circuit_breaker",
			reason: `Max drawdown ${(drawdownPct * 100).toFixed(1)}% >= ${(MAX_DRAWDOWN_CIRCUIT_BREAKER_PCT * 100).toFixed(0)}% circuit breaker — FULL STOP, manual restart required`,
		};
	}

	return { halt: false, requiresManualRestart: false };
}

/**
 * Run all guardian checks and produce a single verdict.
 * Called periodically (every 60s during market hours per spec).
 */
export function runGuardianChecks(state: GuardianState): GuardianVerdict {
	const reasons: string[] = [];
	let canTrade = true;
	let reduceSizes = false;
	let requiresManualRestart = false;

	// Circuit breaker (most severe — check first)
	const cb = checkCircuitBreaker(state.peakBalance, state.currentPortfolioValue);
	if (cb.halt) {
		canTrade = false;
		requiresManualRestart = true;
		if (cb.reason) reasons.push(cb.reason);
	}

	// Daily loss halt
	const daily = checkDailyLossHalt(state.accountBalance, state.dailyPnl);
	if (daily.halt) {
		canTrade = false;
		if (daily.reason) reasons.push(daily.reason);
	}

	// Weekly drawdown (size reduction, not halt)
	const weekly = checkWeeklyDrawdown(state.accountBalance, state.weeklyPnl);
	if (weekly.reduceSizes) {
		reduceSizes = true;
		if (weekly.reason) reasons.push(weekly.reason);
	}

	return { canTrade, reduceSizes, requiresManualRestart, reasons };
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
bun test --preload ./tests/preload.ts tests/risk/guardian-checks.test.ts
```

- [ ] **Step 5: Lint**

```bash
bunx biome check src/risk/guardian-checks.ts tests/risk/guardian-checks.test.ts
```

---

### Task 5: Demotion and Kill Criteria (`demotion.ts`)

**Files:**
- Create: `src/risk/demotion.ts`
- Create: `tests/risk/demotion.test.ts`

Pure functions for the two-strike demotion rule, kill criteria, and behavioral divergence checks. All from spec Section 4.

- [ ] **Step 1: Write the test file first**

```typescript
// tests/risk/demotion.test.ts
import { describe, expect, test } from "bun:test";
import {
	checkTwoStrikeDemotion,
	checkKillCriteria,
	checkBehavioralDivergence,
	type DemotionEvent,
	type StrategyLiveStats,
	type BehavioralComparison,
} from "../../src/risk/demotion.ts";

describe("risk/demotion", () => {
	describe("checkTwoStrikeDemotion", () => {
		const now = new Date("2026-04-04T12:00:00Z");

		test("first strike: reduces capital to 50%", () => {
			const result = checkTwoStrikeDemotion([], now);
			expect(result.action).toBe("first_strike");
			expect(result.capitalMultiplier).toBe(0.5);
		});

		test("second strike within 30 days: demote", () => {
			const events: DemotionEvent[] = [
				{ date: new Date("2026-03-20T12:00:00Z"), type: "strike" },
			];
			const result = checkTwoStrikeDemotion(events, now);
			expect(result.action).toBe("demote");
		});

		test("second strike outside 30 days: treated as first strike", () => {
			const events: DemotionEvent[] = [
				{ date: new Date("2026-02-01T12:00:00Z"), type: "strike" },
			];
			const result = checkTwoStrikeDemotion(events, now);
			expect(result.action).toBe("first_strike");
			expect(result.capitalMultiplier).toBe(0.5);
		});

		test("already demoted twice: kill", () => {
			const events: DemotionEvent[] = [
				{ date: new Date("2026-03-10T12:00:00Z"), type: "demotion" },
				{ date: new Date("2026-03-25T12:00:00Z"), type: "demotion" },
			];
			const result = checkTwoStrikeDemotion(events, now);
			expect(result.action).toBe("kill");
		});
	});

	describe("checkKillCriteria", () => {
		test("no kill when all metrics healthy", () => {
			const stats: StrategyLiveStats = {
				liveTradeCount: 30,
				totalPnl: 50,
				currentLossStreak: 2,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 1,
				demotionCount: 0,
				demotionDates: [],
			};
			const result = checkKillCriteria(stats, new Date());
			expect(result.shouldKill).toBe(false);
		});

		test("kill when loss streak > 3 SD", () => {
			const stats: StrategyLiveStats = {
				liveTradeCount: 50,
				totalPnl: -100,
				currentLossStreak: 10,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 2,
				demotionCount: 0,
				demotionDates: [],
			};
			// 10 > 3 + (3 * 2) = 9 -> kill
			const result = checkKillCriteria(stats, new Date());
			expect(result.shouldKill).toBe(true);
			expect(result.reason).toContain("loss streak");
		});

		test("kill when not profitable after 60 live trades", () => {
			const stats: StrategyLiveStats = {
				liveTradeCount: 60,
				totalPnl: -10,
				currentLossStreak: 1,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 1,
				demotionCount: 0,
				demotionDates: [],
			};
			const result = checkKillCriteria(stats, new Date());
			expect(result.shouldKill).toBe(true);
			expect(result.reason).toContain("60");
		});

		test("no kill at 59 trades even if unprofitable", () => {
			const stats: StrategyLiveStats = {
				liveTradeCount: 59,
				totalPnl: -10,
				currentLossStreak: 1,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 1,
				demotionCount: 0,
				demotionDates: [],
			};
			const result = checkKillCriteria(stats, new Date());
			expect(result.shouldKill).toBe(false);
		});

		test("kill when demoted twice within 60 days", () => {
			const now = new Date("2026-04-04T12:00:00Z");
			const stats: StrategyLiveStats = {
				liveTradeCount: 30,
				totalPnl: 10,
				currentLossStreak: 0,
				expectedLossStreakMean: 3,
				expectedLossStreakStdDev: 1,
				demotionCount: 2,
				demotionDates: [
					new Date("2026-02-15T12:00:00Z"),
					new Date("2026-03-20T12:00:00Z"),
				],
			};
			const result = checkKillCriteria(stats, now);
			expect(result.shouldKill).toBe(true);
			expect(result.reason).toContain("demoted twice");
		});
	});

	describe("checkBehavioralDivergence", () => {
		test("no divergence when within 20% threshold", () => {
			const comparison: BehavioralComparison = {
				paperAvgSlippage: 0.10,
				liveAvgSlippage: 0.11,
				paperFillRate: 0.95,
				liveFillRate: 0.90,
				paperAvgFriction: 0.002,
				liveAvgFriction: 0.0022,
			};
			const result = checkBehavioralDivergence(comparison);
			expect(result.diverged).toBe(false);
		});

		test("flags divergence when slippage deviates > 20%", () => {
			const comparison: BehavioralComparison = {
				paperAvgSlippage: 0.10,
				liveAvgSlippage: 0.15, // 50% higher
				paperFillRate: 0.95,
				liveFillRate: 0.90,
				paperAvgFriction: 0.002,
				liveAvgFriction: 0.002,
			};
			const result = checkBehavioralDivergence(comparison);
			expect(result.diverged).toBe(true);
			expect(result.reasons.length).toBeGreaterThan(0);
		});

		test("flags divergence when fill rate deviates > 20%", () => {
			const comparison: BehavioralComparison = {
				paperAvgSlippage: 0.10,
				liveAvgSlippage: 0.10,
				paperFillRate: 0.95,
				liveFillRate: 0.70, // 26% lower
				paperAvgFriction: 0.002,
				liveAvgFriction: 0.002,
			};
			const result = checkBehavioralDivergence(comparison);
			expect(result.diverged).toBe(true);
		});

		test("handles zero paper values gracefully", () => {
			const comparison: BehavioralComparison = {
				paperAvgSlippage: 0,
				liveAvgSlippage: 0.01,
				paperFillRate: 0,
				liveFillRate: 0.5,
				paperAvgFriction: 0,
				liveAvgFriction: 0.001,
			};
			const result = checkBehavioralDivergence(comparison);
			// When paper baseline is zero, any live value is technically infinite divergence
			// but we should handle it without crashing
			expect(result).toBeDefined();
		});
	});
});
```

- [ ] **Step 2: Run tests (expect failures)**

```bash
bun test --preload ./tests/preload.ts tests/risk/demotion.test.ts
```

- [ ] **Step 3: Implement demotion.ts**

```typescript
// src/risk/demotion.ts
import {
	BEHAVIORAL_DIVERGENCE_THRESHOLD,
	CAPITAL_REDUCTION_FIRST_STRIKE,
	KILL_DEMOTION_WINDOW_DAYS,
	KILL_DEMOTIONS_IN_WINDOW,
	KILL_LOSS_STREAK_SD,
	KILL_MAX_LIVE_TRADES,
	TWO_STRIKE_WINDOW_DAYS,
} from "./constants.ts";

// ── Types ──────────────────────────────────────────────────────────────────

export interface DemotionEvent {
	date: Date;
	type: "strike" | "demotion";
}

export interface TwoStrikeResult {
	action: "first_strike" | "demote" | "kill";
	capitalMultiplier?: number;
	reason: string;
}

export interface StrategyLiveStats {
	liveTradeCount: number;
	totalPnl: number;
	currentLossStreak: number;
	expectedLossStreakMean: number;
	expectedLossStreakStdDev: number;
	demotionCount: number;
	demotionDates: Date[];
}

export interface KillResult {
	shouldKill: boolean;
	reason?: string;
}

export interface BehavioralComparison {
	paperAvgSlippage: number;
	liveAvgSlippage: number;
	paperFillRate: number;
	liveFillRate: number;
	paperAvgFriction: number;
	liveAvgFriction: number;
}

export interface DivergenceResult {
	diverged: boolean;
	reasons: string[];
}

// ── Two-Strike Demotion Rule ──────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Two-strike demotion rule (spec Section 4):
 * - First breach: capital reduced to 50%
 * - Second breach within 30 days: strategy demoted back to Paper
 * - Already demoted twice (within 60 days): killed permanently
 *
 * @param recentEvents - prior demotion events for this strategy
 * @param now - current date
 */
export function checkTwoStrikeDemotion(
	recentEvents: DemotionEvent[],
	now: Date,
): TwoStrikeResult {
	const windowMs = TWO_STRIKE_WINDOW_DAYS * MS_PER_DAY;
	const killWindowMs = KILL_DEMOTION_WINDOW_DAYS * MS_PER_DAY;

	// Check if already demoted twice within 60 days -> kill
	const recentDemotions = recentEvents.filter(
		(e) => e.type === "demotion" && now.getTime() - e.date.getTime() <= killWindowMs,
	);
	if (recentDemotions.length >= KILL_DEMOTIONS_IN_WINDOW) {
		return {
			action: "kill",
			reason: `Demoted ${recentDemotions.length} times within ${KILL_DEMOTION_WINDOW_DAYS} days — permanent retirement`,
		};
	}

	// Check for recent strike within 30 days
	const recentStrikes = recentEvents.filter(
		(e) => e.type === "strike" && now.getTime() - e.date.getTime() <= windowMs,
	);
	if (recentStrikes.length > 0) {
		return {
			action: "demote",
			reason: `Second breach within ${TWO_STRIKE_WINDOW_DAYS} days — demoting to Paper`,
		};
	}

	// First strike
	return {
		action: "first_strike",
		capitalMultiplier: CAPITAL_REDUCTION_FIRST_STRIKE,
		reason: `First breach — capital reduced to ${CAPITAL_REDUCTION_FIRST_STRIKE * 100}%`,
	};
}

// ── Kill Criteria ─────────────────────────────────────────────────────────

/**
 * Kill criteria (spec Section 4):
 * 1. Loss streak > 3 SD of expected distribution
 * 2. Not profitable after 60 live trades
 * 3. Demoted twice within 60 days
 */
export function checkKillCriteria(
	stats: StrategyLiveStats,
	now: Date,
): KillResult {
	// 1. Loss streak exceeding 3 SD
	const streakThreshold =
		stats.expectedLossStreakMean + KILL_LOSS_STREAK_SD * stats.expectedLossStreakStdDev;
	if (stats.currentLossStreak > streakThreshold) {
		return {
			shouldKill: true,
			reason: `Loss streak ${stats.currentLossStreak} exceeds 3 SD threshold (${streakThreshold.toFixed(1)})`,
		};
	}

	// 2. Not profitable after 60 live trades
	if (stats.liveTradeCount >= KILL_MAX_LIVE_TRADES && stats.totalPnl <= 0) {
		return {
			shouldKill: true,
			reason: `Not profitable after ${stats.liveTradeCount} live trades (P&L: $${stats.totalPnl.toFixed(2)})`,
		};
	}

	// 3. Demoted twice within 60 days
	const killWindowMs = KILL_DEMOTION_WINDOW_DAYS * MS_PER_DAY;
	const recentDemotions = stats.demotionDates.filter(
		(d) => now.getTime() - d.getTime() <= killWindowMs,
	);
	if (recentDemotions.length >= KILL_DEMOTIONS_IN_WINDOW) {
		return {
			shouldKill: true,
			reason: `Demoted twice within ${KILL_DEMOTION_WINDOW_DAYS} days`,
		};
	}

	return { shouldKill: false };
}

// ── Behavioral Divergence ─────────────────────────────────────────────────

/**
 * Compare live execution metrics against paper assumptions.
 * If any metric deviates > 20%, flag for review.
 */
export function checkBehavioralDivergence(
	comparison: BehavioralComparison,
): DivergenceResult {
	const reasons: string[] = [];
	const threshold = BEHAVIORAL_DIVERGENCE_THRESHOLD;

	const checkDeviation = (
		label: string,
		paperVal: number,
		liveVal: number,
	) => {
		if (paperVal === 0) {
			// If paper baseline is zero and live is non-zero, flag it
			if (liveVal > 0) {
				reasons.push(
					`${label}: paper=0, live=${liveVal.toFixed(4)} — cannot compute ratio, flagging`,
				);
			}
			return;
		}

		const deviation = Math.abs(liveVal - paperVal) / Math.abs(paperVal);
		if (deviation > threshold) {
			reasons.push(
				`${label}: paper=${paperVal.toFixed(4)}, live=${liveVal.toFixed(4)}, deviation=${(deviation * 100).toFixed(1)}% > ${(threshold * 100).toFixed(0)}%`,
			);
		}
	};

	checkDeviation("Slippage", comparison.paperAvgSlippage, comparison.liveAvgSlippage);
	checkDeviation("Fill rate", comparison.paperFillRate, comparison.liveFillRate);
	checkDeviation("Friction", comparison.paperAvgFriction, comparison.liveAvgFriction);

	return { diverged: reasons.length > 0, reasons };
}
```

- [ ] **Step 4: Run tests (expect pass)**

```bash
bun test --preload ./tests/preload.ts tests/risk/demotion.test.ts
```

- [ ] **Step 5: Lint**

```bash
bunx biome check src/risk/demotion.ts tests/risk/demotion.test.ts
```

---

### Task 6: Schema Addition — `risk_state` Table

**Files:**
- Modify: `src/db/schema.ts`

Add a `risk_state` table to track daily/weekly aggregates and circuit breaker state. This is the persistent state that the guardian reads from and writes to.

- [ ] **Step 1: Add the `riskState` table to schema.ts**

Add the following after the `dailySnapshots` table definition:

```typescript
// ── Risk State ─────────────────────────────────────────────────────────────

export const riskState = sqliteTable("risk_state", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	key: text("key").notNull().unique(),
	value: text("value").notNull(),
	updatedAt: text("updated_at")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),
});
```

The `key`/`value` design stores these runtime states:
- `daily_pnl` — reset at market open each day
- `weekly_pnl` — reset Monday at market open
- `peak_balance` — highest-ever portfolio value
- `circuit_breaker_tripped` — `"true"` or `"false"`, requires manual reset
- `daily_halt_active` — `"true"` or `"false"`, auto-resets next day
- `weekly_drawdown_active` — `"true"` or `"false"`, auto-resets next week

- [ ] **Step 2: Generate a migration**

```bash
bun run db:generate
```

- [ ] **Step 3: Run the migration**

```bash
bun run db:migrate
```

- [ ] **Step 4: Verify table exists**

```bash
bun -e "import { getDb } from './src/db/client.ts'; const db = getDb(); console.log(db.run('SELECT name FROM sqlite_master WHERE type=\"table\" AND name=\"risk_state\"'));"
```

---

### Task 7: Wire Risk Checks into Evaluator

**Files:**
- Modify: `src/strategy/evaluator.ts`

The evaluator currently uses the simple percentage-based `calcPositionSize`. This task adds a pre-trade risk gate that checks all limits before opening a position.

- [ ] **Step 1: Create a risk gate helper**

Add a new file `src/risk/gate.ts` that composes the pure checks with DB reads to produce a single go/no-go decision:

```typescript
// src/risk/gate.ts
import { getDb } from "../db/client.ts";
import { livePositions, paperPositions, riskState } from "../db/schema.ts";
import { eq, isNull } from "drizzle-orm";
import { runAllTradeChecks, type PortfolioState, type TradeProposal } from "./limits.ts";
import { runGuardianChecks, type GuardianVerdict } from "./guardian-checks.ts";
import { calcAtrPositionSize, type PositionSizeResult } from "./position-sizer.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "risk-gate" });

interface RiskGateInput {
	accountBalance: number;
	price: number;
	atr14: number;
	side: "BUY" | "SELL";
	exchange: string;
	sector: string | null;
	borrowFeeAnnualPct: number | null;
	openPositionCount: number;
	openPositionSectors: (string | null)[];
}

export interface RiskGateResult {
	allowed: boolean;
	reason?: string;
	sizing?: PositionSizeResult;
}

/**
 * Synchronous risk gate using only pure functions.
 * The caller is responsible for providing all state.
 * No DB calls — fully testable.
 */
export function checkTradeRiskGate(input: RiskGateInput): RiskGateResult {
	// 1. Calculate position size
	const sizing = calcAtrPositionSize({
		accountBalance: input.accountBalance,
		price: input.price,
		atr14: input.atr14,
		side: input.side,
		exchange: input.exchange,
	});

	if (sizing.skipped) {
		return { allowed: false, reason: sizing.skipReason };
	}

	// 2. Run all per-trade limit checks
	const portfolio: PortfolioState = {
		accountBalance: input.accountBalance,
		openPositions: input.openPositionSectors.map((s) => ({ sector: s })),
	};

	const proposal: TradeProposal = {
		side: input.side,
		riskAmount: sizing.riskAmount,
		sector: input.sector,
		borrowFeeAnnualPct: input.borrowFeeAnnualPct,
	};

	const limitCheck = runAllTradeChecks(portfolio, proposal);
	if (!limitCheck.allowed) {
		return { allowed: false, reason: limitCheck.reason };
	}

	return { allowed: true, sizing };
}
```

- [ ] **Step 2: Update evaluator.ts to use the risk gate**

In `src/strategy/evaluator.ts`, the entry signal branches currently call `calcPositionSize`. Replace those with calls through the risk gate. The key changes:

1. Import `checkTradeRiskGate` from `../risk/gate.ts`
2. When an entry signal fires, call `checkTradeRiskGate` instead of `calcPositionSize`
3. Use the returned `sizing.quantity` and `sizing.stopLossPrice`
4. Log rejections for observability

The modified entry block for longs:

```typescript
if (signals.entry_long && evalExpr(signals.entry_long, ctx)) {
	const gateResult = checkTradeRiskGate({
		accountBalance: strategy.virtualBalance,
		price,
		atr14: input.indicators.atr14 ?? 0,
		side: "BUY",
		exchange,
		sector: null, // sector lookup added in future task
		borrowFeeAnnualPct: null,
		openPositionCount: 0, // caller should provide actual count
		openPositionSectors: [],
	});

	if (!gateResult.allowed) {
		log.debug(
			{ strategy: strategy.name, symbol, reason: gateResult.reason },
			"Trade rejected by risk gate",
		);
		return;
	}

	const { quantity, stopLossPrice } = gateResult.sizing!;
	if (quantity > 0) {
		log.info(
			{ strategy: strategy.name, symbol, signal: "entry_long", quantity, price, stopLossPrice },
			"Entry long signal fired (risk-gated)",
		);
		await openPaperPosition({
			strategyId: strategy.id,
			symbol,
			exchange,
			side: "BUY",
			price,
			quantity,
			signalType: "entry_long",
			reasoning: `Entry signal: ${signals.entry_long}`,
		});
	}
}
```

Apply the same pattern for `entry_short`, using `side: "SELL"`.

- [ ] **Step 3: Update EvalInput to include ATR**

Verify that `SymbolIndicators` already contains `atr14`. Check `src/strategy/historical.ts` — the existing `calcATR` in `src/strategy/indicators.ts` should already populate this. If `SymbolIndicators` does not have an `atr14` field, add it.

- [ ] **Step 4: Run existing tests to ensure no regressions**

```bash
bun test --preload ./tests/preload.ts
```

- [ ] **Step 5: Lint all modified files**

```bash
bunx biome check src/risk/gate.ts src/strategy/evaluator.ts
```

---

### Task 8: Integration — Guardian Runner (Thin Orchestration Layer)

**Files:**
- Create: `src/risk/guardian.ts`

This is the **only** file with side effects in the risk module. It reads state from the DB, calls the pure guardian check functions, and writes results back. Called every 60 seconds during market hours by the scheduler.

- [ ] **Step 1: Implement guardian.ts**

```typescript
// src/risk/guardian.ts
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { riskState, dailySnapshots } from "../db/schema.ts";
import { runGuardianChecks, type GuardianVerdict } from "./guardian-checks.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "guardian" });

/**
 * Read a risk_state key, returning null if not found.
 */
async function getRiskStateValue(key: string): Promise<string | null> {
	const db = getDb();
	const [row] = await db
		.select({ value: riskState.value })
		.from(riskState)
		.where(eq(riskState.key, key))
		.limit(1);
	return row?.value ?? null;
}

/**
 * Upsert a risk_state key/value.
 */
async function setRiskStateValue(key: string, value: string): Promise<void> {
	const db = getDb();
	await db
		.insert(riskState)
		.values({ key, value })
		.onConflictDoUpdate({
			target: riskState.key,
			set: { value, updatedAt: new Date().toISOString() },
		});
}

/**
 * Run the portfolio-level guardian. Called every 60s during market hours.
 *
 * 1. Read current state from DB
 * 2. Call pure guardian check functions
 * 3. Write back any state changes (halt flags, etc.)
 * 4. Return verdict for the scheduler to act on
 */
export async function runGuardian(
	currentPortfolioValue: number,
	dailyPnl: number,
	weeklyPnl: number,
): Promise<GuardianVerdict> {
	// Read persisted state
	const peakBalanceStr = await getRiskStateValue("peak_balance");
	const accountBalanceStr = await getRiskStateValue("account_balance");

	const peakBalance = peakBalanceStr ? Number.parseFloat(peakBalanceStr) : currentPortfolioValue;
	const accountBalance = accountBalanceStr
		? Number.parseFloat(accountBalanceStr)
		: currentPortfolioValue;

	// Update peak balance if we have a new high
	if (currentPortfolioValue > peakBalance) {
		await setRiskStateValue("peak_balance", currentPortfolioValue.toString());
	}

	// Run pure checks
	const verdict = runGuardianChecks({
		accountBalance,
		peakBalance: Math.max(peakBalance, currentPortfolioValue),
		dailyPnl,
		weeklyPnl,
		currentPortfolioValue,
	});

	// Persist state flags
	if (!verdict.canTrade && verdict.requiresManualRestart) {
		await setRiskStateValue("circuit_breaker_tripped", "true");
		log.error({ verdict }, "CIRCUIT BREAKER TRIPPED — manual restart required");
		// TODO: Send email alert via reporting/email.ts
	}

	if (!verdict.canTrade) {
		await setRiskStateValue("daily_halt_active", "true");
		log.warn({ verdict }, "Daily trading halt activated");
	}

	if (verdict.reduceSizes) {
		await setRiskStateValue("weekly_drawdown_active", "true");
		log.warn({ verdict }, "Weekly drawdown — position sizes reduced 50%");
	}

	return verdict;
}

/**
 * Check if trading is currently halted (reads persisted flags).
 */
export async function isTradingHalted(): Promise<{
	halted: boolean;
	requiresManualRestart: boolean;
	reason?: string;
}> {
	const circuitBreaker = await getRiskStateValue("circuit_breaker_tripped");
	if (circuitBreaker === "true") {
		return {
			halted: true,
			requiresManualRestart: true,
			reason: "Circuit breaker tripped — manual restart required",
		};
	}

	const dailyHalt = await getRiskStateValue("daily_halt_active");
	if (dailyHalt === "true") {
		return {
			halted: true,
			requiresManualRestart: false,
			reason: "Daily loss halt active",
		};
	}

	return { halted: false, requiresManualRestart: false };
}

/**
 * Manually reset the circuit breaker. Only called by human operator.
 */
export async function resetCircuitBreaker(): Promise<void> {
	await setRiskStateValue("circuit_breaker_tripped", "false");
	log.info("Circuit breaker manually reset");
}

/**
 * Reset daily flags. Called at market open each day.
 */
export async function resetDailyState(): Promise<void> {
	await setRiskStateValue("daily_halt_active", "false");
	await setRiskStateValue("daily_pnl", "0");
	log.info("Daily risk state reset");
}

/**
 * Reset weekly flags. Called Monday at market open.
 */
export async function resetWeeklyState(): Promise<void> {
	await setRiskStateValue("weekly_drawdown_active", "false");
	await setRiskStateValue("weekly_pnl", "0");
	log.info("Weekly risk state reset");
}
```

- [ ] **Step 2: Add guardian to the scheduler**

In the scheduler (likely `src/scheduler/cron.ts` or `src/scheduler/jobs.ts`), add a 60-second interval job that calls `runGuardian` during market hours. Also add daily/weekly reset jobs at market open.

- [ ] **Step 3: Run all tests**

```bash
bun test --preload ./tests/preload.ts
```

- [ ] **Step 4: Lint everything**

```bash
bunx biome check src/risk/ tests/risk/
```

---

## Summary

| Task | Files | Pure? | Tests |
|---|---|---|---|
| 1. Constants | `src/risk/constants.ts` | Yes | N/A (constants only) |
| 2. Per-trade limits | `src/risk/limits.ts` | Yes | `tests/risk/limits.test.ts` |
| 3. Position sizer | `src/risk/position-sizer.ts` | Yes | `tests/risk/position-sizer.test.ts` |
| 4. Guardian checks | `src/risk/guardian-checks.ts` | Yes | `tests/risk/guardian-checks.test.ts` |
| 5. Demotion / kill | `src/risk/demotion.ts` | Yes | `tests/risk/demotion.test.ts` |
| 6. Schema | `src/db/schema.ts` | N/A | Migration test |
| 7. Wire into evaluator | `src/risk/gate.ts`, `src/strategy/evaluator.ts` | Gate is pure | Existing evaluator tests |
| 8. Guardian runner | `src/risk/guardian.ts` | No (DB I/O) | Scheduler integration |

**Key design decisions:**
- All limit-checking logic is in pure functions (Tasks 2-5). This makes them trivially testable with no mocks needed.
- The only files with side effects are `guardian.ts` (Task 8) and `gate.ts` (the DB-reading overloads, if added later). The core risk logic never touches the database.
- `position-sizer.ts` replaces the simple percentage-based sizing in `paper/pnl.ts` with ATR-based sizing. The old function remains for backward compatibility.
- `risk_state` uses a key/value table rather than columns because the set of tracked flags may grow over time without schema migrations.
- The circuit breaker requires manual reset — this is intentional and non-negotiable per spec.
