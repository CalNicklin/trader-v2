# Live Deployment Requirements

Extracted from the master spec (`docs/specs/2026-04-03-trader-v2-design.md`), the Phase 7 plan (`docs/plans/2026-04-04-phase7-broker-live-executor.md`), and the Phase 8 plan (`docs/plans/2026-04-04-phase8-risk-hard-limits.md`).

---

## From the Spec

### Graduation Criteria (ALL Must Pass)

| Criterion | Threshold | Rationale |
|---|---|---|
| Sample size | >= 30 trades | Minimum for statistical inference |
| Expectancy | > 0 per trade | More important than win rate |
| Profit factor | > 1.3 | Gross profit / gross loss |
| Sharpe ratio (annualized) | > 0.5 | Minimum viable risk-adjusted return |
| Max drawdown | < 15% of virtual balance | Conservative for small capital |
| Consistency | Profitable in >= 3 of last 4 weeks | Prevents lucky-streak graduation |
| Walk-forward validation | Signal works on most recent 20% of data | Prevents overfitting |
| Parameter count | <= 5 tunable parameters | More params = likely overfit |

Win rate is deliberately absent as a standalone criterion.

### Qualitative Graduation Review (Haiku)

In addition to statistical gates, Haiku reviews the qualitative picture before graduation:

1. Is the edge real or regime-dependent?
2. Are wins concentrated in a few large trades or distributed?
3. Does the strategy's universe still make sense (e.g., liquidity)?
4. Any pattern_tags suggesting systematic weakness the metrics miss?
5. Would the strategy survive a regime change (vol spike, sector rotation)?

Output is `"graduate"`, `"hold"`, or `"concerns"`:
- `"concerns"` blocks graduation until next review cycle.
- `"hold"` delays by one week.
- `"graduate"` with confidence > 0.6 proceeds (statistical gate must still pass).

### Capital Tiers

| Tier | Entry Criteria | Capital Allocation | Demotion Trigger |
|---|---|---|---|
| **Paper** | Default state | 0 (virtual only) | N/A |
| **Probation** | Passes all graduation criteria at 30+ trades | 10% of live capital (~20-50 GBP) | Rolling 20-trade Sharpe < 0 |
| **Active** | 30+ live trades, metrics within 1 SD of paper performance | 25% of live capital | Drawdown > 1.5x worst paper drawdown, OR Sharpe < 0 for 2 consecutive periods |
| **Core** | 100+ live trades, sustained edge | Up to 50% of live capital | Same as Active |

### Two-Strike Demotion Rule

- First breach of demotion trigger: capital reduced to 50%.
- Second breach within 30 days: strategy demoted back to Paper (or killed if already demoted twice).

### Kill Criteria (Permanent Retirement)

- Loss streak exceeding 3 standard deviations of expected distribution.
- Not profitable after 60 live trades.
- Demoted twice within 60 days.

### Risk Limits for Live Trading (Hard Limits, Human-Controlled)

| Parameter | Value | Rationale |
|---|---|---|
| Risk per trade | 1% of account balance | Risk of ruin < 0.01% at 55% WR, 1.5:1 payoff |
| Max concurrent positions | 3 | Capital constraint |
| Max short size | 75% of max long size | Unlimited loss potential on shorts |
| Daily loss halt | 3% | Stop all trading for the day |
| Weekly drawdown limit | 5% | Reduce all position sizes by 50% |
| Max drawdown circuit breaker | 10% | Full stop, email alert, manual restart required |
| Max correlated exposure | 2 positions in same sector | Concentration prevention |
| Stop loss (longs) | 2x ATR(14) | Research-backed optimal placement |
| Stop loss (shorts) | 1x ATR(14) | Tighter due to unlimited risk |
| Borrow fee cap | 5% annualized | Hard-to-borrow names eat edge |

**Meta-rule from spec:** "The system can optimize HOW it trades, never HOW MUCH it can lose." All risk limits are in the human-only file category (proposed as GitHub issues only, never AI-modified).

### Position Sizing: ATR-Based with 1% Risk

