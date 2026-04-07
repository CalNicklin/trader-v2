# News Research Intelligence

Upgrade the news pipeline from single-symbol classification to multi-symbol research with missed opportunity tracking and cross-symbol pattern learning.

## Problem

The current pipeline classifies headlines from the perspective of a single queried symbol. "Broadcom and Google seal five-year AI chip partnership" gets classified as +0.20 LOW for GOOGL — missing that this is a much stronger catalyst for AVGO as a major contract win. The learning loop only reviews executed trades, so the system never learns from signals it didn't act on.

## Components

### 1. News Research Agent

New module `src/news/research-agent.ts`. Called from `ingest.ts` after Haiku classification, for every article where `tradeable === true`. The Sonnet call is **fire-and-forget** — `processArticle` awaits classification and signal writing, then spawns the research agent call without awaiting it (wrapped in `.catch()` for error logging). This keeps the ingest pipeline fast; research results land asynchronously.

**Input:** headline, source, article symbols from Finnhub, original Haiku classification, `newsEventId` (returned by modified `storeNewsEvent`).

**Sonnet prompt produces:**
- All materially affected symbols (not just the queried one) with rationale. **Each symbol must include its exchange** (NASDAQ, NYSE, LSE, etc.)
- Per-symbol assessment: sentiment (-1.0 to 1.0), urgency (low/medium/high), event type, direction (long/short/avoid), one-sentence trade thesis
- Confidence score (0-1) per symbol
- For confidence >= 0.8: a direct trade recommendation with entry logic

**Storage:** New `news_analyses` table, one row per affected symbol per article:
- `id` (int, PK)
- `newsEventId` (int, FK to news_events.id)
- `symbol` (text)
- `exchange` (text)
- `sentiment` (real)
- `urgency` (text, enum: low/medium/high)
- `eventType` (text)
- `direction` (text, enum: long/short/avoid)
- `tradeThesis` (text)
- `confidence` (real)
- `recommendTrade` (boolean)
- `priceAtAnalysis` (real, nullable)
- `priceAfter1d` (real, nullable)
- `priceAfter1w` (real, nullable)
- `createdAt` (text)

**Exchange validation:** The research agent validates each symbol's exchange against a known set (`NASDAQ`, `NYSE`, `LSE`). Symbols with unrecognised exchanges are dropped with a warning log.

**Storage details:** `inUniverse` is set at insert time by checking whether the symbol exists in any active strategy's `universe` JSON array or in the current injected symbols list.

**Price at analysis:** For each symbol, attempt to read `last` from `quotes_cache`. If no row exists (newly-discovered symbol), make a single Finnhub `/quote` call to fetch the current price (budget guard applies). If the Finnhub call succeeds, use that price as `priceAtAnalysis`. If it fails or returns no data, set `priceAtAnalysis = null`. The daily tracker will skip null rows.

**Signal writing:** For each symbol in the analysis, write enriched signals to `quotes_cache` via existing `writeSignals`, which creates the row if it doesn't exist (upsert). The existing `quote_refresh` job (every 10 minutes) refreshes **all rows in `quotes_cache`** — not just strategy universes — so newly-created rows get price updates on the next cycle automatically. If `recommendTrade === true && confidence >= 0.8`, inject the symbol into all strategy universes with a 24h TTL (up from the current 4h for normal high-urgency injection).

**Cost:** Sonnet call per tradeable article. At ~3-5 tradeable articles/day this is negligible. Budget guard (`canAffordCall`) still applies.

**Evals:**
- 30-40 tasks: real multi-party headlines from production `news_events` + synthetic edge cases (supply chain events, M&A, partnerships, sector-wide catalysts)
- Code graders: JSON shape validation, all required fields present, sentiment in range [-1, 1], confidence in [0, 1], at least 2 symbols identified for multi-party headlines, direction is valid enum
- LLM-as-judge grader: "Did the analysis correctly identify secondary beneficiaries and assign appropriate per-symbol urgency?" Structured rubric, one dimension per call (beneficiary identification accuracy, urgency calibration, trade thesis quality)
- 3 trials per task (non-deterministic output)
- Track metrics: secondary symbol identification accuracy, sentiment direction correctness, false positive rate on trade recommendations, latency, token usage

### 2. Missed Opportunity Tracker

