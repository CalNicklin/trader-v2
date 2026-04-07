# Demotion Wiring + Sentiment Validation — Design Spec

## Overview

Two fixes addressing gaps identified by system review:

1. **Demotion wiring** — `src/risk/demotion.ts` is fully implemented and tested but never called. Wire it into `runLiveExecutor()` so graduated strategies can be struck, demoted, or killed per the master spec (Section 4).

2. **Sentiment validation** — No code validates whether news sentiment scores predict subsequent price movements. Add a CLI analysis script for immediate diagnostics, an eval suite for ongoing regression, and a forward-looking price capture mechanism.

---

## Fix 1: Demotion Wiring

### Problem

`demotion.ts` exports three pure functions (`checkTwoStrikeDemotion`, `checkKillCriteria`, `checkBehavioralDivergence`) plus types. Nothing imports them outside tests. If a strategy graduates to live and underperforms, there is no automated demotion path. The spec (Section 4) defines tier-specific triggers and a two-strike rule that are not enforced.

### Design

#### New: `checkTierBreach()` in `demotion.ts`

The existing functions handle two-strike logic and kill criteria, but nothing detects the **tier-specific breaches** that feed into the two-strike system. Per the master spec:

- **Probation:** Rolling 20-trade Sharpe < 0
- **Active / Core:** Drawdown > 1.5x worst paper drawdown, OR Sharpe < 0 for 2 consecutive weekly evaluation periods (aligned with the weekly evolution cycle)

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

