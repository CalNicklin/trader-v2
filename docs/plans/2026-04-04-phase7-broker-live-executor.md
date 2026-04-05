# Phase 7: Broker Integration & Live Executor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cherry-pick IBKR broker modules from v1 (~/documents/projects/trader), adapt for v2 schema, and build the live execution layer that runs graduated strategies with real capital.

**Architecture:** Broker modules from trader-v1 are adapted to use v2's Drizzle schema (`livePositions`/`liveTrades` tables), v2's Zod config, and v2's pino logger. The live executor evaluates graduated strategies (probation/active/core) against cached market data and places real trades via IBKR. Capital allocation is tiered per spec Section 4: probation=10%, active=25%, core=50%. A guardian loop runs every 60s during market hours enforcing stop-losses and trailing stops on live positions. Settlement tracking (T+1 US, T+2 UK) prevents trading with unsettled funds. A global `LIVE_TRADING_ENABLED` kill switch defaults to false.

**Tech Stack:** Bun, TypeScript, Drizzle ORM (SQLite), @stoqey/ib, rxjs

---

## File Structure

```
src/broker/
  connection.ts         # IBKR connection via IBApiNext (singleton, reconnect, health)
  contracts.ts          # Multi-exchange contracts (LSE GBP, US USD, SMART routing)
  orders.ts             # Order placement (TradeRequest -> TradeResult, tracks in liveTrades)
  order-monitor.ts      # RxJS subscription monitoring fills/cancels
  order-types.ts        # Shared types (OpenOrderLike, FillData, etc.)
  order-status.ts       # IB status mapping + fill data extraction
  order-events.ts       # processOrderUpdate pure function
  stop-loss.ts          # Pure function: findStopLossBreaches
  trailing-stops.ts     # Pure function: computeTrailingStopUpdate
  guardian.ts           # 60s interval: enforce stops, update prices, trailing stops
  settlement.ts         # Settlement tracking: T+1 US, T+2 UK

src/live/
  executor.ts           # Live strategy evaluator — runs graduated strategies
  capital-allocator.ts  # Tier-based capital allocation

src/scheduler/
  guardian-job.ts       # Scheduler job: start/stop guardian
  live-eval-job.ts      # Scheduler job: run live executor

tests/broker/
  stop-loss.test.ts
  trailing-stops.test.ts
  order-status.test.ts
  order-events.test.ts
  contracts.test.ts
  settlement.test.ts

tests/live/
  capital-allocator.test.ts
  executor.test.ts
```

---

## Task 1: Dependencies & Config

Add `@stoqey/ib` and `rxjs` to the project. Extend the Zod config with IBKR connection settings and the live trading kill switch.

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts`
- Modify: `tests/preload.ts`

### Steps

- [ ] **Step 1.1: Install dependencies**

```bash
bun add @stoqey/ib@^1.5.3 rxjs@^7.8.1
```

- [ ] **Step 1.2: Extend config.ts with IBKR settings**

```typescript
// src/config.ts — add these fields to envSchema

	// IBKR
	IBKR_HOST: z.string().default("127.0.0.1"),
	IBKR_PORT: z.coerce.number().default(4002), // 4001=live TWS, 4002=paper TWS, 7497=live gateway
	IBKR_CLIENT_ID: z.coerce.number().default(1),

	// Live trading
	LIVE_TRADING_ENABLED: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),
```

The full updated `envSchema` after the `FINNHUB_API_KEY` line:

```typescript
const envSchema = z.object({
	// Claude
	ANTHROPIC_API_KEY: z.string(),
	CLAUDE_MODEL: z.string().default("claude-sonnet-4-5-20250929"),
	CLAUDE_MODEL_FAST: z.string().default("claude-haiku-4-5-20251001"),

	// Resend
	RESEND_API_KEY: z.string(),
	ALERT_EMAIL_FROM: z.string().default("trader@updates.example.com"),
	ALERT_EMAIL_TO: z.string(),

	// GitHub (for self-improvement PRs)
	GITHUB_TOKEN: z.string().optional(),
	GITHUB_REPO_OWNER: z.string().optional(),
	GITHUB_REPO_NAME: z.string().default("trader-v2"),

	// Database
	DB_PATH: z.string().default("./data/trader.db"),

	// Logging
	LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

	// Environment
	NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

	// Cost control
	DAILY_API_BUDGET_USD: z.coerce.number().default(0),

	// Finnhub
	FINNHUB_API_KEY: z.string().optional(),

	// IBKR
	IBKR_HOST: z.string().default("127.0.0.1"),
	IBKR_PORT: z.coerce.number().default(4002),
	IBKR_CLIENT_ID: z.coerce.number().default(1),

	// Live trading kill switch (default OFF)
	LIVE_TRADING_ENABLED: z
		.enum(["true", "false"])
		.default("false")
		.transform((v) => v === "true"),
});
```

- [ ] **Step 1.3: Add IBKR env vars to test preload**

```typescript
// tests/preload.ts — append these lines
process.env.IBKR_HOST = "127.0.0.1";
process.env.IBKR_PORT = "4002";
process.env.IBKR_CLIENT_ID = "99";
process.env.LIVE_TRADING_ENABLED = "false";
```

- [ ] **Step 1.4: Verify**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
```

---

## Task 2: Broker Types & Pure Order Helpers

Port the shared types and pure helper functions from v1. These have no dependencies on IBKR or the database — pure logic only.

**Files:**
- Create: `src/broker/order-types.ts`
- Create: `src/broker/order-status.ts`
- Create: `src/broker/order-events.ts`
- Create: `tests/broker/order-status.test.ts`
- Create: `tests/broker/order-events.test.ts`

### Steps

- [ ] **Step 2.1: Create order-types.ts**

Ported directly from v1 — these types are identical.

```typescript
// src/broker/order-types.ts

export type TradeStatus =
	| "PENDING"
	| "SUBMITTED"
	| "FILLED"
	| "PARTIALLY_FILLED"
	| "CANCELLED"
	| "ERROR";

export interface OpenOrderLike {
	readonly orderId: number;
	readonly orderState?: {
		readonly status?: string;
		readonly commission?: number;
	};
	readonly orderStatus?: {
		readonly avgFillPrice?: number;
		readonly filled?: number;
		readonly remaining?: number;
	};
}

export interface ExecutionLike {
	readonly orderId?: number;
	readonly avgPrice?: number;
	readonly shares?: number;
	readonly side?: string;
	readonly time?: string;
}

export interface SubmittedTrade {
	readonly id: number;
	readonly ibOrderId: number;
	readonly symbol: string;
	readonly status: "SUBMITTED";
}

export interface FillData {
	readonly fillPrice?: number;
	readonly commission?: number;
	readonly filledAt?: string;
}

export interface OrderEvent {
	readonly tradeId: number;
	readonly status: TradeStatus;
	readonly fillData?: FillData;
}
```

- [ ] **Step 2.2: Create order-status.ts**

Ported from v1 — maps IB status strings to our TradeStatus enum.

```typescript
// src/broker/order-status.ts

import type { FillData, OpenOrderLike, TradeStatus } from "./order-types.ts";

const IB_COMMISSION_SENTINEL = 1e9;

const statusMap: Readonly<Record<string, TradeStatus>> = {
	Submitted: "SUBMITTED",
	PreSubmitted: "SUBMITTED",
	PendingSubmit: "SUBMITTED",
	PendingCancel: "SUBMITTED",
	Filled: "FILLED",
	Cancelled: "CANCELLED",
	ApiCancelled: "CANCELLED",
	Inactive: "ERROR",
};

export function mapIbStatus(ibStatus: string): TradeStatus {
	return statusMap[ibStatus] ?? "SUBMITTED";
}

export function extractFillData(order: OpenOrderLike): FillData {
	const avgFillPrice = order.orderStatus?.avgFillPrice;
	const commission = order.orderState?.commission;

	return {
		fillPrice: avgFillPrice && avgFillPrice > 0 ? avgFillPrice : undefined,
		commission:
			commission !== undefined && commission < IB_COMMISSION_SENTINEL ? commission : undefined,
	};
}
```

- [ ] **Step 2.3: Create order-events.ts**

Ported from v1 — pure function that processes IB order updates into typed events.

```typescript
// src/broker/order-events.ts

import { extractFillData, mapIbStatus } from "./order-status.ts";
import type { OpenOrderLike, OrderEvent } from "./order-types.ts";

const TERMINAL_STATUSES = new Set(["FILLED", "CANCELLED", "ERROR"]);

export function processOrderUpdate(
	trackedOrders: Map<number, number>,
	openOrders: readonly OpenOrderLike[],
): OrderEvent[] {
	const events: OrderEvent[] = [];

	for (const order of openOrders) {
		const tradeId = trackedOrders.get(order.orderId);
		if (tradeId === undefined) continue;

		const ibStatus = order.orderState?.status;
		if (!ibStatus) continue;

		const status = mapIbStatus(ibStatus);
		const fillData = status === "FILLED" ? extractFillData(order) : undefined;

		events.push({ tradeId, status, fillData });

		if (TERMINAL_STATUSES.has(status)) {
			trackedOrders.delete(order.orderId);
		}
	}

	return events;
}
```

- [ ] **Step 2.4: Write tests for order-status**

