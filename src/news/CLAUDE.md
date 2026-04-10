# News Pipeline Subsystem

This directory implements the news→trade pipeline. Read this before touching any file in it.

**Canonical spec:** `docs/specs/2026-04-10-lse-news-signal-fix.md`
**Related problem statement:** `docs/plans/2026-04-10-lse-news-signal-gap.md`

## Pipeline map

```
UK RSS (10 feeds) + RNS scraper
  → rss-feeds.ts matchArticles()       # FTSE-100 aliases, financial-context filter, collision blacklist
  → news-poll-job.ts                    # routes US → Finnhub, non-US → RSS path
  → pre-filter.ts                       # 8 keyword blocks
  → classifier.ts (Haiku)               # single-symbol sentiment
  → research-agent.ts (Sonnet)          # whitelist-filtered, primary symbol pinned
  → fmp.ts fmpValidateSymbol()          # FMP /profile + isActivelyTrading check
  → news_analyses row (always logged)
  → sentiment-writer.ts → quotes_cache  # only if validatedTicker=1 AND inUniverse=1
```

## Invariants (do NOT break these)

1. **RSS matcher is authoritative for UK symbols.** The primary symbol from
   `matchArticles()` is pinned through the research agent. If the research
   agent drops it from its output, it is re-inserted with a neutralised signal
   (`direction="avoid"`, `confidence=0.5`) — the attribution is preserved.
2. **Research agent output is whitelist-filtered.** Any symbol not in a paper
   strategy universe is dropped before reaching `news_analyses` with a logged
   warning. Do not remove this filter.
3. **Alias management is dynamic.** FTSE-100 aliases are derived from FMP +
   `alias-overrides.ts`. Do not hand-edit `rss-feeds.ts` to add aliases —
   add them to `alias-overrides.ts` (reviewable in PRs).
4. **Collision blacklist tuning needs evals.** Before adding or removing a
   phrase from `COLLISION_BLACKLIST`, add or update an eval task in
   `src/evals/research-agent/` that demonstrates the fix.
5. **Classifier changes are out of scope.** The classifier is called per
   symbol and is not the source of attribution bugs. If classification
   quality is the problem, propose a spec — do not silently retune the
   classifier prompt.

## Surfacing a new symbol to the news loop

Add it to a strategy's universe. Do NOT add it directly to the research
agent prompt or the RSS alias map as a workaround. The universe is the
single source of truth for what gets traded.

## Related tests

- `tests/news/rss-feeds.test.ts`
- `tests/news/research-agent.test.ts`
- `tests/news/rns-scraper.test.ts`
- `src/evals/research-agent/` — regression-gating eval suite
