# Critique — Round 1

## Verdict: ISSUES

## Structural Issues

1. **`tradeInsights.strategyId` is NOT NULL, but missed opportunities have no strategy**
   - **Where:** Component 2 (Missed Opportunity Tracker), `trade_insights` table schema
   - **Problem:** The existing `tradeInsights` table has `strategyId: integer("strategy_id").notNull()`. Missed opportunities and universe suggestions are not associated with any strategy -- they are news-driven, cross-cutting insights. The spec says to insert into `trade_insights` with `insightType = 'missed_opportunity'`, but every insert requires a non-null `strategyId`. There is no strategy to reference for a missed symbol that was never in any universe.
   - **Severity:** HIGH
   - **Why it matters:** The implementer will hit a NOT NULL constraint violation at runtime when trying to insert missed opportunity rows. They will either need a schema migration to make `strategyId` nullable, or they will invent a sentinel value (like 0 or -1), which will corrupt downstream queries that join on `strategies.id`.

2. **`insightType` enum is hardcoded in Drizzle schema -- adding values requires updating all consumers**
   - **Where:** Component 2 & 3, `trade_insights` schema definition
   - **Problem:** The `insightType` column is defined with `text("insight_type", { enum: [...] })`. Adding `"missed_opportunity"` and `"universe_suggestion"` requires changing the schema definition, which the spec acknowledges under "Modified Tables", but it fails to note that existing code that pattern-matches on `insightType` (dashboard data queries, the learning loop) will need updating too. More critically, the `learningLoopConfig` table has its own `configType` enum with similar values. The spec does not mention whether missed_opportunity or universe_suggestion need config entries in `learningLoopConfig`.
   - **Severity:** MEDIUM
   - **Why it matters:** The implementer will update `tradeInsights.insightType` but miss `learningLoopConfig.configType` and any switch/if statements that exhaustively check the old enum values.

3. **`processArticle` returns before the `newsEventId` is available -- research agent needs it**
   - **Where:** Component 1 (Research Agent), `src/news/ingest.ts`
   - **Problem:** The spec says the research agent is "called from `ingest.ts` after Haiku classification, for every article where `tradeable === true`". The `news_analyses` table has `newsEventId` as a FK to `news_events.id`. But `storeNewsEvent()` in `sentiment-writer.ts` does an insert without returning the inserted row's ID. The implementer will need to modify `storeNewsEvent` to return the inserted ID, but the spec does not mention this change to `sentiment-writer.ts` in the "Modified Files" list.
   - **Severity:** HIGH
   - **Why it matters:** Without the `newsEventId`, the research agent cannot populate the FK in `news_analyses`. The implementer will get stuck trying to link the two tables.

4. **Research agent writes signals for symbols that may not have `quotes_cache` rows or price data**
   - **Where:** Component 1 (Research Agent), signal writing
   - **Problem:** The research agent discovers new symbols (e.g., AVGO from a GOOGL article). These symbols likely have no `quotes_cache` row (no price data, no volume data). The spec says to "write enriched signals to `quotes_cache`" and to "inject the symbol into all strategy universes with a 24h TTL". But strategies consuming these symbols from `quotes_cache` will find rows with sentiment signals but no `last` price, no `bid`/`ask`, no `volume`. There is no spec for how/when price data gets fetched for these newly-discovered symbols.
   - **Severity:** HIGH
   - **Why it matters:** Injecting a symbol without price data means the strategy evaluation will either error out or produce nonsensical results. The `quote_refresh` job only refreshes symbols already in `quotes_cache`, so the new symbol needs to be bootstrapped with at least one quote fetch.

5. **Research agent exchange resolution is unspecified**
   - **Where:** Component 1 (Research Agent), `news_analyses.exchange` column
   - **Problem:** When the research agent discovers a new symbol like AVGO from a GOOGL headline, there is no mechanism specified for determining which exchange AVGO trades on. The spec does not address exchange resolution for discovered symbols.
   - **Severity:** MEDIUM
   - **Why it matters:** The implementer will need to either hardcode an exchange assumption (which breaks for LSE symbols in pence), ask the LLM to output exchange (unreliable), or build an exchange lookup -- none of which is specified.

