# Live Trading Code Audit

**Date:** 2026-04-05
**Scope:** All modules related to live/broker execution in trader-v2, compared against spec and v1 codebase.

---

## Complete & Working

These modules are fully implemented, tested, and production-ready.

### `src/broker/contracts.ts`
- Multi-exchange contract builders (LSE, NASDAQ, NYSE) with SMART routing
- `getContract()` dispatcher, `getContractDetails()` for live lookups
- **No issues.** Clean, complete.

### `src/broker/order-types.ts`
- Shared types: `TradeStatus`, `OpenOrderLike`, `ExecutionLike`, `FillData`, `OrderEvent`
- Ported from v1. **Complete.**

### `src/broker/order-status.ts`
- `mapIbStatus()` maps IB status strings to our `TradeStatus` enum
- `extractFillData()` pulls fill price and commission from IB order objects
- Handles IB's sentinel commission value (1e9). **Complete.**

### `src/broker/order-events.ts`
- `processOrderUpdate()` pure function: matches tracked orders against IB open order stream, emits `OrderEvent[]`
- Removes orders from tracking on terminal statuses. **Complete.**

### `src/broker/stop-loss.ts`
- `findStopLossBreaches()` pure function: returns positions whose price <= stop-loss
- **Complete.** But note line 27: only handles `quantity > 0` (long positions). Short stop-loss (price >= stop) is NOT checked here. The guardian in `guardian.ts` line 78 does handle short side (flips to BUY), but the breach detection only fires for longs.

### `src/broker/trailing-stops.ts`
- `computeTrailingStopUpdate()` pure function: updates high-water mark, recalculates trailing stop from ATR, returns `triggered` flag
- **Complete.** Only fires for long positions (triggered when `currentPrice <= effectiveStop`). Same short-position gap as stop-loss.

### `src/broker/connection.ts`
- Singleton `IBApiNext` connection with reconnect handling
- Debounced reconnection (15s stability check), health check on reconnect via `getCurrentTime()`
- `connect()`, `disconnect()`, `isConnected()`, `waitForConnection()`
- **Complete.** Config-driven via `IBKR_HOST`, `IBKR_PORT`, `IBKR_CLIENT_ID`.

### `src/broker/orders.ts`
- `placeTrade()`: creates DB record, places IB order, tracks via `order-monitor`, handles errors
- `cancelOrder()`, `getOpenOrders()`
- **Complete.** Properly records to `liveTrades` table, updates status on success/error.

### `src/broker/order-monitor.ts`
- RxJS subscription to IB open orders stream
- Validates order status shape with Zod before processing
- Auto-resubscribes on error/completion (5s delay)
- Triggers behavioral divergence check on fills
- `startOrderMonitoring()`, `stopOrderMonitoring()`, `trackOrder()`
- **Complete.**

### `src/broker/guardian.ts`
- 60-second interval loop: stop-loss enforcement, position price updates, trailing stop updates
- Properly chains: stop-loss first, then price updates, then trailing stops (skipping already-closed positions)
- Handles both long and short positions for market orders (lines 78-80, 198-200)
- **Complete.**

### `src/broker/settlement.ts`
- Settlement date calculation (T+1 US, T+2 UK) with weekend skipping
- `computeUnsettledCash()` and `getAvailableCash()` pure functions
- **Complete.** No bank holiday handling (documented as acceptable).

### `src/live/capital-allocator.ts`
- Tier-based allocation: probation=10%, active=25%, core=50%
- Equal split within tiers, proportional scale-down if over 100%
- Max position size = 25% of allocated capital
- **Complete.** Pure function, well-tested.

### `src/strategy/expr-eval.ts`
- Recursive descent parser for signal expressions
- Supports: `>`, `<`, `>=`, `<=`, `==`, `!=`, `AND`, `OR`, parentheses
- Unknown variables resolve to null (falsy). No `eval()` or `Function()`.
- **Complete.** This is what paper trading uses and what live should use.

