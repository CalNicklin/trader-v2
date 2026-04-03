# Phase 2: Paper Lab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the paper trading engine — signal expression evaluator, technical indicators, strategy evaluation loop, paper position management, metrics calculation, and graduation gate — so that seed strategies generate paper trades against real market data.

**Architecture:** The strategy evaluator runs every 10 minutes during market hours. For each paper strategy, it evaluates signal expressions against a context built from cached quotes, computed technical indicators, and current position state. When signals fire, paper trades are executed with friction costs. Strategy metrics are recalculated after each evaluation cycle. The graduation gate checks whether strategies meet statistical thresholds for live promotion.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, `bun:sqlite`, `yahoo-finance2` v3 (chart API for historical data), `zod`, custom recursive descent expression parser

**Spec:** `docs/specs/2026-04-03-trader-v2-design.md` (in the v1 repo at `~/Documents/Projects/trader`)

**Depends on:** Phase 1 foundation (complete). All code lives in `~/Documents/Projects/trader-v2`.

---

## File Structure

```
src/
├── strategy/
│   ├── expr-eval.ts          # Safe signal expression parser (recursive descent)
│   ├── indicators.ts         # RSI, ATR, volume ratio pure functions
│   ├── historical.ts         # Fetch OHLCV from Yahoo, compute indicators per symbol
│   ├── context.ts            # Build signal evaluation context
│   ├── evaluator.ts          # Main loop: evaluate signals -> execute paper trades
│   ├── seed.ts               # 3 seed strategy definitions + DB insertion
│   ├── metrics.ts            # Calculate rolling strategy performance metrics
│   └── graduation.ts         # Graduation gate criteria check
├── paper/
│   ├── manager.ts            # Open/close paper positions, execute paper trades
│   └── pnl.ts                # P&L and friction calculations
├── scheduler/
│   ├── jobs.ts               # (modify) Wire up strategy_evaluation + daily_summary
│   ├── strategy-eval-job.ts  # Strategy evaluation job implementation
│   └── daily-summary-job.ts  # Daily summary email implementation
tests/
├── strategy/
│   ├── expr-eval.test.ts
│   ├── indicators.test.ts
│   ├── context.test.ts
│   ├── evaluator.test.ts
│   ├── metrics.test.ts
│   └── graduation.test.ts
├── paper/
│   ├── manager.test.ts
│   └── pnl.test.ts
```

---

### Task 1: Expression Evaluator

**Files:**
- Create: `src/strategy/expr-eval.ts`
- Create: `tests/strategy/expr-eval.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/strategy/expr-eval.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { evalExpr } from "../../src/strategy/expr-eval.ts";

describe("evalExpr", () => {
	const ctx = {
		rsi14: 25,
		volume_ratio: 2.0,
		news_sentiment: 0.8,
		hold_days: 5,
		pnl_pct: -3,
		gap_pct: 0.5,
		change_percent: 1.2,
	};

	test("simple comparisons", () => {
		expect(evalExpr("rsi14 < 30", ctx)).toBe(true);
		expect(evalExpr("rsi14 > 30", ctx)).toBe(false);
		expect(evalExpr("rsi14 >= 25", ctx)).toBe(true);
		expect(evalExpr("rsi14 <= 25", ctx)).toBe(true);
		expect(evalExpr("hold_days == 5", ctx)).toBe(true);
		expect(evalExpr("hold_days != 3", ctx)).toBe(true);
	});

	test("AND expression", () => {
		expect(
			evalExpr("news_sentiment > 0.7 AND rsi14 < 30 AND volume_ratio > 1.5", ctx),
		).toBe(true);
		expect(evalExpr("news_sentiment > 0.9 AND rsi14 < 30", ctx)).toBe(false);
	});

	test("OR expression", () => {
		expect(evalExpr("hold_days >= 3 OR pnl_pct < -2 OR pnl_pct > 5", ctx)).toBe(true);
		expect(evalExpr("rsi14 > 100 OR volume_ratio > 1.0", ctx)).toBe(true);
	});

	test("AND binds tighter than OR", () => {
		// "false AND true OR true" -> "(false AND true) OR true" -> true
		expect(evalExpr("rsi14 > 100 AND volume_ratio > 1.0 OR hold_days >= 3", ctx)).toBe(true);
	});

	test("parentheses override precedence", () => {
		expect(
			evalExpr("hold_days >= 3 AND (rsi14 > 100 OR volume_ratio < 0.5)", ctx),
		).toBe(false);
	});

	test("unknown variable returns false", () => {
		expect(evalExpr("unknown_var > 5", ctx)).toBe(false);
	});

	test("empty expression returns false", () => {
		expect(evalExpr("", ctx)).toBe(false);
	});

	test("negative numbers in context", () => {
		expect(evalExpr("pnl_pct < -2", ctx)).toBe(true);
		expect(evalExpr("pnl_pct > -1", ctx)).toBe(false);
	});

	test("malformed expression returns false", () => {
		expect(evalExpr("rsi14 > > 30", ctx)).toBe(false);
		expect(evalExpr("AND OR", ctx)).toBe(false);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Documents/Projects/trader-v2
bun test --preload ./tests/preload.ts tests/strategy/expr-eval.test.ts
```

Expected: FAIL — cannot resolve `../../src/strategy/expr-eval.ts`

- [ ] **Step 3: Write the implementation**

Create `src/strategy/expr-eval.ts`:

```typescript
// Safe expression evaluator for trading signal rules.
// Supports: >, <, >=, <=, ==, !=, AND, OR, parentheses.
// Variables resolve against a context object. Unknown vars -> null -> false.
// No eval(), no Function(). Recursive descent parser.

export type ExprContext = Record<string, number | null | undefined>;

type Token =
	| { type: "NUM"; value: number }
	| { type: "VAR"; value: string }
	| { type: "OP"; value: string }
	| { type: "LOGIC"; value: "AND" | "OR" }
	| { type: "LPAREN" }
	| { type: "RPAREN" };

const TOKEN_RE = /\s*(>=|<=|==|!=|>|<|\(|\))|([A-Za-z_][A-Za-z0-9_]*)|(-?\d+(?:\.\d+)?)\s*/g;

function tokenize(expr: string): Token[] {
	const tokens: Token[] = [];
	TOKEN_RE.lastIndex = 0;
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = TOKEN_RE.exec(expr)) !== null) {
		if (match.index > lastIndex) {
			const gap = expr.slice(lastIndex, match.index).trim();
			if (gap) throw new Error(`Unexpected: "${gap}"`);
		}
		lastIndex = TOKEN_RE.lastIndex;

		const [, op, word, num] = match;
		if (op === "(") tokens.push({ type: "LPAREN" });
		else if (op === ")") tokens.push({ type: "RPAREN" });
		else if (op) tokens.push({ type: "OP", value: op });
		else if (word === "AND" || word === "OR") tokens.push({ type: "LOGIC", value: word });
		else if (word) tokens.push({ type: "VAR", value: word });
		else if (num !== undefined) tokens.push({ type: "NUM", value: Number.parseFloat(num) });
	}

	const trailing = expr.slice(lastIndex).trim();
	if (trailing) throw new Error(`Unexpected trailing: "${trailing}"`);
	return tokens;
}

class Parser {
	private pos = 0;
	constructor(
		private tokens: Token[],
		private ctx: ExprContext,
	) {}

	eval(): boolean {
		const result = this.orExpr();
		if (this.pos < this.tokens.length) {
			throw new Error(`Unexpected token at position ${this.pos}`);
		}
		return result;
	}

	private orExpr(): boolean {
		let left = this.andExpr();
		while (this.peek()?.type === "LOGIC" && (this.peek() as Token & { value: string }).value === "OR") {
			this.advance();
			const right = this.andExpr();
			left = left || right;
		}
		return left;
	}

	private andExpr(): boolean {
		let left = this.comparison();
		while (this.peek()?.type === "LOGIC" && (this.peek() as Token & { value: string }).value === "AND") {
			this.advance();
			const right = this.comparison();
			left = left && right;
		}
		return left;
	}

	private comparison(): boolean {
		const left = this.value();
		const next = this.peek();
		if (next?.type !== "OP") {
			return left !== null && left !== 0;
		}
		const op = this.advance() as Token & { type: "OP"; value: string };
		const right = this.value();

		if (left === null || right === null) return false;

		switch (op.value) {
			case ">": return left > right;
			case "<": return left < right;
			case ">=": return left >= right;
			case "<=": return left <= right;
			case "==": return left === right;
			case "!=": return left !== right;
			default: throw new Error(`Unknown operator: ${op.value}`);
		}
	}

	private value(): number | null {
		const tok = this.peek();
		if (!tok) throw new Error("Unexpected end of expression");

		if (tok.type === "NUM") {
			this.advance();
			return tok.value;
		}
		if (tok.type === "VAR") {
			this.advance();
			const val = this.ctx[tok.value];
			return val === undefined || val === null ? null : val;
		}
		if (tok.type === "LPAREN") {
			this.advance();
			const result = this.orExpr();
			const closing = this.advance();
			if (closing?.type !== "RPAREN") throw new Error("Expected closing parenthesis");
			return result ? 1 : 0;
		}
		throw new Error(`Unexpected token: ${JSON.stringify(tok)}`);
	}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private advance(): Token {
		return this.tokens[this.pos++]!;
	}
}

/** Evaluate a signal expression against market data. Returns false on any error. */
export function evalExpr(expr: string, ctx: ExprContext): boolean {
	try {
		const tokens = tokenize(expr);
		if (tokens.length === 0) return false;
		return new Parser(tokens, ctx).eval();
	} catch {
		return false;
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/strategy/expr-eval.test.ts
```