6. **Missed opportunity daily job queries "yesterday's" analyses but `priceAtAnalysis` may be null**
   - **Where:** Component 2 (Missed Opportunity Tracker), daily job logic
   - **Problem:** The `news_analyses` table has `priceAtAnalysis` as nullable. The price change formula is `(currentPrice - priceAtAnalysis) / priceAtAnalysis * 100`. If `priceAtAnalysis` is null, this calculation will produce NaN or throw a division-by-zero error.
   - **Severity:** MEDIUM
   - **Why it matters:** The daily tracker will crash or produce incorrect insight records for any symbol where price wasn't available at analysis time.

7. **"Was NOT in any strategy universe at the time of analysis" is not trackable**
   - **Where:** Component 2 (Missed Opportunity Tracker), step 5
   - **Problem:** The spec says to check whether symbols "were NOT in any strategy universe at the time of analysis". Strategy universes include in-memory `injectedSymbols` with TTL expiry. By the time the daily job runs 24+ hours later, the in-memory injection state is gone. There is no persistent record of which symbols were in which universe at a given timestamp.
   - **Severity:** MEDIUM
   - **Why it matters:** The implementer will approximate "not in universe" by checking current universe state, which is incorrect -- a symbol might have been injected at analysis time but expired by review time. This creates false positives.

8. **Global job lock -- missed opportunity job at 21:20 may collide with trade review at 21:15**
   - **Where:** Component 2 (Missed Opportunity Tracker), scheduling
   - **Problem:** The `runJob` function has a global `jobRunning` boolean lock -- only one job can run at a time. Trade review runs at 21:15, and the spec schedules missed_opportunity_review at 21:20. If the trade review takes more than 5 minutes (it calls Sonnet per trade), the missed opportunity job will be silently skipped.
   - **Severity:** MEDIUM
   - **Why it matters:** The missed opportunity tracker will be silently skipped whenever the preceding job overruns.

9. **`news_analyses` stores `priceAfter1d`/`priceAfter1w` but `news_events` already has `priceAfter1d`**
   - **Where:** Component 2, existing `news_events` table vs new `news_analyses` table
   - **Problem:** The existing `news_events` table already has `priceAfter1d` and `price_at_classification` columns (added in a recent migration). The spec does not clarify the relationship: does the tracker update both tables? Is `news_events.priceAfter1d` now redundant? Are there existing jobs that populate it?
   - **Severity:** MEDIUM
   - **Why it matters:** The implementer may create two parallel price-tracking systems that diverge, or break an existing job.

10. **Pattern analysis `universe_suggestions` requires strategy context but missed opportunities are strategy-agnostic**
    - **Where:** Component 3 (Cross-Symbol Pattern Learning)
    - **Problem:** The existing `parsePatternAnalysisResponse` expects per-strategy observations. The spec adds `universe_suggestions` as an optional field but doesn't define where it lives in the response structure or how it relates to per-strategy observations. It also does not specify what `strategyId` to use when inserting `universe_suggestion` rows into `trade_insights` (which, per issue 1, requires a non-null `strategyId`).
    - **Severity:** MEDIUM
    - **Why it matters:** The implementer will struggle to fit strategy-agnostic suggestions into a strategy-centric data model.

## Minor Issues

- **No rate limiting on Sonnet calls per news batch:** If a news poll returns 10 tradeable articles at once, the research agent will fire 10 sequential Sonnet calls. Budget guard handles cost, but no mention of API rate limits.
- **`recommendTrade` threshold duplicated:** "confidence >= 0.8" appears in both the prompt description and signal writing section. Should be a single constant.
- **Weekly job on Wednesdays only:** Analyses from Thursday-Tuesday get checked at 5-12 days, not exactly 7. The "7 days ago" phrasing is misleading.
- **Dashboard "amber badge" underspecified:** What does it look like, where does it appear, what triggers it?

## What's Good

The data flow diagram is clear and the three-component decomposition follows existing codebase patterns well. The eval design is thorough with appropriate trial counts. The decision to flow universe suggestions through the existing self-improvement PR pipeline shows good judgment about human oversight.