### `src/strategy/context.ts`
- `buildSignalContext()`: maps quote fields + indicators + position state into flat `ExprContext`
- Includes all news signal fields (sentiment, earnings surprise, guidance, etc.)
- Computes `hold_days` and `pnl_pct` from position data
- **Complete.**

### `src/strategy/evaluator.ts`
- `evaluateStrategyForSymbol()`: builds context, evaluates signals via `evalExpr()`, opens/closes paper positions
- `evaluateAllStrategies()`: iterates all paper strategies, applies risk gate, universe management
- Checks `isTradingHalted()` and `isWeeklyDrawdownActive()` before evaluation
- **Complete.** This is the WORKING paper evaluator that live should reuse.

### `src/risk/constants.ts`
- All hard limits from spec Section 8 in one file
- Per-trade, stop-loss, portfolio-level, demotion/kill, behavioral divergence constants
- **Complete.**

### `src/risk/limits.ts`
- Per-trade limit checks: risk-per-trade, concurrent positions, max short size, correlated exposure, borrow fee
- `runAllTradeChecks()` aggregates all checks
- **Complete.** Pure functions, no DB calls.

### `src/risk/position-sizer.ts`
- ATR-based position sizing with friction costs
- Handles weekly drawdown 50% reduction
- Min position value check ($50)
- Calculates stop-loss price for both longs and shorts
- **Complete.**

### `src/risk/guardian-checks.ts`
- Pure portfolio-level checks: daily loss halt (3%), weekly drawdown (5%), circuit breaker (10%)
- `runGuardianChecks()` aggregates into `GuardianVerdict`
- **Complete.**

### `src/risk/gate.ts`
- `checkTradeRiskGate()`: combines position sizing + all limit checks into single allow/deny
- **Complete.** Used by paper evaluator. Not yet used by live executor.

### `src/risk/guardian.ts`
- Portfolio-level risk guardian with DB-persisted state (`risk_state` table)
- `runGuardian()`: reads state, runs pure checks, persists flags, sends circuit breaker email
- `isTradingHalted()`, `isWeeklyDrawdownActive()`, `resetCircuitBreaker()`, `resetDailyState()`, `resetWeeklyState()`
- **Complete.**

### `src/scheduler/cron.ts`
- All jobs scheduled: quote refresh, strategy eval, news poll, guardian start, live eval, risk guardian, daily/weekly resets
- Proper timezone handling (Europe/London), offsets to avoid job lock collisions
- **Complete.**

### `src/scheduler/jobs.ts`
- Global job runner with mutex lock and 10-minute timeout
- Pause-aware for trade jobs
- Dispatches to all job implementations including `guardian_start`, `live_evaluation`, `risk_guardian`, `risk_daily_reset`, `risk_weekly_reset`
- **Complete.**

### `src/scheduler/guardian-job.ts`
- Wrapper: checks `LIVE_TRADING_ENABLED` and `isConnected()` before starting broker guardian
- **Complete.**

### `src/scheduler/live-eval-job.ts`
- Wrapper: checks `LIVE_TRADING_ENABLED`, calls `runLiveExecutor()`
- **Complete.**

### `src/scheduler/risk-guardian-job.ts`
- Computes portfolio value from paper strategies (virtual balance + open positions)
- Calls `runGuardian()` with computed value
- **Note:** Lines 38-41: passes `0, 0` for daily/weekly PnL with a TODO to compute real values. This means daily loss halt and weekly drawdown checks will never trigger (they compare `0` against thresholds).

### `src/monitoring/server.ts`
- HTTP server: `/health` (unauthenticated), `/` status page (basic auth), `/pause` + `/resume` endpoints
- **Complete.**

### `src/index.ts`
- Boot sequence: DB migration, seed strategies, start scheduler, start HTTP server
- Graceful shutdown (SIGINT/SIGTERM), uncaught exception email alerting
- **Complete for paper trading.** Does NOT connect to IBKR or start order monitoring (see Integration Gaps).