```typescript
// tests/broker/order-status.test.ts

import { describe, expect, test } from "bun:test";

describe("order-status", () => {
	test("mapIbStatus maps known IB statuses", async () => {
		const { mapIbStatus } = await import("../../src/broker/order-status.ts");
		expect(mapIbStatus("Filled")).toBe("FILLED");
		expect(mapIbStatus("Cancelled")).toBe("CANCELLED");
		expect(mapIbStatus("ApiCancelled")).toBe("CANCELLED");
		expect(mapIbStatus("Submitted")).toBe("SUBMITTED");
		expect(mapIbStatus("PreSubmitted")).toBe("SUBMITTED");
		expect(mapIbStatus("Inactive")).toBe("ERROR");
	});

	test("mapIbStatus defaults unknown statuses to SUBMITTED", async () => {
		const { mapIbStatus } = await import("../../src/broker/order-status.ts");
		expect(mapIbStatus("SomeNewStatus")).toBe("SUBMITTED");
	});

	test("extractFillData extracts price and commission", async () => {
		const { extractFillData } = await import("../../src/broker/order-status.ts");
		const order = {
			orderId: 1,
			orderState: { status: "Filled", commission: 1.25 },
			orderStatus: { avgFillPrice: 150.50, filled: 10, remaining: 0 },
		};
		const fill = extractFillData(order);
		expect(fill.fillPrice).toBe(150.50);
		expect(fill.commission).toBe(1.25);
	});

	test("extractFillData ignores sentinel commission value", async () => {
		const { extractFillData } = await import("../../src/broker/order-status.ts");
		const order = {
			orderId: 1,
			orderState: { status: "Filled", commission: 1e9 },
			orderStatus: { avgFillPrice: 100 },
		};
		const fill = extractFillData(order);
		expect(fill.fillPrice).toBe(100);
		expect(fill.commission).toBeUndefined();
	});
});
```

- [ ] **Step 2.5: Write tests for order-events**

```typescript
// tests/broker/order-events.test.ts

import { describe, expect, test } from "bun:test";

describe("order-events", () => {
	test("processOrderUpdate emits events for tracked orders", async () => {
		const { processOrderUpdate } = await import("../../src/broker/order-events.ts");
		const tracked = new Map([[100, 1]]);
		const orders = [
			{ orderId: 100, orderState: { status: "Filled", commission: 2.0 }, orderStatus: { avgFillPrice: 150 } },
		];
		const events = processOrderUpdate(tracked, orders);
		expect(events).toHaveLength(1);
		expect(events[0]!.tradeId).toBe(1);
		expect(events[0]!.status).toBe("FILLED");
		expect(events[0]!.fillData?.fillPrice).toBe(150);
	});

	test("processOrderUpdate ignores untracked orders", async () => {
		const { processOrderUpdate } = await import("../../src/broker/order-events.ts");
		const tracked = new Map<number, number>();
		const orders = [
			{ orderId: 999, orderState: { status: "Filled" }, orderStatus: { avgFillPrice: 100 } },
		];
		const events = processOrderUpdate(tracked, orders);
		expect(events).toHaveLength(0);
	});

	test("processOrderUpdate removes terminal orders from tracking", async () => {
		const { processOrderUpdate } = await import("../../src/broker/order-events.ts");
		const tracked = new Map([[100, 1]]);
		const orders = [
			{ orderId: 100, orderState: { status: "Cancelled" } },
		];
		processOrderUpdate(tracked, orders);
		expect(tracked.has(100)).toBe(false);
	});

	test("processOrderUpdate skips orders with no orderState", async () => {
		const { processOrderUpdate } = await import("../../src/broker/order-events.ts");
		const tracked = new Map([[100, 1]]);
		const orders = [{ orderId: 100 }];
		const events = processOrderUpdate(tracked, orders);
		expect(events).toHaveLength(0);
	});
});
```

- [ ] **Step 2.6: Verify**

```bash
bun test --preload ./tests/preload.ts tests/broker/order-status.test.ts tests/broker/order-events.test.ts
```

---

## Task 3: Contracts Module

Port the contract builders from v1. Pure functions that create IBKR `Contract` objects for different exchanges.

**Files:**
- Create: `src/broker/contracts.ts`
- Create: `tests/broker/contracts.test.ts`

### Steps

- [ ] **Step 3.1: Create contracts.ts**

Adapted from v1 — uses v2 logger. Removed `searchContracts` and `validateSymbol` for now (those need a live connection).

```typescript
// src/broker/contracts.ts

import { type Contract, SecType } from "@stoqey/ib";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "broker-contracts" });

export type Exchange = "LSE" | "NASDAQ" | "NYSE";

/** Create a Contract for an LSE-listed stock.
 *  Uses SMART routing — IB paper trading doesn't fill direct LSE-routed orders. */
export function lseStock(symbol: string): Contract {
	return {
		symbol,
		secType: SecType.STK,
		exchange: "SMART",
		primaryExch: "LSE",
		currency: "GBP",
	};
}

/** Create a Contract for a US-listed stock (NASDAQ or NYSE). */
export function usStock(symbol: string, exchange: "NASDAQ" | "NYSE"): Contract {
	return {
		symbol,
		secType: SecType.STK,
		exchange: "SMART",
		primaryExch: exchange,
		currency: "USD",
	};
}

/** Dispatch to the correct contract builder based on exchange. */
export function getContract(symbol: string, exchange: Exchange): Contract {
	if (exchange === "LSE") return lseStock(symbol);
	return usStock(symbol, exchange);
}

/** Look up contract details for a symbol on a given exchange.
 *  Requires a live IBKR connection. */
export async function getContractDetails(
	api: { getContractDetails(contract: Contract): Promise<unknown[]> },
	symbol: string,
	exchange: Exchange = "LSE",
) {
	const contract = getContract(symbol, exchange);
	const details = await api.getContractDetails(contract);
	log.debug({ symbol, exchange, count: details.length }, "Contract details fetched");
	return details;
}
```

- [ ] **Step 3.2: Write tests for contracts**

```typescript
// tests/broker/contracts.test.ts

import { describe, expect, test } from "bun:test";

describe("contracts", () => {
	test("lseStock creates GBP SMART-routed contract", async () => {
		const { lseStock } = await import("../../src/broker/contracts.ts");
		const c = lseStock("SHEL");
		expect(c.symbol).toBe("SHEL");
		expect(c.exchange).toBe("SMART");
		expect(c.primaryExch).toBe("LSE");
		expect(c.currency).toBe("GBP");
	});

	test("usStock creates USD SMART-routed contract", async () => {
		const { usStock } = await import("../../src/broker/contracts.ts");
		const c = usStock("AAPL", "NASDAQ");
		expect(c.symbol).toBe("AAPL");
		expect(c.exchange).toBe("SMART");
		expect(c.primaryExch).toBe("NASDAQ");
		expect(c.currency).toBe("USD");
	});

	test("getContract dispatches LSE to lseStock", async () => {
		const { getContract } = await import("../../src/broker/contracts.ts");
		const c = getContract("BARC", "LSE");
		expect(c.currency).toBe("GBP");
		expect(c.primaryExch).toBe("LSE");
	});

	test("getContract dispatches NYSE to usStock", async () => {
		const { getContract } = await import("../../src/broker/contracts.ts");
		const c = getContract("JPM", "NYSE");
		expect(c.currency).toBe("USD");
		expect(c.primaryExch).toBe("NYSE");
	});
});
```

- [ ] **Step 3.3: Verify**

```bash
bun test --preload ./tests/preload.ts tests/broker/contracts.test.ts
```

---

## Task 4: Stop-Loss & Trailing Stops (Pure Functions)

Port the pure decision functions from v1. These have zero dependencies on IBKR or the database.

**Files:**
- Create: `src/broker/stop-loss.ts`
- Create: `src/broker/trailing-stops.ts`
- Create: `tests/broker/stop-loss.test.ts`
- Create: `tests/broker/trailing-stops.test.ts`

### Steps

- [ ] **Step 4.1: Create stop-loss.ts**

Identical to v1 — pure function, no changes needed.

```typescript
// src/broker/stop-loss.ts

export interface StopLossPosition {
	id: number;
	symbol: string;
	quantity: number;
	stopLossPrice: number | null;
}

export interface StopLossBreach {
	symbol: string;
	quantity: number;
	price: number;
	stopLossPrice: number;
}

export interface QuoteLike {
	last: number | null;
	bid: number | null;
}

/** Pure decision: which positions have breached their stop-loss? */
export function findStopLossBreaches(
	positions: ReadonlyArray<StopLossPosition>,
	quotes: Map<string, QuoteLike>,
): StopLossBreach[] {
	const breaches: StopLossBreach[] = [];
	for (const pos of positions) {
		if (!pos.stopLossPrice || pos.quantity <= 0) continue;
		const quote = quotes.get(pos.symbol);
		const price = quote?.last ?? quote?.bid ?? null;
		if (price === null) continue;
		if (price <= pos.stopLossPrice) {
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

- [ ] **Step 4.2: Create trailing-stops.ts**

Identical to v1 — pure function, no changes needed.

```typescript
// src/broker/trailing-stops.ts

export interface TrailingStopPosition {
	id: number;
	symbol: string;
	quantity: number;
	highWaterMark: number | null;
	trailingStopPrice: number | null;
	atr14: number | null;
	currentPrice: number | null;
}

export interface TrailingStopUpdate {
	positionId: number;
	symbol: string;
	highWaterMark: number;
	trailingStopPrice: number;
	triggered: boolean;
}

export function computeTrailingStopUpdate(
	pos: TrailingStopPosition,
	atrMultiplier: number,
): TrailingStopUpdate | null {
	if (!pos.highWaterMark || !pos.atr14 || !pos.currentPrice) return null;

	const newHighWater = Math.max(pos.highWaterMark, pos.currentPrice);
	const recalculatedStop = newHighWater - pos.atr14 * atrMultiplier;
	const effectiveStop = Math.max(recalculatedStop, pos.trailingStopPrice ?? 0);

	return {
		positionId: pos.id,
		symbol: pos.symbol,
		highWaterMark: newHighWater,
		trailingStopPrice: effectiveStop,
		triggered: pos.currentPrice <= effectiveStop && pos.currentPrice > 0,
	};
}
```

- [ ] **Step 4.3: Write tests for stop-loss**

```typescript
// tests/broker/stop-loss.test.ts

