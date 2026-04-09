# IBKR LSE Quotes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the unreliable Yahoo Finance fallback with IBKR market data for LSE/AIM quotes and historical bars.

**Architecture:** New `src/broker/market-data.ts` module wraps IBKR's `getMarketDataSnapshot` and `getHistoricalData` APIs. The existing `fmpQuote`/`fmpHistorical` functions in `src/data/fmp.ts` route LSE/AIM requests to these IBKR functions instead of Yahoo. All Yahoo code is deleted. Consumers see no interface change.

**Tech Stack:** TypeScript, `@stoqey/ib` (IBApiNext), Bun test runner

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/broker/market-data.ts` | Create | `ibkrQuote()` and `ibkrHistorical()` — thin wrappers around IBKR API |
| `src/data/fmp.ts` | Modify | Replace Yahoo branches with IBKR calls, delete all Yahoo code |
| `tests/broker/market-data.test.ts` | Create | Unit tests for `ibkrQuote` and `ibkrHistorical` |
| `src/scripts/test-ibkr-quotes.ts` | Create | Live verification script (run on VPS before deployment) |

---

### Task 1: ibkrQuote — unit tests and implementation

**Files:**
- Create: `src/broker/market-data.ts`
- Create: `tests/broker/market-data.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/broker/market-data.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the connection module before importing market-data
const mockGetApi = mock(() => ({
	getMarketDataSnapshot: mock(),
}));
const mockIsConnected = mock(() => true);

mock.module("../../src/broker/connection.ts", () => ({
	getApi: mockGetApi,
	isConnected: mockIsConnected,
}));

// Mock getContract to return a simple contract object
mock.module("../../src/broker/contracts.ts", () => ({
	getContract: (symbol: string, exchange: string) => ({
		symbol,
		secType: "STK",
		exchange: "SMART",
		primaryExch: exchange,
		currency: exchange === "LSE" ? "GBP" : "USD",
	}),
}));

const { ibkrQuote } = await import("../../src/broker/market-data.ts");

