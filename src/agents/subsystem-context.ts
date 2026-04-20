// src/agents/subsystem-context.ts
//
// Subsystem context blocks injected into runtime LLM prompts (evolution,
// dispatch, etc.) so agents understand invariants that are not obvious from
// the current code snapshot.

export const NEWS_PIPELINE_CONTEXT = `
## News pipeline (current architecture)

- US symbols fetched via Finnhub /company-news (per-symbol).
- LSE/AIM symbols fetched via Yahoo RSS UK (src/news/yahoo-rss-uk.ts),
  which polls the Yahoo Finance RSS feed per symbol. This replaced the
  former FMP /news/stock path (removed April 2026).
- Dual-listed UK companies (BP, VOD) may have their Yahoo RSS news indexed
  under the US ticker instead of the .L form — callers poll both forms and
  deduplicate by URL.
- The queried symbol is authoritative for attribution: article.symbols
  is overridden to the symbol that was polled, regardless of what Yahoo
  returned in the payload.
- The research agent (Sonnet) filters its output against the paper-strategy
  whitelist. Symbols outside the whitelist are dropped before reaching
  news_analyses.
- To surface a new symbol to the news loop, add it to a strategy's universe.
  Do NOT hand-patch the research agent prompt or the Yahoo RSS client to add symbols.
`.trim();
