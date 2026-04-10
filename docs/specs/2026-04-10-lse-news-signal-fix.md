# LSE News Signal Fix — Design

**Date:** 2026-04-10
**Status:** Design approved, awaiting implementation plan
**Problem statement:** `docs/plans/2026-04-10-lse-news-signal-gap.md`
**Related specs:** `docs/specs/2026-04-08-fmp-migration-ticker-validation.md`, `docs/specs/2026-04-07-news-research-intelligence.md`

## 1. Goal & scope

### Goal

Fix the LSE news→trade pipeline so that FTSE-100 symbols appearing in UK news reliably reach strategy evaluation and can drive paper trades. Move LSE from 0 news-driven trades/week toward parity-of-signal-quality with US (not parity-of-volume — that's source-constrained by the absence of a Finnhub-equivalent UK feed).

### Success metrics (7-day window post-deploy)

- ≥50 LSE `news_analyses` rows (vs 15 current)
- ≥60% of LSE rows have `in_universe=1` (vs 0% current)
- Zero false-ticker trades (maintain post-validation-fix baseline)
- Research-agent eval suite passes ≥90% on regression categories A, B, C

### In scope

1. Research-agent prompt refactor: whitelist-aware, RSS attribution pinned.
2. FTSE-100 universe seeding via FMP constituents endpoint with hand-override alias map.
3. UK source expansion: new free RSS feeds + RNS scraper.
4. Three-layer false-ticker rejection: whitelist filter, `isActivelyTrading` check, RSS alias collision guard.
5. Eval suite extensions in `src/evals/research-agent/` gating CI (5 categories, code + Sonnet judge).
6. Subsystem context documentation for evolution, dispatch, and self-improvement agents.

### Out of scope

- Expanding beyond FTSE-100 (FTSE-250, AIM main) — revisit after FTSE-100 is working end-to-end.
- Paid news APIs (Finnhub premium, RNS paid tier, Bloomberg).
- Classifier changes — the Haiku classifier is called per-symbol and is not the source of the attribution bug.
- Live trading for LSE — remains gated by `LIVE_TRADING_ENABLED`, unchanged.
- LSE execution plumbing (quotes, order routing) — already works.
- Dashboard additions.

## 2. Architecture & data flow

### Revised pipeline

```
UK RSS (10 feeds) + RNS scraper
  → matchArticles()                          [FTSE-100-wide aliases,
                                              financial-context requirement,
                                              per-alias collision blacklist]
  → news-poll-job.ts                         [unchanged]
  → pre-filter.ts                            [unchanged]
  → classifier.ts (Haiku)                    [unchanged, per-symbol]
  → research-agent.ts (Sonnet)               [whitelist in prompt,
                                              primary symbol pinned,
                                              post-parse whitelist filter]
  → fmpValidateSymbol()                      [+ isActivelyTrading check]
  → isSymbolInUniverse() → news_analyses
  → sentiment-writer → quotes_cache          [unchanged]
  → strategy/evaluator → openPaperPosition() [unchanged]
```

### Key invariant

Every symbol that reaches `news_analyses` with `in_universe=1` must be:
- (a) in the FTSE-100 whitelist or existing US universe,
- (b) actively trading per FMP, and
- (c) either matched directly by the RSS/RNS source or a plausible sibling in the same in-universe set.

### Critical-path sequence (research agent)

```
processArticle → article.symbols=[SHEL] (from RSS matcher)
  ↓
runResearchAnalysis(input)
  ↓
buildUniverseWhitelist() → {SHEL:LSE, BP.:LSE, ..., AAPL:NASDAQ, ...}
  ↓
Sonnet call with whitelist + primarySymbol="SHEL"
  ↓
parseResearchResponse → filter by whitelist
  ↓
pin-check: is SHEL in output?
  ├─ yes → proceed
  └─ no  → re-insert with degraded confidence (direction="avoid")
  ↓
for each analysis: fmpValidateSymbol + isSymbolInUniverse → news_analyses
```

## 3. Components

### 3.1 `src/data/ftse100.ts` (new)

```ts
export interface Ftse100Constituent {
  symbol: string;        // normalised, e.g., "SHEL"
  exchange: "LSE";
  companyName: string;   // e.g., "Shell plc"
  aliases: string[];     // derived from company name
}

export async function getFtse100Universe(): Promise<Ftse100Constituent[]>
```

- Fetches from FMP `/api/v3/symbol/FTSE` (verify exact endpoint during implementation; fall back to Wikipedia FTSE-100 scrape if FMP is sparse).
- Normalises `.L` suffix to bare symbol with `exchange="LSE"`.
- Strips "plc", "Holdings plc", "Group plc" from company name to derive primary alias; keeps full name as secondary alias.
- Cached in new DB table `universe_cache` with a 7-day TTL.
- On FMP failure: reads `src/data/ftse100-fallback.json` (committed, hand-maintained ~100-entry safety net).

### 3.2 `src/news/alias-overrides.ts` (new)

```ts
export const ALIAS_OVERRIDES: Record<string, string[]> = {
  SHEL: ["Shell", "Royal Dutch Shell"],
  HSBA: ["HSBC"],
  "BP.": ["BP", "British Petroleum"],
  AZN: ["AstraZeneca"],
  // …
};
```

Merged into FTSE-100 aliases at load time. Reviewable in PRs; drifts slowly.

### 3.3 `src/news/rss-feeds.ts` (modified)

**Dynamic alias loader:**

```ts
async function loadAliases(): Promise<Record<string, string[]>> {
  const constituents = await getFtse100Universe();
  const aliases: Record<string, string[]> = {};
  for (const c of constituents) aliases[c.symbol] = [...c.aliases];
  for (const [sym, extra] of Object.entries(ALIAS_OVERRIDES)) {
    aliases[sym] = [...(aliases[sym] ?? []), ...extra];
  }
  return aliases;
}
```

Cached in module-level variable with 1-hour in-process TTL.

**Financial-context requirement:**

```ts
const FINANCIAL_CONTEXT_TERMS = [
  "plc", "ltd", "holdings", "FTSE", "shares", "stock", "dividend",
  "earnings", "CEO", "results", "trading update", "profit", "revenue",
  "guidance", "pre-tax", "interim", "half-year", "full-year", "AGM",
  "rights issue", "placing",
];

function hasFinancialContext(text: string): boolean {
  const lower = text.toLowerCase();
  return FINANCIAL_CONTEXT_TERMS.some(t => lower.includes(t));
}
```

**Collision blacklist:**

```ts
const COLLISION_BLACKLIST: Record<string, string[]> = {
  SHEL: ["shell script", "shell company", "shell game", "in a shell"],
  "BP.": ["blood pressure", "bp oil spill lawsuit"],
  // tuned via eval tasks over time
};
```

**Updated matching logic:** `matchArticles()` requires (alias match) AND (financial context) AND NOT (collision phrase).

### 3.4 `src/news/rns-scraper.ts` (new)

```ts
export async function fetchRnsNews(symbols: string[]): Promise<RssItem[]>
```

- Per-symbol HTTP fetch of `londonstockexchange.com` RNS news listings (verify exact URL during implementation).
- Parses with `HTMLRewriter`.
- Rate-limit: **1 request/second max**, jitter, polite user agent `TraderV2-Research/1.0`.
- Circuit-breaker: on 3 consecutive 403/429/5xx, disable for the rest of the poll cycle and log a warning to `agent_logs`.
- Output slots into the existing `matchArticles()` path with `source="RNS"`.
- Scope: only fetches for FTSE-100 symbols that appear in at least one paper strategy.

### 3.5 `src/news/uk-feed-config.ts` (new)

Moves feed URLs out of `rss-feeds.ts` and expands to ~10 feeds (existing 5 + Sharecast, Citywire, London South East, Reuters UK Business, Proactive AIM). Any URL that 404s on first fetch is logged and dropped — the process does not fail.

### 3.6 `src/news/research-agent.ts` (modified)

**New helper:**

```ts
async function buildUniverseWhitelist(): Promise<Array<{symbol: string; exchange: string}>>
```

Merges and dedupes universes from all paper strategies.

**Prompt change** (`buildResearchPrompt` gains a `whitelist` parameter):

```
## Tradeable universe
You may ONLY return symbols from this whitelist. Any symbol not in this list
will be dropped. Use the exchange listed.

<whitelist>
SHEL:LSE, BP.:LSE, HSBA:LSE, AZN:LSE, …
</whitelist>

## Primary attribution
This headline was matched to "${primarySymbol}:${primaryExchange}" by the
upstream RSS matcher. Unless the headline is entirely unrelated to that
company, you MUST include "${primarySymbol}" in your output with your
independent sentiment assessment. If the headline IS unrelated, return an
empty array.
```

**Post-parse logic:**

1. Filter output against `whitelistSet`. Log and drop anything not in it.
2. Pin-check: if `primarySymbol` is missing from filtered output AND `primarySymbol` is in the whitelist, re-insert with `sentiment=0`, `direction="avoid"`, `confidence=0.5`, `recommendTrade=false`. Attribution preserved; signal neutralised.

### 3.7 `src/data/fmp.ts` (modified)

`fmpValidateSymbol()` extended to check `isActivelyTrading`:

```ts
const profile = await fetchFmpProfile(symbol, exchange);
if (!profile) return false;
if (profile.isActivelyTrading === false) return false;  // new
return true;
```

Any fixtures/fakes used by existing tests need the new field.

## 4. Eval strategy

All eval work extends `src/evals/research-agent/`. Tasks and graders added to the existing suite — no scaffolding changes.

### 4.1 Task categories (20 tasks total)

| ID | Category | Count | Grader type | Blocking? |
|----|----------|------:|-------------|-----------|
| A  | LSE attribution preservation | 5 | Code: primary symbol present | Yes |
| B  | LSE whitelist compliance      | 5 | Code: every output ∈ whitelist | Yes |
| C  | US regression                 | 5 | Code (reuses existing US grader) | Yes |
| D  | Multi-symbol LSE expansion    | 3 | Code set-containment + Sonnet judge | No (tracked) |
| E  | Deprecated-ticker rejection   | 2 | Code: blacklist ∩ output = ∅ | No (tracked) |

Sits at the floor of CLAUDE.md's 20–50 range. Expand over time if specific failure modes start leaking to production.

**Category A** pulls from production `news_events` via a one-off script (`scripts/export-lse-eval-corpus.ts`) and is hand-labelled for the correct primary symbol. Output saved to `src/evals/research-agent/fixtures/lse-corpus.json`.

**Category B** uses synthetic distractor headlines hand-written to stress the whitelist filter ("Panasonic and Shell announce battery supply deal" with `PANASONIC` absent from the whitelist).

**Category C** reuses existing US headlines already in `src/evals/research-agent/tasks.ts`, re-run with the new prompt.

**Category D** tests legitimate multi-symbol expansion ("Shell and BP raise dividends"). Code grader checks set containment; **Sonnet** judge (one-dimension rubric: "Is the trade thesis plausible given the headline?") runs only when the code grader passes.

**Category E** targets deprecated tickers (`RDSB`, legacy `VOD.L` listing). Paired with a unit test for `fmpValidateSymbol` verifying `isActivelyTrading=false` profiles are rejected, living in `tests/data/fmp.test.ts`.

### 4.2 Graders

New code graders in `src/evals/research-agent/graders.ts`:

```ts
export function primaryPresentGrader(
  expected: { primary: string; exchange: string },
  actual: ResearchAnalysis[],
): GraderResult

export function whitelistComplianceGrader(
  expected: { whitelist: Array<{symbol: string; exchange: string}> },
  actual: ResearchAnalysis[],
): GraderResult

export function negativeRejectionGrader(
  expected: { required: string[]; forbidden: string[] },
  actual: ResearchAnalysis[],
): GraderResult
```

New LLM-judge grader (Sonnet):

```ts
export async function thesisPlausibilityJudge(
  headline: string,
  analyses: ResearchAnalysis[],
): Promise<GraderResult>
```

### 4.3 Trial count, metrics, CI gating

- **3 trials per task** (CLAUDE.md minimum for capability evals — LLM non-determinism).
- Metrics tracked per category: pass rate, mean latency, input+output tokens, cost per task, error rate. Results written to `src/evals/research-agent/results/<date>.json` via existing harness.
- **Regression gate (blocking):** Categories A, B, C must pass ≥90% across 3 trials.
- **Quality tracking (non-blocking):** Categories D, E tracked but don't block. Promoted to blocking once they stabilise.
- CI hook extends `src/evals/run.ts`. GitHub Actions runs the research-agent suite on any PR touching `src/news/research-agent.ts`, `src/news/rss-feeds.ts`, or `src/data/ftse100.ts`.

### 4.4 Eval corpus bootstrap

**`scripts/export-lse-eval-corpus.ts`** (new, one-off):
- Queries production DB via `scripts/vps-ssh.sh` for LSE-tagged `news_events` rows over the last 90 days that produced `news_analyses`.
- Emits headline + source + initial classification + RSS-matched primary symbol as JSON.
- Committed to `src/evals/research-agent/fixtures/lse-corpus.json`.
- Run once at build time, re-run manually quarterly to refresh.

**Human review step:** after the script runs, hand-label the "correct" primary symbol for each entry — 5 entries takes roughly 10 minutes. No model-labelled ground truth; that's how regressions sneak in.

## 5. Agent context for evolution & self-improvement

### 5.1 Two audiences, two mechanisms

| Agent | Runtime | Context mechanism |
|---|---|---|
| Self-improvement (weekly) | Claude Code action in `.github/workflows/claude.yml` | Auto-loads nested `CLAUDE.md` files |
| Evolution (daily tournaments) | Direct Anthropic SDK call in `src/evolution/prompt.ts` | Runtime prompt injection |
| Dispatch (session boundaries) | Direct SDK call in `src/scheduler/dispatch.ts` | Runtime prompt injection |
| Research agent (real-time) | Direct SDK call in `src/news/research-agent.ts` | Already gets full task-specific prompt; no injection needed |

### 5.2 Nested `CLAUDE.md` files (for self-improvement)

**`src/news/CLAUDE.md`** (new, ~80 lines) — subsystem guide covering:
- End-to-end pipeline map (kept in sync with this spec by convention).
- Attribution invariants: "RSS matcher is authoritative for UK symbols; research agent can augment but must not replace the primary symbol."
- Whitelist contract: "research-agent output is filtered against paper-strategy universes. Any changes to the whitelist builder must preserve this filter."
- Alias management: "FTSE-100 aliases are derived dynamically from FMP + `alias-overrides.ts`. Do not hand-edit `rss-feeds.ts` to add aliases — add them to the overrides file."
- Collision blacklist rationale: "per-symbol phrase blacklist to block known alias collisions. When tuning, add eval tasks in `src/evals/research-agent/` before editing the blacklist."
- Pointers: this spec, the original problem statement, the eval suite directory.
- Things not to change without a spec update: primary-symbol pin logic, whitelist filter, RSS financial-context requirement.

**`src/evals/research-agent/CLAUDE.md`** (new, ~60 lines) — eval-suite guide covering:
- Where the LSE corpus comes from (`fixtures/lse-corpus.json`) and how to refresh it.
- The 5 task categories (A–E).
- Which categories are blocking vs tracked.
- How to add a new task without breaking the regression gate.

### 5.3 Runtime prompt injection (for evolution/dispatch)

**`src/agents/subsystem-context.ts`** (new) — single source of truth for subsystem summaries injected into LLM prompts:

```ts
export const NEWS_PIPELINE_CONTEXT = `
## News pipeline (current architecture)

- UK symbols matched via RSS + RNS text match using FTSE-100 aliases.
- Primary symbol from the RSS matcher is authoritative.
- Research agent (Sonnet) filters output against the paper-strategy whitelist.
- Any symbol not in a paper strategy universe is dropped before it reaches
  news_analyses.
- To surface a new symbol to the news loop, add it to a strategy's universe
  — do NOT hand-patch the research agent.
`;
```

**Injection sites:**
- `src/evolution/prompt.ts` — imported into the evolution prompt's subsystem-context section so evolution understands that mutating a strategy's universe has downstream news-attribution consequences.
- `src/scheduler/dispatch.ts` — imported into the dispatch prompt so Claude knows LSE symbols only receive news if they're in a paper strategy universe.
- `src/news/research-agent.ts` — NOT injected. The research agent's full prompt is already constructed specifically for its task.

### 5.4 Discipline

- **Spec cross-reference.** Both `CLAUDE.md` files and `subsystem-context.ts` cite this spec at the top. Agents touching them without touching the spec is a signal to re-check.
- **Eval-gated changes.** Any edit to the research-agent prompt or the whitelist logic must go through the eval suite before merging. `src/news/CLAUDE.md` states this explicitly.
- **Weekly self-improvement agent** already reads root `CLAUDE.md` and specs in `docs/specs/` per `.github/workflows/claude.yml` line 62 — it will see this spec the next time it runs.

## 6. Rollout

Ordered so each phase is independently verifiable and any one can be halted without breaking production.

### Phase 0 — Agent context (documentation only)

Ship `src/news/CLAUDE.md`, `src/evals/research-agent/CLAUDE.md`, and `src/agents/subsystem-context.ts` with the evolution/dispatch prompt injections wired in. No behaviour change.

**Why first:** if self-improvement runs mid-rollout, it sees the in-progress invariants and does not "help" by editing the research-agent prompt in parallel.

### Phase 1 — FTSE-100 universe seeding

Ship `src/data/ftse100.ts`, `universe_cache` table, `ftse100-fallback.json`, and `scripts/seed-ftse100.ts` (dry-run first, then execute against paper strategy universes).

**Verification:** `news_events` LSE row count jumps (no attribution fix yet, so `in_universe` remains low).

### Phase 2 — RSS/RNS source expansion

Ship `src/news/uk-feed-config.ts`, `rns-scraper.ts`, `alias-overrides.ts`, collision blacklist, and financial-context filter.

**Verification:** `news_events` LSE row count per day ≥ 3x previous baseline over a 48-hour window.

### Phase 3 — Research-agent refactor (load-bearing)

Ship `research-agent.ts` prompt changes + whitelist filter + primary-symbol pinning. Eval suite gates CI — PR does not merge unless Categories A, B, C hit ≥90%.

**Verification:** within 48 hours of deploy, `news_analyses` LSE rows with `in_universe=1` cross >0, then grow.

### Phase 4 — FMP `isActivelyTrading` guard

One-line fix in `fmp.ts`. Tests updated. Deploy independently.

**Verification:** integration test passes locally; spot-check an `RDSB` lookup returns `false`.

### Phase 5 — Post-deploy validation (7-day window)

Measure the success metrics from Section 1. If any metric fails, halt and diagnose before further LSE work.

## 7. Migrations

Single Drizzle migration adds `universe_cache`:

```ts
export const universeCache = sqliteTable("universe_cache", {
  key: text("key").primaryKey(),
  data: text("data").notNull(),           // JSON blob
  fetchedAt: integer("fetched_at").notNull(),
});
```

Generated via `bun run db:generate` per project convention.

## 8. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| FMP FTSE-100 endpoint returns sparse/empty data | Medium | High | Fallback JSON file committed; loader falls through cleanly |
| RNS scraper breaks from HTML change or gets 403-banned | High over months | Medium | Circuit breaker + log warning; RSS path still runs if RNS is down |
| Whitelist filter is too aggressive, drops legitimate US symbols | Medium | High | Category C eval tasks gate CI; staged rollout; env-var kill-switch `RESEARCH_WHITELIST_ENFORCE=false` |
| RSS financial-context filter drops too many headlines (recall loss) | Medium | Medium | Start with broad term list; tune via Category A eval tasks; monitor `news_events` daily count for regression |
| Cost rises (more research-agent calls from more LSE articles) | Low | Low | Sonnet at ~$0.003/call; even 10× LSE volume ≈ $0.30/day. `canAffordCall` guard already caps daily spend |
| Primary-symbol pinning clutters `news_analyses` with neutralised rows | Low | Low | Tagged `direction="avoid"` + `confidence=0.5`; won't trigger trades; visible in logs |
| Scraper ToS risk for RNS | Low but present | Medium | Polite rate limit, user agent, circuit break. If LSE sends a cease request, rip out the scraper — free RSS still runs |

## 9. Feature flags / kill-switches

- `RESEARCH_WHITELIST_ENFORCE` (default `true`) — set to `false` to revert to current behaviour.
- `RNS_SCRAPER_ENABLED` (default `true`) — disables the RNS scraper.

Both documented in `.env.example`.

## 10. Explicit non-goals

- Classifier prompt changes (the addendum to the problem statement proves this is not the source of the bug).
- Multi-exchange symbol collision handling (e.g., HSBC cross-listings).
- Smarter UK universe injection strategy — current injection is adequate.
- Dashboard query additions (mentioned only as verification aid in Phase 3).
