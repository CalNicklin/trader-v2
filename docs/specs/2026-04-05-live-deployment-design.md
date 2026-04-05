# Live Deployment Design — IBKR Paper & Live Trading

**Date:** 2026-04-05
**Status:** Design
**Depends on:** Phases 1–9 (all complete)

---

## Overview

Wire the existing broker modules and live executor into a working end-to-end trading pipeline. The code is ~90% built (Phase 7 broker integration, Phase 8 risk limits). This design addresses the integration gaps, stubs, and missing pieces identified by the code audit.

**Goal:** Graduate strategies from paper lab → IBKR paper account → IBKR live account with all spec risk controls enforced.

---

## Deployment Progression

| Stage | IBKR Port | Real Money | Purpose |
|-------|-----------|------------|---------|
| Current | None | No | Paper lab only, strategies evolve and graduate |
| **Stage 2** | 4002 (paper) | No | Validate full broker pipeline: orders, fills, positions, guardian, settlement |
| **Stage 3** | 4001 (live) | Yes | Real capital with all risk controls. Just a port change + `TRADING_MODE=live` |

Stage 2 is the target of this design. Stage 3 is a config change once Stage 2 is validated.

---

## Infrastructure

### IB Gateway (Docker)

Adapted from v1's `docker/docker-compose.yml`. Runs as standalone Docker container on the v2 Hetzner VPS.

- **Image:** `gnzsnz/ib-gateway:latest`
- **Ports:** 4002 (API, localhost only), 5900 (VNC for emergency access)
- **Config:** `TRADING_MODE=paper`, credentials via `docker/.env` (gitignored)
- **Health:** TCP probe on API port every 10s, 60s startup grace
- **Maintenance:** Daily cold restart at 05:00 UTC (prevents stale sessions)
- **Persistence:** `ib-gateway-data` Docker volume for session state

### trader-v2 (systemd, unchanged)

Stays on systemd. Connects to `127.0.0.1:4002`. Existing deploy pipeline (GitHub Actions → git pull → restart) is unchanged. IB Gateway is managed separately — does not redeploy with code pushes.

### Boot Sequence Change

When `LIVE_TRADING_ENABLED=true`, `src/index.ts` boot adds:
1. `connect()` from `src/broker/connection.ts`
2. `startOrderMonitoring()` from `src/broker/order-monitor.ts`
3. Wait for connection (with timeout + graceful fallback — scheduler jobs already check `isConnected()`)

---

## P0: Code Changes Required for IBKR Paper Trading

### 1. Wire Signal Evaluation in Live Executor

**File:** `src/live/executor.ts`
**Problem:** `evaluateSignal()` always returns `false` (placeholder).
**Fix:** Reuse the paper evaluator's pipeline: `buildSignalContext()` + `evalExpr()` from `src/strategy/context.ts` and `src/strategy/expr-eval.ts`. For exit signals, thread position data (entry price, opened at, quantity) into the context.

### 2. Wire Risk Gate into Live Executor

**File:** `src/live/executor.ts`
**Problem:** Live executor uses only `allocation.maxPositionSize`. No ATR sizing, no concurrent position check, no per-trade risk limit.
**Fix:** Call `checkTradeRiskGate()` before every live entry, same as paper evaluator does. Use the risk gate's sizing output (quantity, stop-loss price) instead of the capital allocator's simple cap. Capital allocator still sets the upper bound per strategy; risk gate sizes within that.

### 3. Add Trading Halt + Weekly Drawdown Checks

**File:** `src/live/executor.ts`
**Problem:** Live executor only checks `LIVE_TRADING_ENABLED` and IBKR connection. Ignores risk guardian halt flags.
**Fix:** At the top of `runLiveExecutor()`, check `isTradingHalted()` (returns early if daily halt or circuit breaker active) and `isWeeklyDrawdownActive()` (pass to risk gate for 50% size reduction).

### 4. Port Account Module from v1

**Create:** `src/broker/account.ts`
**Port from:** `~/Documents/Projects/trader/src/broker/account.ts`
**Provides:**
- `getAccountSummary()` — fetches NetLiquidation, TotalCashValue, AvailableFunds via IBKR API
- `getPositions()` — fetches all open positions from IBKR for reconciliation

**Adapt:** Use v2's pino logger, v2's connection module (`getApi()`).

Replace `estimateAvailableCash()` in executor with `getAccountSummary()` → `TotalCashValue`.

### 5. Position Lifecycle: Fill → livePositions → PnL

**Problem:** Order monitor detects fills but nothing creates `livePositions` rows. Guardian reads from `livePositions` but the table is always empty.

**Fix in `src/broker/order-monitor.ts` (or new `src/live/position-manager.ts`):**

On BUY/entry fill:
1. Insert `livePositions` row (symbol, exchange, quantity, avgCost, stopLossPrice from risk gate)
2. Place server-side stop-loss order with IBKR (spec requires stops survive bot disconnection)