```
risk_per_trade = account_balance * 0.01
stop_distance  = ATR(14) * multiplier (2x longs, 1x shorts)
shares         = risk_per_trade / stop_distance
position_value = shares * price
```

Minimum position size: $50. Below this, spreads eat the edge -- skip the trade.

### Per-Market Friction

| Market | Stamp Duty | FX Cost (round-trip) | Effective Friction |
|---|---|---|---|
| US (NASDAQ/NYSE) | 0% | ~0.4% (GBP to USD to GBP) | ~0.4% |
| UK AIM | 0% | 0% | ~0.1% (spread only) |
| UK LSE Main | 0.5% (buy only) | 0% | ~0.6% |

Paper metrics already deduct friction per trade. Graduation gate sees friction-adjusted numbers.

### Settlement Rules

- **US equities (NASDAQ/NYSE):** T+1
- **UK/EU equities (LSE):** T+2
- System must track unsettled funds on cash account; do not trade with unsettled cash.

### Short-Specific Controls

**Phase 1 (cash account -- starting state):**
- Shorts allowed, must be settled.
- Short max = 75% of equivalent long max.
- Always use stop-losses on shorts -- non-negotiable.
- Avoid hard-to-borrow names (fee > 5%).
- Track T+1 settlement -- do not trade with unsettled funds.

**Phase 2 (margin -- unlocked manually once edge is proven):**
- Max leverage: 2x (not the full 4x IBKR offers).
- Same risk-per-trade rules apply to leveraged positions.
- Margin call buffer: maintain 50% excess margin above IBKR's 25% minimum.

### Guardian Behavior (Portfolio-Level)

Runs every 60 seconds during market hours (zero API cost):

1. **Stop-loss enforcement** -- check all positions against stops, market-sell on breach.
2. **Trailing stop updates** -- ATR-based, ratchet up as price moves favourably.
3. **Daily P&L check** -- halt trading if 3% daily loss reached.
4. **Drawdown check** -- reduce sizes at 5% weekly, full stop at 10% max.
5. **Position price updates** -- refresh from Yahoo quotes.
6. **Risk of ruin monitoring** -- track rolling estimates, auto-pause if > 5%.

**Stop-losses are set as IBKR-native server-side orders** so they execute even if the bot is disconnected.

### Kill Switch Behavior

- Global `LIVE_TRADING_ENABLED` flag defaults to `false`.
- Must be explicitly set to `true` to enable live trading.
- Circuit breaker (10% max drawdown) triggers full stop with email alert, requires manual restart.
- Daily halt (3% loss) auto-resets next trading day.
- Weekly drawdown (5%) does not halt, but reduces all position sizes by 50%; auto-resets next week.

### Behavioral Divergence Check

If live slippage, fill rate, or execution costs deviate > 20% from paper assumptions, flag for review. Paper trading does not capture real-world friction perfectly.

### "Paper Mode with IBKR" vs "Fully Live"

The spec describes two concurrent systems:

1. **Paper Lab** -- runs 3-5+ strategies against real market data with virtual capital. No real money, no broker interaction. Strategies start here.
2. **Live Executor** -- runs only graduated strategies. Connects to IBKR, places real trades with real capital.

There is an additional nuance: IBKR itself has a paper trading mode (port 4002 vs 4001). The Phase 7 plan defaults to `IBKR_PORT=4002` (paper TWS), meaning the system can connect to IBKR's paper account for integration testing before going truly live. The ports:
- 4001 = live TWS
- 4002 = paper TWS
- 7497 = live gateway

So the progression is:
1. Internal paper lab (no IBKR) -- current state.
2. IBKR paper account (port 4002) -- validates broker integration, order flow, settlement, guardian without real money.
3. IBKR live account (port 4001/7497) -- real capital with all risk controls active.

### Demotion/Kill Criteria for Live Strategies

**Probation tier demotion:** Rolling 20-trade Sharpe < 0.

**Active/Core tier demotion:** Drawdown > 1.5x worst paper drawdown, OR Sharpe < 0 for 2 consecutive periods.

**Kill triggers:** Loss streak > 3 SD, not profitable after 60 live trades, demoted twice in 60 days.