New scheduled job `missed_opportunity_review` with two schedules:
- **Daily** at 21:20 weekdays (after trade review at 21:15) — checks +1d price movement
- **Weekly** on Wednesdays at 21:35 — backfills +1w price movement for analyses from 7 days ago

**Daily job logic:**
1. Query `news_analyses` rows where `createdAt` is between 24 and 48 hours ago (i.e., analysed 24+ hours ago but not older than 48 hours) that don't yet have `priceAfter1d`, **WHERE `priceAtAnalysis` IS NOT NULL** (skip symbols that had no price data at analysis time)
2. For each row, fetch current price: try `quotes_cache` first, fall back to a Finnhub `/quote` API call if the cached price is stale (older than 24 hours) or missing
3. Compute actual price change percentage: `(currentPrice - priceAtAnalysis) / priceAtAnalysis * 100`
4. Update `priceAfter1d` on the `news_analyses` row
5. For rows where **`inUniverse = false`** (symbol was not in any strategy universe at analysis time):
   - If price moved >2% in the predicted direction (positive move for `long`, negative for `short`) → classify as a missed opportunity
   - Insert into `trade_insights` with `insightType = 'missed_opportunity'` and **`strategyId = null`**
   - Observation includes: symbol, predicted direction, actual move percentage, trade thesis from research agent
   - Tags include: `["missed_opportunity", eventType, symbol]`

**Weekly job logic:** Same as daily but checks `priceAfter1w` for analyses where `createdAt` is between 7 and 8 days ago. Also requires `priceAtAnalysis IS NOT NULL`. Uses the same price fetch strategy (cache first, Finnhub fallback for stale/missing). Only logs a missed opportunity if not already logged by the daily job AND the 1-week move exceeds 5% in the predicted direction.

**Dashboard:** Add "Missed" count to Learning Loop tab summary stats. Show missed opportunity insights in the insight log with a distinct amber badge.

**Evals:**
- Code graders only (no LLM needed): verify price change math, threshold logic, correct insight type
- 15-20 tasks with mock price data covering: true misses (>2% correct direction), near misses (<2%), wrong-direction predictions, symbols that WERE in universe (should not log)
- Verify no false misses logged

### 3. Cross-Symbol Pattern Learning

Enhancement to existing `src/learning/pattern-analysis.ts`, not a new job.

**Prompt changes:**
1. Add new context block to the pattern analysis prompt: recent missed opportunities from `trade_insights` where `insightType = 'missed_opportunity'`, last 14 days
2. Add instruction: "Identify patterns in missed opportunities. Are there symbol relationships (supplier/customer, sector peers, M&A targets) that the system should watch? Recommend specific symbols for universe inclusion if evidence supports it."

**Output changes:**
- Pattern analysis output gains optional field: `universe_suggestions` — array of `{ symbol, exchange, reason, evidenceCount }`
- Universe suggestions logged to `trade_insights` with `insightType = 'universe_suggestion'` and **`strategyId = null`** (cross-cutting, not strategy-specific)

**Acting on suggestions:**
- The existing weekly self-improvement job (Sundays 19:00) picks up `universe_suggestion` insights
- Self-improvement can propose PRs adding suggested symbols to strategy seed lists
- No automatic universe changes — flows through existing self-improvement PR pipeline for human review

**Evals:**
- 10-15 tasks with synthetic trade + missed opportunity clusters (e.g., 3 missed opportunities involving AVGO over 2 weeks)
- LLM-as-judge: "Given these missed opportunities, did the analysis identify the underlying relationship and recommend adding the symbol?" Structured rubric
- Code graders: `universe_suggestions` has valid shape (`{ symbol, exchange, reason, evidenceCount }[]`), exchange is in known set, evidence count matches actual missed opportunity count in input data, no duplicate symbols in suggestions
- Negative cases: tasks where missed opportunities are noise (uncorrelated symbols) — should produce empty `universe_suggestions`
- 3 trials per task

## Data Flow

