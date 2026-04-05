# Trader v2: Autonomous Strategy Discovery Engine

**Date:** 2026-04-03
**Status:** Draft
**Author:** Cal + Claude

## Overview

A new autonomous trading system that discovers its own edge through experimentation. Replaces the current ISA-focused momentum trader with a "Paper Lab + Live Executor" architecture: multiple strategies run simultaneously in paper trading, and only graduate to real capital after statistically proving edge.

### Goals

- Net profitable after API costs within 6 months
- Fully autonomous — light daily oversight via email, active engineering on the system
- Self-improving — the system evolves its own strategies via parameter mutation and code PRs
- Cost-efficient — total running cost under £15/month

### Constraints

- **Capital:** £200–500 IBKR regular account (active trading). ISA parked in index ETF, ignored.
- **API budget:** £10–15/month (~$12–18/month)
- **Risk progression:** Start long+short cash account, graduate to margin (2x max) once edge is proven
- **Markets:** Multi-market — US (NASDAQ/NYSE), UK (LSE main + AIM), EU. The system discovers where edge exists rather than prescribing it.
- **No PDT constraint:** UK-based on IBKR UK (FCA-regulated), exempt from FINRA pattern day trader rule
- **Settlement:** T+1 on US equities, T+2 on UK/EU — system must track unsettled funds on cash account
- **FX awareness:** GBP base account. USD trades incur ~0.2% FX spread each way. AIM stocks have 0% stamp duty. LSE main market has 0.5% stamp duty on buys. US has 0% stamp duty. All friction costs factored into strategy evaluation.

### Relationship to Current Codebase

New project. Cherry-pick infrastructure from the current repo (documents/projects/trader):
- `db/client.ts` — SQLite + Drizzle setup
- `utils/token-tracker.ts`, `utils/cost.ts` — API cost tracking
- `utils/logger.ts` — Pino logging
- `reporting/email.ts` — Resend email integration
- `broker/connection.ts`, `broker/orders.ts` — IBKR connection + order placement
- `research/sources/yahoo-finance.ts` — quote/fundamentals fetching
- `research/sources/news-scraper.ts` — RSS feed polling
- `research/sources/fmp.ts` — FMP integration

Everything ISA-specific is dropped: stamp duty handling, long-only constraints, ISA risk limits, the 3-tier escalation system, the current orchestrator.

---

## 1. System Architecture

Two concurrent systems sharing a single database:

**Paper Lab** — runs 3–5+ strategies against real market data with virtual capital. Each strategy is isolated with its own virtual balance, positions, and trade log. No real money, no broker interaction.

**Live Executor** — runs only strategies that have graduated via statistical proof of edge. Connects to IBKR, places real trades with real capital.

### Core Loop

```
Morning:   Fetch market data (quotes, news) -> shared data layer
           Paper Lab evaluates all strategies -> generate paper trades
           Live Executor evaluates graduated strategies -> generate real trades

Intraday:  Guardian monitors live positions (stop losses, trailing stops)
           Paper Lab tracks hypothetical positions against real prices
           News event bus triggers immediate evaluations on breaking news

Evening:   Score all trades (paper + live)
           Learning loop: Haiku reviews each closed trade -> pattern tags + insights
           Learning loop: insights accumulate in trade_insights table

Twice/wk: Pattern analysis: Haiku reviews trade clusters -> regime observations, failure modes

Weekly:    Graduation gate evaluates paper strategies for live promotion
             (statistical gate + Haiku qualitative reasoning review)
           Strategy evolution proposes mutations informed by learning loop insights
           Learning loop meta-evolution: tune review prompts based on insight hit rates
           Self-improvement can modify its own code via PRs
```

**Key design principle:** Claude is used for *thinking about strategies* (evolution, generation, review) and *learning from outcomes* (trade review, pattern analysis), not for *executing trades*. Trading decisions are mechanical — predefined rules evaluated against market data. AI spend is concentrated where it has genuine edge: understanding text, spotting patterns across trades, and reasoning about strategy quality. This keeps API costs minimal while maximising the system's ability to learn.

---

## 2. Data Architecture

Single SQLite database via Drizzle ORM (same stack as current system).

### Core Tables

