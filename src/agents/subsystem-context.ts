// src/agents/subsystem-context.ts
//
// Subsystem context blocks injected into runtime LLM prompts (evolution,
// dispatch, etc.) so agents understand invariants that are not obvious from
// the current code snapshot. See docs/specs/2026-04-10-lse-news-signal-fix.md
// for rationale.

export const NEWS_PIPELINE_CONTEXT = `
## News pipeline (current architecture)

- UK symbols matched via RSS + RNS text match using FTSE-100 aliases.
- The primary symbol from the RSS matcher is authoritative attribution.
- The research agent (Sonnet) filters its output against the paper-strategy
  whitelist. Symbols outside the whitelist are dropped before reaching
  news_analyses.
- To surface a new symbol to the news loop, add it to a strategy's universe.
  Do NOT hand-patch the research agent prompt to add symbols.
- FTSE-100 aliases are derived dynamically from FMP + src/news/alias-overrides.ts.
  Add nicknames (e.g. "HSBC" for HSBA) to the overrides file, not to rss-feeds.ts.
`.trim();