```
Finnhub articles
  → Pre-filter (keyword gate)
  → Haiku triage (tradeable? sentiment? urgency?)
  → Store in news_events
  → IF tradeable:
      → Sonnet research agent (multi-symbol deep analysis)
      → Store per-symbol rows in news_analyses
      → Write enriched signals to quotes_cache per symbol
      → IF confidence >= 0.8: inject symbol (24h TTL) + flag recommendTrade
  → Strategies consume signals from quotes_cache as before

Daily 21:20:
  → Missed opportunity review
  → Fetch prices for yesterday's news_analyses
  → Log missed opportunities to trade_insights

Wednesday 21:35:
  → Weekly missed opportunity review (1-week price check)

Tue/Fri 21:30 (existing):
  → Pattern analysis (now includes missed opportunities)
  → Produces universe_suggestions

Sunday 19:00 (existing):
  → Self-improvement picks up universe_suggestions
  → Proposes PRs for seed list changes
```

## New DB Tables

### news_analyses

| Column | Type | Notes |
|--------|------|-------|
| id | integer PK | auto-increment |
| newsEventId | integer | FK to news_events.id |
| symbol | text | affected symbol |
| exchange | text | e.g., LSE, NASDAQ |
| sentiment | real | -1.0 to 1.0 |
| urgency | text | low/medium/high |
| eventType | text | from research agent |
| direction | text | long/short/avoid |
| tradeThesis | text | one-sentence thesis |
| confidence | real | 0 to 1 |
| recommendTrade | integer (boolean) | true if confidence >= 0.8 |
| inUniverse | integer (boolean) | true if symbol was in any strategy universe at analysis time |
| priceAtAnalysis | real, nullable | price when analysed (from quotes_cache or Finnhub; null if unavailable) |
| priceAfter1d | real, nullable | filled by daily tracker (per-symbol; distinct from news_events.priceAfter1d which tracks primary symbol only) |
| priceAfter1w | real, nullable | filled by weekly tracker |
| createdAt | text | ISO timestamp |

**Unique constraint** on `(newsEventId, symbol)` — prevents duplicate rows on retry/reprocessing. Use `onConflictDoUpdate` to update existing rows if the research agent re-analyses the same article.

Index on `newsEventId`. Index on `symbol`. Index on `inUniverse` (for missed opportunity queries).

## Modified Tables

### trade_insights

- `strategyId` column: change from `NOT NULL` to **nullable** (new migration). Missed opportunities and universe suggestions have no associated strategy.
- New `insightType` enum values: `missed_opportunity`, `universe_suggestion` (added to existing enum: trade_review, pattern_analysis, graduation).
- `learningLoopConfig` is NOT modified — missed opportunities are code-driven (no LLM prompt), and universe suggestions come from the existing `pattern_analysis` prompt.

## New Files

- `src/news/research-agent.ts` — Sonnet research agent
- `src/scheduler/missed-opportunity-job.ts` — daily + weekly tracker job
- `src/evals/research-agent/tasks.ts` — eval tasks
- `src/evals/research-agent/graders.ts` — code + LLM-as-judge graders
- `src/evals/missed-opportunity/tasks.ts` — tracker eval tasks
- `src/evals/missed-opportunity/graders.ts` — tracker code graders
- `src/evals/pattern-analysis/tasks.ts` — enhanced pattern analysis tasks (extend existing)
- `src/evals/pattern-analysis/graders.ts` — pattern analysis graders (extend existing)

## Modified Files

- `src/news/ingest.ts` — call research agent after classification for tradeable articles; capture `newsEventId` from `storeNewsEvent` return value
- `src/news/sentiment-writer.ts` — modify `storeNewsEvent` to return the inserted row's `id` (use `.returning()`)
- `src/learning/pattern-analysis.ts` — add missed opportunity context to prompt, parse universe_suggestions from output, insert universe suggestions with `strategyId = null`
- `src/learning/types.ts` — add `universeSuggestions` optional field to pattern analysis output type
- `src/scheduler/cron.ts` — register missed_opportunity_review jobs
- `src/scheduler/jobs.ts` — add `missed_opportunity_review` to `JobName` union and `executeJob` switch
- `src/db/schema.ts` — add news_analyses table, extend insightType enum, make `strategyId` nullable on `tradeInsights`
- `src/db/migrations/` — new migration: (1) create `news_analyses` table, (2) alter `trade_insights` to make `strategy_id` nullable
- `src/monitoring/dashboard-data.ts` — add missed opportunity count to learning loop stats
- `src/monitoring/status-page.ts` — add amber badge for missed_opportunity type