On SELL/exit fill:
1. Compute PnL = (exitPrice - entryPrice) × quantity - friction
2. Write PnL to `liveTrades` row
3. Delete `livePositions` row
4. Record daily PnL contribution to `risk_state`

### 6. Fix Short Position Stop-Loss Detection

**File:** `src/broker/stop-loss.ts`
**Problem:** `findStopLossBreaches()` only checks `price <= stopLoss` (long side). Short positions need `price >= stopLoss`.
**Fix:** Check `quantity > 0` for longs (`price <= stop`) and `quantity < 0` for shorts (`price >= stop`).

### 7. IBKR Connection in Boot Sequence

**File:** `src/index.ts`
**Fix:** When `LIVE_TRADING_ENABLED=true`:
- Call `connect()` with retry
- Call `startOrderMonitoring()`
- Add `disconnect()` + `stopOrderMonitoring()` to graceful shutdown
- Add IBKR connection status to `/health` endpoint

### 8. Position Reconciliation on Reconnect

**File:** `src/broker/account.ts` or `src/live/reconciliation.ts`
**Trigger:** On IBKR reconnect (connection state change from disconnected → connected) and on boot.
**Logic:**
1. Fetch positions from IBKR via `getPositions()`
2. Compare against `livePositions` table
3. For positions in IBKR but not in DB: insert (orphaned position from prior crash)
4. For positions in DB but not in IBKR: delete (phantom position, trade was closed while disconnected)
5. Log all discrepancies

---

## P1: Required Before IBKR Paper → Live

### 9. Real Daily/Weekly PnL for Risk Guardian

**File:** `src/scheduler/risk-guardian-job.ts`
**Problem:** Always passes `0, 0` for daily/weekly PnL. Daily halt (3%) and weekly drawdown (5%) never trigger.
**Fix:** Aggregate `liveTrades` PnL for today (daily) and this week (weekly). When live is enabled, use live PnL; otherwise use paper PnL from snapshots.

### 10. Risk Guardian Monitors Live When Enabled

**File:** `src/scheduler/risk-guardian-job.ts`
**Problem:** `computePortfolioState()` only looks at paper strategy virtual balances.
**Fix:** When `LIVE_TRADING_ENABLED=true`, compute portfolio value from IBKR account summary (NetLiquidation). Fall back to paper calculation when live is off.

### 11. Guardian Stop at Market Close

**File:** `src/scheduler/cron.ts`
**Problem:** `guardian_start` runs at 08:00 but never stops. Runs 24/7 once started.
**Fix:** Add `guardian_stop` job at 21:00 weekdays.

### 12. IB Gateway Docker Setup

**Create:** `docker/docker-compose.yml`, `docker/.env.example`
**Adapted from v1.** IB Gateway only (no trader container). Deploy script to set up Docker on Hetzner VPS.

---

## P2: Deferred (Not Blocking Deployment)

| Item | Reason for Deferral |
|------|-------------------|
| Automated tier promotion (probation→active→core) | Manual promotion is safe; automated requires more live data |
| Demotion trigger detection loop | Pure functions exist; wiring needs live trade history to accumulate first |
| Sector data for correlated exposure | Max 3 concurrent positions mitigates concentration risk; sector lookup is a data enrichment task |
| Risk of ruin monitoring | Conservative position sizing (1% risk) + circuit breaker (10%) + max 3 positions gives implicit protection |
| Margin phase (2x leverage) | Spec says "unlocked manually once edge is proven" — not for initial deployment |
| Dynamic confidence scoring | Hardcoded 0.7 is a cosmetic issue, doesn't affect trade execution |

---

## Testing Strategy

### Unit Tests (automated, run in CI)
- Signal evaluation in live executor (same signals produce same results as paper)
- Position lifecycle: fill creates position, exit fill computes PnL and deletes position
- Short stop-loss detection
- Risk gate integration in live executor
- Account summary parsing
- Reconciliation logic

### Integration Tests (manual, against IBKR paper account)
From Phase 7 checklist + additions:
1. Connection: connect, verify state, handle disconnect/reconnect
2. Contract: verify AAPL NASDAQ + SHEL LSE contracts resolve
3. Order: small LIMIT BUY below market → verify in open orders → cancel
4. Fill lifecycle: LIMIT BUY at market → verify `livePositions` row created with stop-loss
5. Guardian: insert position with stop above market → verify sell within 60s
6. Reconciliation: restart bot with open positions → verify positions match
7. Risk halt: trigger daily halt flag → verify live executor stops
8. Full cycle: seed probation strategy, enable live trading, verify allocation + risk gate + order placement

---

## Success Criteria

- [ ] Graduated strategy places a trade on IBKR paper account
- [ ] Fill creates `livePositions` row with correct stop-loss
- [ ] Guardian enforces stop-loss within 60 seconds
- [ ] Risk gate rejects trades exceeding 1% risk or max 3 concurrent positions
- [ ] Trading halt flag stops the live executor
- [ ] Bot restart reconciles positions with IBKR
- [ ] All unit tests pass, integration checklist completed manually