| Table | Purpose |
|---|---|
| `strategies` | Registry of all strategies. Name, description, parameters (JSON), status (paper/probation/active/core/retired), virtual_balance, parent_strategy_id, generation, created_by |
| `paper_positions` | Virtual positions per strategy. Symbol, quantity, entry_price, strategy_id, stop_loss, trailing_stop |
| `paper_trades` | Every hypothetical trade. Symbol, side, quantity, price, strategy_id, timestamp, reasoning, signal_type |
| `live_positions` | Real IBKR positions. Symbol, quantity, avg_cost, current_price, stop_loss, trailing_stop, high_water_mark |
| `live_trades` | Real executed trades. Symbol, side, quantity, fill_price, commission, pnl, strategy_id, reasoning |
| `quotes_cache` | Latest Yahoo quotes refreshed every 5–15 min. Shared across all strategies |
| `strategy_metrics` | Rolling performance per strategy: win_rate, expectancy, sharpe, sortino, profit_factor, max_drawdown, sample_size, calmar_ratio |
| `graduation_events` | Audit log: graduation/demotion events with statistical evidence |
| `strategy_mutations` | Evolution lineage: parent_id, child_id, mutation_type, parameter_diff, parent_sharpe, child_sharpe, generation |
| `news_events` | Headlines + classification results. Source, headline, symbols, sentiment, tradeable, event_type, urgency |
| `earnings_calendar` | Upcoming earnings dates. Symbol, date, estimated_eps, source |
| `token_usage` | API cost tracking per job (cherry-picked from current system) |
| `agent_logs` | General audit trail (cherry-picked from current system) |
| `daily_snapshots` | End-of-day portfolio snapshots for P&L tracking |
| `trade_insights` | Accumulated learning loop observations: pattern tags, suggested actions, confidence, led_to_improvement flag |
| `learning_loop_config` | Versioned review prompts and criteria for trade review, pattern analysis, graduation reasoning. Tracks hit_rate for meta-evolution |
| `improvement_proposals` | Self-improvement PRs and issues with status tracking |

---

## 3. Strategy System

### Strategy Definition

A strategy is a JSON parameter set stored in the `strategies` table:

```json
{
  "name": "news_sentiment_mr_v1",
  "description": "Buy on positive sentiment divergence with oversold RSI, short the inverse",
  "universe": ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA"],
  "signals": {
    "entry_long": "news_sentiment > 0.7 AND rsi14 < 30 AND volume_ratio > 1.5",
    "entry_short": "news_sentiment < -0.7 AND rsi14 > 70 AND volume_ratio > 1.5",
    "exit": "hold_days >= 3 OR pnl_pct < -2 OR pnl_pct > 5"
  },
  "parameters": {
    "sentiment_threshold": 0.7,
    "rsi_oversold": 30,
    "rsi_overbought": 70,
    "hold_days": 3,
    "position_size_pct": 10
  },
  "status": "paper",
  "virtual_balance": 10000,
  "parent_strategy_id": null,
  "generation": 1
}
```

Strategies are NOT hardcoded. The AI generates and evolves them. Signal rules are evaluated mechanically against market data — no Claude API call per trade.

### Seed Strategies

Three diverse starting strategies, each leveraging the LLM's text comprehension edge:

**Strategy 1: News Sentiment Mean Reversion**
- Signal: LLM scores breaking news. Buy stocks with positive sentiment + oversold RSI. Short the inverse.
- Hold period: 1–3 days
- Edge: LLM detects nuance that simple keyword sentiment misses
- Parameters: sentiment_threshold, rsi_oversold, rsi_overbought, hold_days (4 params)