export function checkTierBreach(input: TierBreachInput): TierBreachResult;
```

Pure function, no DB access. Returns whether the strategy has breached its tier's demotion trigger.

#### New: `runDemotionChecks()` in `executor.ts`

Called at the end of `runLiveExecutor()`, after all strategy evaluations complete. For each graduated strategy:

1. **Gather stats from DB:**
   - `liveTrades` WHERE `strategyId = X AND status = 'FILLED'` — compute trade count, total PnL, current loss streak, loss streak mean/stddev
   - `graduationEvents` WHERE `strategyId = X AND event IN ('demoted', 'killed')` — build `DemotionEvent[]` for two-strike
   - `strategyMetrics` — rolling Sharpe, current drawdown
   - `paperTrades` — worst paper drawdown for behavioral comparison, avg slippage/friction

2. **Run checks in order (kill first, then breach, then divergence):**
   - `checkKillCriteria(stats)` — if `shouldKill`, retire strategy immediately
   - `checkTierBreach(input)` — if breached, feed into `checkTwoStrikeDemotion(events)`
     - `action: 'kill'` → retire strategy
     - `action: 'demote'` → set `strategies.status = 'paper'`
     - `action: 'first_strike'` → reduce capital allocation by 50% (update `virtualBalance`)
   - `checkBehavioralDivergence(comparison)` — if diverged, log warning to `agentLogs` (not auto-demoting — it's a review signal per spec)

3. **Record all actions:**
   - Insert `graduationEvents` with appropriate event type (`'demoted'` or `'killed'`), from/to tier, and evidence JSON
   - Log to `agentLogs` at WARN/ACTION level
   - Update `strategies.status` and `strategies.retiredAt` where applicable

#### Executor.ts `checkBehavioralDivergence` (line 457)

Stays as-is. It's a per-fill slippage alert called by `order-monitor.ts`. The `demotion.ts` version is broader (aggregate slippage + fill rate + friction). Both serve different purposes — real-time alert vs periodic review.

### What does NOT change

- `demotion.ts` stays pure — no DB imports, no side effects
- `constants.ts` already has all the thresholds
- `graduationEvents` table already has `'demoted'` and `'killed'` event types
- Existing risk guardian (circuit breakers, daily halt, weekly drawdown) is unaffected — it handles portfolio-level risk, demotion handles strategy-level risk

---

## Fix 2: Sentiment Validation

### Problem

The news classifier produces sentiment scores, confidence, urgency, event types, and detailed signals (earnings surprise, guidance change, etc.). These are consumed by strategy signal expressions. But there is no validation that these scores predict price movements. The evals test classifier label accuracy, not signal efficacy.

### Design — Three Components

#### A) CLI Analysis Script: `scripts/analyze-sentiment.ts`

A standalone diagnostic run with `bun run scripts/analyze-sentiment.ts`. Queries existing data to extract whatever signal we can from historical paper trades that were triggered by news events.

**Logic:**
1. Query `news_events` WHERE `tradeable = 1 AND sentiment IS NOT NULL AND classifiedAt IS NOT NULL`
2. For each event, find `paperTrades` for the same symbol within 1 hour of `classifiedAt` (these are trades triggered by the news)
3. Find the corresponding exit trade to compute actual PnL
4. Bucket by:
   - Sentiment direction: positive (>0) vs negative (<0)
   - Sentiment strength: weak (0.3-0.5), medium (0.5-0.7), strong (>0.7)
   - Event type (earnings_beat, fda_approval, etc.)
   - Urgency (medium, high)
5. Output table:
   - Per bucket: count, hit rate (did trade PnL match sentiment direction?), avg PnL, avg hold time
   - Overall: Pearson correlation between sentiment score and trade PnL
   - Event type breakdown: which event types have positive expected value?
   - Confidence calibration: does higher confidence → better outcomes?

**Limitations:** Only measures events that triggered paper trades. Events classified as tradeable but not acted on (no matching signal rule) are invisible. This is why we need Part C.

#### B) Eval Suite: `src/evals/sentiment/`

Ongoing regression suite that tracks signal quality as the classifier evolves.

**`tasks.ts`** — Seeded from real data after the CLI script runs. Each task represents a classified news event paired with the actual price outcome:

```typescript
interface SentimentEvalTask {
  headline: string;
  classifiedSentiment: number;
  classifiedConfidence: number;
  eventType: string;
  expectedMoveDuration: string;
  actualPriceChangePct: number;  // measured over expectedMoveDuration window
  actualDirection: "up" | "down" | "flat";
}
```

Start with whatever data the CLI script produces (even if small), grow as forward-looking data accumulates.

**`graders.ts`** — Code-based graders:

- `directionAccuracyGrader`: Did sentiment polarity (positive/negative) match actual price direction? Score: 1 if match, 0 if not, 0.5 if flat.
- `magnitudeCalibrationGrader`: Is confidence proportional to move size? Buckets confidence into quartiles and checks if higher confidence correlates with larger absolute moves.
- `durationAccuracyGrader`: Did the move occur within the `expectedMoveDuration` window? Score: 1 if >50% of total move happened within window, 0 otherwise.
- `eventTypeGrader`: Per event-type hit rate. Identifies which event types the classifier is good/bad at predicting.

**`harness.ts`** — Standard runner matching existing eval harness pattern. Can be run via CI.

#### C) Forward-Looking Price Capture

To measure all classified events (not just ones that triggered trades), add a price capture mechanism:

**New column on `news_events`:** `priceAtClassification` (real, nullable) — the symbol's last price from `quotesCache` at the time of classification. Written by the news ingest pipeline (`src/news/ingest.ts`) immediately after classification.

**New column on `news_events`:** `priceAfter1d` (real, nullable) — the symbol's price ~24h after classification. Written by a lightweight follow-up check.

**New logic in the quote refresh job:** After refreshing quotes, scan `news_events` where `priceAtClassification IS NOT NULL AND priceAfter1d IS NULL AND classifiedAt < now - 24h`. For each, write the current price as `priceAfter1d`. This piggybacks on the existing quote refresh cycle — no new scheduler job.

This gives clean, forward-looking data: for every classified event, we know the price at classification and +1d. The eval suite and CLI script can both consume this data as it accumulates.

### Schema Changes

```sql
-- news_events additions
ALTER TABLE news_events ADD COLUMN price_at_classification REAL;
ALTER TABLE news_events ADD COLUMN price_after_1d REAL;
```

Drizzle schema update in `src/db/schema.ts`:
```typescript
priceAtClassification: real("price_at_classification"),
priceAfter1d: real("price_after_1d"),
```

---

## What This Is NOT

- Not changing the classifier itself — we're measuring it first
- Not adding new trading strategies — we're validating the existing signal
- Not replacing the existing eval suite — the classifier label evals stay; these are additive
- Not blocking paper trading — everything runs alongside the existing system

## File Summary

| Action | File |
|--------|------|
| Modify | `src/risk/demotion.ts` — add `checkTierBreach()` |
| Modify | `src/live/executor.ts` — add `runDemotionChecks()`, call from `runLiveExecutor()` |
| Modify | `src/db/schema.ts` — add `priceAtClassification`, `priceAfter1d` to `newsEvents` |
| Modify | `src/news/ingest.ts` — capture price at classification time |
| Modify | `src/scheduler/quote-refresh.ts` — backfill `priceAfter1d` on stale events |
| Create | `scripts/analyze-sentiment.ts` — CLI diagnostic |
| Create | `src/evals/sentiment/tasks.ts` — eval task definitions |
| Create | `src/evals/sentiment/graders.ts` — code-based graders |
| Create | `src/evals/sentiment/harness.ts` — eval runner |
