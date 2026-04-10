# News Signal Aggregation

**Status:** Draft
**Date:** 2026-04-10
**Related:** `docs/specs/2026-04-10-lse-news-fmp-migration.md` (shipped the LSE ingestion path that made this bug visible)

## Problem

Within a 30-second window the VPS logged seven distinct AstraZeneca headlines hitting the research agent back-to-back (COPD drug FTSE-top, Jefferies target raise, Shore downgrade, diabetes halt, Citi buy, earnings lift, China headwinds). Each call invokes `writeSignals` on `quotes_cache`, which upserts via `onConflictDoUpdate`. The row a strategy reads at eval time is whichever Sonnet response arrived last — not an aggregate, not the highest-confidence, not the most recent by publish time. Just a race.

The same race exists in the classifier path: `src/news/ingest.ts` calls `writeSignals` per classified article, and multiple classifications for the same symbol within a polling cycle overwrite each other.

This is a correctness bug, not a performance bug. The signals are wrong, silently, in a way that depends on HTTP scheduling.

## Goal

Replace the last-write-wins `quotes_cache.news_*` columns with a read-time aggregator that computes a per-symbol, confidence-weighted, exponentially-decayed signal from `news_analyses` and `news_events` at strategy eval time.

**Out of scope:** FMP noise articles mis-tagged to AZN, research-agent prompt changes, classifier changes, strategy logic changes.

## Aggregation rule

For a symbol `S`, exchange `E`, at query time `now`:

### Inputs

- **Research signal source** — `news_analyses` rows where `symbol = S AND exchange = E AND createdAt >= now - 24h`. Provides `sentiment`, `confidence`, `createdAt`.
- **Sub-signal source** — `news_events` rows where the `symbols` JSON array contains `S` and `classifiedAt >= now - 24h`. Provides `sentiment`, `confidence`, `classifiedAt`, and the sub-signals (`earningsSurprise`, `guidanceChange`, `managementTone`, `regulatoryRisk`, `acquisitionLikelihood`, `catalystType`, `expectedMoveDuration`). Exchange is not stored on `news_events`; matching is symbol-only, which is acceptable because the classifier's per-symbol semantics are set upstream at the poll layer. The `symbols` column is `JSON.stringify`'d at write time, so the match is implemented as `symbols LIKE '%"S"%'` (quoted to avoid prefix collisions, e.g. `AZN` matching `AZNL`). Rows where `sentiment` is null (classification failed) are excluded entirely.

### Weighting

```
ageHours = (now - rowCreatedAt) / 1h
w = confidence × exp(-ageHours / 2)
```

2-hour half-life, no cutoff beyond the 24h query window.

### Formulas

**Aggregated sentiment** (from `news_analyses`):

```
sentiment = Σ(row.sentiment × w) / Σ(w)
```

Returns `null` if `Σ(w) == 0`.

**Aggregated sub-signals** (from `news_events`, each field independent):

```
field = Σ(row.field × w) / Σ(w_where_field_not_null)
```

Rows with a null value for a given field are excluded from that field's denominator. Returns `null` if `Σ(w) == 0` for that field.

**Categorical fields** (`catalystType`, `expectedMoveDuration`): take the value from the single highest-weight row in `news_events`. Null when no rows.

### Design notes

