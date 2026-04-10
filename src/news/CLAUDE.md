# News Pipeline Subsystem

This directory implements the news→trade pipeline. Read this before touching any file in it.

**Canonical spec:** `docs/specs/2026-04-10-lse-news-fmp-migration.md`
**Prior spec (partially superseded):** `docs/specs/2026-04-10-lse-news-signal-fix.md`

## Pipeline map

```
US: Finnhub /company-news (per symbol, via finnhub.ts)
UK: FMP /news/stock (per symbol, via fmp-news.ts)
  → news-poll-job.ts                   # routes per exchange
  → pre-filter.ts                      # 8 keyword blocks
  → classifier.ts (Haiku)              # single-symbol sentiment
  → research-agent.ts (Sonnet)         # whitelist-filtered, primary symbol pinned
  → fmp.ts fmpValidateSymbol()         # FMP /profile + isActivelyTrading check
  → news_analyses row (always logged)
  → sentiment-writer.ts → quotes_cache # only if validatedTicker=1 AND inUniverse=1
```

## Invariants (do NOT break these)

1. **FMP `/news/stock` is the authoritative source for LSE/AIM symbols.**
   Do not add an RSS, scraper, or third-party fallback. Verified in
   production: RSS feeds are Cloudflare/Incapsula-blocked, LSE RNS is
   a client-rendered SPA. If FMP is down, news is down — quotes are
   also down in that case, so news being down is a non-issue.

2. **Dual-listing fallback is LSE/AIM-only.** `fetchFmpCompanyNews`
   tries `SYM.L` first and falls back to plain `SYM` if empty. This
   handles dual-listed companies (BP, VOD) where FMP keys news to
   the US ticker. Do NOT extend the fallback to other exchanges.

3. **The queried symbol is authoritative for attribution.** When
   `fetchFmpCompanyNews(symbol, exchange)` parses a payload, it
   overrides `article.symbols = [symbol]` regardless of what FMP
   returned. The research agent downstream is still responsible for
   identifying additional co-referenced symbols inside the article text.

4. **Research agent output is whitelist-filtered.** Any symbol not in
   a paper strategy universe is dropped before reaching `news_analyses`
   with a logged warning. Do not remove this filter.

5. **Dedup is headline-based.** `processArticle` calls `isHeadlineSeen`,
   which does an exact match on `newsEvents.headline`. Do NOT rely on
   `finnhubId` or `url` for dedup. FMP articles carry `finnhubId: null`
   and that is fine.

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

`fetchFmpCompanyNews` and `runNewsPoll` both accept optional `deps`
parameters for dependency injection. Tests pass stub functions
directly instead of using `mock.module()`. This is deliberate:
Bun's `mock.module()` leaks across test files and broke unrelated
tests that statically imported the mocked modules. The DI pattern
lets us stub behaviour without touching the module cache.

## Surfacing a new symbol to the news loop

Add it to a strategy's universe. Do NOT add it to a hand-maintained
whitelist or hand-edit the FMP client. The universe is the single
source of truth.

## Related tests

- `tests/news/fmp-news.test.ts` — parser + fetch (18 tests)
- `tests/scheduler/news-poll-job-lse.test.ts` — LSE branch integration
- `tests/news/research-agent.test.ts`
- `src/evals/research-agent/` — regression-gating eval suite