### Deployment/Operations Requirements from Spec

- Hetzner CX22 VPS (Frankfurt), systemd service, SQLite at `/opt/trader-v2/data/`.
- When IBKR integration is added, IB Gateway runs alongside as a separate systemd service or Docker container, API port (4002) bound to localhost only.
- Deployment via GitHub Actions only (push to main), never manually via SSH.
- IBKR "trusted IP" restriction to VPS IP.
- IB Gateway port internal-only (Docker network or localhost).
- IBKR preserves open orders server-side -- stop-losses execute regardless of connection.
- On reconnect, system reconciles positions and resumes.
- Monitoring: dead man's switch (POST to Uptime Kuma every tick), health endpoint, email summaries at market close and weekly.

### FX Awareness

GBP base account. USD trades incur ~0.2% FX spread each way. All friction costs factored into strategy evaluation. Capital constraint is 200-500 GBP.

---

## From Phase 7 Plan

### Task List (What Was Supposed to Be Built)

| Task | What It Builds |
|---|---|
| 1 | Dependencies (`@stoqey/ib`, `rxjs`) + config (`IBKR_HOST`, `IBKR_PORT`, `IBKR_CLIENT_ID`, `LIVE_TRADING_ENABLED`) |
| 2 | Shared types and pure order helpers (`order-types.ts`, `order-status.ts`, `order-events.ts`) |
| 3 | Contract builders for multi-exchange (`contracts.ts` -- LSE GBP, US USD, SMART routing) |
| 4 | Stop-loss + trailing stop pure functions (ported from v1) |
| 5 | Settlement tracking (`settlement.ts` -- T+1 US, T+2 UK, unsettled cash computation) |
| 6 | Capital allocator (`capital-allocator.ts` -- tier-based allocation per spec Section 4) |
| 7 | IBKR connection singleton (`connection.ts` -- reconnect handling, health checks) |
| 8 | Order placement + monitoring (`orders.ts` writes to `liveTrades`, `order-monitor.ts` RxJS subscription) |
| 9 | Guardian loop (`guardian.ts` -- 60s interval, stop-loss enforcement, trailing stops, price updates) + scheduler job |
| 10 | Live executor (`executor.ts` -- evaluates graduated strategies, places trades, settlement-aware) + scheduler job |
| 11 | Scheduler wiring (guardian starts at 08:00 weekdays, live eval every 10 min during market hours) |
| 12 | Integration test checklist (manual, against IB Gateway paper account) |
| 13 | Behavioral divergence tracking (log warning if slippage > 20%) |

### Key Architecture Decisions in Phase 7

- All pure logic ported from v1 unchanged (stop-loss, trailing stops, order status mapping).
- Broker modules adapted to use v2's Drizzle schema (`livePositions`/`liveTrades`), v2's Zod config, v2's pino logger.
- `evaluateSignal` function in `executor.ts` is a placeholder that returns `false` -- actual signal evaluation was deferred. This means the executor cannot actually trigger trades until this is wired.
- `estimateAvailableCash` is a static conservative estimate (hardcoded 500 GBP starting capital minus positions). The TODO says to replace with actual IBKR account balance API call.
- Capital allocator: if multiple strategies share a tier, they split equally. Max position size per strategy = 25% of allocated capital.

### Integration Testing Requirements

Manual checklist against IB Gateway paper account:
1. Connection test (connect, log states, handle disconnect/reconnect).
2. Contract test (verify AAPL NASDAQ contract, `getContractDetails`).
3. Order test (small LIMIT BUY below market, verify in open orders, cancel).
4. Guardian test (insert position with stop-loss above market, verify sell triggered within 60s).
5. Full cycle test (seed probation strategy, enable live trading, run executor, verify allocation respected).

---

## From Phase 8 Plan

### Task List (What Risk Controls Were Supposed to Be Built)

