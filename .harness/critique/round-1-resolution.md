# Resolution — Round 1

## Responses

1. **`tradeInsights.strategyId` is NOT NULL, but missed opportunities have no strategy**
   - **Action:** FIXED
   - **Reasoning:** Valid. Schema migration to make `strategyId` nullable. Missed opportunities and universe suggestions insert with `strategyId = null`.
   - **Changes:** Added migration to Modified Files, updated spec.

2. **`insightType` enum needs updating all consumers**
   - **Action:** PARTIALLY_ADDRESSED
   - **Reasoning:** Enum extension is already specified. Added explicit note that `learningLoopConfig` does NOT need entries for new types.
   - **Changes:** Clarification added.

3. **`processArticle` returns before `newsEventId` is available**
   - **Action:** FIXED
   - **Reasoning:** Valid. `storeNewsEvent` must return the inserted ID. Added `sentiment-writer.ts` to Modified Files.
   - **Changes:** Updated Modified Files and Component 1 input spec.

4. **Research agent writes signals for symbols without price data**
   - **Action:** PARTIALLY_ADDRESSED
   - **Reasoning:** `writeSignals` upserts create the row. Existing `quote_refresh` job (10min cycle) populates prices. Documented explicitly.
   - **Changes:** Added price bootstrapping note to Component 1.

5. **Exchange resolution unspecified**
   - **Action:** FIXED
   - **Reasoning:** Sonnet prompt outputs exchange per symbol. Validated against known set. Invalid exchanges dropped.
   - **Changes:** Updated Component 1 prompt spec.

6. **Null `priceAtAnalysis` causes division by zero**
   - **Action:** FIXED
   - **Reasoning:** Skip rows where `priceAtAnalysis IS NULL`.
   - **Changes:** Added WHERE clause to daily/weekly job logic.

7. **Universe membership not trackable retroactively**
   - **Action:** FIXED
   - **Reasoning:** Added `inUniverse` boolean column to `news_analyses`, set at insert time.
   - **Changes:** Updated table schema and daily job logic.

8. **Global job lock collision**
   - **Action:** PUSHED_BACK
   - **Reasoning:** Trade review is fast (Haiku calls). 5-min gap is ample. Job lock gracefully skips with warning.
   - **Changes:** None.

9. **Duplicate `priceAfter1d` columns**
   - **Action:** PUSHED_BACK
   - **Reasoning:** Different granularity. `news_events.priceAfter1d` tracks primary symbol. `news_analyses.priceAfter1d` tracks per-symbol (multiple per article). Not redundant.
   - **Changes:** Added clarifying note.

10. **Universe suggestions are strategy-agnostic**
    - **Action:** FIXED
    - **Reasoning:** Covered by issue 1 fix (nullable `strategyId`). Universe suggestions insert with `strategyId = null`.
    - **Changes:** Updated Component 3 spec.

## Summary of Plan Changes

1. Migration: `tradeInsights.strategyId` becomes nullable
2. `sentiment-writer.ts` added to Modified Files, returns inserted row ID
3. Sonnet prompt requires exchange per symbol with validation
4. Price bootstrapping documented (relies on existing `quote_refresh`)
5. Null price guard: daily job skips rows where `priceAtAnalysis IS NULL`
6. `inUniverse` column added to `news_analyses`, set at insert time
7. `priceAfter1d` clarification note added
8. Universe suggestions inserted with `strategyId = null`
9. `learningLoopConfig` explicitly NOT modified