### `src/db/schema.ts` (live tables)
- `livePositions`: id, strategyId, symbol, exchange, currency, quantity, avgCost, currentPrice, unrealizedPnl, marketValue, stopLossPrice, trailingStopPrice, highWaterMark, updatedAt. UNIQUE(symbol, exchange).
- `liveTrades`: id, strategyId, symbol, exchange, side, quantity, orderType, limitPrice, fillPrice, commission, friction, status (enum), ibOrderId, reasoning, confidence, pnl, createdAt, updatedAt, filledAt.
- **Complete.**

---

## Stubbed / Placeholder

### `src/live/executor.ts` — `evaluateSignal()` (lines 311-327)

**THE CRITICAL STUB.** This function is the only thing standing between the live executor and actual trading. It always returns `false`, meaning no live trades will ever be placed.

```typescript
function evaluateSignal(
    _signal: string,
    _parameters: Record<string, unknown>,
    _quote: { ... },
    _indicators: SymbolIndicators,
): boolean {
    // For Phase 7 MVP, return false (no automatic trading) until evaluator integration is wired.
    return false;
}
```

**What it should do:** Call `buildSignalContext()` from `src/strategy/context.ts` and `evalExpr()` from `src/strategy/expr-eval.ts` — the exact same logic that paper trading uses in `src/strategy/evaluator.ts` lines 70 and 94.

**Fix:** Replace the stub body with:
```typescript
const ctx = buildSignalContext({ quote: _quote, indicators: _indicators, position: null });
return evalExpr(_signal, ctx);
```
For exit signals with an existing position, the position data needs to be threaded through.

### `src/live/executor.ts` — `estimateAvailableCash()` (lines 334-346)

**Hardcoded starting capital.** Line 344: `const STARTING_CAPITAL = 500;` — a static GBP value. Subtracts current position value to estimate remaining cash.

**What it should do:** Call the IBKR Account Summary API to get actual `TotalCashValue` or `AvailableFunds`. The v1 code at `~/Documents/Projects/trader/src/broker/account.ts` has a working implementation (see below).

### `src/live/executor.ts` — No risk gate on live trades (lines 161-200)

**Paper evaluator runs `checkTradeRiskGate()` before every entry (evaluator.ts lines 95-116). Live executor does NOT.** It only checks `allocation.maxPositionSize` and a simple 25% cap. There's no ATR-based position sizing, no concurrent position limit, no correlated exposure check, no borrow fee check.

### `src/live/executor.ts` — Hardcoded confidence (lines 183, 220, 257)

All trades placed with `confidence: 0.7` hardcoded. Should reflect actual signal strength or be computed from context.

### `src/live/executor.ts` — Hardcoded exchange (line 129)

`const exchange = (parameters.exchange ?? "NASDAQ") as Exchange;` — defaults to NASDAQ if strategy parameters don't specify. Should handle LSE stocks properly since the spec targets GBP/pence LSE stocks.

### `src/scheduler/risk-guardian-job.ts` — Daily/weekly PnL always zero (lines 38-41)

```typescript
// TODO: Compute real daily/weekly PnL from trade history when snapshots are available.
const verdict = await runGuardian(portfolioValue, 0, 0);
```

This means the daily loss halt (3%) and weekly drawdown (5%) checks are effectively disabled. The circuit breaker (10% max drawdown from peak) still works because it uses portfolio value, not PnL.

---

## Missing

### 1. Account Balance / Position Sync from IBKR

**No `src/broker/account.ts` exists in v2.** The v1 project has a complete, working implementation at `~/Documents/Projects/trader/src/broker/account.ts` that provides:

- `getAccountSummary()`: Fetches NetLiquidation, TotalCashValue, BuyingPower, GrossPositionValue, AvailableFunds via `api.getAccountSummary("All", tags)`
- `getPositions()`: Fetches all positions via `api.getPositions()` with contract details (symbol, exchange, currency, quantity, avgCost)

Both use RxJS subscriptions with 10-second timeouts. This needs to be ported to v2.

### 2. Position Reconciliation on Reconnect