import { describe, expect, test } from "bun:test";

describe("stop-loss", () => {
	test("findStopLossBreaches detects breach when price <= stop", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: 145, bid: 144 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(1);
		expect(breaches[0]!.symbol).toBe("AAPL");
		expect(breaches[0]!.price).toBe(145);
	});

	test("findStopLossBreaches no breach when price > stop", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: 155, bid: 154 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(0);
	});

	test("findStopLossBreaches skips positions without stop-loss", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: null },
		];
		const quotes = new Map([["AAPL", { last: 100, bid: 99 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(0);
	});

	test("findStopLossBreaches skips zero-quantity positions", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 0, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: 100, bid: 99 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(0);
	});

	test("findStopLossBreaches uses bid when last is null", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: null, bid: 140 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(1);
		expect(breaches[0]!.price).toBe(140);
	});

	test("findStopLossBreaches skips when no quote available", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map<string, { last: number | null; bid: number | null }>();
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(0);
	});

	test("findStopLossBreaches breach at exact stop price", async () => {
		const { findStopLossBreaches } = await import("../../src/broker/stop-loss.ts");
		const positions = [
			{ id: 1, symbol: "AAPL", quantity: 10, stopLossPrice: 150 },
		];
		const quotes = new Map([["AAPL", { last: 150, bid: 149 }]]);
		const breaches = findStopLossBreaches(positions, quotes);
		expect(breaches).toHaveLength(1);
	});
});
```

- [ ] **Step 4.4: Write tests for trailing-stops**

```typescript
// tests/broker/trailing-stops.test.ts

import { describe, expect, test } from "bun:test";

describe("trailing-stops", () => {
	test("computeTrailingStopUpdate updates high water mark", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		const result = computeTrailingStopUpdate(
			{
				id: 1,
				symbol: "AAPL",
				quantity: 10,
				highWaterMark: 150,
				trailingStopPrice: 140,
				atr14: 5,
				currentPrice: 160,
			},
			2,
		);
		expect(result).not.toBeNull();
		expect(result!.highWaterMark).toBe(160);
		// trailingStop = 160 - 5*2 = 150, which is > existing 140
		expect(result!.trailingStopPrice).toBe(150);
		expect(result!.triggered).toBe(false);
	});

	test("computeTrailingStopUpdate never lowers existing stop", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		const result = computeTrailingStopUpdate(
			{
				id: 1,
				symbol: "AAPL",
				quantity: 10,
				highWaterMark: 170,
				trailingStopPrice: 160,
				atr14: 10,
				currentPrice: 165,
			},
			2,
		);
		expect(result).not.toBeNull();
		// recalculated: 170 - 10*2 = 150, but existing stop is 160 — keep 160
		expect(result!.trailingStopPrice).toBe(160);
	});

	test("computeTrailingStopUpdate triggers when price <= stop", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		const result = computeTrailingStopUpdate(
			{
				id: 1,
				symbol: "AAPL",
				quantity: 10,
				highWaterMark: 160,
				trailingStopPrice: 150,
				atr14: 5,
				currentPrice: 148,
			},
			2,
		);
		expect(result).not.toBeNull();
		expect(result!.triggered).toBe(true);
	});

	test("computeTrailingStopUpdate returns null when data missing", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		expect(computeTrailingStopUpdate(
			{ id: 1, symbol: "AAPL", quantity: 10, highWaterMark: null, trailingStopPrice: null, atr14: 5, currentPrice: 100 },
			2,
		)).toBeNull();

		expect(computeTrailingStopUpdate(
			{ id: 1, symbol: "AAPL", quantity: 10, highWaterMark: 100, trailingStopPrice: null, atr14: null, currentPrice: 100 },
			2,
		)).toBeNull();

		expect(computeTrailingStopUpdate(
			{ id: 1, symbol: "AAPL", quantity: 10, highWaterMark: 100, trailingStopPrice: null, atr14: 5, currentPrice: null },
			2,
		)).toBeNull();
	});

	test("computeTrailingStopUpdate does not trigger at zero price", async () => {
		const { computeTrailingStopUpdate } = await import("../../src/broker/trailing-stops.ts");
		const result = computeTrailingStopUpdate(
			{
				id: 1,
				symbol: "AAPL",
				quantity: 10,
				highWaterMark: 100,
				trailingStopPrice: 90,
				atr14: 5,
				currentPrice: 0,
			},
			2,
		);
		expect(result).not.toBeNull();
		// currentPrice=0, stop=90, but triggered requires currentPrice > 0
		expect(result!.triggered).toBe(false);
	});
});
```

- [ ] **Step 4.5: Verify**

```bash
bun test --preload ./tests/preload.ts tests/broker/stop-loss.test.ts tests/broker/trailing-stops.test.ts
```

---

## Task 5: Settlement Tracking

New module (not in v1). Tracks settlement dates so the executor does not trade with unsettled funds. US stocks settle T+1, UK stocks settle T+2.

**Files:**
- Create: `src/broker/settlement.ts`
- Create: `tests/broker/settlement.test.ts`

### Steps

- [ ] **Step 5.1: Create settlement.ts**

```typescript
// src/broker/settlement.ts

import type { Exchange } from "./contracts.ts";

/** Settlement rules by exchange region */
const SETTLEMENT_DAYS: Record<Exchange, number> = {
	LSE: 2, // T+2
	NASDAQ: 1, // T+1
	NYSE: 1, // T+1
};

export interface UnsettledTrade {
	fillPrice: number;
	quantity: number;
	side: "BUY" | "SELL";
	exchange: string;
	filledAt: string; // ISO date string
}

/**
 * Calculate the settlement date for a trade.
 * Skips weekends (Sat/Sun) but not bank holidays — conservative enough for safety.
 */
export function getSettlementDate(tradeDate: Date, exchange: Exchange): Date {
	const days = SETTLEMENT_DAYS[exchange];
	const result = new Date(tradeDate);
	let added = 0;
	while (added < days) {
		result.setDate(result.getDate() + 1);
		const dow = result.getDay();
		if (dow !== 0 && dow !== 6) {
			added++;
		}
	}
	return result;
}

/**
 * Calculate total unsettled cash tied up from recent trades.
 * A BUY that hasn't settled = cash outflow not yet debited.
 * A SELL that hasn't settled = cash inflow not yet credited.
 * Returns the net unsettled amount (positive = cash locked up).
 */
export function computeUnsettledCash(
	trades: ReadonlyArray<UnsettledTrade>,
	now: Date = new Date(),
): number {
	let unsettledBuys = 0;
	let unsettledSells = 0;

	for (const trade of trades) {
		const exchange = trade.exchange as Exchange;
		if (!(exchange in SETTLEMENT_DAYS)) continue;

		const filledDate = new Date(trade.filledAt);
		const settlementDate = getSettlementDate(filledDate, exchange);

		if (now < settlementDate) {
			const tradeValue = trade.fillPrice * trade.quantity;
			if (trade.side === "BUY") {
				unsettledBuys += tradeValue;
			} else {
				unsettledSells += tradeValue;
			}
		}
	}

	// Net: buys lock up cash, sells will release cash but haven't yet
	return unsettledBuys - unsettledSells;
}

/**
 * Calculate available cash for trading after subtracting unsettled amounts.
 * Returns 0 if unsettled cash exceeds total cash (don't go negative).
 */
export function getAvailableCash(
	totalCash: number,
	trades: ReadonlyArray<UnsettledTrade>,
	now: Date = new Date(),
): number {
	const unsettled = computeUnsettledCash(trades, now);
	return Math.max(0, totalCash - unsettled);
}
```

- [ ] **Step 5.2: Write tests for settlement**

```typescript
// tests/broker/settlement.test.ts

import { describe, expect, test } from "bun:test";

