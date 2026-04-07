# Resolution — Round 2

## Responses

1. **MEDIUM: Blocking Sonnet call in ingest pipeline**
   - **Action:** FIXED
   - **Reasoning:** Valid. The Sonnet call should not block the fast ingest loop. Research agent is fire-and-forget — `processArticle` spawns it without awaiting, with `.catch()` for error logging. Research results land asynchronously; the ingest pipeline stays fast.
   - **Changes:** Updated Component 1 description to specify fire-and-forget execution model.

2. **HIGH: `writeSignals` creates orphan `quotes_cache` rows with no prices for sub-0.8-confidence symbols**
   - **Action:** PUSHED_BACK
   - **Reasoning:** The critique's premise is wrong. `refreshQuotesForAllCached()` (in `src/scheduler/quote-refresh.ts`) iterates over **all rows in `quotes_cache`**, not just strategy universes. Any symbol that gets a `quotes_cache` row via `writeSignals` will have prices populated on the next 10-minute refresh cycle. There are no orphan rows — every row in the cache gets refreshed. Updated the spec to make this explicit so future readers don't make the same assumption.
   - **Changes:** Clarified signal writing paragraph to state `quote_refresh` refreshes all `quotes_cache` rows.

3. **HIGH: `priceAtAnalysis` is null for newly-discovered symbols, defeating the tracker**
   - **Action:** FIXED
   - **Reasoning:** Valid and important. For newly-discovered symbols, there's no cached price, so the most interesting case gets skipped. Fix: make a single Finnhub `/quote` call per new symbol at analysis time. This is bounded by the number of symbols per article (typically 2-5, rarely more), budget guard applies, and Finnhub quote calls are fast and cheap.
   - **Changes:** Updated "Price at analysis" to fetch from Finnhub when no cache row exists.

4. **MEDIUM: Weekly tracker stale prices after TTL expiry**
   - **Action:** PARTIALLY_ADDRESSED
   - **Reasoning:** Partially invalid — `quote_refresh` refreshes all `quotes_cache` rows regardless of injection status, so prices stay fresh for any symbol that has a cache row. However, if a symbol was never injected AND somehow lost its cache row, the weekly job could miss it. Added Finnhub fallback to both daily and weekly jobs: try cache first, fall back to Finnhub `/quote` if cached price is stale (>24h) or missing. This covers edge cases without adding new infrastructure.
   - **Changes:** Updated daily and weekly job logic to include Finnhub fallback for stale/missing prices.

5. **MEDIUM: No deduplication on `news_analyses`**
   - **Action:** FIXED
   - **Reasoning:** Valid. Retry or duplicate processing could create duplicate rows. Simple fix: unique constraint on `(newsEventId, symbol)` with `onConflictDoUpdate`.
   - **Changes:** Added unique constraint to table schema section.

6. **MEDIUM: "Yesterday" boundary ambiguity**
   - **Action:** FIXED
   - **Reasoning:** Valid. Replaced vague "from yesterday" with explicit time window: `createdAt` between 24 and 48 hours ago. This is simple, timezone-agnostic, and ensures no row is processed too early or missed. Same approach for weekly (7-8 days ago).
   - **Changes:** Updated daily and weekly job query descriptions with explicit hour-based windows.

7. **MEDIUM: No eval coverage for `universe_suggestions`**
   - **Action:** FIXED
   - **Reasoning:** Valid per CLAUDE.md requirements. The existing Component 3 evals already test pattern analysis including universe suggestions, but they needed strengthening. Added explicit shape validation for the `universe_suggestions` field, exchange validation, and negative test cases (noise clusters that should produce empty suggestions).
   - **Changes:** Enhanced Component 3 eval spec with detailed code grader checks and negative cases.

## Summary of Plan Changes

1. Research agent execution model: fire-and-forget from `processArticle` (not blocking)
2. Price at analysis: Finnhub `/quote` fallback for newly-discovered symbols (fixes null price gap)
3. Clarified `quote_refresh` refreshes ALL `quotes_cache` rows (not just strategy universes)
4. Daily/weekly tracker: Finnhub fallback for stale/missing cached prices
5. Unique constraint `(newsEventId, symbol)` on `news_analyses` with `onConflictDoUpdate`
6. Time windows: "24-48 hours ago" for daily, "7-8 days ago" for weekly (replaces vague "yesterday")
7. Component 3 evals: explicit `universe_suggestions` shape validation, exchange checks, negative cases

## Revised Spec Sections

See updated `docs/specs/2026-04-07-news-research-intelligence.md` — changes applied directly to the spec.
