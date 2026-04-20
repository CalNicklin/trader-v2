# News Pipeline Subsystem

This directory implements the news→trade pipeline. Read this before touching any file in it.

**Canonical spec:** `docs/specs/2026-04-10-lse-news-fmp-migration.md` (historical context)

## Pipeline map

```
US: Finnhub /company-news (per symbol, via finnhub.ts)
UK: Yahoo RSS (per symbol, via yahoo-rss-uk.ts)
  → news-poll-job.ts                   # routes per exchange
  → pre-filter.ts                      # 8 keyword blocks
  → classifier.ts (Haiku)              # single-symbol sentiment
  → research-agent.ts (Sonnet)         # whitelist-filtered, primary symbol pinned
  → news_analyses row (always logged)
  → sentiment-writer.ts → quotes_cache # only if validatedTicker=1 AND inUniverse=1
```

## Invariants (do NOT break these)

1. **Yahoo RSS is the authoritative source for LSE/AIM symbols.**
   `src/news/yahoo-rss-uk.ts` polls the Yahoo Finance RSS feed per symbol.
   This replaced the former FMP `/news/stock` path (removed April 2026).

2. **Dual-listing fallback is LSE/AIM-only.** `fetchYahooRssUk`
   accepts a symbol and polls its Yahoo RSS URL. Dual-listed companies
   (BP, VOD) may appear under the US ticker on Yahoo — callers can poll
   both forms and deduplicate by URL. Do NOT extend the fallback to
   other exchanges.

3. **The queried symbol is authoritative for attribution.** When
   `fetchYahooRssUk(symbol, exchange)` parses a payload, it
   overrides `article.symbols = [symbol]` regardless of what Yahoo
   returned. The research agent downstream is still responsible for
   identifying additional co-referenced symbols inside the article text.

4. **Research agent output is whitelist-filtered.** Any symbol not in
   a paper strategy universe is dropped before reaching `news_analyses`
   with a logged warning. Do not remove this filter.

5. **Dedup is headline-based.** `processArticle` calls `isHeadlineSeen`,
   which does an exact match on `newsEvents.headline`. Do NOT rely on
   `finnhubId` or `url` for dedup.

6. **The universe is the single source of truth for what gets polled.**
   `news-poll-job.ts` reads strategy universes via `getWatchlistSymbols`.
   Symbols are only polled if at least one paper strategy includes them.
   Out-of-universe symbol *discovery* happens at the research agent
   stage, via co-referenced symbols inside article text — not via the
   fetch layer.

7. **Classifier changes are out of scope.** The classifier is called
   per symbol and is not the source of attribution bugs. If
   classification quality is the problem, propose a spec — do not
   silently retune the classifier prompt.

## Testing these modules

`fetchYahooRssUk` and `runNewsPoll` both accept optional `deps`
parameters for dependency injection. Tests pass stub functions
directly instead of using `mock.module()`. This is deliberate:
Bun's `mock.module()` leaks across test files and broke unrelated
tests that statically imported the mocked modules. The DI pattern
lets us stub behaviour without touching the module cache.

## Surfacing a new symbol to the news loop

Add it to a strategy's universe. Do NOT add it to a hand-maintained
whitelist or hand-edit the Yahoo RSS client. The universe is the single
source of truth.

## Related tests

- `tests/news/yahoo-rss-uk.test.ts` — parser + fetch
- `tests/scheduler/news-poll-job-lse.test.ts` — LSE branch integration
- `tests/news/research-agent.test.ts`
- `src/evals/research-agent/` — regression-gating eval suite