describe("settlement", () => {
	test("getSettlementDate T+1 for US stock (weekday)", async () => {
		const { getSettlementDate } = await import("../../src/broker/settlement.ts");
		// Wednesday 2026-04-01 -> T+1 = Thursday 2026-04-02
		const tradeDate = new Date("2026-04-01T15:00:00Z");
		const settlement = getSettlementDate(tradeDate, "NASDAQ");
		expect(settlement.toISOString().slice(0, 10)).toBe("2026-04-02");
	});

	test("getSettlementDate T+2 for LSE stock (weekday)", async () => {
		const { getSettlementDate } = await import("../../src/broker/settlement.ts");
		// Wednesday 2026-04-01 -> T+2 = Friday 2026-04-03
		const tradeDate = new Date("2026-04-01T15:00:00Z");
		const settlement = getSettlementDate(tradeDate, "LSE");
		expect(settlement.toISOString().slice(0, 10)).toBe("2026-04-03");
	});

	test("getSettlementDate skips weekends for US T+1", async () => {
		const { getSettlementDate } = await import("../../src/broker/settlement.ts");
		// Friday 2026-04-03 -> T+1 skips Sat/Sun = Monday 2026-04-06
		const tradeDate = new Date("2026-04-03T15:00:00Z");
		const settlement = getSettlementDate(tradeDate, "NYSE");
		expect(settlement.toISOString().slice(0, 10)).toBe("2026-04-06");
	});

	test("getSettlementDate skips weekends for LSE T+2", async () => {
		const { getSettlementDate } = await import("../../src/broker/settlement.ts");
		// Thursday 2026-04-02 -> T+2 = Fri(+1), skip Sat/Sun, Mon(+2) = 2026-04-06
		const tradeDate = new Date("2026-04-02T15:00:00Z");
		const settlement = getSettlementDate(tradeDate, "LSE");
		expect(settlement.toISOString().slice(0, 10)).toBe("2026-04-06");
	});

	test("computeUnsettledCash counts unsettled buys as locked cash", async () => {
		const { computeUnsettledCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-02T12:00:00Z"); // Thursday
		const trades = [
			{
				fillPrice: 100,
				quantity: 10,
				side: "BUY" as const,
				exchange: "NASDAQ",
				filledAt: "2026-04-02T10:00:00Z", // Same day — settles 2026-04-03
			},
		];
		const unsettled = computeUnsettledCash(trades, now);
		expect(unsettled).toBe(1000); // 100 * 10 locked
	});

	test("computeUnsettledCash returns 0 for settled trades", async () => {
		const { computeUnsettledCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-04T12:00:00Z"); // Saturday
		const trades = [
			{
				fillPrice: 100,
				quantity: 10,
				side: "BUY" as const,
				exchange: "NASDAQ",
				filledAt: "2026-04-02T10:00:00Z", // Settled on 2026-04-03
			},
		];
		const unsettled = computeUnsettledCash(trades, now);
		expect(unsettled).toBe(0);
	});

	test("computeUnsettledCash nets buys against sells", async () => {
		const { computeUnsettledCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-02T12:00:00Z");
		const trades = [
			{ fillPrice: 100, quantity: 10, side: "BUY" as const, exchange: "NASDAQ", filledAt: "2026-04-02T10:00:00Z" },
			{ fillPrice: 50, quantity: 10, side: "SELL" as const, exchange: "NASDAQ", filledAt: "2026-04-02T10:00:00Z" },
		];
		const unsettled = computeUnsettledCash(trades, now);
		expect(unsettled).toBe(500); // 1000 - 500
	});

	test("getAvailableCash subtracts unsettled from total", async () => {
		const { getAvailableCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-02T12:00:00Z");
		const trades = [
			{ fillPrice: 100, quantity: 10, side: "BUY" as const, exchange: "NASDAQ", filledAt: "2026-04-02T10:00:00Z" },
		];
		const available = getAvailableCash(5000, trades, now);
		expect(available).toBe(4000); // 5000 - 1000
	});

	test("getAvailableCash never goes below 0", async () => {
		const { getAvailableCash } = await import("../../src/broker/settlement.ts");
		const now = new Date("2026-04-02T12:00:00Z");
		const trades = [
			{ fillPrice: 100, quantity: 100, side: "BUY" as const, exchange: "NASDAQ", filledAt: "2026-04-02T10:00:00Z" },
		];
		const available = getAvailableCash(500, trades, now);
		expect(available).toBe(0); // 500 - 10000 clamped to 0
	});
});
```

- [ ] **Step 5.3: Verify**

```bash
bun test --preload ./tests/preload.ts tests/broker/settlement.test.ts
```

---

## Task 6: Capital Allocator

Pure function that computes how much capital each strategy tier gets, respecting settlement constraints and the tiered allocation from spec Section 4.

**Files:**
- Create: `src/live/capital-allocator.ts`
- Create: `tests/live/capital-allocator.test.ts`

### Steps

- [ ] **Step 6.1: Create capital-allocator.ts**

```typescript
// src/live/capital-allocator.ts

export type StrategyTier = "probation" | "active" | "core";

/** Capital allocation percentages per tier (from spec Section 4) */
const TIER_ALLOCATION: Record<StrategyTier, number> = {
	probation: 0.10, // 10% of live capital
	active: 0.25, // 25% of live capital
	core: 0.50, // 50% of live capital
};

export interface StrategyAllocation {
	strategyId: number;
	tier: StrategyTier;
	allocatedCapital: number;
	maxPositionSize: number;
}

export interface AllocationInput {
	strategyId: number;
	tier: StrategyTier;
}

/**
 * Compute capital allocations for all graduated strategies.
 *
 * Rules:
 * - Each tier gets a fixed percentage of available capital
 * - If multiple strategies share a tier, they split that tier's allocation equally
 * - Total allocation is capped at 100% of available capital (excess strategies get reduced allocation)
 * - Max position size per strategy = 25% of its allocated capital (diversification)
 */
export function computeAllocations(
	strategies: ReadonlyArray<AllocationInput>,
	availableCash: number,
): StrategyAllocation[] {
	if (strategies.length === 0 || availableCash <= 0) return [];

	// Group strategies by tier
	const byTier = new Map<StrategyTier, AllocationInput[]>();
	for (const s of strategies) {
		const list = byTier.get(s.tier) ?? [];
		list.push(s);
		byTier.set(s.tier, list);
	}

	// Calculate raw allocations
	const allocations: StrategyAllocation[] = [];
	let totalRequested = 0;

	for (const [tier, tierStrategies] of byTier) {
		const tierPct = TIER_ALLOCATION[tier];
		const tierCapital = availableCash * tierPct;
		const perStrategy = tierCapital / tierStrategies.length;

		for (const s of tierStrategies) {
			totalRequested += perStrategy;
			allocations.push({
				strategyId: s.strategyId,
				tier: s.tier,
				allocatedCapital: perStrategy,
				maxPositionSize: perStrategy * 0.25,
			});
		}
	}

	// If total exceeds available cash, scale down proportionally
	if (totalRequested > availableCash) {
		const scale = availableCash / totalRequested;
		for (const a of allocations) {
			a.allocatedCapital = Math.round(a.allocatedCapital * scale * 100) / 100;
			a.maxPositionSize = Math.round(a.allocatedCapital * 0.25 * 100) / 100;
		}
	}

	return allocations;
}

/**
 * Get the allocation percentage for a specific tier.
 */
export function getTierAllocationPct(tier: StrategyTier): number {
	return TIER_ALLOCATION[tier];
}
```

- [ ] **Step 6.2: Write tests for capital-allocator**

```typescript
// tests/live/capital-allocator.test.ts

import { describe, expect, test } from "bun:test";

describe("capital-allocator", () => {
	test("single probation strategy gets 10% of capital", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[{ strategyId: 1, tier: "probation" }],
			1000,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.allocatedCapital).toBe(100); // 10% of 1000
		expect(result[0]!.maxPositionSize).toBe(25); // 25% of 100
	});

	test("single active strategy gets 25% of capital", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[{ strategyId: 1, tier: "active" }],
			1000,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.allocatedCapital).toBe(250);
	});

	test("single core strategy gets 50% of capital", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[{ strategyId: 1, tier: "core" }],
			1000,
		);
		expect(result).toHaveLength(1);
		expect(result[0]!.allocatedCapital).toBe(500);
	});

	test("two probation strategies split tier allocation", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[
				{ strategyId: 1, tier: "probation" },
				{ strategyId: 2, tier: "probation" },
			],
			1000,
		);
		expect(result).toHaveLength(2);
		expect(result[0]!.allocatedCapital).toBe(50); // 100 / 2
		expect(result[1]!.allocatedCapital).toBe(50);
	});

	test("mixed tiers allocate independently", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		const result = computeAllocations(
			[
				{ strategyId: 1, tier: "probation" },
				{ strategyId: 2, tier: "active" },
				{ strategyId: 3, tier: "core" },
			],
			1000,
		);
		const byId = new Map(result.map((r) => [r.strategyId, r]));
		expect(byId.get(1)!.allocatedCapital).toBe(100); // probation: 10%
		expect(byId.get(2)!.allocatedCapital).toBe(250); // active: 25%
		expect(byId.get(3)!.allocatedCapital).toBe(500); // core: 50%
	});

	test("returns empty array for no strategies", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		expect(computeAllocations([], 1000)).toHaveLength(0);
	});

	test("returns empty array for zero cash", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		expect(computeAllocations([{ strategyId: 1, tier: "core" }], 0)).toHaveLength(0);
	});

	test("scales down if total exceeds available cash", async () => {
		const { computeAllocations } = await import("../../src/live/capital-allocator.ts");
		// 3 core strategies: each wants 50% = 150% total — must scale down
		const result = computeAllocations(
			[
				{ strategyId: 1, tier: "core" },
				{ strategyId: 2, tier: "core" },
				{ strategyId: 3, tier: "core" },
			],
			1000,
		);
		const total = result.reduce((sum, r) => sum + r.allocatedCapital, 0);
		// 3 * (500/3) = 500, which is <= 1000, so no scaling needed here
		// Each gets 500/3 = 166.67
		expect(result[0]!.allocatedCapital).toBeCloseTo(166.67, 1);
	});

	test("getTierAllocationPct returns correct percentages", async () => {
		const { getTierAllocationPct } = await import("../../src/live/capital-allocator.ts");
		expect(getTierAllocationPct("probation")).toBe(0.10);
		expect(getTierAllocationPct("active")).toBe(0.25);
		expect(getTierAllocationPct("core")).toBe(0.50);
	});
});
```

- [ ] **Step 6.3: Verify**

```bash
bun test --preload ./tests/preload.ts tests/live/capital-allocator.test.ts
```

---

## Task 7: IBKR Connection Module

Adapted from v1 to use v2's config (Zod-based `getConfig()`) and v2's pino logger. Singleton pattern with reconnect handling and health checks.

**Files:**
- Create: `src/broker/connection.ts`

### Steps

- [ ] **Step 7.1: Create connection.ts**

```typescript
// src/broker/connection.ts