| Task | What It Builds |
|---|---|
| 1 | Risk constants (`constants.ts` -- all hard limits as exported consts, single source of truth) |
| 2 | Per-trade limit checks (`limits.ts` -- pure functions: risk per trade, concurrent positions, max short size, correlated exposure, borrow fee) |
| 3 | ATR-based position sizer (`position-sizer.ts` -- replaces simple percentage-based sizing, includes friction, weekly drawdown reduction) |
| 4 | Guardian checks (`guardian-checks.ts` -- pure functions: daily loss halt 3%, weekly drawdown 5%, circuit breaker 10%) |
| 5 | Demotion and kill criteria (`demotion.ts` -- two-strike rule, kill criteria, behavioral divergence checks) |
| 6 | Schema addition (`risk_state` table -- key/value store for daily_pnl, weekly_pnl, peak_balance, circuit_breaker_tripped, halt flags) |
| 7 | Wire risk checks into evaluator (`gate.ts` composing pure checks; evaluator calls risk gate before opening positions) |
| 8 | Guardian runner (`src/risk/guardian.ts` -- reads DB state, calls pure checks, writes back flags, persists circuit breaker state) |

### How Guardian Checks Interact with Live Positions

1. **Risk gate before trade placement:** `checkTradeRiskGate` runs ATR position sizing + all per-trade limit checks (risk per trade, concurrent positions, max short size, correlated exposure, borrow fee). If any check fails, the trade is rejected with a reason.

2. **Guardian runner every 60s:** Reads `risk_state` table for `peak_balance`, `account_balance`. Calls pure `runGuardianChecks` with current portfolio value, daily P&L, weekly P&L. Persists results:
   - Circuit breaker tripped -> writes `circuit_breaker_tripped=true`, requires manual `resetCircuitBreaker()`.
   - Daily halt -> writes `daily_halt_active=true`, auto-resets next trading day via `resetDailyState()`.
   - Weekly drawdown -> writes `weekly_drawdown_active=true`, halves position sizes via the position sizer's `weeklyDrawdownActive` flag, auto-resets Monday via `resetWeeklyState()`.

3. **Demotion checks:** `checkTwoStrikeDemotion` and `checkKillCriteria` are pure functions that examine a strategy's event history. They are called when a demotion trigger fires (Sharpe < 0, drawdown exceeded). The demotion logic:
   - First strike: capital multiplied by 0.5.
   - Second strike within 30 days: demote to Paper.
   - Already demoted twice within 60 days: permanent kill.

4. **Behavioral divergence:** `checkBehavioralDivergence` compares paper vs live slippage, fill rate, and friction. If any deviates > 20%, the result `diverged=true` with specific reasons.

### Key Architecture Decision in Phase 8

All risk checking logic is pure functions with no side effects. The only file with side effects is `src/risk/guardian.ts` (the orchestration layer that reads/writes DB). This makes all limit checks trivially testable without mocks.

---

## Gaps

### Things the Spec Requires That Phase 7 + 8 Plans Do Not Fully Cover

1. **IBKR-native server-side stop-loss orders.** The spec says "Stop-losses are set as IBKR-native server-side orders so they execute even if the bot is disconnected." Phase 7's guardian checks stop-losses locally every 60s and places market sells on breach, but it does NOT set server-side stop-loss orders with IBKR at position open time. If the bot goes down, stops are not enforced until reconnection. This is a significant gap for live deployment.

2. **Signal evaluation in live executor is a placeholder.** Phase 7 Task 10 has `evaluateSignal()` returning `false` always, with a comment saying "For Phase 7 MVP, return false (no automatic trading) until evaluator integration is wired." The live executor cannot actually place trades from signal evaluation -- it needs to be wired to the same `evalExpr` used in the paper evaluator.

3. **Actual IBKR account balance API call.** Phase 7's `estimateAvailableCash()` uses a hardcoded 500 GBP starting capital minus position values. In production, this must call the IBKR account summary API to get real available cash.

4. **Risk of ruin monitoring.** The spec's guardian behavior includes "Risk of ruin monitoring -- track rolling estimates, auto-pause if > 5%." Neither Phase 7 nor Phase 8 implements this. There is no function to compute risk of ruin from rolling trade history.