The spec states (Section 7): "On reconnect, system reconciles positions and resumes." There is no reconciliation logic anywhere — no code compares `livePositions` DB state against IBKR's actual position state after a reconnect or restart. Stale or phantom positions could accumulate.

### 3. IB Gateway Docker Setup for v2

v1 has a working `docker/docker-compose.yml` at `~/Documents/Projects/trader/docker/docker-compose.yml` using `gnzsnz/ib-gateway:latest` with:
- Paper/live trading mode toggle
- VNC for GUI access (port 5900)
- Health check on port 4004
- Auto cold restart at 05:00
- Environment-based credentials

v2 has no Docker configuration at all. The current deployment is systemd on Hetzner, so a `docker-compose.yml` for IB Gateway needs to be created (the trader app itself can stay as systemd, but IB Gateway needs Docker).

### 4. Live Position Creation on Fill

When a live trade fills (detected by `order-monitor.ts`), the code updates `liveTrades` status to "FILLED" and records fill price/commission. But **nothing creates or updates a `livePositions` row**. The fill event handler (order-monitor.ts lines 86-103) only calls `checkBehavioralDivergence()`. There's no:
- Insert into `livePositions` on BUY fill
- Delete/update `livePositions` on SELL fill
- Update of `avgCost`, `quantity`, `stopLossPrice` on fill

### 5. PnL Calculation for Closed Live Trades

The `liveTrades` table has a `pnl` column but nothing ever writes to it. When a position is closed (exit trade fills), PnL should be computed from entry vs exit price and written back.

### 6. Daily/Weekly PnL Tracking

The risk guardian checks for daily loss (3%) and weekly drawdown (5%) but the job always passes `0, 0` for these values. There's no:
- Daily PnL snapshot mechanism
- Trade-level PnL aggregation by day/week
- Writing of `daily_pnl` / `weekly_pnl` to `risk_state`

### 7. Short Position Stop-Loss Detection

`src/broker/stop-loss.ts` line 27-31: `findStopLossBreaches()` only detects breaches where `price <= pos.stopLossPrice`. For short positions, the stop-loss breach condition should be `price >= pos.stopLossPrice` (price moving up against the short). This is a logic bug that would let short positions blow through their stop-losses undetected.

### 8. Strategy Demotion/Kill for Live Strategies

`src/risk/demotion.ts` exists with pure functions for two-strike demotion and kill criteria (loss streak, max trades, repeated demotions). However, there's no live-specific demotion integration — the live executor doesn't check if a graduated strategy should be demoted back to paper or killed entirely based on live trading performance.

### 9. Sector Data for Correlated Exposure Checks

The risk gate checks `checkCorrelatedExposure()` but the paper evaluator passes `null` for all sectors (evaluator.ts line 219: `openPositions.map(() => null as string | null)`). No sector lookup exists for either paper or live positions. The correlated exposure check is effectively a no-op.

---

## Integration Gaps

### 1. Boot Sequence Does Not Connect to IBKR

`src/index.ts` starts the scheduler and HTTP server but never calls:
- `connect()` from `src/broker/connection.ts`
- `startOrderMonitoring()` from `src/broker/order-monitor.ts`

The `guardian-job.ts` and `live-eval-job.ts` check `isConnected()` and bail if false, but nothing in the boot sequence establishes the connection. **IBKR connection must be added to `boot()` when `LIVE_TRADING_ENABLED=true`.**

### 2. Live Executor Does Not Use Paper Evaluator's Signal Logic

The paper evaluator (`src/strategy/evaluator.ts`) uses `buildSignalContext()` + `evalExpr()` — a complete, working, tested signal evaluation pipeline. The live executor (`src/live/executor.ts`) has its own stub `evaluateSignal()` that always returns false. These should share code.

### 3. Live Executor Does Not Use Risk Gate

Paper evaluator calls `checkTradeRiskGate()` before every entry, which enforces:
- ATR-based position sizing
- 1% risk-per-trade limit
- Max 3 concurrent positions
- Sector correlation limits
- Borrow fee cap

The live executor skips all of this and uses only the capital allocator's `maxPositionSize`. The risk gate should be wired in.