- **Research agent is authoritative for sentiment** because it explicitly reasons per-symbol (the classifier's sentiment is scoped to the primary symbol only). Sub-signals come from `news_events` because they're produced by the classifier and aren't carried on `news_analyses`.
- **No cross-source dedup.** `news_analyses` and `news_events` measure different things and feed different output fields.
- **Within-source dedup.** Not needed. `news_analyses` has a `(newsEventId, symbol)` unique constraint. `news_events` is deduped on headline at insert time.
- **Neutralised primary-symbol re-insertion** (from `research-agent.ts` `filterAndPin`): when the LLM drops the primary symbol, a `sentiment=0, confidence=0.5, direction=avoid` row is inserted. This contributes to the weighted mean and correctly dampens the signal. Intended.

## API surface

### New file: `src/news/signal-aggregator.ts`

```ts
export interface AggregatedNewsSignal {
    sentiment: number | null;
    earningsSurprise: number | null;
    guidanceChange: number | null;
    managementTone: number | null;
    regulatoryRisk: number | null;
    acquisitionLikelihood: number | null;
    catalystType: string | null;
    expectedMoveDuration: string | null;
}

export async function getAggregatedNewsSignal(
    symbol: string,
    exchange: string,
    now?: Date,
): Promise<AggregatedNewsSignal>;
```

- `now` is defaulted to `new Date()` but injectable for deterministic tests.
- Returns all-null object when no rows in window — simplifies call sites vs. returning `null`.
- Uses `getDb()` internally (matches project convention for DB access).

### Changes to `src/strategy/context.ts`

Currently reads `news_sentiment`, `news_earnings_surprise`, etc. from `quotes_cache`. Switch to calling `getAggregatedNewsSignal(symbol, exchange)` for each symbol in the context loop. The per-symbol query is small (max 24h × a few headlines per symbol) and indexed.

### DB indices

- `news_analyses`: add `(symbol, exchange, createdAt)` composite index
- `news_events`: add index on `classifiedAt` (symbol match is via JSON LIKE, no viable compound index)

Drizzle migration file required.

### Removals

After `context.ts` is switched and tests pass:

- Delete `writeSignals` and `writeSentiment` from `src/news/sentiment-writer.ts`.
- Delete the `writeSignals`/`writeSentiment` call sites in `src/news/ingest.ts` (~lines 98-113) and `src/news/research-agent.ts` (~line 253).
- `quotes_cache.news_*` columns become dead. **Leave them in this PR.** Follow-up PR drops the columns and removes `strategy-eval-job.ts:44-50` and `live/executor.ts:442-449` references. Keeping the column drop separate makes this migration reversible.

### Ordering within this PR

1. Commit 1: add `signal-aggregator.ts` + index migration + unit tests
2. Commit 2: switch `context.ts` to use the aggregator (writers still fill old columns as a safety net)
3. Commit 3: remove `writeSignals` / `writeSentiment` call sites and the functions themselves

If a reviewer spots a problem between commits 2 and 3, the writers in the old path are still running — nothing is broken until commit 3 lands.

## Testing

### Unit tests (`tests/news/signal-aggregator.test.ts`)

In-memory SQLite, insert rows directly, assert on `getAggregatedNewsSignal` output.

1. **Empty** — no rows → all-null result
2. **Single row** — one `news_analyses` row with sentiment 0.5, confidence 0.8 → returned sentiment = 0.5
3. **Decay** — two rows, sentiment +1 (age 0) and sentiment -1 (age 4h, weight = 0.25 of fresh) → result ≈ +0.6
4. **Confidence weighting** — sentiment +1 @ conf 0.9 vs sentiment -1 @ conf 0.3 (same age) → result = 0.6/1.2 = +0.5
5. **Neutralised pin row** — one real +0.8 conf 0.9 row plus a `filterAndPin` row (0, 0.5, avoid) → sentiment dampened but stays positive
6. **24h cutoff** — row at 25h ago is excluded
7. **Mixed sources** — `news_analyses` drives sentiment, `news_events` drives sub-signals, fields don't leak across tables
8. **Categorical tie-break** — two rows with different `catalystType`, higher-weight row wins
9. **Exchange filter** — `AZN:LSE` row does not appear in `AZN:NASDAQ` query (applies to `news_analyses`; `news_events` is symbol-only)
10. **Null sub-signal handling** — `news_events` row with null `earningsSurprise` is excluded from that field's denominator, not treated as 0

### Integration

- `tests/strategy/context.test.ts` — if it exists, assert `context.ts` reads the aggregated signal. If not, add one test: insert two conflicting `news_analyses` rows for the same symbol and confirm the context returns the weighted mean, not last-write.
- `tests/news/research-agent.test.ts` — remove assertions that `writeSignals` was called. Keep `news_analyses` insert assertions.
- `tests/news/ingest.test.ts` — remove `writeSignals` / `writeSentiment` call assertions.

### Manual verification post-deploy

- Watch the next AZN or SHEL headline burst on the VPS. Strategy eval logs should show a stable weighted sentiment that doesn't flip across successive eval cycles while new analyses land mid-cycle.
- Spot-check with a one-off script: query `news_analyses` for a symbol, hand-compute the weighted mean, compare against `getAggregatedNewsSignal` output.

### Eval suite

Research-agent eval suite does not touch `quotes_cache`. Unaffected by this change.

## Risks

- **Per-eval query cost.** Each strategy eval cycle now runs one aggregator query per symbol in its universe. At ~20 symbols per strategy × ~5 strategies × every 10 min, that's ~100 queries per cycle. Each is indexed and bounded to 24h of rows (low tens). Negligible.
- **Reader/writer skew during commit 2.** Briefly, `context.ts` reads from the aggregator while writers still fill `quotes_cache`. The two paths produce different numbers. Strategy evals will reflect the aggregator (the new, correct value). Nothing else consumes `quotes_cache.news_*` except logging. Acceptable.
- **Follow-up column drop forgotten.** Dead columns linger. Low-severity — they're `REAL` and `TEXT`, cheap. Worst case they're discovered later and cleaned up then.

## Success criteria

- Back-to-back headlines for the same symbol produce a stable, explainable sentiment at strategy eval time — no race.
- Unit test suite covers all ten cases above and passes.
- VPS logs show strategy evals reading consistent values across a news burst.
- `writeSignals` / `writeSentiment` are fully removed from the codebase at the end of this PR.