5. **Position reconciliation on reconnect.** The spec says "On reconnect, system reconciles positions and resumes." Phase 7's connection module handles reconnect events and does a health check, but there is no position reconciliation logic that compares local `livePositions` table against IBKR's actual positions.

6. **Email alert on circuit breaker.** Phase 8's guardian runner has a `// TODO: Send email alert via reporting/email.ts` comment when the circuit breaker trips. The spec requires email alert on 10% max drawdown.

7. **Active/Core promotion criteria checks.** The spec defines promotion from Probation to Active (30+ live trades, metrics within 1 SD of paper) and Active to Core (100+ live trades, sustained edge). Neither plan includes automated tier promotion logic -- only the initial graduation from Paper to Probation is covered.

8. **IB Gateway setup as systemd service or Docker container.** The spec says IB Gateway should run alongside as a separate service. Neither plan covers the operational setup of IB Gateway on the VPS (systemd unit file, Docker compose, trusted IP config, auto-restart).

9. **Margin phase.** The spec describes Phase 2 margin trading (2x max leverage, margin call buffer at 50% excess above IBKR's 25% minimum). Neither plan addresses margin-aware position sizing or margin monitoring.

10. **Sector data for correlated exposure checks.** Phase 8's `checkCorrelatedExposure` requires a `sector` for each position and proposed trade. Phase 7's risk gate passes `sector: null` with a comment "sector lookup added in future task." Without sector data, the correlated exposure limit is never enforced.

11. **Demotion trigger detection loop.** Phase 8 defines the demotion/kill pure functions, but there is no scheduled job or trigger that detects when a strategy has breached demotion thresholds (rolling 20-trade Sharpe < 0, drawdown > 1.5x paper max). The functions exist but nothing calls them periodically.

12. **Live position creation from fills.** Phase 7's order monitor updates `liveTrades` status on fill, but there is no logic to create or update `livePositions` entries when a trade fills. The guardian reads from `livePositions`, but nothing populates it from filled trades.

### Ambiguities

1. **"Max position size per strategy = 25% of allocated capital"** appears in the Phase 7 capital allocator but is not in the spec. The spec does not define an intra-strategy diversification limit. This could be overly conservative for a probation strategy with 10% allocation (25% of 10% of 500 GBP = 12.50 GBP position, barely above the $50 minimum).

2. **Market hours for guardian.** The spec says guardian runs "every 60 seconds during market hours." Phase 7 starts the guardian at 08:00 London time as a continuous 60s interval, but does not stop it after market close. The interval runs 24/7 once started (until the process restarts next day). This is harmless but wasteful.

3. **Which evaluator for live.** The spec says the Paper Lab and Live Executor both evaluate strategies against market data. Phase 7's executor has its own `evaluateSignal` stub rather than reusing the paper evaluator's `evalExpr` + context building. The spec implies they should use the same mechanical evaluation logic.

4. **Settlement tracking granularity.** Phase 7's settlement module skips weekends but not bank holidays. The implementation notes this is "conservative enough for safety" -- but for UK bank holidays with T+2 settlement, it could undercount by a day, potentially allowing trading with unsettled funds on rare occasions.

5. **Trailing stop ATR multiplier.** Phase 7's guardian uses a hardcoded `TRAILING_STOP_ATR_MULTIPLIER = 2` for trailing stops. Phase 8's constants define `STOP_LOSS_ATR_MULT_LONG = 2` and `STOP_LOSS_ATR_MULT_SHORT = 1` for initial stop-losses. The spec says trailing stops are "ATR-based" but does not specify whether the multiplier should differ from the initial stop-loss multiplier or whether it should differ for longs vs shorts.

6. **What counts as "profitable" for the 60-trade kill.** Phase 8 checks `totalPnl <= 0` after 60 live trades. The spec says "not profitable after 60 live trades" -- unclear whether this means total P&L or whether it should be friction-adjusted, or if commission costs are already deducted.

### Contradictions

1. **None found.** The Phase 7 and Phase 8 plans are consistent with the spec. All hard limit values match. The plans are subsets of the spec requirements (they implement what they claim to implement), with the gaps noted above being omissions rather than contradictions.
