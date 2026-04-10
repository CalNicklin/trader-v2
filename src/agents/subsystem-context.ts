// src/agents/subsystem-context.ts
//
// Subsystem context blocks injected into runtime LLM prompts (evolution,
// dispatch, etc.) so agents understand invariants that are not obvious from
// the current code snapshot. See docs/specs/2026-04-10-lse-news-fmp-migration.md
// for rationale.

export const NEWS_PIPELINE_CONTEXT = `
## News pipeline (current architecture)

- US symbols fetched via Finnhub /company-news (per-symbol).
- LSE/AIM symbols fetched via FMP /news/stock (per-symbol, through
  src/news/fmp-news.ts). FMP is the sole source for UK news — RSS
  and the LSE RNS scraper were removed because they were blocked in
  production.
- Dual-listed UK companies (BP, VOD) may have their FMP news indexed
  under the US ticker instead of .L. fetchFmpCompanyNews tries .L
  first and falls back to the plain symbol if empty.
- The queried symbol is authoritative for attribution: article.symbols
  is overridden to the symbol that was polled, regardless of what FMP
  returned in the payload.
- The research agent (Sonnet) filters its output against the paper-strategy
  whitelist. Symbols outside the whitelist are dropped before reaching
  news_analyses.
- To surface a new symbol to the news loop, add it to a strategy's universe.
  Do NOT hand-patch the research agent prompt or the FMP client to add symbols.
`.trim();
