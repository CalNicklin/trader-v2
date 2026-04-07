# Critique — Round 2

## Verdict: ISSUES

## Structural Issues

1. **Sonnet call for every tradeable article creates a blocking bottleneck in the ingest pipeline**
   - **Where:** Component 1 — Research Agent called from `ingest.ts`
   - **Problem:** The spec doesn't address whether the Sonnet call is blocking, fire-and-forget, or queued. If blocking, a burst of tradeable news could cause the ingest job to overrun.
   - **Severity:** MEDIUM
   - **Why it matters:** Implementer has to make an architectural call the spec doesn't make.

2. **`writeSignals` upsert creates `quotes_cache` rows for symbols the system has never quoted, with no mechanism to clean them up or populate prices**
   - **Where:** Component 1 — Signal writing
   - **Problem:** `quote_refresh` iterates over strategy universes. A symbol with confidence < 0.8 (not injected) gets a `quotes_cache` row with signals but `quote_refresh` never fills in prices. These orphan rows accumulate. The missed opportunity tracker skips them (priceAtAnalysis IS NULL).
   - **Severity:** HIGH
   - **Why it matters:** The core value proposition — tracking secondary beneficiaries outside the universe — is defeated for sub-0.8-confidence symbols.

3. **`priceAtAnalysis` is null for newly-discovered symbols, defeating the tracker**
   - **Where:** Component 1 — Price at analysis, Component 2 — Daily job
   - **Problem:** For newly-discovered symbols (the core value of this feature), there's no `quotes_cache` row at analysis time, so `priceAtAnalysis = null`, and the tracker skips them entirely. No backfill step exists.
   - **Severity:** HIGH
   - **Why it matters:** The missed opportunity tracker can't track the most interesting case — symbols it discovers for the first time.

4. **Weekly tracker has no price source for out-of-universe symbols after injection TTL expires**
   - **Where:** Component 2 — Weekly job
   - **Problem:** After 24h TTL expires, `quote_refresh` stops quoting the symbol. The weekly job 7 days later finds stale prices.
   - **Severity:** MEDIUM
   - **Why it matters:** Weekly tracker gets stale or missing prices.

5. **No deduplication on `news_analyses` rows**
   - **Where:** Component 1 — Storage
   - **Problem:** No unique constraint on `(newsEventId, symbol)`. Retry/duplicate processing creates duplicate rows.
   - **Severity:** MEDIUM
   - **Why it matters:** Duplicate insights, wasted Sonnet budget.

6. **"Yesterday" boundary ambiguity in daily tracker**
   - **Where:** Component 2 — Daily job timing
   - **Problem:** Spec doesn't define whether "from yesterday" means calendar day, last 24 hours, or trading day.
   - **Severity:** MEDIUM
   - **Why it matters:** Inconsistent date boundaries produce unreliable measurements.

7. **No eval coverage for `universe_suggestions` output field**
   - **Where:** Component 3 — Evals
   - **Problem:** CLAUDE.md says "Every AI-facing feature MUST include evaluations." Universe suggestions are AI-facing with no evals defined.
   - **Severity:** MEDIUM
   - **Why it matters:** Blocking per project conventions.

## Minor Issues

- Known exchange set not defined as a constant
- TTL override behavior unspecified when symbol already injected
- `news_analyses.priceAfter1d` vs `news_events.price_after_1d` naming inconsistency for downstream consumers

## What's Good

The `inUniverse` flag is clean. Making `strategyId` nullable is correct. Research agent eval design is thorough. Existing infrastructure reuse is good — the coverage gap for out-of-universe symbols just needs addressing.