### 4. No Position Lifecycle Between Order Monitor and Live Positions Table

The order placement (`orders.ts`) writes to `liveTrades`. The order monitor updates `liveTrades` status on fill. The guardian reads from `livePositions`. But nothing bridges the gap — no code creates `livePositions` rows from filled `liveTrades`. The guardian will operate on an empty table.

### 5. Risk Guardian Monitors Paper Strategies, Not Live

`src/scheduler/risk-guardian-job.ts` lines 16-27: `computePortfolioState()` queries strategies with `status = "paper"` and sums paper virtual balances + paper positions. It does NOT look at `livePositions` or actual IBKR account state. When live trading is active, the risk guardian should monitor real positions and real account value.

### 6. Guardian Job Starts But Never Stops

`src/scheduler/cron.ts` line 89: `guardian_start` runs at 08:00 weekdays. There's no corresponding `guardian_stop` job at market close. The 60-second guardian interval will run 24/7 once started (consuming resources and making quote lookups outside market hours). A stop at ~21:00 would be appropriate.

### 7. No Live Trading Halt Integration

The risk guardian can set `daily_halt_active` and `circuit_breaker_tripped` flags, and `isTradingHalted()` reads them. The paper evaluator checks this in `evaluateAllStrategies()`. But the live executor (`runLiveExecutor()`) does NOT check `isTradingHalted()` — it only checks `LIVE_TRADING_ENABLED` config and IBKR connection. A halt from the risk guardian would not stop live trading.

### 8. No Weekly Drawdown Integration in Live Executor

Paper evaluator checks `isWeeklyDrawdownActive()` and passes it to the risk gate for 50% size reduction. The live executor does not check this flag at all.

---

## v1 Files for Porting

### `~/Documents/Projects/trader/src/broker/account.ts`
- **Port priority: HIGH** — needed to replace `estimateAvailableCash()` stub
- `getAccountSummary()`: RxJS subscription to `api.getAccountSummary("All", tags)`, 10s timeout
- `getPositions()`: RxJS subscription to `api.getPositions()`, 10s timeout, filters zero-quantity
- Needs minor adaptation: use v2's logger, add Exchange type mapping

### `~/Documents/Projects/trader/docker/docker-compose.yml`
- **Port priority: MEDIUM** — needed before deploying live
- IB Gateway: `gnzsnz/ib-gateway:latest`, ports 4002 (API) + 5900 (VNC)
- Health check on port 4004, cold restart at 05:00
- v2 adaptation: remove the trader service (v2 runs via systemd), adjust env vars to match v2 config names, add to Hetzner deployment

---

## Summary Priority List

| Priority | Item | Effort |
|----------|------|--------|
| **P0** | Wire `evaluateSignal()` to use `buildSignalContext()` + `evalExpr()` | Small |
| **P0** | Port `account.ts` from v1, replace `estimateAvailableCash()` | Medium |
| **P0** | Add IBKR connect + order monitoring to boot sequence | Small |
| **P0** | Create `livePositions` rows from filled trades (order monitor) | Medium |
| **P0** | Wire risk gate (`checkTradeRiskGate()`) into live executor | Medium |
| **P0** | Check `isTradingHalted()` + `isWeeklyDrawdownActive()` in live executor | Small |
| **P0** | Fix short position stop-loss detection in `stop-loss.ts` | Small |
| **P1** | Compute real daily/weekly PnL for risk guardian | Medium |
| **P1** | Switch risk guardian to monitor live positions when live is enabled | Medium |
| **P1** | Position reconciliation on IBKR reconnect | Medium |
| **P1** | Add guardian stop job at market close | Small |
| **P1** | PnL calculation on closed live trades | Small |
| **P2** | Docker compose for IB Gateway on Hetzner | Medium |
| **P2** | Sector data lookup for correlated exposure | Medium |
| **P2** | Strategy demotion/kill integration for live | Medium |
| **P2** | Dynamic confidence scoring instead of hardcoded 0.7 | Small |
