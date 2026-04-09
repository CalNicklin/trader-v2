# IBKR LSE Quotes — Design Spec

## Problem

FMP Starter tier does not support `.L` (LSE/AIM) symbols. All LSE quotes and historical data fall through to a Yahoo Finance Chart API fallback, which is unreliable: BP. returns 404, SHEL/HSBA timeout on historical requests, SSE returns no data. This means LSE strategies get no quotes, no RSI/ATR indicators, and therefore generate no trades.

## Solution

Replace the Yahoo Finance fallback with IBKR market data for LSE/AIM symbols. The system already maintains a persistent IBKR connection for order placement and position management. IBKR provides both real-time snapshots and historical OHLCV bars via the `@stoqey/ib` library.

FMP continues to serve US quotes (NASDAQ/NYSE) where it works reliably.

## Architecture

### New module: `src/broker/market-data.ts`

Two functions:

**`ibkrQuote(symbol: string, exchange: Exchange): Promise<FmpQuoteData | null>`**
- Uses `api.getMarketDataSnapshot(contract, "", false)` to get a one-shot snapshot
- Extracts last price, bid, ask, volume from the `MutableMarketData` result
- Returns `FmpQuoteData`-compatible shape (same interface consumers already use)
- Returns `null` if IBKR is not connected

**`ibkrHistorical(symbol: string, exchange: Exchange, days?: number): Promise<FmpHistoricalBar[] | null>`**
- Uses `api.getHistoricalData(contract, "", "${days} D", BarSizeSetting.DAYS_ONE, WhatToShow.TRADES, 1, 1)`
- Empty string for `endDateTime` means "now"
- `useRTH: 1` for regular trading hours only
- `formatDate: 1` for `YYYYMMDD` string format
- Returns bars in oldest-first order (matching `fmpHistorical` convention)
- Returns `null` if IBKR is not connected

Both functions build contracts via the existing `getContract(symbol, exchange)` from `src/broker/contracts.ts`.

### Changes to `src/data/fmp.ts`

The `isLseOrAim` branches in `fmpQuote()` and `fmpHistorical()` call `ibkrQuote`/`ibkrHistorical` instead of `yahooChart`.

Delete entirely:
- `yahooChart()` function
- `YahooChartResult` interface
- All Yahoo-related imports and comments

### No consumer changes

The routing is internal to `fmpQuote`/`fmpHistorical`. All consumers (`quotes.ts`, `historical.ts`, `evaluator.ts`, `guardian.ts`, `quote-refresh.ts`) continue calling the same functions with the same interfaces.

## Data Flow

```
quote_refresh_uk (every 10 min during uk_session/overlap)
  → fmpBatchQuotes(lseSymbols)
    → fmpQuote(symbol, "LSE")
      → ibkrQuote(symbol, "LSE")  // IBKR snapshot
      → upsertQuote(result)

strategy_eval_uk (every 10 min)
  → getIndicators(symbol, "LSE")
    → fmpHistorical(symbol, "LSE", 90)
      → ibkrHistorical(symbol, "LSE", 90)  // IBKR historical bars
      → compute RSI/ATR/volume_ratio
```

## IBKR Market Data Details

**Snapshots** (`getMarketDataSnapshot`):
- Collects ticks for up to 11 seconds, then resolves with accumulated data
- Paper accounts receive 15-minute delayed data by default (acceptable for 10-min polling)
- Key fields: last price, bid, ask, volume, close price

**Historical bars** (`getHistoricalData`):
- Daily OHLCV bars, regular trading hours only
- Duration "90 D" gives ~90 calendar days of data (sufficient for RSI-14, ATR-14, volume ratio)
- Returns a `Bar[]` with `time`, `open`, `high`, `low`, `close`, `volume` fields

**Connection dependency**: Both functions check `isConnected()` before making requests. If IBKR is disconnected, they return `null` — the system degrades the same way it did when Yahoo failed.

## Graceful Degradation

IBKR down → `ibkrQuote`/`ibkrHistorical` return `null` → quote cache retains last known values → indicators return `null` → strategies skip symbols without data. This is identical to the current Yahoo failure mode but should happen far less often since IBKR is the broker we trade on.

## Testing

### Unit tests (mocked, run locally): `tests/broker/market-data.test.ts`
- `ibkrQuote` returns correct `FmpQuoteData` shape from snapshot
- `ibkrQuote` returns `null` when disconnected
- `ibkrHistorical` returns bars in oldest-first order
- `ibkrHistorical` returns `null` when disconnected
- `fmpQuote("HSBA", "LSE")` routes to IBKR (integration)
- `fmpQuote("AAPL", "NASDAQ")` routes to FMP (unchanged)

### Live verification script: `src/scripts/test-ibkr-quotes.ts`
- Connects to IBKR gateway
- Calls `ibkrQuote` for 3 LSE symbols (HSBA, SHEL, AZN)
- Calls `ibkrHistorical` for 1 symbol (HSBA, 30 days)
- Prints results to stdout for manual inspection
- Run on VPS with service stopped before deployment

### Existing tests
- Any Yahoo-related test assertions are removed
- All other FMP/quote tests continue to pass unchanged

## Files

| File | Action |
|------|--------|
| `src/broker/market-data.ts` | Create — `ibkrQuote()`, `ibkrHistorical()` |
| `src/data/fmp.ts` | Modify — replace Yahoo branches with IBKR, delete Yahoo code |
| `src/scripts/test-ibkr-quotes.ts` | Create — live verification script |
| `tests/broker/market-data.test.ts` | Create — mocked unit tests |
| Existing FMP tests | Update — remove Yahoo-specific assertions if any |