**Strategy 2: Gap Fade with Sentiment Filter**
- Signal: Fade opening gaps > 2%, but only when LLM confirms no fundamental reason for the gap
- Hold period: Intraday to 1 day
- Edge: LLM filters out gaps caused by real catalysts (which shouldn't be faded)
- Parameters: gap_threshold_pct, sentiment_filter, exit_target_pct (3 params)

**Strategy 3: Earnings Drift**
- Signal: After earnings release, LLM reads headline/summary. Long on positive surprise with confident tone, short on negative.
- Hold period: 1–5 days (post-earnings drift)
- Edge: LLM assesses management tone, not just the numbers
- Parameters: surprise_threshold, tone_score_min, hold_days, position_size_pct (4 params)

All leverage the LLM's actual strength (text comprehension), all have <=5 parameters to avoid overfitting. Each seed strategy starts with a mixed universe of US large-caps + UK AIM stocks (zero stamp duty on both). The evolution system can shift a strategy's universe toward whichever market shows more edge — e.g., if UK mid-caps with sparse analyst coverage produce better sentiment alpha than hyper-efficient US mega-caps, the system will discover that.

### Strategy Evaluation

Runs every 5–15 minutes during market hours:

1. Fetch latest quotes from `quotes_cache`
2. For each active strategy, evaluate signal rules against current data
3. If entry/exit signal fires -> create `paper_trade` (or `live_trade` for graduated strategies)
4. Update positions accordingly
5. Zero Claude API calls — pure mechanical evaluation

**Signal expression evaluation:** Signal strings like `"news_sentiment > 0.7 AND rsi14 < 30"` are parsed by a simple safe expression evaluator (NOT `eval()`). The evaluator supports: numeric comparisons (`>`, `<`, `>=`, `<=`, `==`), boolean operators (`AND`, `OR`), and a fixed set of variable names that map to current market data fields (rsi14, volume_ratio, news_sentiment, hold_days, pnl_pct, etc.). Unknown variables evaluate to `null` and the signal does not fire.

**News signals as strategy variables:** When the news event bus classifies a headline as tradeable for a symbol, it writes the full signal set (sentiment, earnings_surprise, management_tone, catalyst_type, etc.) to `quotes_cache` alongside the price data. The strategy evaluator reads them like any other field — no API call at evaluation time. This means strategies can express nuanced rules like `"earnings_surprise > 0.7 AND management_tone > 0.5"` rather than just `"news_sentiment > 0.7"`.

### Universe Management

Each strategy defines a `universe` of symbols to track. The universe is managed as follows:

- **Seed strategies** start with a curated mixed universe: ~15 liquid US large-caps (top S&P 500 by volume) + ~10 UK AIM stocks (high volume, zero stamp duty) + ~5 LSE main market blue chips
- **The evolution system can modify a strategy's universe** as a parameter mutation (add/remove symbols)
- **News-discovered symbols** can be temporarily added to all strategies' evaluation when the news bus detects a high-urgency event for a symbol not in any universe
- **Universe cap:** max 50 symbols per strategy (bounded quote fetching cost)
- **Minimum liquidity filter:** average daily volume > 500k shares (avoids illiquid names where paper results won't match live)

---

## 4. Graduation Gate

Evidence-based criteria derived from quantitative finance research (Harvey, Liu & Zhu 2016; de Prado "Advances in Financial Machine Learning").

### Graduation Criteria (ALL must pass)

| Criterion | Threshold | Rationale |
|---|---|---|
| Sample size | >= 30 trades | Minimum for statistical inference |
| Expectancy | > 0 per trade | More important than win rate — 35% WR with 3:1 R:R is fine |
| Profit factor | > 1.3 | Gross profit / gross loss. Industry minimum viable. |
| Sharpe ratio (annualized) | > 0.5 | Minimum viable risk-adjusted return |
| Max drawdown | < 15% of virtual balance | Conservative for small capital |
| Consistency | Profitable in >= 3 of last 4 weeks | Prevents lucky-streak graduation |
| Walk-forward validation | Signal works on most recent 20% of data | Prevents overfitting to historical window |
| Parameter count | <= 5 tunable parameters | More params at small sample = almost certainly overfit |

Win rate is deliberately absent as a standalone criterion. Expectancy and profit factor capture what matters.

### Tiered Capital Allocation

| Tier | Entry Criteria | Capital Allocation | Demotion Trigger |
|---|---|---|---|
| **Paper** | Default state | £0 (virtual only) | N/A |
| **Probation** | Passes all graduation criteria at 30+ trades | 10% of live capital (~£20–50) | Rolling 20-trade Sharpe < 0 |
| **Active** | 30+ live trades, metrics within 1 SD of paper performance | 25% of live capital | Drawdown > 1.5x worst paper drawdown, OR Sharpe < 0 for 2 consecutive periods |
| **Core** | 100+ live trades, sustained edge | Up to 50% of live capital | Same as Active |

### Behavioral Divergence Check

If live slippage, fill rate, or execution costs deviate > 20% from paper assumptions, flag for review. Paper trading doesn't capture real-world friction perfectly.

### Kill Criteria (Permanent Retirement)

- Loss streak exceeding 3 standard deviations of expected distribution
- Not profitable after 60 live trades
- Demoted twice within 60 days

### Two-Strike Demotion Rule

First breach of demotion triggers: capital reduced to 50%. Second breach within 30 days: strategy demoted back to Paper (or killed if already demoted twice).

---

## 5. Self-Improvement & Evolution System

Two-track evolution: autonomous parameter mutation + human-gated code changes.

### Track 1: Parameter Evolution (Autonomous)

Strategies are JSON parameter sets. Evolution uses tournament selection with Bayesian optimization:

1. **Weekly evolution cycle** (1 Sonnet call): Review all strategy performance data. Select top performers. For each, propose 1–2 parameter variants.
2. **Deploy variants as new paper strategies** alongside the parent. Both run simultaneously.
3. **After 30+ trades each**, compare parent vs child statistically. Winner survives, loser retires.
4. **New strategies** can be proposed — Sonnet sees the full performance landscape and identifies gaps.

**Safety rails:**
- Every parameter has hard-clamped range (e.g., stop_loss_pct: 1–10%)
- Max 5 parameters per strategy (overfitting prevention)
- Population cap: max 8 paper strategies active at once
- Exponentially weighted fitness — recent performance matters more
- Drawdown kill switch: any mutant drawing down > 15% in paper is culled immediately
- Max population diversity enforced — prevent convergence to single approach

### Track 2: Code Evolution (Human-Gated)

For structural changes (new signal types, new data sources, graduation gate modifications):

1. Weekly Sonnet call proposes code changes as PRs
2. Automated tests must pass before PR is created
3. User reviews and merges (or rejects)
4. Rate-limited: max 2 PRs/week, max 3 issues/week

**Whitelisted files** (AI proposes direct code changes):
- Strategy evaluation logic
- Signal computation functions
- News classification prompts
- Reporting templates

**Human-only files** (AI proposes as GitHub issues):
- Risk limits and hard caps
- Graduation gate thresholds
- Broker integration
- Database schema

### Lineage Tracking

`strategy_mutations` table records:
- parent_id -> child_id
- mutation_type: "parameter_tweak" | "new_variant" | "code_change"
- parameter_diff: JSON of what changed
- parent_sharpe -> child_sharpe (after evaluation)
- generation: integer

Enables tracing which evolutionary paths produce edge. If Sharpe isn't trending up across generations, the evolution process itself needs tuning.

### Track 3: Learning Loop Evolution (Self-Evolving)

The learning loop's own prompts, review criteria, and analysis patterns are themselves subject to evolution. This is the meta-layer — the system learns how to learn.

**What evolves:**
- Trade review prompt (what questions to ask about each trade outcome)
- Pattern analysis prompt (what patterns to look for across trade clusters)
- Graduation reasoning prompt (what qualitative factors to weigh)
- The set of insight categories the learning loop tracks
- Weighting of different insight types when feeding back to evolution

**How it evolves:**
1. The learning loop tracks which of its own insights led to actionable improvements (via lineage: insight → evolution proposal → child strategy → performance delta)
2. Weekly, the evolution cycle includes a meta-review: "which types of learning loop insights actually improved strategies?"
3. Insights with high hit rates get amplified; insight categories that never lead to improvements get pruned
4. The review prompts themselves are versioned in `learning_loop_config` and can be mutated by the evolution system (whitelisted for AI modification)

**Safety rails:**
- Meta-evolution runs at most 1x/week alongside parameter evolution (same Sonnet call)
- Prompt changes are logged with before/after diffs in `strategy_mutations` (mutation_type: "learning_prompt_tweak")
- If learning loop quality degrades (measured by insight→improvement hit rate), auto-revert to last known good prompt version
- Human can freeze learning prompts via config flag

This creates a triple flywheel: trades generate data → learning loop extracts insights → evolution uses insights to improve strategies → better strategies generate better data → learning loop evolves to extract better insights.

---

## 6. Learning Loop

The learning loop is the system's primary feedback mechanism. It closes the gap between "what happened" and "what should change." Without it, the evolution system is flying blind — optimising parameters without understanding *why* trades succeed or fail.

**Key design principle:** The learning loop is not a cost centre — it's the system's competitive edge. Every insight it produces should either improve a strategy or prove that a strategy's edge is real. If it's not doing either, its own prompts need evolving (see Track 3 above).

### Daily Trade Review (Haiku, ~$0.02/day)

Runs after market close. Reviews all trades closed today (paper + live).

**Input:** Trade details (symbol, side, entry/exit prices, PnL, hold time, signal that fired, news context at entry, price action during hold).

**Output:** Structured JSON per trade:
```json
{
  "trade_id": "abc123",
  "outcome_quality": "good_entry_early_exit",
  "what_worked": "Sentiment signal correctly identified earnings surprise direction",
  "what_failed": "Exit triggered too early — trailed stop too tight for post-earnings drift",
  "pattern_tags": ["earnings_drift_truncated", "stop_too_tight"],
  "suggested_parameter_adjustment": {
    "parameter": "trailing_stop_multiplier",
    "direction": "increase",
    "reasoning": "Post-earnings moves typically extend 2-3 days; current 1-day exit misses the tail"
  },
  "market_context": "Low volatility environment — ATR-based stops may be too tight",
  "confidence": 0.7
}
```

**What it feeds:**
- `pattern_tags` accumulate in a `trade_insights` table. When the same tag appears 5+ times across a strategy's trades, it becomes a signal to the evolution system.
- `suggested_parameter_adjustment` is advisory — the evolution system can accept or ignore it, but it's weighted input alongside raw metrics.
- `market_context` observations feed into graduation reasoning (see below).

### Pattern Analysis (Haiku, 2x/week ~$0.40/month)

Looks across trade clusters rather than individual trades. Groups recent trades by strategy, symbol, time-of-day, event type, and market regime. Identifies:

- **Recurring failure modes** — e.g., "gap fade strategy consistently loses on Monday mornings" → suggests time-of-day filter
- **Regime sensitivity** — e.g., "news sentiment strategy works in low-VIX but fails in high-VIX" → suggests regime-aware entry rules
- **Cross-strategy patterns** — e.g., "two strategies are taking opposite sides of the same trade" → flags redundancy or hedging opportunity
- **Edge decay** — e.g., "strategy's win rate has been declining monotonically for 3 weeks" → early warning before metrics breach demotion threshold

Output is a structured list of observations ranked by confidence and actionability. High-confidence observations are logged to `trade_insights` and surfaced to the evolution system.

### Graduation Reasoning (Haiku, as needed ~$0.20/month)

The graduation gate's statistical criteria (Section 4) are necessary but not sufficient. Before promoting a strategy to live capital, Haiku reviews the qualitative picture:

**Input:** Strategy metrics, recent trade log, pattern analysis insights, market regime context.

**Questions the review answers:**
1. Is this edge real or is it regime-dependent? (e.g., "only works in a bull market")
2. Are the wins concentrated in a few large trades or distributed? (concentration risk)
3. Does the strategy's universe still make sense? (e.g., has a stock become illiquid)
4. Are there any pattern_tags suggesting a systematic weakness the metrics don't capture?
5. Would this strategy survive a regime change (vol spike, sector rotation)?

**Output:**
```json
{
  "recommendation": "graduate" | "hold" | "concerns",
  "confidence": 0.8,
  "reasoning": "Edge appears real — wins distributed across 12 symbols, no regime dependency detected. Pattern analysis flags tight stops as recurring issue but profit factor still strong.",
  "risk_flags": ["stop_distance_may_need_widening"],
  "suggested_conditions": "Monitor first 10 live trades for slippage divergence"
}
```

A "concerns" recommendation blocks graduation until the next review cycle. A "hold" delays by one week. Only "graduate" with confidence > 0.6 proceeds. The statistical gate must still pass — this is an additional qualitative gate, not a replacement.

### Data Architecture

| Table | Purpose |
|---|---|
| `trade_insights` | Accumulated pattern tags and observations from trade reviews. Columns: id, strategy_id, trade_id (nullable), insight_type (trade_review/pattern_analysis/graduation), tags (JSON), observation, suggested_action (JSON), confidence, led_to_improvement (boolean, backfilled), created_at |
| `learning_loop_config` | Versioned prompts and review criteria. Columns: id, config_type (trade_review/pattern_analysis/graduation), prompt_version, prompt_text, active (boolean), hit_rate (float, backfilled), created_at, retired_at |

### The Complete Flywheel

```
Trades → Trade Review (daily) → pattern_tags + suggestions
                                        ↓
                              Pattern Analysis (2x/week) → recurring patterns + regime observations
                                        ↓
                              Evolution Cycle (weekly) → parameter mutations informed by insights
                                        ↓
                              New/improved strategies → more trades → ...
                                        ↑
                              Learning Loop Meta-Evolution (weekly) → better review prompts → better insights
```

Every component in this loop is observable and measurable. If trade reviews aren't producing actionable insights, the meta-evolution layer tunes the prompts. If pattern analysis flags something that evolution ignores, that's logged for human review. The system gets smarter at getting smarter.

---

## 7. News & Event Bus

### Architecture

```
Finnhub Websocket -----> Keyword Pre-Filter -----> Haiku Classifier -----> Event Bus
SEC EDGAR Poll (5m) --->                                                      |
RSS Feeds Poll (10m) -->                                              +-------+-------+
                                                                      | Paper Lab     |
                                                                      | Live Executor |
                                                                      +---------------+
```

### Three-Stage Pipeline

**Stage 1: Streaming Ingest (free, <1s)**
- Finnhub websocket (free tier: 60 msg/min) — real-time US market news with ticker tags
- SEC EDGAR RSS (polled every 5 min) — 8-K filings (US material events, earnings)
- UK Regulatory News Service (RNS) via RSS (polled every 5 min) — UK equivalent of EDGAR, covers LSE + AIM regulatory announcements
- RSS feeds (polled every 10 min) — PR Newswire, GlobeNewsWire, Investegate (UK), financial press

All headlines stored in `news_events` table.

**Stage 2: Keyword Pre-Filter (free, <1ms)**
Regex/keyword gate eliminates ~80% of noise before any API call:
- Pass-through: earnings, FDA, acquisition, merger, guidance, downgrade, upgrade, profit warning, revenue, buyback, dividend, bankruptcy, recall
- Block: analyst reiterates, routine filing, board appointment, ESG report
- ~10–20 headlines/day pass the keyword gate from ~50–100 total

**Stage 3: Haiku Classification (~$0.001/call)**

Returns structured JSON with **event-specific signal fields**, not just a sentiment float. Different event types produce different tradeable signals — an FDA approval and a revenue beat both score high sentiment, but they have very different implications for price action. The classifier captures this nuance so strategies can differentiate.

```json
{
  "tradeable": true,
  "symbols": ["AAPL"],
  "sentiment": 0.8,
  "confidence": 0.85,
  "event_type": "earnings_beat",
  "urgency": "high",
  "signals": {
    "earnings_surprise": 0.9,
    "guidance_change": 0.3,
    "management_tone": 0.7,
    "regulatory_risk": 0.0,
    "acquisition_likelihood": 0.0,
    "catalyst_type": "fundamental",
    "expected_move_duration": "1-3d"
  }
}
```

The `signals` object is event-type-dependent — only relevant fields are populated (others null). These are written to `quotes_cache` as individual signal variables (e.g., `earnings_surprise`, `management_tone`) that strategy expressions can reference directly. This lets strategies distinguish "buy on earnings surprise with confident management tone" from "buy on high sentiment" — the latter loses the nuance that is the LLM's actual edge.

At 10–20 calls/day = $0.01–0.02/day (same cost — richer output schema, not more calls).

### Event Bus Behavior

When a headline is classified as tradeable + high urgency:
1. Check if any paper strategy has a signal rule matching this event type
2. Check if any graduated live strategy has a matching signal rule
3. If yes -> trigger immediate strategy evaluation for affected symbols
4. Log event, classification, and resulting trades for learning loop

### Earnings Calendar

Nightly batch job (Finnhub free endpoint) fetches next 2 weeks of earnings dates into `earnings_calendar` table. Strategies reference this for entry/exit rules.

---

## 8. Risk Management

Replaces the ISA-centric risk system entirely. Multi-market aware — accounts for per-exchange friction (stamp duty, FX costs, spreads) in all position sizing and strategy evaluation.

### Position Sizing: ATR-Based with 1% Risk

```
risk_per_trade = account_balance * 0.01       (e.g., $500 * 1% = $5)
stop_distance  = ATR(14) * multiplier          (2x for longs, 1x for shorts)
shares         = risk_per_trade / stop_distance
position_value = shares * price
```

Minimum position size: $50. Below this, spreads eat the edge. If calculation yields < $50, skip the trade.

### Hard Limits (Human-Controlled, Not AI-Tunable)

| Parameter | Value | Rationale |
|---|---|---|
| Risk per trade | 1% | Risk of ruin < 0.01% at 55% WR, 1.5:1 payoff |
| Max concurrent positions | 3 | Capital constraint |
| Max short size | 75% of max long size | Unlimited loss potential on shorts |
| Daily loss halt | 3% | Stop all trading for the day |
| Weekly drawdown limit | 5% | Reduce all position sizes by 50% |
| Max drawdown circuit breaker | 10% | Full stop, email alert, manual restart required |
| Max correlated exposure | 2 positions in same sector | Concentration prevention |
| Stop loss (longs) | 2x ATR(14) | Research-backed optimal placement |
| Stop loss (shorts) | 1x ATR(14) | Tighter due to unlimited risk |
| Borrow fee cap | 5% annualized | Hard-to-borrow names eat edge |

### Per-Market Friction (Factored Into Strategy P&L)

| Market | Stamp Duty | FX Cost (round-trip) | Effective Friction |
|---|---|---|---|
| US (NASDAQ/NYSE) | 0% | ~0.4% (GBP→USD→GBP) | ~0.4% |
| UK AIM | 0% | 0% | ~0.1% (spread only) |
| UK LSE Main | 0.5% (buy only) | 0% | ~0.6% |

Paper strategy metrics automatically deduct the applicable friction per trade. A strategy that looks profitable before friction but not after is correctly penalised — the graduation gate sees the friction-adjusted numbers.

**Implication for strategy evolution:** The system will naturally favour low-friction markets (US, AIM) for short-duration trades and tolerate higher-friction markets (LSE main) only for longer holds where the expected move exceeds the friction. The AI doesn't need to be told this — the P&L data will show it.

### Short-Specific Controls

**Phase 1 (cash account — starting state):**
- Shorts allowed, must be settled
- Short max = 75% of equivalent long max
- Always use stop-losses on shorts — non-negotiable
- Avoid hard-to-borrow names (fee > 5%)
- Track T+1 settlement — don't trade with unsettled funds

**Phase 2 (margin — unlocked manually once edge is proven):**
- Max leverage: 2x (not the full 4x IBKR offers)
- Same risk-per-trade rules apply to leveraged positions
- Margin call buffer: maintain 50% excess margin above IBKR's 25% minimum

### Portfolio-Level Guardian

Runs every 60 seconds during market hours (zero API cost):

1. Stop-loss enforcement — check all positions against stops, market-sell on breach
2. Trailing stop updates — ATR-based, ratchet up as price moves favourably
3. Daily P&L check — halt trading if 3% daily loss reached
4. Drawdown check — reduce sizes at 5% weekly, full stop at 10% max
5. Position price updates — refresh from Yahoo quotes
6. Risk of ruin monitoring — track rolling estimates, auto-pause if > 5%

Stop-losses are set as **IBKR-native server-side orders** so they execute even if the bot is disconnected.

---

## 9. Deployment & Monitoring

### Infrastructure

**Hetzner CX22 in Frankfurt** — EUR 5.50/month (~GBP 4.70). 2 vCPU, 4GB RAM, 40GB SSD. Already deployed and running.

### Runtime

Bun runs directly on the VPS as a systemd service (`trader-v2.service`). SQLite database stored at `/opt/trader-v2/data/`. No Docker — simpler, lower overhead for a single-process app.

When IBKR integration is added, IB Gateway will run alongside as a separate systemd service or Docker container, with API port (4002) bound to localhost only.

### Deployment Pipeline (Live)

Two GitHub Actions workflows:

**CI** (`.github/workflows/ci.yml`) — runs on PR to main:
1. Install deps (`bun install --frozen-lockfile`)
2. Lint, typecheck, test

**Deploy** (`.github/workflows/deploy.yml`) — runs on push to main + manual dispatch:
1. Same lint/typecheck/test gate
2. SSH to Hetzner, `git pull origin main`
3. `bun install --frozen-lockfile`
4. Run DB migrations (`bun run db:migrate`)
5. `sudo systemctl restart trader-v2`

### Monitoring

**Layer 1: Dead man's switch**
Trader POSTs to Uptime Kuma push monitor every tick. Missed for 5 minutes -> email alert.

**Layer 2: Health endpoint**
`GET /health` returns connection status, last tick time, active strategies, daily P&L, API spend. Uptime Kuma polls every 60s.

**Layer 3: Email summaries (Resend)**
- Market close: positions, P&L, trades, paper strategy performance, API spend
- Weekly digest: evolution updates, graduation events, pending self-improvement PRs

**Pause/status:** Simple web page behind basic auth. Single HTML page for viewing status and pausing/resuming trading.

### Downtime Handling

- IBKR preserves open orders server-side — stop-losses execute regardless of connection
- On reconnect, system reconciles positions and resumes
- Hetzner 99.9% SLA = ~43 min downtime/month — acceptable at this scale

### Security

- `.env` file with `chmod 600` for secrets
- SSH key-only auth, password disabled, fail2ban
- IBKR "trusted IP" restriction to VPS IP
- IB Gateway port internal-only (Docker network)
- No secrets in git — GitHub Actions secrets for deploy

---

## 10. Cost Budget

### Monthly Running Costs

| Item | Monthly Cost | Notes |
|---|---|---|
| Hetzner VPS | GBP 4.70 | CX22, Frankfurt |
| Anthropic API | GBP 5–10 | See breakdown below |
| Resend email | GBP 0 | Free tier (3k emails/month) |
| Finnhub | GBP 0 | Free tier (60 calls/min) |
| Yahoo Finance | GBP 0 | Free, no key needed |
| FMP | GBP 0 | Free tier if needed |
| IBKR Lite | GBP 0 | No commission, no data fees |
| **Total** | **GBP 10–15/month** | |

### API Cost Breakdown

| Job | Model | Frequency | Monthly Cost (USD) |
|---|---|---|---|
| News classification | Haiku | ~20/day | $0.60 |
| Strategy evaluation review | Sonnet | 1x/week | $1.20 |
| Strategy mutation/evolution | Sonnet | 1–2x/week | $2.40 |
| Self-improvement PRs | Sonnet | 1x/week | $1.20 |
| Graduation reviews | Haiku | As needed | $0.20 |
| Trade reviews (learning loop) | Haiku | Daily | $0.60 |
| Pattern analysis (learning loop) | Haiku | 2x/week | $0.40 |
| Graduation reasoning | Haiku | As needed | $0.20 |
| Learning loop meta-evolution | — | Included in weekly evolution Sonnet call | $0.00 |
| Daily summary generation | Haiku | Daily | $0.60 |
| **Total API** | | | **$7–9/month** |

### Break-Even Analysis

At GBP 10–15/month total cost:
- GBP 500 capital: need 2–3% monthly return to break even
- GBP 200 capital: need 5–7.5% monthly return to break even
- Research baseline: 15–40% annualized (1.2–3.3% monthly) is realistic for a working system

Most cost is fixed (VPS + weekly Sonnet). Adding more capital doesn't increase costs — only increases returns. Once the system proves edge, scaling capital makes the economics very comfortable.

---

## 11. What the AI Evolves vs What Stays Fixed

### AI Can Change (via parameter mutation or code PRs)

- Strategy parameters (thresholds, hold periods, sizing weights)
- Strategy signal logic (entry/exit rules)
- News classification prompts and output schema
- Learning loop review prompts (trade review, pattern analysis, graduation reasoning)
- Learning loop insight categories and weightings
- Universe of symbols to trade
- Strategy evaluation code
- Reporting templates

### Human Controls (proposed as GitHub issues only)

- All hard risk limits (Section 8)
- Graduation gate statistical thresholds (Section 4)
- Broker integration code
- Database schema
- Maximum leverage
- The kill switch itself

**Meta-rule:** The system can optimize HOW it trades, never HOW MUCH it can lose.

---

## 12. Cherry-Pick List from Current Codebase

### Keep (adapt for new project)

| Current File | New Purpose |
|---|---|
| `src/db/client.ts` | SQLite + Drizzle setup (new schema) |
| `src/utils/token-tracker.ts` | API cost tracking |
| `src/utils/cost.ts` | Pricing calculations (update model prices) |
| `src/utils/logger.ts` | Pino structured logging |
| `src/utils/retry.ts` | Retry with backoff |
| `src/utils/budget.ts` | Daily spend tracking |
| `src/reporting/email.ts` | Resend email integration |
| `src/broker/connection.ts` | IBKR connection management |
| `src/broker/orders.ts` | Order placement |
| `src/broker/order-monitor.ts` | Fill/cancel event handling |
| `src/broker/guardian.ts` | Position guardian (adapt for new risk limits) |
| `src/broker/stop-loss.ts` | Stop-loss enforcement |
| `src/broker/trailing-stops.ts` | Trailing stop computation |
| `src/research/sources/yahoo-finance.ts` | Quote + fundamentals |
| `src/research/sources/news-scraper.ts` | RSS polling |
| `src/research/sources/fmp.ts` | FMP screening |
| `src/research/sources/lse-screener.ts` | LSE/AIM stock discovery |
| `src/research/sources/lse-resolver.ts` | LSE symbol resolution |
| `src/broker/contracts.ts` | Multi-exchange contract handling (LSE, NASDAQ, NYSE) |
| `src/utils/fx.ts` | GBP/USD currency conversion |
| `src/self-improve/github.ts` | PR/issue creation |
| `src/self-improve/code-generator.ts` | Code change generation |

### Drop

- All ISA-specific code (stamp duty, long-only, ISA risk limits)
- Current orchestrator (3-tier escalation)
- Current agent/planner (per-tick Sonnet calls)
- Momentum gate as hardcoded filter (becomes one possible strategy)
- Current research analyzer (replaced by strategy-driven analysis)
- Learning loop (rebuilt as self-evolving system: daily trade reviews, pattern analysis, graduation reasoning — with meta-evolution of its own prompts)
- Evals framework (rebuild once new system is stable)