Expected: all 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/strategy/expr-eval.ts tests/strategy/expr-eval.test.ts
git commit -m "feat: add safe signal expression evaluator"
```

---

### Task 2: Technical Indicators

**Files:**
- Create: `src/strategy/indicators.ts`
- Create: `tests/strategy/indicators.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/strategy/indicators.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { calcRSI, calcATR, calcVolumeRatio, type Candle } from "../../src/strategy/indicators.ts";

// Helper: generate simple candle data
function makeCandles(closes: number[], volumes?: number[]): Candle[] {
	return closes.map((close, i) => ({
		date: new Date(2026, 0, i + 1),
		open: close - 0.5,
		high: close + 1,
		low: close - 1,
		close,
		volume: volumes?.[i] ?? 1000000,
	}));
}

describe("calcRSI", () => {
	test("returns null with insufficient data", () => {
		const candles = makeCandles([100, 101, 102]);
		expect(calcRSI(candles, 14)).toBeNull();
	});

	test("returns 100 when all gains (no losses)", () => {
		// 16 candles, each +1 from previous — no losses at all
		const closes = Array.from({ length: 16 }, (_, i) => 100 + i);
		const candles = makeCandles(closes);
		expect(calcRSI(candles, 14)).toBe(100);
	});

	test("returns value between 0 and 100 for mixed data", () => {
		// 30 data points with realistic fluctuation
		const closes = [
			100, 102, 101, 103, 104, 102, 105, 103, 106, 104, 107, 105, 108, 106, 109,
			107, 110, 108, 111, 109, 112, 110, 113, 111, 114, 112, 115, 113, 116, 114,
		];
		const candles = makeCandles(closes);
		const rsi = calcRSI(candles, 14);
		expect(rsi).not.toBeNull();
		expect(rsi!).toBeGreaterThan(0);
		expect(rsi!).toBeLessThan(100);
	});

	test("RSI is low when price mostly falls", () => {
		const closes = Array.from({ length: 20 }, (_, i) => 200 - i * 2 + (i % 3 === 0 ? 1 : 0));
		const candles = makeCandles(closes);
		const rsi = calcRSI(candles, 14);
		expect(rsi).not.toBeNull();
		expect(rsi!).toBeLessThan(40);
	});
});

describe("calcATR", () => {
	test("returns null with insufficient data", () => {
		const candles = makeCandles([100, 101, 102]);
		expect(calcATR(candles, 14)).toBeNull();
	});

	test("returns positive value for valid data", () => {
		const closes = Array.from({ length: 20 }, (_, i) => 100 + Math.sin(i) * 5);
		const candles = closes.map((close, i) => ({
			date: new Date(2026, 0, i + 1),
			open: close - 0.3,
			high: close + 2,
			low: close - 2,
			close,
			volume: 1000000,
		}));
		const atr = calcATR(candles, 14);
		expect(atr).not.toBeNull();
		expect(atr!).toBeGreaterThan(0);
	});

	test("ATR is larger when candles have wider range", () => {
		const makeRangedCandles = (range: number): Candle[] =>
			Array.from({ length: 20 }, (_, i) => ({
				date: new Date(2026, 0, i + 1),
				open: 100,
				high: 100 + range,
				low: 100 - range,
				close: 100,
				volume: 1000000,
			}));

		const narrowATR = calcATR(makeRangedCandles(1), 14);
		const wideATR = calcATR(makeRangedCandles(5), 14);
		expect(narrowATR).not.toBeNull();
		expect(wideATR).not.toBeNull();
		expect(wideATR!).toBeGreaterThan(narrowATR!);
	});
});

