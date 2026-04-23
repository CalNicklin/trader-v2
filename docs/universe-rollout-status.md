# Universe Rollout — Status & Next Steps

**Parent spec:** `docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md`
**Cross-cutting monitoring board:** `docs/rollout-monitoring.md`

Four-tier architecture replacing hand-picked 25-symbol seed universes. **Steps 1 / 1a / 2 shipped; Step 3 activated 2026-04-23, parity window open**; Steps 4 / 5 pending.

## Status by step

| Step | PR | Status | Description |
|---|---|---|---|
| 1 — Investable Universe | #17 | **Shipped 2026-04-17** | Tier 1 tables, weekly refresh, snapshots, liquidity filters, `/health` section |
| 1a — Metrics enrichers | #18 | **Shipped 2026-04-17** | FMP profile enrichment with last-known-good cache; filter loosened for US-only |
| 2 — Active Watchlist | #19 | **Shipped 2026-04-18** | Tier 2 tables, catalyst-promoted watchlist with async Opus enrichment, 4 scheduler jobs, hooks in classifier/research-agent/pattern-analysis, `/health` section, eval suite |
| 3 — Migrate `news_sentiment_mr_v1` | #63 (spec) + #64 (impl) + #65 (fix) | **Activated 2026-04-23 09:34 UTC — parity window day 1 of 5** | `watchlist_filter` JSON read-path; `USE_WATCHLIST=true`; dual-write `evaluator:universe-compare` log line active |
| 4 — Migrate `earnings_drift_v1` + `earnings_drift_aggressive_v1` | — | Blocked on Step 3 parity completion (earliest 2026-04-28) | These gain earnings-calendar auto-promotion natively |
| 5 — Retire legacy static universes | — | Pending | Drop the `universe` column from seeds after 30d stable watchlist operation |

## Step 3 — active parity window (TRA-20)

**Activated** 2026-04-23 09:34 UTC: `strategies.watchlist_filter` set on strategy 1 + `USE_WATCHLIST=true` on the VPS.

Live observations (first day, pre-US and into overlap):
- Watchlist size stable at **9** (vs static **20** — filter drops UK names and symbols without recent news/research catalysts)
- Shared entries: **7** NASDAQ mega-caps
- Only-watchlist adds: **NFLX, PYPL** — fresh catalysts not in seed universe
- Only-static drops: 5 US (GOOGL, META, JPM, V, JNJ) + 8 UK/AIM
- **Zero `universe_empty` ticks** across 30+ eval cycles
- Strategy 1 has executed 3 exits via the watchlist path (TSLA +2.6%, JPM ~flat, META +2.0%) — plumbing verified

**Normalization fix:** PR #65 corrected an early log-display bug where bare `"AAPL"` vs `"AAPL:NASDAQ"` counted as divergent. All logs from 2026-04-23 11:33 UTC onward use the corrected diff.

**Criteria to close (see TRA-20):** 5 trading days of data; watchlist trade count ≥50% of static baseline; no Sharpe DD widening >20%; zero catastrophic-miss ticks.

**UK blind spot flagged:** zero UK symbols on the current watchlist (promotions are earnings/news-driven and US-language-heavy). Strategy 1 loses its 10 UK exposures under the watchlist filter today. Worth revisiting before TRA-22 retires the static universe — may need UK-specific watchlist coverage or a compat shim.

## Parallel observation tier — AI-semi (TRA-11)

Not a step of this rollout proper, but operating on the same Tier-1/Tier-2 infrastructure:

- **Shipped** 2026-04-23 as PR #67 (spec: PR #66).
- 13-symbol AI-semi-supply-chain basket (AVGO/MRVL/TSM/ASML/AMAT/KLAC/LRCX/SMCI/MU/WDC/ANET/ADI/INTC) run in **zero-size observation mode**.
- Fires on high-urgency tradeable news from NVDA / AVGO / AMZN / MSFT / GOOGL / META.
- Nightly sweep at 23:15 UK measures T+5 trading day basket moves.
- **Pre-registered activation threshold:** ≥55% of 21-day-window fires produce avg basket move ≥ +2%. Review 2026-05-14.

## Prerequisites before starting Step 3