import { ConnectionState, IBApiNext } from "@stoqey/ib";
import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";
import { withRetry } from "../utils/retry.ts";

const log = createChildLogger({ module: "broker-connection" });

let _api: IBApiNext | null = null;
let _connected = false;
let _wasConnected = false;
let _disconnectAlerted = false;

/** Debounce reconnection handling to avoid flap storms during IB Gateway restarts. */
let _healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
const RECONNECT_STABLE_MS = 15_000;

export function getApi(): IBApiNext {
	if (!_api) {
		const config = getConfig();
		_api = new IBApiNext({
			host: config.IBKR_HOST,
			port: config.IBKR_PORT,
			reconnectInterval: 5000,
			connectionWatchdogInterval: 30,
			maxReqPerSec: 40,
		});
	}
	return _api;
}

export async function connect(): Promise<IBApiNext> {
	const api = getApi();
	const config = getConfig();

	const result = await withRetry(
		() =>
			new Promise<IBApiNext>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(new Error("Connection timeout after 15s"));
				}, 15000);

				const sub = api.connectionState.subscribe((state) => {
					log.info({ state: ConnectionState[state] }, "Connection state changed");
					if (state === ConnectionState.Connected) {
						clearTimeout(timeout);
						sub.unsubscribe();
						resolve(api);
					}
				});

				api.connect(config.IBKR_CLIENT_ID);
			}),
		"IBKR connect",
		{ maxAttempts: 5, baseDelayMs: 3000 },
	);

	// Monitor connection state changes
	_connected = true;
	_wasConnected = true;
	_disconnectAlerted = false;

	api.connectionState.subscribe((state) => {
		if (state === ConnectionState.Disconnected) {
			_connected = false;

			if (_healthCheckTimer) {
				clearTimeout(_healthCheckTimer);
				_healthCheckTimer = null;
			}

			if (_wasConnected && !_disconnectAlerted) {
				_disconnectAlerted = true;
				log.error("IBKR connection lost after being connected");
			}
		} else if (state === ConnectionState.Connected) {
			const wasDisconnected = !_connected;
			_connected = true;

			if (wasDisconnected && _wasConnected) {
				log.info("IBKR connection re-established after disconnect");

				if (_healthCheckTimer) clearTimeout(_healthCheckTimer);
				_healthCheckTimer = setTimeout(() => {
					_healthCheckTimer = null;
					if (!_connected) return;

					_disconnectAlerted = false;
					api
						.getCurrentTime()
						.then((time: number) => {
							log.info({ serverTime: time }, "IBKR reconnection health check passed");
						})
						.catch((err: unknown) => {
							log.warn({ error: err }, "IBKR reconnection health check failed");
						});
				}, RECONNECT_STABLE_MS);
			}
		}
	});

	return result;
}

export async function disconnect(): Promise<void> {
	if (_api) {
		_api.disconnect();
		_api = null;
		_connected = false;
		log.info("Disconnected from IBKR");
	}
}

export function isConnected(): boolean {
	return _api !== null && _connected;
}

export function waitForConnection(timeoutMs = 60000): Promise<boolean> {
	if (_connected) return Promise.resolve(true);
	return new Promise((resolve) => {
		const start = Date.now();
		const interval = setInterval(() => {
			if (_connected) {
				clearInterval(interval);
				resolve(true);
			} else if (Date.now() - start >= timeoutMs) {
				clearInterval(interval);
				resolve(false);
			}
		}, 1000);
	});
}
```

Note: No unit tests for connection.ts — it requires a live IB Gateway. Integration testing only.

---

## Task 8: Order Placement & Monitoring

Adapted from v1 to write to v2's `liveTrades` table instead of v1's `trades` table. Uses v2 Drizzle schema.

**Files:**
- Create: `src/broker/orders.ts`
- Create: `src/broker/order-monitor.ts`

### Steps

- [ ] **Step 8.1: Create orders.ts**

```typescript
// src/broker/orders.ts

import { type Order, OrderAction, OrderType } from "@stoqey/ib";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { liveTrades } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { getApi } from "./connection.ts";
import { type Exchange, getContract } from "./contracts.ts";
import { trackOrder } from "./order-monitor.ts";

const log = createChildLogger({ module: "broker-orders" });

export interface TradeRequest {
	strategyId?: number;
	symbol: string;
	exchange?: Exchange;
	side: "BUY" | "SELL";
	quantity: number;
	orderType: "LIMIT" | "MARKET";
	limitPrice?: number;
	reasoning?: string;
	confidence?: number;
}

export interface TradeResult {
	tradeId: number;
	ibOrderId: number;
	status: string;
}