describe("calcVolumeRatio", () => {
	test("returns null with insufficient data", () => {
		const candles = makeCandles([100, 101], [500, 600]);
		expect(calcVolumeRatio(candles, 20)).toBeNull();
	});

	test("returns ~1.0 when volume is constant", () => {
		const closes = Array.from({ length: 25 }, () => 100);
		const volumes = Array.from({ length: 25 }, () => 1000000);
		const candles = makeCandles(closes, volumes);
		const ratio = calcVolumeRatio(candles, 20);
		expect(ratio).not.toBeNull();
		expect(ratio!).toBeCloseTo(1.0, 2);
	});

	test("returns > 1 when latest volume is above average", () => {
		const closes = Array.from({ length: 25 }, () => 100);
		const volumes = Array.from({ length: 25 }, () => 1000000);
		volumes[24] = 3000000; // spike on last day
		const candles = makeCandles(closes, volumes);
		const ratio = calcVolumeRatio(candles, 20);
		expect(ratio).not.toBeNull();
		expect(ratio!).toBeGreaterThan(2.5);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/strategy/indicators.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/strategy/indicators.ts`:

```typescript
export interface Candle {
	date: Date;
	open: number | null;
	high: number | null;
	low: number | null;
	close: number | null;
	volume: number | null;
}

/**
 * RSI (Relative Strength Index) using Wilder's smoothing.
 * Returns null if fewer than period+1 valid closing prices.
 */
export function calcRSI(candles: Candle[], period = 14): number | null {
	const closes: number[] = [];
	for (const c of candles) {
		if (c.close != null) closes.push(c.close);
	}
	if (closes.length < period + 1) return null;

	const changes: number[] = [];
	for (let i = 1; i < closes.length; i++) {
		changes.push(closes[i]! - closes[i - 1]!);
	}

	let avgGain = 0;
	let avgLoss = 0;
	for (let i = 0; i < period; i++) {
		if (changes[i]! > 0) avgGain += changes[i]!;
		else avgLoss += Math.abs(changes[i]!);
	}
	avgGain /= period;
	avgLoss /= period;

	for (let i = period; i < changes.length; i++) {
		const gain = changes[i]! > 0 ? changes[i]! : 0;
		const loss = changes[i]! < 0 ? Math.abs(changes[i]!) : 0;
		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;
	}

	if (avgLoss === 0) return 100;
	const rs = avgGain / avgLoss;
	return 100 - 100 / (1 + rs);
}

/**
 * ATR (Average True Range) using Wilder's smoothing.
 * Returns null if fewer than period+1 valid candles.
 */
export function calcATR(candles: Candle[], period = 14): number | null {
	const valid = candles.filter(
		(c): c is Candle & { high: number; low: number; close: number } =>
			c.high != null && c.low != null && c.close != null,
	);
	if (valid.length < period + 1) return null;

	const trueRanges: number[] = [];
	for (let i = 1; i < valid.length; i++) {
		const high = valid[i]!.high;
		const low = valid[i]!.low;
		const prevClose = valid[i - 1]!.close;
		trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
	}

	let atr = 0;
	for (let i = 0; i < period; i++) {
		atr += trueRanges[i]!;
	}
	atr /= period;

	for (let i = period; i < trueRanges.length; i++) {
		atr = (atr * (period - 1) + trueRanges[i]!) / period;
	}

	return atr;
}

/**
 * Volume ratio: latest volume / average volume over prior N days.
 * Returns null if insufficient data or zero average.
 */
export function calcVolumeRatio(candles: Candle[], avgPeriod = 20): number | null {
	const volumes: number[] = [];
	for (const c of candles) {
		if (c.volume != null && c.volume > 0) volumes.push(c.volume);
	}
	if (volumes.length < avgPeriod + 1) return null;

	const currentVolume = volumes[volumes.length - 1]!;
	let sum = 0;
	for (let i = volumes.length - 1 - avgPeriod; i < volumes.length - 1; i++) {
		sum += volumes[i]!;
	}
	const avgVolume = sum / avgPeriod;

	if (avgVolume === 0) return null;
	return currentVolume / avgVolume;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/strategy/indicators.test.ts
```

Expected: all 9 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/strategy/indicators.ts tests/strategy/indicators.test.ts
git commit -m "feat: add RSI, ATR, and volume ratio indicator calculations"
```

---

### Task 3: Historical Data + Indicator Computation

**Files:**
- Create: `src/strategy/historical.ts`

No unit test for this module — it wraps the Yahoo Finance API which can't be called in tests. The pure indicator functions (Task 2) cover the calculation logic. This module is a thin fetch-and-compute layer.

- [ ] **Step 1: Create src/strategy/historical.ts**

```typescript
import YahooFinance from "yahoo-finance2";
import { calcATR, calcRSI, calcVolumeRatio, type Candle } from "./indicators.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "historical" });

const yf = new YahooFinance();

export interface SymbolIndicators {
	rsi14: number | null;
	atr14: number | null;
	volume_ratio: number | null;
}

interface CacheEntry {
	indicators: SymbolIndicators;
	timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/** Map exchange to Yahoo Finance suffix */
function yahooSymbol(symbol: string, exchange: string): string {
	if (exchange === "LSE" || exchange === "AIM") return `${symbol}.L`;
	return symbol;
}

/**
 * Fetch historical OHLCV data and compute indicators for a symbol.
 * Results are cached for 30 minutes.
 */
export async function getIndicators(
	symbol: string,
	exchange: string,
): Promise<SymbolIndicators> {
	const key = `${symbol}:${exchange}`;
	const cached = cache.get(key);
	if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
		return cached.indicators;
	}

	try {
		const ninetyDaysAgo = new Date();
		ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

		const result = await yf.chart(yahooSymbol(symbol, exchange), {
			period1: ninetyDaysAgo,
			interval: "1d",
		});

		const candles: Candle[] = result.quotes.map((q) => ({
			date: q.date,
			open: q.open ?? null,
			high: q.high ?? null,
			low: q.low ?? null,
			close: q.close ?? null,
			volume: q.volume ?? null,
		}));

		const indicators: SymbolIndicators = {
			rsi14: calcRSI(candles, 14),
			atr14: calcATR(candles, 14),
			volume_ratio: calcVolumeRatio(candles, 20),
		};

		cache.set(key, { indicators, timestamp: Date.now() });
		return indicators;
	} catch (error) {
		log.warn({ symbol, exchange, error }, "Failed to fetch historical data");
		return { rsi14: null, atr14: null, volume_ratio: null };
	}
}

/** Clear the indicator cache (for testing) */
export function clearIndicatorCache(): void {
	cache.clear();
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/strategy/historical.ts
git commit -m "feat: add historical data fetching and indicator computation"
```

---

### Task 4: P&L and Friction Calculations

**Files:**
- Create: `src/paper/pnl.ts`
- Create: `tests/paper/pnl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/paper/pnl.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
	calcFriction,
	calcPositionSize,
	calcPnl,
} from "../../src/paper/pnl.ts";

describe("calcFriction", () => {
	test("LSE buy has stamp duty", () => {
		const friction = calcFriction(1000, "LSE", "BUY");
		// LSE buy: 0.6% friction
		expect(friction).toBeCloseTo(6.0, 2);
	});

	test("AIM has no stamp duty", () => {
		const friction = calcFriction(1000, "AIM", "BUY");
		// AIM: 0.1% friction
		expect(friction).toBeCloseTo(1.0, 2);
	});

	test("US has FX spread", () => {
		const friction = calcFriction(1000, "NASDAQ", "BUY");
		// NASDAQ: 0.2% friction
		expect(friction).toBeCloseTo(2.0, 2);
	});
});

describe("calcPositionSize", () => {
	test("calculates quantity from balance and position_size_pct", () => {
		const result = calcPositionSize(10000, 10, 150);
		// 10% of 10000 = 1000, 1000 / 150 = 6.66 shares
		expect(result.quantity).toBe(6);
		expect(result.positionValue).toBeCloseTo(900, 0);
	});

	test("returns 0 quantity if position value below minimum", () => {
		const result = calcPositionSize(100, 10, 150);
		// 10% of 100 = 10, below $50 minimum
		expect(result.quantity).toBe(0);
	});
});

describe("calcPnl", () => {
	test("profitable long trade", () => {
		const pnl = calcPnl("BUY", 10, 100, 110, 0.002, 0.002);
		// Gross: (110 - 100) * 10 = 100
		// Entry friction: 10 * 100 * 0.002 = 2
		// Exit friction: 10 * 110 * 0.002 = 2.2
		// Net: 100 - 2 - 2.2 = 95.8
		expect(pnl).toBeCloseTo(95.8, 1);
	});

	test("losing long trade", () => {
		const pnl = calcPnl("BUY", 10, 100, 90, 0.002, 0.002);
		// Gross: (90 - 100) * 10 = -100
		// Friction: 2 + 1.8 = 3.8
		// Net: -100 - 3.8 = -103.8
		expect(pnl).toBeCloseTo(-103.8, 1);
	});

	test("profitable short trade", () => {
		const pnl = calcPnl("SELL", 10, 100, 90, 0.002, 0.002);
		// Gross: (100 - 90) * 10 = 100
		// Entry friction: 10 * 100 * 0.002 = 2
		// Exit friction: 10 * 90 * 0.002 = 1.8
		// Net: 100 - 2 - 1.8 = 96.2
		expect(pnl).toBeCloseTo(96.2, 1);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/paper/pnl.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/paper/pnl.ts`:

```typescript
import { getTradeFriction } from "../utils/fx.ts";

const MIN_POSITION_VALUE = 50;

/**
 * Calculate the friction cost for a trade.
 * Returns the absolute friction amount.
 */
export function calcFriction(
	positionValue: number,
	exchange: string,
	side: "BUY" | "SELL",
): number {
	const frictionPct = getTradeFriction(exchange, side);
	return positionValue * frictionPct;
}

/**
 * Calculate position size from balance, allocation %, and price.
 * Returns 0 quantity if below minimum position value.
 */
export function calcPositionSize(
	virtualBalance: number,
	positionSizePct: number,
	price: number,
): { quantity: number; positionValue: number } {
	const targetValue = virtualBalance * (positionSizePct / 100);
	if (targetValue < MIN_POSITION_VALUE) {
		return { quantity: 0, positionValue: 0 };
	}
	const quantity = Math.floor(targetValue / price);
	return { quantity, positionValue: quantity * price };
}

/**
 * Calculate P&L for a closed trade, including friction on both legs.
 * entryFrictionPct and exitFrictionPct come from getTradeFriction().
 */
export function calcPnl(
	side: "BUY" | "SELL",
	quantity: number,
	entryPrice: number,
	exitPrice: number,
	entryFrictionPct: number,
	exitFrictionPct: number,
): number {
	const grossPnl =
		side === "BUY"
			? (exitPrice - entryPrice) * quantity
			: (entryPrice - exitPrice) * quantity;
	const entryFriction = quantity * entryPrice * entryFrictionPct;
	const exitFriction = quantity * exitPrice * exitFrictionPct;
	return grossPnl - entryFriction - exitFriction;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/paper/pnl.test.ts
```

Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/paper/pnl.ts tests/paper/pnl.test.ts
git commit -m "feat: add P&L and friction calculations for paper trading"
```

---

### Task 5: Paper Position Manager

**Files:**
- Create: `src/paper/manager.ts`
- Create: `tests/paper/manager.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/paper/manager.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("paper manager", () => {
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

	async function insertStrategy(balance = 10000) {
		const { strategies } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_strat",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				status: "paper" as const,
				virtualBalance: balance,
				generation: 1,
			})
			.returning();
		return strat!;
	}

	test("openPaperPosition creates position and trade records", async () => {
		const { openPaperPosition } = await import("../../src/paper/manager.ts");
		const { paperPositions, paperTrades, strategies } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "RSI oversold",
		});

		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.symbol).toBe("AAPL");
		expect(positions[0]!.quantity).toBe(6);
		expect(positions[0]!.entryPrice).toBe(150);

		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(1);
		expect(trades[0]!.side).toBe("BUY");
		expect(trades[0]!.friction).toBeGreaterThan(0);

		// Virtual balance should be reduced
		const [updatedStrat] = await db
			.select()
			.from(strategies)
			.where(eq(strategies.id, strat.id));
		expect(updatedStrat!.virtualBalance).toBeLessThan(10000);
	});

	test("closePaperPosition closes position and records P&L", async () => {
		const { openPaperPosition, closePaperPosition } = await import("../../src/paper/manager.ts");
		const { paperPositions, paperTrades, strategies } = await import("../../src/db/schema.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "RSI oversold",
		});

		const [position] = await db.select().from(paperPositions);

		await closePaperPosition({
			positionId: position!.id,
			strategyId: strat.id,
			exitPrice: 160,
			signalType: "exit",
			reasoning: "Target hit",
		});

		// Position should be closed
		const [closedPos] = await db.select().from(paperPositions);
		expect(closedPos!.closedAt).not.toBeNull();

		// Should have entry + exit trades
		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(2);

		// Exit trade should have P&L
		const exitTrade = trades.find((t) => t.signalType === "exit");
		expect(exitTrade!.pnl).not.toBeNull();
		expect(exitTrade!.pnl!).toBeGreaterThan(0);

		// Virtual balance should reflect profit
		const [updatedStrat] = await db
			.select()
			.from(strategies)
			.where(eq(strategies.id, strat.id));
		expect(updatedStrat!.virtualBalance).toBeGreaterThan(10000 - 6 * 150);
	});

	test("getOpenPositions returns only open positions for a strategy", async () => {
		const { openPaperPosition, getOpenPositions } = await import("../../src/paper/manager.ts");
		const strat = await insertStrategy();

		await openPaperPosition({
			strategyId: strat.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "test",
		});

		const positions = await getOpenPositions(strat.id);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.closedAt).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/paper/manager.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/paper/manager.ts`:

```typescript
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { paperPositions, paperTrades, strategies } from "../db/schema.ts";
import { getTradeFriction } from "../utils/fx.ts";
import { calcPnl } from "./pnl.ts";

export interface OpenPositionInput {
	strategyId: number;
	symbol: string;
	exchange: string;
	side: "BUY" | "SELL";
	price: number;
	quantity: number;
	signalType: string;
	reasoning: string;
}

export interface ClosePositionInput {
	positionId: number;
	strategyId: number;
	exitPrice: number;
	signalType: string;
	reasoning: string;
}

export async function openPaperPosition(input: OpenPositionInput): Promise<void> {
	const db = getDb();
	const frictionPct = getTradeFriction(input.exchange, input.side);
	const positionValue = input.quantity * input.price;
	const friction = positionValue * frictionPct;

	// Create position
	await db.insert(paperPositions).values({
		strategyId: input.strategyId,
		symbol: input.symbol,
		exchange: input.exchange,
		quantity: input.quantity,
		entryPrice: input.price,
		currentPrice: input.price,
	});

	// Record the entry trade
	await db.insert(paperTrades).values({
		strategyId: input.strategyId,
		symbol: input.symbol,
		exchange: input.exchange,
		side: input.side as "BUY" | "SELL",
		quantity: input.quantity,
		price: input.price,
		friction,
		signalType: input.signalType,
		reasoning: input.reasoning,
	});

	// Deduct from virtual balance (position value + friction)
	const [strat] = await db
		.select({ virtualBalance: strategies.virtualBalance })
		.from(strategies)
		.where(eq(strategies.id, input.strategyId));

	if (strat) {
		await db
			.update(strategies)
			.set({ virtualBalance: strat.virtualBalance - positionValue - friction })
			.where(eq(strategies.id, input.strategyId));
	}
}

export async function closePaperPosition(input: ClosePositionInput): Promise<void> {
	const db = getDb();

	// Get the position
	const [position] = await db
		.select()
		.from(paperPositions)
		.where(eq(paperPositions.id, input.positionId));

	if (!position) throw new Error(`Position ${input.positionId} not found`);

	// Determine original side from entry price vs quantity
	// If they opened a BUY, they close with a SELL, and vice versa
	const [entryTrade] = await db
		.select()
		.from(paperTrades)
		.where(
			and(
				eq(paperTrades.strategyId, input.strategyId),
				eq(paperTrades.symbol, position.symbol),
			),
		)
		.limit(1);

	const entrySide = (entryTrade?.side ?? "BUY") as "BUY" | "SELL";
	const exitSide = entrySide === "BUY" ? "SELL" : "BUY";
	const entryFrictionPct = getTradeFriction(position.exchange, entrySide);
	const exitFrictionPct = getTradeFriction(position.exchange, exitSide);

	const pnl = calcPnl(
		entrySide,
		position.quantity,
		position.entryPrice,
		input.exitPrice,
		entryFrictionPct,
		exitFrictionPct,
	);

	const exitFriction = position.quantity * input.exitPrice * exitFrictionPct;

	// Close the position
	await db
		.update(paperPositions)
		.set({ closedAt: new Date().toISOString(), currentPrice: input.exitPrice })
		.where(eq(paperPositions.id, input.positionId));

	// Record exit trade with P&L
	await db.insert(paperTrades).values({
		strategyId: input.strategyId,
		symbol: position.symbol,
		exchange: position.exchange,
		side: exitSide as "BUY" | "SELL",
		quantity: position.quantity,
		price: input.exitPrice,
		friction: exitFriction,
		pnl,
		signalType: input.signalType,
		reasoning: input.reasoning,
	});

	// Return proceeds to virtual balance
	const proceeds = position.quantity * input.exitPrice - exitFriction;
	const [strat] = await db
		.select({ virtualBalance: strategies.virtualBalance })
		.from(strategies)
		.where(eq(strategies.id, input.strategyId));

	if (strat) {
		await db
			.update(strategies)
			.set({ virtualBalance: strat.virtualBalance + proceeds })
			.where(eq(strategies.id, input.strategyId));
	}
}

/** Get all open positions for a strategy */
export async function getOpenPositions(strategyId: number) {
	const db = getDb();
	return db
		.select()
		.from(paperPositions)
		.where(
			and(eq(paperPositions.strategyId, strategyId), isNull(paperPositions.closedAt)),
		);
}

/** Get open position for a specific symbol in a strategy */
export async function getOpenPositionForSymbol(
	strategyId: number,
	symbol: string,
	exchange: string,
) {
	const db = getDb();
	const [position] = await db
		.select()
		.from(paperPositions)
		.where(
			and(
				eq(paperPositions.strategyId, strategyId),
				eq(paperPositions.symbol, symbol),
				eq(paperPositions.exchange, exchange),
				isNull(paperPositions.closedAt),
			),
		)
		.limit(1);
	return position ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/paper/manager.test.ts
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/paper/manager.ts tests/paper/manager.test.ts
git commit -m "feat: add paper position manager (open/close/P&L)"
```

---

### Task 6: Signal Context Builder

**Files:**
- Create: `src/strategy/context.ts`
- Create: `tests/strategy/context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/strategy/context.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { buildSignalContext } from "../../src/strategy/context.ts";

describe("buildSignalContext", () => {
	test("builds context from quote and indicators", () => {
		const ctx = buildSignalContext({
			quote: {
				last: 150,
				bid: 149.5,
				ask: 150.5,
				volume: 5000000,
				avgVolume: 3000000,
				changePercent: 1.5,
				newsSentiment: 0.8,
			},
			indicators: { rsi14: 28, atr14: 3.5, volume_ratio: 1.67 },
			position: null,
		});

		expect(ctx.last).toBe(150);
		expect(ctx.rsi14).toBe(28);
		expect(ctx.atr14).toBe(3.5);
		expect(ctx.volume_ratio).toBe(1.67);
		expect(ctx.news_sentiment).toBe(0.8);
		expect(ctx.change_percent).toBe(1.5);
		expect(ctx.hold_days).toBeNull();
		expect(ctx.pnl_pct).toBeNull();
	});

	test("includes position data when position exists", () => {
		const twoDaysAgo = new Date();
		twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

		const ctx = buildSignalContext({
			quote: {
				last: 160,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
			},
			indicators: { rsi14: 55, atr14: 4.0, volume_ratio: null },
			position: {
				entryPrice: 150,
				openedAt: twoDaysAgo.toISOString(),
				quantity: 10,
			},
		});

		expect(ctx.hold_days).toBe(2);
		// pnl_pct: (160 - 150) / 150 * 100 = 6.67%
		expect(ctx.pnl_pct).toBeCloseTo(6.67, 1);
	});

	test("handles null indicators gracefully", () => {
		const ctx = buildSignalContext({
			quote: {
				last: 100,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
			},
			indicators: { rsi14: null, atr14: null, volume_ratio: null },
			position: null,
		});

		expect(ctx.rsi14).toBeNull();
		expect(ctx.atr14).toBeNull();
		expect(ctx.volume_ratio).toBeNull();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/strategy/context.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/strategy/context.ts`:

```typescript
import type { ExprContext } from "./expr-eval.ts";
import type { SymbolIndicators } from "./historical.ts";

export interface QuoteFields {
	last: number | null;
	bid: number | null;
	ask: number | null;
	volume: number | null;
	avgVolume: number | null;
	changePercent: number | null;
	newsSentiment: number | null;
}

export interface PositionFields {
	entryPrice: number;
	openedAt: string;
	quantity: number;
}

export interface ContextInput {
	quote: QuoteFields;
	indicators: SymbolIndicators;
	position: PositionFields | null;
}

/**
 * Build a signal evaluation context from quote data, indicators, and position state.
 * All values are nullable — unknown variables will cause signals to not fire.
 */
export function buildSignalContext(input: ContextInput): ExprContext {
	const { quote, indicators, position } = input;

	let holdDays: number | null = null;
	let pnlPct: number | null = null;

	if (position) {
		const openedAt = new Date(position.openedAt);
		const now = new Date();
		holdDays = Math.floor((now.getTime() - openedAt.getTime()) / (1000 * 60 * 60 * 24));

		if (quote.last != null && position.entryPrice > 0) {
			pnlPct = ((quote.last - position.entryPrice) / position.entryPrice) * 100;
		}
	}

	return {
		// Quote fields
		last: quote.last,
		bid: quote.bid,
		ask: quote.ask,
		volume: quote.volume,
		avg_volume: quote.avgVolume,
		change_percent: quote.changePercent,
		news_sentiment: quote.newsSentiment,

		// Computed indicators
		rsi14: indicators.rsi14,
		atr14: indicators.atr14,
		volume_ratio: indicators.volume_ratio,

		// Position state
		hold_days: holdDays,
		pnl_pct: pnlPct,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/strategy/context.test.ts
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/strategy/context.ts tests/strategy/context.test.ts
git commit -m "feat: add signal context builder (quotes + indicators + position)"
```

---

### Task 7: Strategy Evaluator (Core Loop)

**Files:**
- Create: `src/strategy/evaluator.ts`
- Create: `tests/strategy/evaluator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/strategy/evaluator.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("strategy evaluator", () => {
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

	test("evaluateStrategy opens position when entry signal fires", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");

		// Insert strategy with very permissive entry signal
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_long",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					exit: "pnl_pct > 100",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: {
				last: 150,
				bid: 149.5,
				ask: 150.5,
				volume: 5000000,
				avgVolume: 3000000,
				changePercent: 1.0,
				newsSentiment: null,
			},
			indicators: { rsi14: 45, atr14: 3.0, volume_ratio: 1.5 },
		});

		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(1);
		expect(positions[0]!.symbol).toBe("AAPL");

		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(1);
		expect(trades[0]!.side).toBe("BUY");
	});

	test("evaluateStrategy closes position when exit signal fires", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions, paperTrades } = await import("../../src/db/schema.ts");
		const { openPaperPosition } = await import("../../src/paper/manager.ts");

		// Insert strategy with exit signal that fires on any P&L
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_exit",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "rsi14 < 20",
					exit: "hold_days >= 0",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Open a position first
		await openPaperPosition({
			strategyId: strat!.id,
			symbol: "AAPL",
			exchange: "NASDAQ",
			side: "BUY",
			price: 150,
			quantity: 6,
			signalType: "entry_long",
			reasoning: "test",
		});

		await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: {
				last: 160,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
			},
			indicators: { rsi14: 55, atr14: 3.0, volume_ratio: 1.0 },
		});

		// Position should be closed
		const positions = await db.select().from(paperPositions);
		expect(positions[0]!.closedAt).not.toBeNull();

		// Should have entry + exit trades
		const trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(2);
	});

	test("evaluateStrategy does nothing when no signal fires", async () => {
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { strategies, paperPositions } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test_no_signal",
				description: "test",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "rsi14 < 10",
					exit: "pnl_pct > 100",
				}),
				universe: JSON.stringify(["AAPL"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await evaluateStrategyForSymbol(strat!, "AAPL", "NASDAQ", {
			quote: {
				last: 150,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
			},
			indicators: { rsi14: 50, atr14: 3.0, volume_ratio: 1.0 },
		});

		const positions = await db.select().from(paperPositions);
		expect(positions).toHaveLength(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/strategy/evaluator.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/strategy/evaluator.ts`:

```typescript
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { closePaperPosition, getOpenPositionForSymbol, openPaperPosition } from "../paper/manager.ts";
import { calcPositionSize } from "../paper/pnl.ts";
import { createChildLogger } from "../utils/logger.ts";
import { buildSignalContext, type QuoteFields } from "./context.ts";
import { evalExpr } from "./expr-eval.ts";
import type { SymbolIndicators } from "./historical.ts";

const log = createChildLogger({ module: "evaluator" });

interface StrategyRow {
	id: number;
	name: string;
	parameters: string;
	signals: string | null;
	universe: string | null;
	status: string;
	virtualBalance: number;
}

interface SignalDef {
	entry_long?: string;
	entry_short?: string;
	exit?: string;
}

export interface EvalInput {
	quote: QuoteFields;
	indicators: SymbolIndicators;
}

/**
 * Evaluate a single strategy for a single symbol.
 * If exit signal fires on an open position -> close it.
 * If entry signal fires and no open position -> open one.
 */
export async function evaluateStrategyForSymbol(
	strategy: StrategyRow,
	symbol: string,
	exchange: string,
	input: EvalInput,
): Promise<void> {
	if (!strategy.signals) return;

	const signals: SignalDef = JSON.parse(strategy.signals);
	const params = JSON.parse(strategy.parameters);
	const positionSizePct = params.position_size_pct ?? 10;

	// Check for existing open position
	const openPosition = await getOpenPositionForSymbol(strategy.id, symbol, exchange);

	if (openPosition) {
		// Evaluate exit signal
		if (signals.exit) {
			const ctx = buildSignalContext({
				quote: input.quote,
				indicators: input.indicators,
				position: {
					entryPrice: openPosition.entryPrice,
					openedAt: openPosition.openedAt,
					quantity: openPosition.quantity,
				},
			});

			if (evalExpr(signals.exit, ctx)) {
				log.info(
					{ strategy: strategy.name, symbol, signal: "exit" },
					"Exit signal fired",
				);

				if (input.quote.last != null) {
					await closePaperPosition({
						positionId: openPosition.id,
						strategyId: strategy.id,
						exitPrice: input.quote.last,
						signalType: "exit",
						reasoning: `Exit signal: ${signals.exit}`,
					});
				}
			}
		}
	} else {
		// Evaluate entry signals (long first, then short)
		const ctx = buildSignalContext({
			quote: input.quote,
			indicators: input.indicators,
			position: null,
		});

		if (input.quote.last == null || input.quote.last <= 0) return;
		const price = input.quote.last;

		if (signals.entry_long && evalExpr(signals.entry_long, ctx)) {
			const { quantity } = calcPositionSize(strategy.virtualBalance, positionSizePct, price);
			if (quantity > 0) {
				log.info(
					{ strategy: strategy.name, symbol, signal: "entry_long", quantity, price },
					"Entry long signal fired",
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
		} else if (signals.entry_short && evalExpr(signals.entry_short, ctx)) {
			const { quantity } = calcPositionSize(strategy.virtualBalance, positionSizePct, price);
			if (quantity > 0) {
				log.info(
					{ strategy: strategy.name, symbol, signal: "entry_short", quantity, price },
					"Entry short signal fired",
				);
				await openPaperPosition({
					strategyId: strategy.id,
					symbol,
					exchange,
					side: "SELL",
					price,
					quantity,
					signalType: "entry_short",
					reasoning: `Entry signal: ${signals.entry_short}`,
				});
			}
		}
	}
}

/**
 * Evaluate all paper strategies against current market data.
 * Called by the scheduler's strategy_evaluation job.
 */
export async function evaluateAllStrategies(
	getQuoteAndIndicators: (
		symbol: string,
		exchange: string,
	) => Promise<{ quote: QuoteFields; indicators: SymbolIndicators } | null>,
): Promise<void> {
	const db = getDb();

	const activeStrategies = await db
		.select()
		.from(strategies)
		.where(eq(strategies.status, "paper"));

	log.info({ count: activeStrategies.length }, "Evaluating paper strategies");

	for (const strategy of activeStrategies) {
		if (!strategy.universe) continue;
		const universe: string[] = JSON.parse(strategy.universe);

		for (const symbolSpec of universe) {
			// Universe entries can be "SYMBOL" (default NASDAQ) or "SYMBOL:EXCHANGE"
			const [symbol, exchange] = symbolSpec.includes(":")
				? symbolSpec.split(":")
				: [symbolSpec, "NASDAQ"];

			const data = await getQuoteAndIndicators(symbol!, exchange!);
			if (!data) continue;

			try {
				await evaluateStrategyForSymbol(strategy, symbol!, exchange!, data);
			} catch (error) {
				log.error({ strategy: strategy.name, symbol, error }, "Error evaluating strategy");
			}
		}
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/strategy/evaluator.test.ts
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/strategy/evaluator.ts tests/strategy/evaluator.test.ts
git commit -m "feat: add strategy evaluator (signal evaluation + paper trade execution)"
```

---

### Task 8: Seed Strategies

**Files:**
- Create: `src/strategy/seed.ts`

- [ ] **Step 1: Create src/strategy/seed.ts**

```typescript
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "seed" });

const SEED_STRATEGIES = [
	{
		name: "news_sentiment_mr_v1",
		description:
			"Buy on positive sentiment divergence with oversold RSI, short the inverse. Targets LLM's text comprehension edge for detecting nuance beyond keyword sentiment.",
		parameters: JSON.stringify({
			sentiment_threshold: 0.7,
			rsi_oversold: 30,
			rsi_overbought: 70,
			hold_days: 3,
			position_size_pct: 10,
		}),
		signals: JSON.stringify({
			entry_long: "news_sentiment > 0.7 AND rsi14 < 30 AND volume_ratio > 1.5",
			entry_short: "news_sentiment < -0.7 AND rsi14 > 70 AND volume_ratio > 1.5",
			exit: "hold_days >= 3 OR pnl_pct < -2 OR pnl_pct > 5",
		}),
		universe: JSON.stringify([
			"AAPL",
			"MSFT",
			"GOOGL",
			"AMZN",
			"NVDA",
			"TSLA",
			"META",
			"JPM",
			"V",
			"JNJ",
			"SHEL:LSE",
			"BP.:LSE",
			"HSBA:LSE",
			"VOD:LSE",
			"RIO:LSE",
			"GAW:AIM",
			"FDEV:AIM",
			"TET:AIM",
			"JET2:AIM",
			"BOWL:AIM",
		]),
		status: "paper" as const,
		virtualBalance: 10000,
		generation: 1,
		createdBy: "seed",
	},
	{
		name: "gap_fade_v1",
		description:
			"Fade opening gaps > 2%, but only when no fundamental catalyst detected by LLM. Edge: filters out gaps caused by real catalysts that shouldn't be faded.",
		parameters: JSON.stringify({
			gap_threshold_pct: 2,
			exit_target_pct: 1,
			position_size_pct: 10,
		}),
		signals: JSON.stringify({
			entry_long: "change_percent < -2 AND news_sentiment > -0.3",
			entry_short: "change_percent > 2 AND news_sentiment < 0.3",
			exit: "hold_days >= 1 OR pnl_pct < -3 OR pnl_pct > 1",
		}),
		universe: JSON.stringify([
			"AAPL",
			"MSFT",
			"GOOGL",
			"AMZN",
			"NVDA",
			"TSLA",
			"META",
			"AMD",
			"NFLX",
			"CRM",
			"SHEL:LSE",
			"BP.:LSE",
			"HSBA:LSE",
			"AZN:LSE",
			"ULVR:LSE",
			"GAW:AIM",
			"FDEV:AIM",
			"TET:AIM",
			"JET2:AIM",
			"FEVR:AIM",
		]),
		status: "paper" as const,
		virtualBalance: 10000,
		generation: 1,
		createdBy: "seed",
	},
	{
		name: "earnings_drift_v1",
		description:
			"Post-earnings drift: long on positive surprise with confident tone, short on negative. Edge: LLM assesses management tone, not just the EPS numbers.",
		parameters: JSON.stringify({
			surprise_threshold: 0.5,
			tone_score_min: 0.6,
			hold_days: 5,
			position_size_pct: 8,
		}),
		signals: JSON.stringify({
			entry_long: "news_sentiment > 0.5 AND volume_ratio > 2.0",
			entry_short: "news_sentiment < -0.5 AND volume_ratio > 2.0",
			exit: "hold_days >= 5 OR pnl_pct < -3 OR pnl_pct > 8",
		}),
		universe: JSON.stringify([
			"AAPL",
			"MSFT",
			"GOOGL",
			"AMZN",
			"NVDA",
			"TSLA",
			"META",
			"AMD",
			"NFLX",
			"CRM",
			"PYPL",
			"SHEL:LSE",
			"BP.:LSE",
			"HSBA:LSE",
			"AZN:LSE",
			"GAW:AIM",
			"FDEV:AIM",
			"TET:AIM",
			"JET2:AIM",
			"BOWL:AIM",
		]),
		status: "paper" as const,
		virtualBalance: 10000,
		generation: 1,
		createdBy: "seed",
	},
];

/**
 * Insert seed strategies if none exist.
 * Idempotent — checks for existing strategies first.
 */
export async function ensureSeedStrategies(): Promise<void> {
	const db = getDb();
	const existing = await db.select({ id: strategies.id }).from(strategies);

	if (existing.length > 0) {
		log.info({ count: existing.length }, "Strategies already exist, skipping seed");
		return;
	}

	for (const seed of SEED_STRATEGIES) {
		await db.insert(strategies).values(seed);
	}

	log.info({ count: SEED_STRATEGIES.length }, "Seed strategies inserted");
}
```

- [ ] **Step 2: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/strategy/seed.ts
git commit -m "feat: add 3 seed strategies (sentiment MR, gap fade, earnings drift)"
```

---

### Task 9: Strategy Metrics Calculator

**Files:**
- Create: `src/strategy/metrics.ts`
- Create: `tests/strategy/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/strategy/metrics.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("strategy metrics", () => {
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

	async function insertStrategyAndTrades(pnls: number[]) {
		const { strategies, paperTrades } = await import("../../src/db/schema.ts");
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "test",
				description: "test",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		for (let i = 0; i < pnls.length; i++) {
			// Insert exit trades with P&L values (metrics only look at trades with pnl)
			const weekOffset = Math.floor(i / 5); // spread trades across weeks
			const tradeDate = new Date();
			tradeDate.setDate(tradeDate.getDate() - (pnls.length - i) - weekOffset * 2);

			await db.insert(paperTrades).values({
				strategyId: strat!.id,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "SELL" as const,
				quantity: 10,
				price: 150,
				friction: 0.3,
				pnl: pnls[i]!,
				signalType: "exit",
				reasoning: "test",
				createdAt: tradeDate.toISOString(),
			});
		}
		return strat!;
	}

	test("calculates metrics for strategy with mixed wins/losses", async () => {
		const { recalculateMetrics } = await import("../../src/strategy/metrics.ts");
		const { strategyMetrics } = await import("../../src/db/schema.ts");

		// 10 trades: 6 wins, 4 losses
		const pnls = [50, -20, 30, -15, 45, -25, 60, 40, -10, 35];
		const strat = await insertStrategyAndTrades(pnls);

		await recalculateMetrics(strat.id);

		const [metrics] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strat.id));

		expect(metrics).not.toBeUndefined();
		expect(metrics!.sampleSize).toBe(10);
		expect(metrics!.winRate).toBeCloseTo(0.6, 2); // 6/10
		expect(metrics!.expectancy).toBeCloseTo(19, 0); // avg P&L = 190/10
		expect(metrics!.profitFactor).toBeGreaterThan(1); // gross profit / gross loss
	});

	test("calculates zero metrics with no trades", async () => {
		const { recalculateMetrics } = await import("../../src/strategy/metrics.ts");
		const { strategyMetrics, strategies } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "empty",
				description: "test",
				parameters: "{}",
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await recalculateMetrics(strat!.id);

		const [metrics] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strat!.id));

		expect(metrics).not.toBeUndefined();
		expect(metrics!.sampleSize).toBe(0);
		expect(metrics!.winRate).toBeNull();
	});

	test("updates existing metrics on recalculation", async () => {
		const { recalculateMetrics } = await import("../../src/strategy/metrics.ts");
		const { strategyMetrics } = await import("../../src/db/schema.ts");

		const strat = await insertStrategyAndTrades([50, -20, 30]);
		await recalculateMetrics(strat.id);
		await recalculateMetrics(strat.id); // second call updates

		const rows = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strat.id));

		expect(rows).toHaveLength(1); // should be upserted, not duplicated
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/strategy/metrics.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/strategy/metrics.ts`:

```typescript
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { paperTrades, strategyMetrics } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "metrics" });

/**
 * Recalculate rolling performance metrics for a strategy from its trade history.
 * Upserts into strategy_metrics table.
 */
export async function recalculateMetrics(strategyId: number): Promise<void> {
	const db = getDb();

	// Get all closed trades (trades with pnl set = exit trades)
	const trades = await db
		.select()
		.from(paperTrades)
		.where(and(eq(paperTrades.strategyId, strategyId), isNotNull(paperTrades.pnl)));

	const sampleSize = trades.length;

	if (sampleSize === 0) {
		await upsertMetrics(strategyId, {
			sampleSize: 0,
			winRate: null,
			expectancy: null,
			profitFactor: null,
			sharpeRatio: null,
			sortinoRatio: null,
			maxDrawdownPct: null,
			calmarRatio: null,
			consistencyScore: null,
		});
		return;
	}

	const pnls = trades.map((t) => t.pnl!);
	const wins = pnls.filter((p) => p > 0);
	const losses = pnls.filter((p) => p < 0);

	const winRate = wins.length / sampleSize;
	const totalPnl = pnls.reduce((sum, p) => sum + p, 0);
	const expectancy = totalPnl / sampleSize;

	const grossProfit = wins.reduce((sum, p) => sum + p, 0);
	const grossLoss = Math.abs(losses.reduce((sum, p) => sum + p, 0));
	const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

	// Sharpe ratio (annualized, assuming ~252 trading days)
	const mean = expectancy;
	const variance = pnls.reduce((sum, p) => sum + (p - mean) ** 2, 0) / sampleSize;
	const stdDev = Math.sqrt(variance);
	const sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : null;

	// Sortino ratio (only penalizes downside deviation)
	const downsideReturns = pnls.filter((p) => p < 0);
	const downsideVariance =
		downsideReturns.length > 0
			? downsideReturns.reduce((sum, p) => sum + p ** 2, 0) / sampleSize
			: 0;
	const downsideDev = Math.sqrt(downsideVariance);
	const sortinoRatio = downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(252) : null;

	// Max drawdown (peak-to-trough in cumulative P&L)
	let peak = 0;
	let cumPnl = 0;
	let maxDrawdown = 0;
	for (const pnl of pnls) {
		cumPnl += pnl;
		if (cumPnl > peak) peak = cumPnl;
		const drawdown = peak - cumPnl;
		if (drawdown > maxDrawdown) maxDrawdown = drawdown;
	}
	// Express as % of starting virtual balance (10000)
	const maxDrawdownPct = (maxDrawdown / 10000) * 100;

	// Calmar ratio: annualized return / max drawdown
	const annualizedReturn = totalPnl * (252 / Math.max(sampleSize, 1));
	const calmarRatio =
		maxDrawdownPct > 0 ? (annualizedReturn / 10000 / (maxDrawdownPct / 100)) : null;

	// Consistency: profitable in how many of the last 4 weeks?
	const consistencyScore = calcConsistency(trades);

	await upsertMetrics(strategyId, {
		sampleSize,
		winRate,
		expectancy,
		profitFactor,
		sharpeRatio,
		sortinoRatio,
		maxDrawdownPct,
		calmarRatio,
		consistencyScore,
	});

	log.info(
		{ strategyId, sampleSize, winRate: winRate.toFixed(2), profitFactor: profitFactor.toFixed(2) },
		"Metrics recalculated",
	);
}

interface MetricsValues {
	sampleSize: number;
	winRate: number | null;
	expectancy: number | null;
	profitFactor: number | null;
	sharpeRatio: number | null;
	sortinoRatio: number | null;
	maxDrawdownPct: number | null;
	calmarRatio: number | null;
	consistencyScore: number | null;
}

async function upsertMetrics(strategyId: number, values: MetricsValues): Promise<void> {
	const db = getDb();
	const existing = await db
		.select()
		.from(strategyMetrics)
		.where(eq(strategyMetrics.strategyId, strategyId))
		.limit(1);

	if (existing.length > 0) {
		await db
			.update(strategyMetrics)
			.set({ ...values, updatedAt: new Date().toISOString() })
			.where(eq(strategyMetrics.strategyId, strategyId));
	} else {
		await db.insert(strategyMetrics).values({ strategyId, ...values });
	}
}

function calcConsistency(
	trades: Array<{ pnl: number | null; createdAt: string }>,
): number {
	const now = new Date();
	let profitableWeeks = 0;

	for (let week = 0; week < 4; week++) {
		const weekStart = new Date(now);
		weekStart.setDate(weekStart.getDate() - (week + 1) * 7);
		const weekEnd = new Date(now);
		weekEnd.setDate(weekEnd.getDate() - week * 7);

		const weekTrades = trades.filter((t) => {
			const d = new Date(t.createdAt);
			return d >= weekStart && d < weekEnd;
		});

		if (weekTrades.length === 0) continue;
		const weekPnl = weekTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
		if (weekPnl > 0) profitableWeeks++;
	}

	return profitableWeeks;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/strategy/metrics.test.ts
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/strategy/metrics.ts tests/strategy/metrics.test.ts
git commit -m "feat: add strategy metrics calculator (Sharpe, profit factor, drawdown)"
```

---

### Task 10: Graduation Gate

**Files:**
- Create: `src/strategy/graduation.ts`
- Create: `tests/strategy/graduation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/strategy/graduation.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("graduation gate", () => {
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

	test("strategy passes graduation with strong metrics", async () => {
		const { checkGraduation } = await import("../../src/strategy/graduation.ts");
		const { strategies, strategyMetrics, paperTrades } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "strong",
				description: "test",
				parameters: JSON.stringify({ a: 1, b: 2 }),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: 35,
			winRate: 0.6,
			expectancy: 25,
			profitFactor: 1.8,
			sharpeRatio: 1.2,
			sortinoRatio: 1.5,
			maxDrawdownPct: 8,
			calmarRatio: 1.5,
			consistencyScore: 3,
		});

		// Insert 35 trades for walk-forward validation (most are profitable)
		for (let i = 0; i < 35; i++) {
			const tradeDate = new Date();
			tradeDate.setDate(tradeDate.getDate() - (35 - i));
			await db.insert(paperTrades).values({
				strategyId: strat!.id,
				symbol: "AAPL",
				exchange: "NASDAQ",
				side: "SELL" as const,
				quantity: 10,
				price: 150,
				friction: 0.3,
				pnl: i % 3 === 0 ? -10 : 30, // mostly winners
				signalType: "exit",
				reasoning: "test",
				createdAt: tradeDate.toISOString(),
			});
		}

		const result = await checkGraduation(strat!.id);
		expect(result.passes).toBe(true);
		expect(result.failures).toHaveLength(0);
	});

	test("strategy fails graduation with insufficient sample", async () => {
		const { checkGraduation } = await import("../../src/strategy/graduation.ts");
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "small_sample",
				description: "test",
				parameters: JSON.stringify({ a: 1, b: 2 }),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: 15,
			winRate: 0.8,
			expectancy: 50,
			profitFactor: 3.0,
			sharpeRatio: 2.0,
			sortinoRatio: 2.5,
			maxDrawdownPct: 5,
			calmarRatio: 2.0,
			consistencyScore: 4,
		});

		const result = await checkGraduation(strat!.id);
		expect(result.passes).toBe(false);
		expect(result.failures.some((f) => f.includes("sample"))).toBe(true);
	});

	test("strategy fails multiple criteria", async () => {
		const { checkGraduation } = await import("../../src/strategy/graduation.ts");
		const { strategies, strategyMetrics } = await import("../../src/db/schema.ts");

		const [strat] = await db
			.insert(strategies)
			.values({
				name: "weak",
				description: "test",
				parameters: JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		await db.insert(strategyMetrics).values({
			strategyId: strat!.id,
			sampleSize: 35,
			winRate: 0.3,
			expectancy: -5,
			profitFactor: 0.8,
			sharpeRatio: 0.2,
			sortinoRatio: 0.3,
			maxDrawdownPct: 20,
			calmarRatio: 0.5,
			consistencyScore: 1,
		});

		const result = await checkGraduation(strat!.id);
		expect(result.passes).toBe(false);
		expect(result.failures.length).toBeGreaterThan(3);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test --preload ./tests/preload.ts tests/strategy/graduation.test.ts
```

Expected: FAIL — cannot resolve module

- [ ] **Step 3: Write the implementation**

Create `src/strategy/graduation.ts`:

```typescript
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { graduationEvents, paperTrades, strategies, strategyMetrics } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "graduation" });

// Graduation thresholds from spec Section 4
const CRITERIA = {
	minSampleSize: 30,
	minExpectancy: 0,
	minProfitFactor: 1.3,
	minSharpe: 0.5,
	maxDrawdownPct: 15,
	minConsistency: 3, // profitable in >= 3 of last 4 weeks
	maxParameters: 5,
	walkForwardSplit: 0.8, // 80/20 train/test split
};

export interface GraduationResult {
	passes: boolean;
	failures: string[];
}

/**
 * Check whether a strategy meets all graduation criteria.
 * Returns pass/fail with a list of failed criteria.
 */
export async function checkGraduation(strategyId: number): Promise<GraduationResult> {
	const db = getDb();
	const failures: string[] = [];

	const [metrics] = await db
		.select()
		.from(strategyMetrics)
		.where(eq(strategyMetrics.strategyId, strategyId))
		.limit(1);

	if (!metrics) {
		return { passes: false, failures: ["No metrics found"] };
	}

	// Sample size
	if (metrics.sampleSize < CRITERIA.minSampleSize) {
		failures.push(
			`Insufficient sample size: ${metrics.sampleSize} < ${CRITERIA.minSampleSize}`,
		);
	}

	// Expectancy
	if (metrics.expectancy == null || metrics.expectancy <= CRITERIA.minExpectancy) {
		failures.push(`Expectancy not positive: ${metrics.expectancy ?? "null"}`);
	}

	// Profit factor
	if (metrics.profitFactor == null || metrics.profitFactor < CRITERIA.minProfitFactor) {
		failures.push(
			`Profit factor too low: ${metrics.profitFactor?.toFixed(2) ?? "null"} < ${CRITERIA.minProfitFactor}`,
		);
	}

	// Sharpe ratio
	if (metrics.sharpeRatio == null || metrics.sharpeRatio < CRITERIA.minSharpe) {
		failures.push(
			`Sharpe ratio too low: ${metrics.sharpeRatio?.toFixed(2) ?? "null"} < ${CRITERIA.minSharpe}`,
		);
	}

	// Max drawdown
	if (metrics.maxDrawdownPct != null && metrics.maxDrawdownPct > CRITERIA.maxDrawdownPct) {
		failures.push(
			`Max drawdown too high: ${metrics.maxDrawdownPct.toFixed(1)}% > ${CRITERIA.maxDrawdownPct}%`,
		);
	}

	// Consistency
	if (metrics.consistencyScore == null || metrics.consistencyScore < CRITERIA.minConsistency) {
		failures.push(
			`Consistency too low: ${metrics.consistencyScore ?? 0} < ${CRITERIA.minConsistency} profitable weeks`,
		);
	}

	// Parameter count (check from strategy definition)
	const [strat] = await db
		.select()
		.from(strategies)
		.where(eq(strategies.id, strategyId))
		.limit(1);

	if (strat) {
		const params = JSON.parse(strat.parameters);
		const paramCount = Object.keys(params).length;
		if (paramCount > CRITERIA.maxParameters) {
			failures.push(
				`Too many parameters: ${paramCount} > ${CRITERIA.maxParameters}`,
			);
		}
	}

	// Walk-forward validation: signal must be profitable on most recent 20% of trades
	if (metrics.sampleSize >= CRITERIA.minSampleSize) {
		const walkForwardResult = await checkWalkForward(strategyId, metrics.sampleSize);
		if (!walkForwardResult) {
			failures.push("Walk-forward validation failed: not profitable on recent 20% of trades");
		}
	}

	return { passes: failures.length === 0, failures };
}

/**
 * Walk-forward validation: check that the strategy is profitable
 * on the most recent 20% of its trades (out-of-sample window).
 */
async function checkWalkForward(strategyId: number, sampleSize: number): Promise<boolean> {
	const db = getDb();
	const trades = await db
		.select({ pnl: paperTrades.pnl, createdAt: paperTrades.createdAt })
		.from(paperTrades)
		.where(and(eq(paperTrades.strategyId, strategyId), isNotNull(paperTrades.pnl)))
		.orderBy(paperTrades.createdAt);

	if (trades.length < 5) return false; // need at least 5 trades to split

	const splitIdx = Math.floor(trades.length * CRITERIA.walkForwardSplit);
	const recentTrades = trades.slice(splitIdx);
	const recentPnl = recentTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

	return recentPnl > 0;

/**
 * Run the graduation gate for a strategy. If it passes, promote to probation.
 * Records the event in graduation_events.
 */
export async function runGraduationGate(strategyId: number): Promise<void> {
	const db = getDb();
	const result = await checkGraduation(strategyId);

	const [strat] = await db
		.select()
		.from(strategies)
		.where(eq(strategies.id, strategyId))
		.limit(1);

	if (!strat || strat.status !== "paper") return;

	if (result.passes) {
		await db
			.update(strategies)
			.set({ status: "probation" })
			.where(eq(strategies.id, strategyId));

		await db.insert(graduationEvents).values({
			strategyId,
			event: "graduated" as const,
			fromTier: "paper",
			toTier: "probation",
			evidence: JSON.stringify(result),
		});

		log.info({ strategyId, strategy: strat.name }, "Strategy graduated to probation");
	} else {
		log.debug(
			{ strategyId, strategy: strat.name, failures: result.failures },
			"Strategy not ready for graduation",
		);
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test --preload ./tests/preload.ts tests/strategy/graduation.test.ts
```

Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/strategy/graduation.ts tests/strategy/graduation.test.ts
git commit -m "feat: add graduation gate with statistical criteria"
```

---

### Task 11: Scheduler Wiring + Daily Summary

**Files:**
- Create: `src/scheduler/strategy-eval-job.ts`
- Create: `src/scheduler/daily-summary-job.ts`
- Modify: `src/scheduler/jobs.ts` — wire up new jobs
- Modify: `src/scheduler/cron.ts` — add new cron schedules
- Modify: `src/index.ts` — call ensureSeedStrategies on boot

- [ ] **Step 1: Create src/scheduler/strategy-eval-job.ts**

```typescript
import { getQuoteFromCache } from "../data/quotes.ts";
import { getIndicators } from "../strategy/historical.ts";
import { evaluateAllStrategies } from "../strategy/evaluator.ts";
import { recalculateMetrics } from "../strategy/metrics.ts";
import { runGraduationGate } from "../strategy/graduation.ts";
import { getDb } from "../db/client.ts";
import { strategies } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { createChildLogger } from "../utils/logger.ts";
import type { QuoteFields } from "../strategy/context.ts";

const log = createChildLogger({ module: "strategy-eval-job" });

export async function runStrategyEvaluation(): Promise<void> {
	await evaluateAllStrategies(async (symbol, exchange) => {
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
		};

		return { quote, indicators };
	});

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

	log.info("Strategy evaluation cycle complete");
}
```

- [ ] **Step 2: Create src/scheduler/daily-summary-job.ts**

```typescript
import { eq, gte } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { paperTrades, strategies, strategyMetrics } from "../db/schema.ts";
import { sendEmail } from "../reporting/email.ts";
import { getDailySpend } from "../utils/budget.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "daily-summary" });

export async function runDailySummary(): Promise<void> {
	const db = getDb();
	const todayStart = new Date();
	todayStart.setUTCHours(0, 0, 0, 0);

	// Get all strategies with their metrics
	const allStrategies = await db
		.select()
		.from(strategies)
		.leftJoin(strategyMetrics, eq(strategies.id, strategyMetrics.strategyId));

	// Get today's trades
	const todayTrades = await db
		.select()
		.from(paperTrades)
		.where(gte(paperTrades.createdAt, todayStart.toISOString()));

	const apiSpend = await getDailySpend();

	// Build HTML email
	const strategyRows = allStrategies
		.map(({ strategies: s, strategy_metrics: m }) => {
			return `<tr>
				<td>${s.name}</td>
				<td>${s.status}</td>
				<td>${m?.sampleSize ?? 0}</td>
				<td>${m?.winRate != null ? (m.winRate * 100).toFixed(0) + "%" : "—"}</td>
				<td>${m?.profitFactor?.toFixed(2) ?? "—"}</td>
				<td>${m?.sharpeRatio?.toFixed(2) ?? "—"}</td>
				<td>${m?.maxDrawdownPct?.toFixed(1) ?? "—"}%</td>
				<td>$${s.virtualBalance.toFixed(0)}</td>
			</tr>`;
		})
		.join("\n");

	const html = `
		<h2>Trader v2 — Daily Summary</h2>
		<p><strong>Date:</strong> ${new Date().toISOString().split("T")[0]}</p>
		<p><strong>Paper trades today:</strong> ${todayTrades.length}</p>
		<p><strong>API spend today:</strong> $${apiSpend.toFixed(4)}</p>

		<h3>Strategy Performance</h3>
		<table border="1" cellpadding="4" cellspacing="0">
			<tr>
				<th>Strategy</th><th>Status</th><th>Trades</th><th>Win Rate</th>
				<th>Profit Factor</th><th>Sharpe</th><th>Max DD</th><th>Balance</th>
			</tr>
			${strategyRows}
		</table>
	`;

	await sendEmail({
		subject: `Trader v2 Daily — ${todayTrades.length} trades, $${apiSpend.toFixed(3)} API`,
		html,
	});

	log.info({ trades: todayTrades.length, apiSpend }, "Daily summary sent");
}
```

- [ ] **Step 3: Update src/scheduler/jobs.ts — wire up new jobs**

Replace the `strategy_evaluation` and `daily_summary` stubs in the `executeJob` switch:

```typescript
// In the executeJob function, replace:
//   case "strategy_evaluation":
//   case "daily_summary":
//   ...
//     log.info({ job: name }, "Job not yet implemented (future phase)");
//     break;
//
// With:

case "strategy_evaluation": {
	const { runStrategyEvaluation } = await import("./strategy-eval-job.ts");
	await runStrategyEvaluation();
	break;
}

case "daily_summary": {
	const { runDailySummary } = await import("./daily-summary-job.ts");
	await runDailySummary();
	break;
}
```

Keep the other stubs (`weekly_digest`, `strategy_evolution`, `trade_review`, `pattern_analysis`, `earnings_calendar_sync`) as-is — they're future phases.

- [ ] **Step 4: Update src/scheduler/cron.ts — add new cron schedules**

Add these two schedules inside `startScheduler()`, after the existing ones:

```typescript
// Strategy evaluation every 10 minutes during market hours (08:00-20:00 UK)
tasks.push(
	cron.schedule("*/10 8-20 * * 1-5", () => runJob("strategy_evaluation"), {
		timezone: "Europe/London",
	}),
);

// Daily summary at 21:05 weekdays (after market close)
tasks.push(
	cron.schedule("5 21 * * 1-5", () => runJob("daily_summary"), {
		timezone: "Europe/London",
	}),
);
```

- [ ] **Step 5: Update src/index.ts — seed strategies on boot**

Add after the `migrate(db, ...)` line in the `boot()` function:

```typescript
// Ensure seed strategies exist
const { ensureSeedStrategies } = await import("./strategy/seed.ts");
await ensureSeedStrategies();
log.info("Seed strategies verified");
```

- [ ] **Step 6: Verify typecheck**

```bash
bun run typecheck
```

Expected: no errors

- [ ] **Step 7: Run full test suite**

```bash
bun test --preload ./tests/preload.ts
```

Expected: all tests pass

- [ ] **Step 8: Run lint and fix**

```bash
bun run lint:fix
bun run lint
```

Expected: clean

- [ ] **Step 9: Commit**

```bash
git add src/scheduler/ src/index.ts
git commit -m "feat: wire up strategy evaluation and daily summary to scheduler"
```

---

### Task 12: Integration Test — Full Evaluation Cycle

**Files:**
- Create: `tests/strategy/integration.test.ts`

- [ ] **Step 1: Write the integration test**

Create `tests/strategy/integration.test.ts`:

```typescript
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

describe("full evaluation cycle", () => {
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

	test("seeds strategies on first run", async () => {
		const { ensureSeedStrategies } = await import("../../src/strategy/seed.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		await ensureSeedStrategies();

		const strats = await db.select().from(strategies);
		expect(strats).toHaveLength(3);
		expect(strats[0]!.status).toBe("paper");
		expect(strats[0]!.signals).not.toBeNull();
		expect(strats[0]!.universe).not.toBeNull();
	});

	test("skips seeding when strategies already exist", async () => {
		const { ensureSeedStrategies } = await import("../../src/strategy/seed.ts");
		const { strategies } = await import("../../src/db/schema.ts");

		await ensureSeedStrategies();
		await ensureSeedStrategies(); // second call should be no-op

		const strats = await db.select().from(strategies);
		expect(strats).toHaveLength(3);
	});

	test("full cycle: strategy + quote -> evaluate -> trade -> metrics", async () => {
		const { strategies, quotesCache, paperTrades, strategyMetrics } = await import(
			"../../src/db/schema.ts"
		);
		const { evaluateStrategyForSymbol } = await import("../../src/strategy/evaluator.ts");
		const { recalculateMetrics } = await import("../../src/strategy/metrics.ts");

		// Insert a strategy that will trigger on any positive price
		const [strat] = await db
			.insert(strategies)
			.values({
				name: "always_enter",
				description: "test: enters on any stock",
				parameters: JSON.stringify({ position_size_pct: 10 }),
				signals: JSON.stringify({
					entry_long: "last > 0",
					exit: "pnl_pct > 0.5 OR pnl_pct < -0.5",
				}),
				universe: JSON.stringify(["TEST"]),
				status: "paper" as const,
				virtualBalance: 10000,
				generation: 1,
			})
			.returning();

		// Evaluate — should open a position
		await evaluateStrategyForSymbol(strat!, "TEST", "NASDAQ", {
			quote: {
				last: 100,
				bid: 99.5,
				ask: 100.5,
				volume: 1000000,
				avgVolume: 800000,
				changePercent: 0.5,
				newsSentiment: null,
			},
			indicators: { rsi14: 50, atr14: 2.0, volume_ratio: 1.25 },
		});

		let trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(1);
		expect(trades[0]!.side).toBe("BUY");

		// Evaluate again with higher price — should trigger exit (pnl_pct > 0.5)
		await evaluateStrategyForSymbol(strat!, "TEST", "NASDAQ", {
			quote: {
				last: 105,
				bid: null,
				ask: null,
				volume: null,
				avgVolume: null,
				changePercent: null,
				newsSentiment: null,
			},
			indicators: { rsi14: 60, atr14: 2.0, volume_ratio: 1.0 },
		});

		trades = await db.select().from(paperTrades);
		expect(trades).toHaveLength(2);
		const exitTrade = trades.find((t) => t.signalType === "exit");
		expect(exitTrade).not.toBeUndefined();
		expect(exitTrade!.pnl).not.toBeNull();
		expect(exitTrade!.pnl!).toBeGreaterThan(0);

		// Recalculate metrics
		await recalculateMetrics(strat!.id);

		const [metrics] = await db
			.select()
			.from(strategyMetrics)
			.where(eq(strategyMetrics.strategyId, strat!.id));
		expect(metrics).not.toBeUndefined();
		expect(metrics!.sampleSize).toBe(1);
		expect(metrics!.winRate).toBe(1);
	});
});
```

- [ ] **Step 2: Run the integration test**

```bash
bun test --preload ./tests/preload.ts tests/strategy/integration.test.ts
```

Expected: all 3 PASS

- [ ] **Step 3: Run full test suite + lint**

```bash
bun test --preload ./tests/preload.ts
bun run typecheck
bun run lint
```

Expected: all pass, all clean

- [ ] **Step 4: Commit**

```bash
git add tests/strategy/integration.test.ts
git commit -m "test: add integration test for full evaluation cycle"
```

---

## Phase 2 Complete Checklist

After all tasks, verify:

- [ ] `bun test --preload ./tests/preload.ts` — all tests pass
- [ ] `bun run typecheck` — no errors
- [ ] `bun run lint` — no errors
- [ ] App boots, seeds 3 strategies, starts scheduler with strategy evaluation
- [ ] Expression evaluator correctly parses signal rules
- [ ] Paper trades are executed when signals fire, with friction costs
- [ ] Strategy metrics are calculated from trade history
- [ ] Graduation gate evaluates all criteria from spec Section 4

## What's Next

**Phase 3: News Event Bus** — Finnhub websocket, RSS polling, keyword pre-filter, Haiku classification. This is where strategies start getting real sentiment signals.

**Phase 4: Live Executor** — IBKR connection, real order placement, position guardian, stop-loss enforcement. This is where graduated strategies trade with real capital.