describe("ibkrQuote", () => {
	beforeEach(() => {
		mockIsConnected.mockReturnValue(true);
	});

	afterEach(() => {
		mock.restore();
	});

	test("returns quote data from IBKR snapshot", async () => {
		const snapshotMap = new Map();
		snapshotMap.set(4, { value: 1330.5 }); // TickType.LAST = 4
		snapshotMap.set(1, { value: 1330.0 }); // TickType.BID = 1
		snapshotMap.set(2, { value: 1331.0 }); // TickType.ASK = 2
		snapshotMap.set(8, { value: 5000000 }); // TickType.VOLUME = 8

		const api = mockGetApi();
		api.getMarketDataSnapshot.mockResolvedValue(snapshotMap);

		const result = await ibkrQuote("HSBA", "LSE");

		expect(result).not.toBeNull();
		expect(result!.symbol).toBe("HSBA");
		expect(result!.exchange).toBe("LSE");
		expect(result!.last).toBe(1330.5);
		expect(result!.bid).toBe(1330.0);
		expect(result!.ask).toBe(1331.0);
		expect(result!.volume).toBe(5000000);
	});

	test("returns null when IBKR is disconnected", async () => {
		mockIsConnected.mockReturnValue(false);

		const result = await ibkrQuote("HSBA", "LSE");

		expect(result).toBeNull();
	});

	test("returns null when snapshot throws", async () => {
		const api = mockGetApi();
		api.getMarketDataSnapshot.mockRejectedValue(new Error("timeout"));

		const result = await ibkrQuote("HSBA", "LSE");

		expect(result).toBeNull();
	});

	test("returns quote with null fields when ticks are missing", async () => {
		const snapshotMap = new Map();
		snapshotMap.set(4, { value: 1330.5 }); // Only LAST, no bid/ask/volume

		const api = mockGetApi();
		api.getMarketDataSnapshot.mockResolvedValue(snapshotMap);

		const result = await ibkrQuote("HSBA", "LSE");

		expect(result).not.toBeNull();
		expect(result!.last).toBe(1330.5);
		expect(result!.bid).toBeNull();
		expect(result!.ask).toBeNull();
		expect(result!.volume).toBeNull();
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test --preload ./tests/preload.ts tests/broker/market-data.test.ts`
Expected: FAIL with "Cannot find module" or "ibkrQuote is not a function"

- [ ] **Step 3: Implement ibkrQuote**

Create `src/broker/market-data.ts`:

```typescript
import { TickType } from "@stoqey/ib";
import type { FmpQuoteData } from "../data/fmp.ts";
import { createChildLogger } from "../utils/logger.ts";
import { getContract } from "./contracts.ts";
import { getApi, isConnected } from "./connection.ts";

const log = createChildLogger({ module: "broker-market-data" });

/**
 * Fetch a one-shot market data snapshot from IBKR.
 * Returns null if IBKR is disconnected or the request fails.
 */
export async function ibkrQuote(symbol: string, exchange: string): Promise<FmpQuoteData | null> {
	if (!isConnected()) {
		log.warn({ symbol, exchange }, "IBKR not connected, skipping quote");
		return null;
	}

	try {
		const api = getApi();
		const contract = getContract(symbol, exchange as "LSE" | "NASDAQ" | "NYSE");
		const snapshot = await api.getMarketDataSnapshot(contract, "", false);

		const last = snapshot.get(TickType.LAST)?.value ?? null;
		const bid = snapshot.get(TickType.BID)?.value ?? null;
		const ask = snapshot.get(TickType.ASK)?.value ?? null;
		const volume = snapshot.get(TickType.VOLUME)?.value ?? null;

		if (last === null) {
			log.warn({ symbol, exchange }, "IBKR snapshot returned no last price");
			return null;
		}

		return {
			symbol,
			exchange,
			last,
			bid,
			ask,
			volume,
			avgVolume: null,
			changePercent: null,
		};
	} catch (error) {
		log.warn(
			{ symbol, exchange, error: error instanceof Error ? error.message : String(error) },
			"IBKR snapshot failed",
		);
		return null;
	}
}
```

Note: The `FmpQuoteData` interface in `fmp.ts` currently types `bid` and `ask` as `null`. We need to widen these to `number | null` since IBKR provides real bid/ask. Update `src/data/fmp.ts` lines 15-16:

```typescript
// Change from:
bid: null;
ask: null;
// To:
bid: number | null;
ask: number | null;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/broker/market-data.test.ts`
Expected: PASS (all 4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/broker/market-data.ts tests/broker/market-data.test.ts src/data/fmp.ts
git commit -m "feat: add ibkrQuote for LSE market data snapshots"
```

---

### Task 2: ibkrHistorical — unit tests and implementation

**Files:**
- Modify: `src/broker/market-data.ts`
- Modify: `tests/broker/market-data.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/broker/market-data.test.ts`, updating the mock setup and imports:

Update the mock at the top to also mock `getHistoricalData`:

```typescript
const mockGetApi = mock(() => ({
	getMarketDataSnapshot: mock(),
	getHistoricalData: mock(),
}));
```

Update the import to also pull `ibkrHistorical`:

```typescript
const { ibkrQuote, ibkrHistorical } = await import("../../src/broker/market-data.ts");
```

Add new describe block:

```typescript
describe("ibkrHistorical", () => {
	beforeEach(() => {
		mockIsConnected.mockReturnValue(true);
	});

	afterEach(() => {
		mock.restore();
	});

	test("returns bars in oldest-first order", async () => {
		const api = mockGetApi();
		// IBKR returns bars in chronological order (oldest first)
		api.getHistoricalData.mockResolvedValue([
			{ time: "20260401", open: 100, high: 105, low: 99, close: 103, volume: 1000 },
			{ time: "20260402", open: 103, high: 108, low: 102, close: 107, volume: 1200 },
			{ time: "20260403", open: 107, high: 110, low: 106, close: 109, volume: 900 },
		]);

		const result = await ibkrHistorical("HSBA", "LSE", 30);

		expect(result).not.toBeNull();
		expect(result!.length).toBe(3);
		expect(result![0]!.date).toBe("2026-04-01");
		expect(result![0]!.open).toBe(100);
		expect(result![0]!.close).toBe(103);
		expect(result![2]!.date).toBe("2026-04-03");
		expect(result![2]!.close).toBe(109);
	});

	test("returns null when IBKR is disconnected", async () => {
		mockIsConnected.mockReturnValue(false);

		const result = await ibkrHistorical("HSBA", "LSE", 30);

		expect(result).toBeNull();
	});

	test("returns null when getHistoricalData throws", async () => {
		const api = mockGetApi();
		api.getHistoricalData.mockRejectedValue(new Error("No data"));

		const result = await ibkrHistorical("HSBA", "LSE", 30);

		expect(result).toBeNull();
	});

	test("returns null for empty bar array", async () => {
		const api = mockGetApi();
		api.getHistoricalData.mockResolvedValue([]);

		const result = await ibkrHistorical("HSBA", "LSE", 30);

		expect(result).toBeNull();
	});

	test("defaults to 90 days when days not specified", async () => {
		const api = mockGetApi();
		api.getHistoricalData.mockResolvedValue([
			{ time: "20260401", open: 100, high: 105, low: 99, close: 103, volume: 1000 },
		]);

		await ibkrHistorical("HSBA", "LSE");

		expect(api.getHistoricalData).toHaveBeenCalledWith(
			expect.anything(), // contract
			"", // endDateTime (now)
			"90 D", // durationStr
			"1 day", // barSizeSetting
			"TRADES", // whatToShow
			1, // useRTH
			1, // formatDate
		);
	});
});
```

- [ ] **Step 2: Run tests to verify new tests fail**

Run: `bun test --preload ./tests/preload.ts tests/broker/market-data.test.ts`
Expected: FAIL — `ibkrHistorical is not a function`

- [ ] **Step 3: Implement ibkrHistorical**

Add to `src/broker/market-data.ts`:

```typescript
import { type Bar, BarSizeSetting, TickType } from "@stoqey/ib";
import type { FmpHistoricalBar, FmpQuoteData } from "../data/fmp.ts";
```

(Update the import at the top to include `Bar`, `BarSizeSetting`, and `FmpHistoricalBar`.)

Add the function:

```typescript
/**
 * Fetch historical daily OHLCV bars from IBKR.
 * Returns bars in oldest-first order matching fmpHistorical convention.
 * Returns null if IBKR is disconnected or the request fails.
 */
export async function ibkrHistorical(
	symbol: string,
	exchange: string,
	days = 90,
): Promise<FmpHistoricalBar[] | null> {
	if (!isConnected()) {
		log.warn({ symbol, exchange }, "IBKR not connected, skipping historical");
		return null;
	}

	try {
		const api = getApi();
		const contract = getContract(symbol, exchange as "LSE" | "NASDAQ" | "NYSE");
		const bars: Bar[] = await api.getHistoricalData(
			contract,
			"", // endDateTime — empty string means "now"
			`${days} D`,
			BarSizeSetting.DAYS_ONE,
			"TRADES",
			1, // useRTH — regular trading hours only
			1, // formatDate — yyyyMMdd format
		);

		if (!bars || bars.length === 0) {
			log.warn({ symbol, exchange, days }, "IBKR returned no historical bars");
			return null;
		}

		// Convert IBKR Bar[] to FmpHistoricalBar[] (already oldest-first from IBKR)
		return bars.map((bar) => ({
			date: formatIbkrDate(bar.time ?? ""),
			open: bar.open ?? 0,
			high: bar.high ?? 0,
			low: bar.low ?? 0,
			close: bar.close ?? 0,
			volume: bar.volume ?? 0,
		}));
	} catch (error) {
		log.warn(
			{ symbol, exchange, error: error instanceof Error ? error.message : String(error) },
			"IBKR historical data failed",
		);
		return null;
	}
}

/** Convert IBKR date format "yyyyMMdd" or "yyyyMMdd HH:mm:ss" to "yyyy-MM-dd" */
function formatIbkrDate(raw: string): string {
	const d = raw.replace(/\s.*$/, ""); // Strip time portion if present
	if (d.length === 8) {
		return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
	}
	return d; // Already formatted or unexpected — return as-is
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test --preload ./tests/preload.ts tests/broker/market-data.test.ts`
Expected: PASS (all 9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/broker/market-data.ts tests/broker/market-data.test.ts
git commit -m "feat: add ibkrHistorical for LSE daily OHLCV bars"
```

---

### Task 3: Wire IBKR into fmpQuote/fmpHistorical and delete Yahoo

**Files:**
- Modify: `src/data/fmp.ts`

- [ ] **Step 1: Replace Yahoo branch in fmpQuote with IBKR**

In `src/data/fmp.ts`, replace lines 184-201 (the `fmpQuote` function's LSE branch):

```typescript
// Old code (delete this):
if (isLseOrAim(exchange)) {
    const chart = await yahooChart(symbol, "1d");
    if (!chart) {
        log.warn({ symbol, exchange }, "No quote from Yahoo chart fallback");
        return null;
    }
    return {
        symbol,
        exchange,
        last: chart.meta.regularMarketPrice ?? null,
        bid: null,
        ask: null,
        volume: chart.indicators.quote[0]?.volume?.[0] ?? null,
        avgVolume: null,
        changePercent: null,
    };
}
```

Replace with:

```typescript
if (isLseOrAim(exchange)) {
    const { ibkrQuote } = await import("../broker/market-data.ts");
    return ibkrQuote(symbol, exchange);
}
```

- [ ] **Step 2: Replace Yahoo branch in fmpHistorical with IBKR**

In `src/data/fmp.ts`, replace lines 265-287 (the `fmpHistorical` function's LSE branch):

```typescript
// Old code (delete this):
if (isLseOrAim(exchange)) {
    const chart = await yahooChart(symbol, `${days}d`);
    if (!chart || !chart.timestamp || chart.timestamp.length === 0) {
        log.warn({ symbol, exchange }, "No historical data from Yahoo chart fallback");
        return null;
    }
    const q = chart.indicators.quote[0]!;
    const bars: FmpHistoricalBar[] = [];
    for (let i = 0; i < chart.timestamp.length; i++) {
        const close = q.close[i];
        if (close == null) continue;
        bars.push({
            date: new Date(chart.timestamp[i]! * 1000).toISOString().slice(0, 10),
            open: q.open[i] ?? close,
            high: q.high[i] ?? close,
            low: q.low[i] ?? close,
            close,
            volume: q.volume[i] ?? 0,
        });
    }
    return bars;
}
```

Replace with:

```typescript
if (isLseOrAim(exchange)) {
    const { ibkrHistorical } = await import("../broker/market-data.ts");
    return ibkrHistorical(symbol, exchange, days);
}
```

- [ ] **Step 3: Delete all Yahoo code**

Delete from `src/data/fmp.ts`:
- The `YahooChartResult` interface (lines 141-156)
- The `yahooChart` function (lines 158-178)
- The comment block "Yahoo chart fallback for LSE/AIM" (lines 133-135)

Keep the `isLseOrAim` helper — it's still used by the IBKR routing.

- [ ] **Step 4: Run the full test suite**

Run: `bun test --preload ./tests/preload.ts`
Expected: All tests pass. No existing tests reference Yahoo.

- [ ] **Step 5: Run type check and linter**

Run: `bunx tsc --noEmit && bunx biome check src/ tests/`
Expected: Clean — no type errors or lint issues.

- [ ] **Step 6: Commit**

```bash
git add src/data/fmp.ts
git commit -m "feat: route LSE quotes through IBKR, remove Yahoo fallback"
```

---

### Task 4: Live verification script

**Files:**
- Create: `src/scripts/test-ibkr-quotes.ts`

- [ ] **Step 1: Write the verification script**

Create `src/scripts/test-ibkr-quotes.ts`:

```typescript
/**
 * Live verification script for IBKR LSE market data.
 * Run on VPS with trader-v2 service STOPPED to avoid client ID conflicts.
 *
 * Usage: bun src/scripts/test-ibkr-quotes.ts
 */
import { connect, disconnect } from "../broker/connection.ts";
import { ibkrHistorical, ibkrQuote } from "../broker/market-data.ts";
import { createChildLogger } from "../utils/logger.ts";

const log = createChildLogger({ module: "test-ibkr-quotes" });

const TEST_SYMBOLS = ["HSBA", "SHEL", "AZN"];

async function main() {
	log.info("Connecting to IBKR...");
	await connect();

	console.log("\n=== IBKR LSE Quote Tests ===\n");

	// Test quotes
	for (const symbol of TEST_SYMBOLS) {
		console.log(`--- ${symbol} quote ---`);
		const quote = await ibkrQuote(symbol, "LSE");
		if (quote) {
			console.log(`  last:   ${quote.last}`);
			console.log(`  bid:    ${quote.bid}`);
			console.log(`  ask:    ${quote.ask}`);
			console.log(`  volume: ${quote.volume}`);
		} else {
			console.log("  FAILED: null");
		}
		console.log();
	}

	// Test historical (one symbol, 30 days)
	console.log("--- HSBA historical (30 days) ---");
	const bars = await ibkrHistorical("HSBA", "LSE", 30);
	if (bars) {
		console.log(`  bars: ${bars.length}`);
		console.log(`  first: ${bars[0]?.date} close=${bars[0]?.close}`);
		console.log(`  last:  ${bars[bars.length - 1]?.date} close=${bars[bars.length - 1]?.close}`);
	} else {
		console.log("  FAILED: null");
	}

	console.log("\n=== Done ===\n");

	await disconnect();
	process.exit(0);
}

main().catch((err) => {
	log.error({ err }, "Test failed");
	process.exit(1);
});
```

- [ ] **Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add src/scripts/test-ibkr-quotes.ts
git commit -m "chore: add IBKR LSE quotes verification script"
```

- [ ] **Step 4: Run full test suite and linter one final time**

Run: `bun test --preload ./tests/preload.ts && bunx tsc --noEmit && bunx biome check src/ tests/`
Expected: All pass, no errors.

---

### Task 5: Live verification on VPS

**Files:** None (operational task)

- [ ] **Step 1: Push to main**

```bash
git push
```

- [ ] **Step 2: Wait for CI/CD to deploy, then SSH to VPS**

```bash
ssh deploy@<VPS_HOST> "cd /opt/trader-v2 && git pull"
```

- [ ] **Step 3: Stop the trader-v2 service**

```bash
ssh deploy@<VPS_HOST> "sudo systemctl stop trader-v2"
```

- [ ] **Step 4: Run the verification script**

```bash
ssh deploy@<VPS_HOST> "cd /opt/trader-v2 && /home/deploy/.bun/bin/bun src/scripts/test-ibkr-quotes.ts"
```

Expected output: all 3 quotes return non-null last prices, historical bars return 20+ daily bars with valid OHLCV data.

If any symbol returns `FAILED: null`, investigate before restarting — check IBKR gateway logs and connection status.

- [ ] **Step 5: Restart the trader-v2 service**

```bash
ssh deploy@<VPS_HOST> "sudo systemctl start trader-v2 && sleep 2 && sudo systemctl is-active trader-v2"
```

Expected: `active`

- [ ] **Step 6: Verify LSE quotes are flowing**

Wait for the next `quote_refresh_uk` cycle (every 10 minutes), then check:

```bash
ssh deploy@<VPS_HOST> "sqlite3 /opt/trader-v2/data/trader.db \"SELECT symbol, exchange, last, bid, ask, volume, updated_at FROM quotes_cache WHERE exchange='LSE' ORDER BY updated_at DESC;\""
```

Expected: LSE symbols now have non-null `last` values with recent `updated_at` timestamps, including BP. and SSE which were previously failing.