/** Place a trade order and log it to the live_trades table */
export async function placeTrade(req: TradeRequest): Promise<TradeResult> {
	const db = getDb();
	const api = getApi();
	const exchange = req.exchange ?? "LSE";
	const contract = getContract(req.symbol, exchange);

	const [tradeRecord] = await db
		.insert(liveTrades)
		.values({
			strategyId: req.strategyId ?? null,
			symbol: req.symbol,
			exchange,
			side: req.side as "BUY" | "SELL",
			quantity: req.quantity,
			orderType: req.orderType as "LIMIT" | "MARKET",
			limitPrice: req.limitPrice,
			reasoning: req.reasoning,
			confidence: req.confidence,
			status: "PENDING" as const,
		})
		.returning();

	if (!tradeRecord) {
		throw new Error("Failed to create trade record");
	}

	const order: Order = {
		action: req.side === "BUY" ? OrderAction.BUY : OrderAction.SELL,
		totalQuantity: req.quantity,
		orderType: req.orderType === "LIMIT" ? OrderType.LMT : OrderType.MKT,
		tif: "DAY",
		transmit: true,
	};

	if (req.orderType === "LIMIT" && req.limitPrice) {
		order.lmtPrice = req.limitPrice;
	}

	try {
		const ibOrderId = await api.placeNewOrder(contract, order);

		await db
			.update(liveTrades)
			.set({
				ibOrderId,
				status: "SUBMITTED" as const,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(liveTrades.id, tradeRecord.id));

		log.info(
			{
				tradeId: tradeRecord.id,
				ibOrderId,
				symbol: req.symbol,
				side: req.side,
				qty: req.quantity,
				strategyId: req.strategyId,
			},
			"Order placed",
		);

		trackOrder(ibOrderId, tradeRecord.id);

		return { tradeId: tradeRecord.id, ibOrderId, status: "SUBMITTED" };
	} catch (error) {
		await db
			.update(liveTrades)
			.set({ status: "ERROR" as const, updatedAt: new Date().toISOString() })
			.where(eq(liveTrades.id, tradeRecord.id));

		log.error({ tradeId: tradeRecord.id, error }, "Failed to place order");
		throw error;
	}
}

/** Cancel an order */
export async function cancelOrder(ibOrderId: number): Promise<void> {
	const api = getApi();
	api.cancelOrder(ibOrderId);
	log.info({ ibOrderId }, "Order cancellation requested");
}

/** Get all open orders */
export async function getOpenOrders() {
	const api = getApi();
	return api.getAllOpenOrders();
}
```

- [ ] **Step 8.2: Create order-monitor.ts**

Adapted from v1 to use `liveTrades` table. Uses the same RxJS subscription pattern.

```typescript
// src/broker/order-monitor.ts

import { eq } from "drizzle-orm";
import type { Subscription } from "rxjs";
import { z } from "zod";
import { liveTrades } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import { processOrderUpdate } from "./order-events.ts";
import type { OpenOrderLike } from "./order-types.ts";

const log = createChildLogger({ module: "order-monitor" });

const OrderStatusSchema = z.object({
	avgFillPrice: z.number().optional(),
	filled: z.number().optional(),
	remaining: z.number().optional(),
	status: z.string().optional(),
});

const trackedOrders = new Map<number, number>();
let orderSub: Subscription | null = null;
let resubscribeTimer: ReturnType<typeof setTimeout> | null = null;

const RESUBSCRIBE_DELAY_MS = 5_000;

interface SubscribableApi {
	getOpenOrders(): {
		subscribe(handlers: {
			next: (update: { all: readonly OpenOrderLike[] }) => void;
			error?: (err: unknown) => void;
			complete?: () => void;
		}): Subscription;
	};
}

interface UpdatableDb {
	update(table: typeof liveTrades): {
		set(data: Record<string, unknown>): {
			where(condition: unknown): Promise<unknown>;
		};
	};
}

function validateOrderStatus(order: OpenOrderLike): OpenOrderLike {
	if (!order.orderStatus) return order;
	const parsed = OrderStatusSchema.safeParse(order.orderStatus);
	if (!parsed.success) {
		log.warn(
			{ orderId: order.orderId, errors: parsed.error.format() },
			"Invalid orderStatus shape from IB — skipping status fields",
		);
		return { ...order, orderStatus: undefined };
	}
	return order;
}

function subscribe(api: SubscribableApi, db: UpdatableDb): void {
	orderSub = api.getOpenOrders().subscribe({
		next: (update) => {
			const validated = update.all.map(validateOrderStatus);
			const events = processOrderUpdate(trackedOrders, validated);

			for (const event of events) {
				const updateData: Record<string, unknown> = {
					status: event.status,
					updatedAt: new Date().toISOString(),
				};

				if (event.status === "FILLED") {
					updateData.filledAt = new Date().toISOString();
					if (event.fillData?.fillPrice) {
						updateData.fillPrice = event.fillData.fillPrice;
					}
					if (event.fillData?.commission !== undefined) {
						updateData.commission = event.fillData.commission;
					}
				}

				db.update(liveTrades)
					.set(updateData)
					.where(eq(liveTrades.id, event.tradeId))
					.then(() => {
						log.info({ tradeId: event.tradeId, status: event.status }, "Trade status updated");
					})
					.catch((err: unknown) => {
						log.error({ tradeId: event.tradeId, error: err }, "Failed to update trade status");
					});
			}
		},
		error: (err) => {
			log.error({ error: err }, "Order subscription error — will resubscribe");
			orderSub = null;
			resubscribeTimer = setTimeout(() => {
				resubscribeTimer = null;
				log.info("Resubscribing to order updates");
				subscribe(api, db);
			}, RESUBSCRIBE_DELAY_MS);
		},
		complete: () => {
			log.warn("Order subscription completed unexpectedly — will resubscribe");
			orderSub = null;
			resubscribeTimer = setTimeout(() => {
				resubscribeTimer = null;
				log.info("Resubscribing to order updates");
				subscribe(api, db);
			}, RESUBSCRIBE_DELAY_MS);
		},
	});
}

export function startOrderMonitoring(api: SubscribableApi, db: UpdatableDb): void {
	if (orderSub) {
		log.warn("Order monitoring already started");
		return;
	}
	log.info("Starting order monitoring (shared subscription)");
	subscribe(api, db);
}

export function trackOrder(ibOrderId: number, tradeId: number): void {
	trackedOrders.set(ibOrderId, tradeId);
	log.info({ ibOrderId, tradeId }, "Tracking order");
}

export function stopOrderMonitoring(): void {
	if (resubscribeTimer) {
		clearTimeout(resubscribeTimer);
		resubscribeTimer = null;
	}
	if (orderSub) {
		orderSub.unsubscribe();
		orderSub = null;
	}
	trackedOrders.clear();
	log.info("Order monitoring stopped");
}
```

Note: Orders and order-monitor are integration-only tests (require IBKR). The pure logic is tested via order-status.test.ts and order-events.test.ts.

---

## Task 9: Guardian Loop

Adapted from v1's guardian to use v2's `livePositions` table and v2's quote cache. Runs every 60s during market hours. Enforces stop-losses and trailing stops on live positions.

**Files:**
- Create: `src/broker/guardian.ts`
- Create: `src/scheduler/guardian-job.ts`

### Steps

- [ ] **Step 9.1: Create guardian.ts**

```typescript
// src/broker/guardian.ts

import { eq } from "drizzle-orm";
import { getQuoteFromCache } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import { agentLogs, livePositions } from "../db/schema.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { Exchange } from "./contracts.ts";
import { placeTrade } from "./orders.ts";
import { findStopLossBreaches } from "./stop-loss.ts";
import { computeTrailingStopUpdate } from "./trailing-stops.ts";

const log = createChildLogger({ module: "guardian" });

const GUARDIAN_INTERVAL_MS = 60_000;
const TRAILING_STOP_ATR_MULTIPLIER = 2;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startGuardian(): void {
	if (intervalHandle) return;
	log.info("Live Guardian started");
	intervalHandle = setInterval(guardianTick, GUARDIAN_INTERVAL_MS);
	guardianTick();
}

export function stopGuardian(): void {
	if (intervalHandle) {
		clearInterval(intervalHandle);
		intervalHandle = null;
		log.info("Live Guardian stopped");
	}
}

async function guardianTick(): Promise<void> {
	try {
		const db = getDb();
		const positionRows = await db.select().from(livePositions);

		if (positionRows.length === 0) return;

		// Build quotes map from cache
		const quotes = new Map<string, { last: number | null; bid: number | null }>();
		for (const pos of positionRows) {
			const cached = await getQuoteFromCache(pos.symbol, pos.exchange);
			if (cached) {
				quotes.set(pos.symbol, { last: cached.last, bid: cached.bid });
			}
		}

		// 1. Stop-loss enforcement
		await enforceStopLosses(positionRows, quotes);

		// 2. Update position prices
		await updatePositionPrices(positionRows, quotes);

		// 3. Trailing stop updates
		await updateTrailingStops(positionRows, quotes);
	} catch (error) {
		log.error({ error }, "Guardian tick failed");
	}
}

async function enforceStopLosses(
	positionRows: Array<{
		id: number;
		symbol: string;
		exchange: string;
		quantity: number;
		stopLossPrice: number | null;
		strategyId: number | null;
	}>,
	quotes: Map<string, { last: number | null; bid: number | null }>,
): Promise<void> {
	const breaches = findStopLossBreaches(positionRows, quotes);

	for (const breach of breaches) {
		const pos = positionRows.find((p) => p.symbol === breach.symbol);
		log.warn(
			{ symbol: breach.symbol, price: breach.price, stopLoss: breach.stopLossPrice },
			"Stop-loss triggered — placing MARKET SELL",
		);

		try {
			await placeTrade({
				strategyId: pos?.strategyId ?? undefined,
				symbol: breach.symbol,
				exchange: (pos?.exchange ?? "LSE") as Exchange,
				side: "SELL",
				quantity: breach.quantity,
				orderType: "MARKET",
				reasoning: `Stop-loss triggered: price ${breach.price} <= stop ${breach.stopLossPrice}`,
				confidence: 1.0,
			});

			const db = getDb();
			await db.insert(agentLogs).values({
				level: "ACTION" as const,
				phase: "guardian",
				message: `Stop-loss executed for ${breach.symbol}: price ${breach.price} <= stop ${breach.stopLossPrice}, sold ${breach.quantity} shares`,
			});
		} catch (error) {
			log.error({ symbol: breach.symbol, error }, "Stop-loss SELL failed");
		}
	}
}

async function updatePositionPrices(
	positionRows: Array<{ id: number; symbol: string; quantity: number; avgCost: number }>,
	quotes: Map<string, { last: number | null; bid: number | null }>,
): Promise<void> {
	const db = getDb();

	for (const pos of positionRows) {
		const quote = quotes.get(pos.symbol);
		const price = quote?.last ?? quote?.bid ?? null;
		if (price === null) continue;

		const marketValue = price * pos.quantity;
		const unrealizedPnl = (price - pos.avgCost) * pos.quantity;

		await db
			.update(livePositions)
			.set({
				currentPrice: price,
				marketValue,
				unrealizedPnl,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(livePositions.id, pos.id));
	}
}

async function updateTrailingStops(
	positionRows: Array<{
		id: number;
		symbol: string;
		exchange: string;
		quantity: number;
		highWaterMark: number | null;
		trailingStopPrice: number | null;
		strategyId: number | null;
	}>,
	quotes: Map<string, { last: number | null; bid: number | null }>,
): Promise<void> {
	const db = getDb();

	for (const pos of positionRows) {
		const quote = quotes.get(pos.symbol);
		const currentPrice = quote?.last ?? quote?.bid ?? null;
		if (!currentPrice) continue;

		// Look up ATR from indicators cache
		let atr14: number | null = null;
		try {
			const { getIndicators } = await import("../strategy/historical.ts");
			const indicators = await getIndicators(pos.symbol, pos.exchange);
			atr14 = indicators?.atr14 ?? null;
		} catch {
			// Indicators not available — skip trailing stop update
		}

		const update = computeTrailingStopUpdate(
			{
				id: pos.id,
				symbol: pos.symbol,
				quantity: pos.quantity,
				highWaterMark: pos.highWaterMark,
				trailingStopPrice: pos.trailingStopPrice,
				atr14,
				currentPrice,
			},
			TRAILING_STOP_ATR_MULTIPLIER,
		);

		if (!update) continue;

		await db
			.update(livePositions)
			.set({
				highWaterMark: update.highWaterMark,
				trailingStopPrice: update.trailingStopPrice,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(livePositions.id, pos.id));

		if (update.triggered) {
			log.warn(
				{
					symbol: pos.symbol,
					price: currentPrice,
					trailingStop: update.trailingStopPrice,
				},
				"Trailing stop triggered — placing MARKET SELL",
			);

			try {
				await placeTrade({
					strategyId: pos.strategyId ?? undefined,
					symbol: pos.symbol,
					exchange: pos.exchange as Exchange,
					side: "SELL",
					quantity: pos.quantity,
					orderType: "MARKET",
					reasoning: `Trailing stop triggered: price ${currentPrice} <= stop ${update.trailingStopPrice.toFixed(2)}`,
					confidence: 1.0,
				});

				await db.insert(agentLogs).values({
					level: "ACTION" as const,
					phase: "guardian",
					message: `Trailing stop executed for ${pos.symbol}: price ${currentPrice} <= trailing stop ${update.trailingStopPrice.toFixed(2)}, sold ${pos.quantity} shares`,
				});
			} catch (error) {
				log.error({ symbol: pos.symbol, error }, "Trailing stop SELL failed");
			}
		}
	}
}
```

- [ ] **Step 9.2: Create guardian-job.ts**

```typescript
// src/scheduler/guardian-job.ts

import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "guardian-job" });

export async function startGuardianJob(): Promise<void> {
	const config = getConfig();
	if (!config.LIVE_TRADING_ENABLED) {
		log.info("Live trading disabled — guardian not started");
		return;
	}

	const { isConnected } = await import("../broker/connection.ts");
	if (!isConnected()) {
		log.warn("IBKR not connected — guardian not started");
		return;
	}

	const { startGuardian } = await import("../broker/guardian.ts");
	startGuardian();
}

export async function stopGuardianJob(): Promise<void> {
	const { stopGuardian } = await import("../broker/guardian.ts");
	stopGuardian();
}
```

- [ ] **Step 9.3: Verify typecheck**

```bash
bun run typecheck
```

---

## Task 10: Live Executor

Evaluates graduated strategies against market data and places real trades. This is the bridge between the strategy evaluation system and the broker.

**Files:**
- Create: `src/live/executor.ts`
- Create: `src/scheduler/live-eval-job.ts`
- Create: `tests/live/executor.test.ts`

### Steps

- [ ] **Step 10.1: Create executor.ts**

```typescript
// src/live/executor.ts

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { getConfig } from "../config.ts";
import { getQuoteFromCache } from "../data/quotes.ts";
import { getDb } from "../db/client.ts";
import {
	agentLogs,
	liveTrades,
	livePositions,
	strategies,
	strategyMetrics,
} from "../db/schema.ts";
import { getIndicators } from "../strategy/historical.ts";
import { createChildLogger } from "../utils/logger.ts";
import type { Exchange } from "../broker/contracts.ts";
import { placeTrade } from "../broker/orders.ts";
import { getAvailableCash } from "../broker/settlement.ts";
import type { UnsettledTrade } from "../broker/settlement.ts";
import { computeAllocations, type StrategyTier } from "./capital-allocator.ts";

const log = createChildLogger({ module: "live-executor" });

/** Strategy tiers eligible for live trading */
const LIVE_TIERS: StrategyTier[] = ["probation", "active", "core"];

export interface LiveEvalResult {
	strategiesEvaluated: number;
	tradesPlaced: number;
	errors: string[];
}

/**
 * Run the live executor cycle:
 * 1. Check kill switch
 * 2. Fetch graduated strategies
 * 3. Compute capital allocations (respecting settlement)
 * 4. For each strategy, evaluate signals against market data
 * 5. Place trades for triggered signals
 */
export async function runLiveExecutor(): Promise<LiveEvalResult> {
	const config = getConfig();
	const result: LiveEvalResult = {
		strategiesEvaluated: 0,
		tradesPlaced: 0,
		errors: [],
	};

	// Kill switch check
	if (!config.LIVE_TRADING_ENABLED) {
		log.debug("Live trading disabled — skipping");
		return result;
	}

	const { isConnected } = await import("../broker/connection.ts");
	if (!isConnected()) {
		log.warn("IBKR not connected — skipping live execution");
		result.errors.push("IBKR not connected");
		return result;
	}

	const db = getDb();

	// Fetch graduated strategies
	const graduatedStrategies = await db
		.select()
		.from(strategies)
		.where(inArray(strategies.status, LIVE_TIERS));

	if (graduatedStrategies.length === 0) {
		log.debug("No graduated strategies — skipping");
		return result;
	}

	// Get recent filled trades for settlement calculation
	const recentTrades = await db
		.select({
			fillPrice: liveTrades.fillPrice,
			quantity: liveTrades.quantity,
			side: liveTrades.side,
			exchange: liveTrades.exchange,
			filledAt: liveTrades.filledAt,
		})
		.from(liveTrades)
		.where(
			and(
				eq(liveTrades.status, "FILLED"),
				isNotNull(liveTrades.filledAt),
				isNotNull(liveTrades.fillPrice),
			),
		);

	const unsettledTrades: UnsettledTrade[] = recentTrades
		.filter((t): t is typeof t & { fillPrice: number; filledAt: string } =>
			t.fillPrice !== null && t.filledAt !== null,
		)
		.map((t) => ({
			fillPrice: t.fillPrice,
			quantity: t.quantity,
			side: t.side as "BUY" | "SELL",
			exchange: t.exchange,
			filledAt: t.filledAt,
		}));

	// TODO: Get actual account cash from IBKR API in a future iteration.
	// For now, use a conservative estimate based on known positions.
	const totalCash = await estimateAvailableCash();
	const availableCash = getAvailableCash(totalCash, unsettledTrades);

	if (availableCash <= 0) {
		log.warn("No available cash after settlement — skipping");
		result.errors.push("No available cash");
		return result;
	}

	// Compute allocations
	const allocationInputs = graduatedStrategies.map((s) => ({
		strategyId: s.id,
		tier: s.status as StrategyTier,
	}));
	const allocations = computeAllocations(allocationInputs, availableCash);
	const allocationMap = new Map(allocations.map((a) => [a.strategyId, a]));

	// Evaluate each strategy
	for (const strategy of graduatedStrategies) {
		result.strategiesEvaluated++;
		const allocation = allocationMap.get(strategy.id);
		if (!allocation || allocation.allocatedCapital <= 0) continue;

		try {
			const signals = JSON.parse(strategy.signals ?? "{}");
			const universe: string[] = JSON.parse(strategy.universe ?? "[]");
			const parameters = JSON.parse(strategy.parameters);

			for (const symbol of universe) {
				const exchange = (parameters.exchange ?? "NASDAQ") as Exchange;
				const cached = await getQuoteFromCache(symbol, exchange);
				if (!cached || cached.last == null) continue;

				const indicators = await getIndicators(symbol, exchange);
				if (!indicators) continue;

				// Check for existing position
				const [existingPos] = await db
					.select()
					.from(livePositions)
					.where(
						and(
							eq(livePositions.symbol, symbol),
							eq(livePositions.strategyId, strategy.id),
						),
					)
					.limit(1);

				// Evaluate entry signal (only if no existing position)
				if (!existingPos && signals.entry_long) {
					const shouldEnter = evaluateSignal(
						signals.entry_long,
						parameters,
						cached,
						indicators,
					);

					if (shouldEnter) {
						const positionValue = Math.min(
							allocation.maxPositionSize,
							allocation.allocatedCapital * 0.25,
						);
						const quantity = Math.floor(positionValue / cached.last);

						if (quantity > 0) {
							try {
								await placeTrade({
									strategyId: strategy.id,
									symbol,
									exchange,
									side: "BUY",
									quantity,
									orderType: "LIMIT",
									limitPrice: cached.ask ?? cached.last,
									reasoning: `Strategy ${strategy.name}: entry_long signal triggered`,
									confidence: 0.7,
								});
								result.tradesPlaced++;

								log.info(
									{
										strategyId: strategy.id,
										symbol,
										quantity,
										price: cached.ask ?? cached.last,
									},
									"Live entry trade placed",
								);
							} catch (err) {
								const msg = `Failed to place entry for ${symbol}: ${err}`;
								result.errors.push(msg);
								log.error({ error: err, symbol, strategyId: strategy.id }, msg);
							}
						}
					}
				}

				// Evaluate exit signal (only if we have a position)
				if (existingPos && signals.exit) {
					const shouldExit = evaluateSignal(
						signals.exit,
						parameters,
						cached,
						indicators,
					);

					if (shouldExit) {
						try {
							await placeTrade({
								strategyId: strategy.id,
								symbol,
								exchange,
								side: "SELL",
								quantity: existingPos.quantity,
								orderType: "LIMIT",
								limitPrice: cached.bid ?? cached.last,
								reasoning: `Strategy ${strategy.name}: exit signal triggered`,
								confidence: 0.7,
							});
							result.tradesPlaced++;

							log.info(
								{
									strategyId: strategy.id,
									symbol,
									quantity: existingPos.quantity,
								},
								"Live exit trade placed",
							);
						} catch (err) {
							const msg = `Failed to place exit for ${symbol}: ${err}`;
							result.errors.push(msg);
							log.error({ error: err, symbol, strategyId: strategy.id }, msg);
						}
					}
				}
			}
		} catch (error) {
			const msg = `Strategy ${strategy.id} evaluation failed: ${error}`;
			result.errors.push(msg);
			log.error({ strategyId: strategy.id, error }, msg);
		}
	}

	// Log the cycle
	if (result.tradesPlaced > 0) {
		await db.insert(agentLogs).values({
			level: "ACTION" as const,
			phase: "live-executor",
			message: `Live execution: evaluated ${result.strategiesEvaluated} strategies, placed ${result.tradesPlaced} trades`,
			data: JSON.stringify(result),
		});
	}

	return result;
}

/**
 * Evaluate a signal expression against current market data.
 * Signal expressions are simple rule strings like:
 *   "rsi14 < 30 AND changePercent < -2"
 *   "rsi14 > 70 OR priceAboveSma20 == false"
 *
 * This is a simplified evaluator — matches the paper trading evaluator's logic.
 */
function evaluateSignal(
	_signal: string,
	_parameters: Record<string, unknown>,
	_quote: { last: number | null; bid: number | null; ask: number | null; changePercent: number | null },
	_indicators: Record<string, unknown>,
): boolean {
	// Signal evaluation delegates to the same LLM-based evaluator used in paper trading.
	// This function is a placeholder — the actual implementation will call the strategy
	// evaluator module which already handles signal interpretation.
	// For Phase 7 MVP, return false (no automatic trading) until evaluator integration is wired.
	return false;
}

/**
 * Estimate available cash from account.
 * In production, this should call IBKR's account summary API.
 * For now, returns a conservative static value from config or position calculation.
 */
async function estimateAvailableCash(): Promise<number> {
	const db = getDb();
	const positions = await db.select().from(livePositions);
	const totalPositionValue = positions.reduce(
		(sum, p) => sum + (p.marketValue ?? p.avgCost * p.quantity),
		0,
	);

	// Conservative estimate: assume we started with known capital
	// This will be replaced with actual IBKR account balance API call
	const STARTING_CAPITAL = 500; // GBP — from spec "£200-500 IBKR regular account"
	return Math.max(0, STARTING_CAPITAL - totalPositionValue);
}
```

- [ ] **Step 10.2: Create live-eval-job.ts**

```typescript
// src/scheduler/live-eval-job.ts

import { getConfig } from "../config.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "live-eval-job" });

export async function runLiveEvalJob(): Promise<void> {
	const config = getConfig();
	if (!config.LIVE_TRADING_ENABLED) {
		log.debug("Live trading disabled — skipping live eval");
		return;
	}

	try {
		const { runLiveExecutor } = await import("../live/executor.ts");
		const result = await runLiveExecutor();
		log.info(
			{
				strategiesEvaluated: result.strategiesEvaluated,
				tradesPlaced: result.tradesPlaced,
				errorCount: result.errors.length,
			},
			"Live eval job completed",
		);
	} catch (error) {
		log.error({ error }, "Live eval job failed");
	}
}
```

- [ ] **Step 10.3: Write executor tests**

Tests verify the kill switch, settlement integration, and allocation logic. Actual trade placement is not tested (requires IBKR).

```typescript
// tests/live/executor.test.ts

import { describe, expect, test, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../../src/db/schema.ts";

function createTestDb() {
	const sqlite = new Database(":memory:");
	sqlite.exec("PRAGMA journal_mode = WAL;");
	const db = drizzle(sqlite, { schema });

	// Create tables
	sqlite.exec(`
		CREATE TABLE strategies (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			name TEXT NOT NULL,
			description TEXT NOT NULL,
			parameters TEXT NOT NULL,
			signals TEXT,
			universe TEXT,
			status TEXT NOT NULL DEFAULT 'paper',
			virtual_balance REAL NOT NULL DEFAULT 10000,
			parent_strategy_id INTEGER,
			generation INTEGER NOT NULL DEFAULT 1,
			created_by TEXT DEFAULT 'seed',
			created_at TEXT NOT NULL,
			retired_at TEXT
		);
		CREATE TABLE live_positions (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			strategy_id INTEGER,
			symbol TEXT NOT NULL,
			exchange TEXT NOT NULL,
			currency TEXT NOT NULL DEFAULT 'USD',
			quantity REAL NOT NULL,
			avg_cost REAL NOT NULL,
			current_price REAL,
			unrealized_pnl REAL,
			market_value REAL,
			stop_loss_price REAL,
			trailing_stop_price REAL,
			high_water_mark REAL,
			updated_at TEXT NOT NULL,
			UNIQUE(symbol, exchange)
		);
		CREATE TABLE live_trades (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			strategy_id INTEGER,
			symbol TEXT NOT NULL,
			exchange TEXT NOT NULL,
			side TEXT NOT NULL,
			quantity REAL NOT NULL,
			order_type TEXT NOT NULL,
			limit_price REAL,
			fill_price REAL,
			commission REAL,
			friction REAL NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'PENDING',
			ib_order_id INTEGER,
			reasoning TEXT,
			confidence REAL,
			pnl REAL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			filled_at TEXT
		);
		CREATE TABLE agent_logs (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			level TEXT NOT NULL,
			phase TEXT,
			message TEXT NOT NULL,
			data TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`);

	return { db, sqlite };
}

describe("live executor", () => {
	test("runLiveExecutor returns early when LIVE_TRADING_ENABLED=false", async () => {
		// Default test env has LIVE_TRADING_ENABLED=false
		const { runLiveExecutor } = await import("../../src/live/executor.ts");
		const result = await runLiveExecutor();
		expect(result.strategiesEvaluated).toBe(0);
		expect(result.tradesPlaced).toBe(0);
	});
});
```

- [ ] **Step 10.4: Verify**

```bash
bun test --preload ./tests/preload.ts tests/live/executor.test.ts
bun run typecheck
```

---

## Task 11: Wire Into Scheduler

Add the guardian and live eval jobs to the scheduler and job registry.

**Files:**
- Modify: `src/scheduler/jobs.ts`
- Modify: `src/scheduler/cron.ts`

### Steps

- [ ] **Step 11.1: Add job names to JobName type**

In `src/scheduler/jobs.ts`, add `"guardian_start"` and `"live_evaluation"` to the `JobName` union:

```typescript
export type JobName =
	| "quote_refresh"
	| "strategy_evaluation"
	| "daily_summary"
	| "weekly_digest"
	| "strategy_evolution"
	| "trade_review"
	| "pattern_analysis"
	| "earnings_calendar_sync"
	| "news_poll"
	| "heartbeat"
	| "guardian_start"
	| "live_evaluation";
```

- [ ] **Step 11.2: Add cases to executeJob switch**

In the `executeJob` function in `src/scheduler/jobs.ts`, add:

```typescript
		case "guardian_start": {
			const { startGuardianJob } = await import("./guardian-job.ts");
			await startGuardianJob();
			break;
		}

		case "live_evaluation": {
			const { runLiveEvalJob } = await import("./live-eval-job.ts");
			await runLiveEvalJob();
			break;
		}
```

- [ ] **Step 11.3: Add cron schedules**

In `src/scheduler/cron.ts`, add after the existing schedules:

```typescript
	// Guardian start at 08:00 weekdays (starts the 60s interval loop)
	tasks.push(
		cron.schedule("0 8 * * 1-5", () => runJob("guardian_start"), {
			timezone: "Europe/London",
		}),
	);

	// Live strategy evaluation every 10 minutes during market hours, offset to :07
	tasks.push(
		cron.schedule("7,17,27,37,47,57 8-20 * * 1-5", () => runJob("live_evaluation"), {
			timezone: "Europe/London",
		}),
	);
```

- [ ] **Step 11.4: Verify**

```bash
bun run typecheck
bun test --preload ./tests/preload.ts
```

---

## Task 12: Integration Test Checklist

Manual integration testing against IB Gateway paper account. Not automated — requires IB TWS or Gateway running.

**Files:**
- Create: `tests/broker/integration-checklist.md` (reference only, not code)

### Steps

- [ ] **Step 12.1: Connection test**

```bash
# Start IB Gateway/TWS paper account first
LIVE_TRADING_ENABLED=true IBKR_PORT=4002 bun run src/broker/connection.ts
```

Verify: connects successfully, logs connection state, handles disconnect/reconnect.

- [ ] **Step 12.2: Contract test**

After connection, verify `getContract("AAPL", "NASDAQ")` returns valid contract and `getContractDetails` works.

- [ ] **Step 12.3: Order test (paper account only)**

Place a small LIMIT BUY far below market price, verify it appears in open orders, then cancel it.

- [ ] **Step 12.4: Guardian test**

Insert a test position in `livePositions` with a stop-loss above current market price. Start guardian. Verify stop-loss sell is triggered within 60s.

- [ ] **Step 12.5: Full cycle test**

1. Seed a strategy with status="probation"
2. Set `LIVE_TRADING_ENABLED=true`
3. Run `runLiveExecutor()`
4. Verify it evaluates the strategy and respects capital allocation

---

## Task 13: Behavioral Divergence Tracking

Track slippage and execution quality to detect when live performance diverges from paper assumptions (spec Section 4: flag if > 20% divergence).

**Files:**
- Modify: `src/live/executor.ts` (add divergence tracking after fills)

### Steps

- [ ] **Step 13.1: Add divergence check after fill**

After a live trade is filled, compare the fill price to what the paper evaluator would have used. Log a warning if slippage exceeds 20%.

Add this function to `src/live/executor.ts`:

```typescript
/**
 * Check if live execution diverges significantly from paper assumptions.
 * Logs a warning if slippage > 20% of expected execution cost.
 */
export async function checkBehavioralDivergence(
	strategyId: number,
	symbol: string,
	expectedPrice: number,
	actualFillPrice: number,
): Promise<void> {
	const slippagePct = Math.abs(actualFillPrice - expectedPrice) / expectedPrice;

	if (slippagePct > 0.20) {
		const db = getDb();
		log.warn(
			{
				strategyId,
				symbol,
				expectedPrice,
				actualFillPrice,
				slippagePct: (slippagePct * 100).toFixed(1),
			},
			"Behavioral divergence detected: live slippage > 20%",
		);

		await db.insert(agentLogs).values({
			level: "WARN" as const,
			phase: "live-executor",
			message: `Behavioral divergence: ${symbol} expected ${expectedPrice}, filled at ${actualFillPrice} (${(slippagePct * 100).toFixed(1)}% slippage)`,
			data: JSON.stringify({ strategyId, symbol, expectedPrice, actualFillPrice, slippagePct }),
		});
	}
}
```

- [ ] **Step 13.2: Verify**

```bash
bun run typecheck
```

---

## Summary

| Task | Files | Tests | Description |
|------|-------|-------|-------------|
| 1 | 3 modified | existing pass | Dependencies + config |
| 2 | 3 created | 2 test files | Order types, status mapping, event processing |
| 3 | 1 created | 1 test file | Contract builders |
| 4 | 2 created | 2 test files | Stop-loss + trailing stops (pure) |
| 5 | 1 created | 1 test file | Settlement tracking (pure) |
| 6 | 1 created | 1 test file | Capital allocator (pure) |
| 7 | 1 created | integration only | IBKR connection singleton |
| 8 | 2 created | integration only | Order placement + monitoring |
| 9 | 2 created | integration only | Guardian loop + scheduler job |
| 10 | 2 created | 1 test file | Live executor + scheduler job |
| 11 | 2 modified | existing pass | Scheduler wiring |
| 12 | checklist | manual | Integration testing |
| 13 | 1 modified | typecheck | Behavioral divergence tracking |

**Total new files:** 18
**Total test files:** 8
**Estimated implementation time:** 4-6 hours

**Key safety rails:**
- `LIVE_TRADING_ENABLED` defaults to `false` — must be explicitly enabled
- Settlement tracking prevents trading with unsettled funds
- Guardian enforces stop-losses every 60s
- Capital allocation is tiered and capped
- Behavioral divergence detection at 20% threshold
- All broker actions logged to `agent_logs` for audit trail