1. ✅ **PR [#36](https://github.com/CalNicklin/trader-v2/pull/36) — fail-partial aggregator.** Merged 2026-04-20.
2. ✅ **PR [#37](https://github.com/CalNicklin/trader-v2/pull/37) — free-hybrid data stack (UK).** Merged 2026-04-20. Closes issue #33.
3. ✅ **PR [#40 / #42 / #43](https://github.com/CalNicklin/trader-v2/pull/43) — US profile enricher.** EDGAR shares frames + Yahoo US composer replaces FMP `/v3/profile`.
4. ✅ **PR [#44](https://github.com/CalNicklin/trader-v2/pull/44) — FMP removal.** Merged 2026-04-20. Zero FMP dependency: iShares + Wikipedia + Yahoo + Frankfurter + EDGAR + Finnhub + IBKR. FMP subscription can be cancelled.
5. ✅ **PR [#45](https://github.com/CalNicklin/trader-v2/pull/45) — classifier backfill playbook.** Merged 2026-04-20. Handles `classified_at IS NULL` recovery after credit-exhaustion or outage windows.
6. ✅ **PR [#46](https://github.com/CalNicklin/trader-v2/pull/46) — spread filter fix.** Merged 2026-04-20. Without this the universe silently drops 50+ US mega-caps (NFLX/AAPL/NVDA/META/GOOGL) on every refresh.
7. **Review issue [#32](https://github.com/CalNicklin/trader-v2/issues/32)** — Drizzle `migrate()` silently skipped migrations 0014–0016 on prod. Hotfixed manually. Not blocking Step 3, but consider adding a post-migrate assertion before any schema change.
8. **Let Step 2 bake for ~10 trading days** (per spec §rollout) — collect data on promotion quality, enrichment cost, demotion rates.

## Current prod state (2026-04-20, post-fix)

- `investable_universe` active: **1,190** (988 Russell + 200 FTSE + 2 AIM)
- `watchlist` active: **22** (20 news, 5 research; some symbols carry both)
- API spend today: ~$0.64 (within budget)
- News pipeline: polling Finnhub + Yahoo RSS, ~1 new headline per 10-min cycle
- Classifier: healthy post credit refill
- No FMP imports anywhere in codebase

## Free Hybrid Stack (shipped + extended)

Full research in `docs/research/2026-04-20-data-provider-alternatives.md`. Shipped in two waves:

- **Wave 1 (PR #37)** — free sources for UK constituents + Yahoo for UK quotes + FMP kept for US.
- **Wave 2 (PR #44, same day)** — FMP removed entirely. US profile composed from SEC EDGAR + Yahoo v8. US news from Finnhub. UK quotes via IBKR (fallback Yahoo). FX via Frankfurter.

Cost: $0 incremental. Finnhub free tier + IBKR paper subscription already in place.

Verified live (2026-04-20):

| Need | Source | Status |
|---|---|---|
| Russell 1000 constituents | iShares IWB CSV | ✅ ~1004 holdings |
| FTSE 100 constituents | iShares ISF CSV | ✅ ~100 holdings |
| FTSE 250 constituents | Wikipedia scrape | ✅ ~247 tickers |
| AIM All-Share constituents | **hand-curated** | ⚠️ 5 names (GAW, FDEV, TET, JET2, BOWL) — no free source for full list |
| US shares outstanding | SEC EDGAR `/api/xbrl/frames/` | ✅ ~4,000 tickers per quarter; marketCap = shares × price |
| US ticker→CIK map | SEC EDGAR `company_tickers.json` | ✅ ~10,000 rows, cached in `symbol_ciks` |
| US quotes (price + 30d avg vol + $ADV) | Yahoo v8 chart | ✅ `last` only — **bid/ask NOT published** |
| UK quotes (price + 30d avg vol) | Yahoo chart API | ✅ anonymous, AIM works too |
| UK live bid/ask | IBKR (via `@stoqey/ib`) | ✅ feeds spread filter — UK-only |
| US news | Finnhub | ✅ free tier, US-only |
| UK news | Yahoo RSS per `.L` symbol | ✅ wired in PR #44 |
| GBP→USD FX | Frankfurter.dev | ✅ no key, ECB data |
| US earnings calendar | Finnhub | ✅ swapped from FMP in PR #44 |
| UK earnings calendar | — | ❌ no free source, null for UK |
| US insider (Form 4) | SEC EDGAR direct | ✅ not wired yet (wishlist) |
| UK fundamentals (mkt cap, free float, IPO date) | Yahoo v10 quoteSummary | ⚠️ crumb-protected, null for UK rows |

**Dry-run scripts** (still available for diagnostics):

```bash
bun scripts/free-sources-dryrun.ts    # raw endpoint probes (9/10 pass)
bun scripts/free-hybrid-dryrun.ts     # end-to-end UK universe simulation
```

**Known fragility watch-list:**
- iShares CSV URL pattern differs US vs UK (US `1467271812596.ajax`, UK `1506575576011.ajax`); could change without notice — mitigated by PR #36 fail-partial
- BlackRock iShares ToS technically prohibits automated use (grey zone, fine for paper trading)
- Wikipedia FTSE 250 lags quarterly reviews by ~1 week
- Yahoo v8 chart API is stable today; v10 quoteSummary needs crumb dance we avoided

## Step 3 — kickoff checklist

When ready to start:

1. Read `docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md` §Step 3
2. Read this file + the memory at `~/.claude/projects/-Users-Cal-Documents-Projects-trader-v2/memory/project_universe_research_architecture.md`
3. Inspect live watchlist after 10 days:
   - `sqlite3 /opt/trader-v2/data/trader.db 'SELECT promotion_reasons, COUNT(*) FROM watchlist WHERE demoted_at IS NULL GROUP BY 1;'`
   - `sqlite3 /opt/trader-v2/data/trader.db 'SELECT COUNT(*) FROM token_usage WHERE job=\"watchlist_enrich\";'`
   - `/health` watchlist section + dashboard
4. Review open `gh issue list --label universe-followup` — resolve or defer anything blocking Step 3
5. Brainstorm (`brainstorming` skill) the `watchlist_filter` schema: what fields should strategies be able to gate on (directional_bias, horizon, promotion_reasons, enrichedAt != null)?
6. Write a spec covering:
   - `watchlist_filter` JSON schema on the `strategies` row
   - Migration path for existing strategies (null = behave as today)
   - `USE_WATCHLIST` env flag for rollback
   - Strategy-side consumer: how `news_sentiment_mr_v1` reads watchlist instead of static universe
   - Dual-write period (both paths fire, compare decisions) for at least 5 trading days before deprecating the old path
   - Eval changes — the strategy's eval suite needs new scenarios covering watchlist-only and watchlist-empty cases

## Deferred follow-ups (cross-step)

Tracked on GitHub with label `universe-followup`. Review before touching related modules.

```bash
gh issue list --label universe-followup
```

Current (2026-04-20):
- #20–#24: Step 1 (ETF exclusion, halt detection, SPAC, SEC flag, learning-loop exclude) — all open, deferred to post-v1
- #25–#31: Step 2 (demotion rules 3/6, N+1 pre-filter, index predicate, dead enum, ingest hot path, tags parsing) — all open, deferred to post-Step-3
- #32: Infrastructure — Drizzle migration pipeline silently skipping migrations. Hotfixed; needs root-cause fix before next schema change.
- ~~#33: Infrastructure — FTSE/LSE FMP paywall~~ — **closed 2026-04-20** via PR #37 (bypassed FMP with free-hybrid stack).

## Related PRs / branches (all merged)

- **PR #34** — this status doc (merged 2026-04-20).
- **PR #36** — `fix/universe-fail-partial`: fail-partial source aggregator. Merged 2026-04-20.
- **PR #37** — `feat/free-hybrid-data-stack`: replaces FMP UK fetchers with iShares/Wikipedia/Yahoo/Frankfurter. Merged 2026-04-20. Closes #33.
- **PR #40 / #42 / #43** — US profile enricher (EDGAR shares frames + Yahoo US). Shipped 2026-04-20 after revert-of-revert.
- **PR #44** — `refactor/remove-fmp`: removed FMP entirely. Merged 2026-04-20.
- **PR #45** — `scripts/backfill-news-classifications`: one-shot backfill for `classified_at IS NULL` rows. Merged 2026-04-20. Ran on VPS today to classify 440 stuck rows (439 classified, 60 tradeable).
- **PR #46** — `fix/universe-us-spread-filter`: ignore stale US bid/ask in spread filter. Merged 2026-04-20. Recovered 50+ US mega-caps silently dropping out of universe.

## Post-FMP-removal production issues (2026-04-20)

Both issues surfaced after PR #44 merged and were fixed same-day.

1. **Universe stuck at 281 active after FMP removal.** Weekly refresh at 03:00 UTC ran on old FMP code (merge landed later that morning). Triggered manual `runWeeklyUniverseRefresh` → expanded to 1,137 active. Root cause was a deploy-timing artefact, not a code bug. Weekly cron will be correct going forward.

2. **50+ US mega-caps silently rejected** (NFLX, AAPL, NVDA, META, GOOGL, AMD, V, JNJ, PYPL etc.). Root cause: Yahoo v8 chart doesn't publish bid/ask, so `quotes_cache.bid/ask` for NASDAQ/NYSE rows were stale pre-FMP-removal artefacts feeding garbage `spreadBps` into the `MAX_SPREAD_BPS=25` filter. Fix in PR #46 gates spread computation to UK rows only (where IBKR refreshes bid/ask during the UK quote job). Prod hotfix: `UPDATE quotes_cache SET bid=NULL, ask=NULL WHERE exchange IN ('NASDAQ','NYSE')` (196 rows) + re-run refresh + run `scripts/repromote-tradeable-news.ts` (11 missed promotions). Watchlist: 11 → 22 active.

**Lesson:** PR #44 smoke test checked end-to-end universe population but didn't verify specific mega-caps were present. Worth adding to the smoke test: assert `NFLX, AAPL, NVDA, META, GOOGL` all appear in the resulting universe — they're canary tickers that no legitimate liquidity filter should reject.

## Progress logs (per PR)

- `docs/progress/2026-04-17-universe-research-step1-investable-universe.md`
- `docs/progress/2026-04-17-universe-research-step1a-metrics-enrichers.md` (if present)
- `docs/progress/2026-04-17-universe-step2-watchlist.md`
