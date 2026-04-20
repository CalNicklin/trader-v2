# Universe Rollout — Status & Next Steps

**Parent spec:** `docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md`

Four-tier architecture replacing hand-picked 25-symbol seed universes. **Steps 1 / 1a / 2 shipped**; Steps 3 / 4 / 5 pending.

## Status by step

| Step | PR | Status | Description |
|---|---|---|---|
| 1 — Investable Universe | #17 | **Shipped 2026-04-17** | Tier 1 tables, weekly refresh, snapshots, liquidity filters, `/health` section |
| 1a — Metrics enrichers | #18 | **Shipped 2026-04-17** | FMP profile enrichment with last-known-good cache; filter loosened for US-only |
| 2 — Active Watchlist | #19 | **Shipped 2026-04-18** | Tier 2 tables, catalyst-promoted watchlist with async Opus enrichment, 4 scheduler jobs, hooks in classifier/research-agent/pattern-analysis, `/health` section, eval suite |
| 3 — Migrate `news_sentiment_mr_v1` | — | **Next** | Replace static `universe` field on that strategy with `watchlist_filter` JSON; env flag `USE_WATCHLIST` for rollback |
| 4 — Migrate `earnings_drift_v1` + `earnings_drift_aggressive_v1` | — | Pending | These gain earnings-calendar auto-promotion natively |
| 5 — Retire legacy static universes | — | Pending | Drop the `universe` column from seeds after 30d stable watchlist operation |

## Prerequisites before starting Step 3

1. ✅ **PR [#36](https://github.com/CalNicklin/trader-v2/pull/36) — fail-partial aggregator.** Merged 2026-04-20. Single source failures no longer abort the whole refresh; rows from failed sources are not deactivated.
2. ✅ **PR [#37](https://github.com/CalNicklin/trader-v2/pull/37) — free-hybrid data stack.** Merged 2026-04-20. Closes issue #33 (FMP 403). UK + US constituents now sourced from iShares CSVs + Wikipedia; UK price/volume from Yahoo chart; FX from Frankfurter. Full details in §Free Hybrid Stack below.
3. **Review issue [#32](https://github.com/CalNicklin/trader-v2/issues/32)** — Drizzle `migrate()` silently skipped migrations 0014–0016 on prod. Hotfixed manually. Not blocking Step 3, but the next migration attempt will reveal whether the root cause remains. Consider adding a post-migrate assertion before any schema change in Step 3.
4. **Populate the universe in prod** — deploy happens automatically on merge to main; SSH to VPS and trigger `runWeeklyUniverseRefresh` once (or wait for Monday 03:00 UTC cron) to backfill `investable_universe`. Verify `/health` `universe.bySource` shows populated counts.
5. **Let Step 2 bake for ~10 trading days** (per spec §rollout) — collect data on promotion quality, enrichment cost, demotion rates. Skipping this gate ships watchlist-dependent strategy behaviour without real-world validation.

## Free Hybrid Stack (shipped)

Full research in `docs/research/2026-04-20-data-provider-alternatives.md`. Chose Option 3 from that report: **free sources for constituents + Yahoo for UK quotes + keep FMP for US profile/news/quotes**. Cost: $0 incremental.

Verified live (2026-04-20):

| Need | Source | Status |
|---|---|---|
| Russell 1000 constituents | iShares IWB CSV | ✅ ~1010 holdings |
| FTSE 100 constituents | iShares ISF CSV | ✅ ~100 holdings |
| FTSE 250 constituents | Wikipedia scrape | ✅ ~248 tickers |
| AIM All-Share constituents | **hand-curated** | ⚠️ 5 names (GAW, FDEV, TET, JET2, BOWL) — no free source for full list |
| UK quotes (price + 30d avg vol) | Yahoo chart API | ✅ anonymous, AIM works too |
| UK news | Yahoo RSS per `.L` symbol | ✅ (not wired yet — see follow-ups) |
| GBP→USD FX | Frankfurter.dev | ✅ no key, ECB data |
| US profile / quotes / news / earnings | FMP (existing) | ✅ still works for US |
| US insider (Form 4) | SEC EDGAR direct | ✅ not wired yet (wishlist) |
| UK fundamentals (mkt cap, free float, IPO date) | Yahoo v10 quoteSummary | ⚠️ crumb-protected, null for UK rows in v1 |
| UK earnings calendar | — | ❌ no free source, null for UK in v1 |

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
- **PR #39** — `fix/get-profiles-batch-sqlite-limit`: batches getProfiles to avoid expression-tree overflow (>1000 symbols). Merged 2026-04-20.
- **PR #40** — `feat/us-profile-enricher`: SEC EDGAR + Yahoo US composer for Russell 1000 profile data. Merged 2026-04-20.
- **PR #41** — `test/uk-pipeline-smoke`: UK-only smoke test script. Merged 2026-04-20.
- **PR #43** — `restore/pr-40-us-profile-enricher`: re-applied PR #40 after a mistaken revert. Merged 2026-04-20.
- **PR #44** — `refactor/remove-fmp`: removes FMP entirely; all call sites migrated to Yahoo/IBKR/EDGAR/Frankfurter/Finnhub. **Merged 2026-04-20.** FMP subscription can now be cancelled.

## Current data stack (post-PR #44)

| Need | Source | Notes |
|---|---|---|
| Russell 1000 constituents | iShares IWB CSV | ~1004 names daily |
| FTSE 350 constituents | iShares ISF CSV + Wikipedia FTSE 250 | ~347 names combined |
| AIM All-Share constituents | hand-curated whitelist | 5 names (GAW, FDEV, TET, JET2, BOWL) |
| US profile (market cap, shares, IPO date) | SEC EDGAR `company_tickers.json` + `/api/xbrl/frames/` | free, official, no auth |
| US price + avg volume | Yahoo v8 chart | `query1.finance.yahoo.com/v8/finance/chart/{symbol}` |
| UK price + avg volume | Yahoo v8 chart + Frankfurter FX | `.L` suffix, GBp→USD conversion |
| UK news | Yahoo RSS per `.L` | `finance.yahoo.com/rss/headline?s=BP.L` |
| US news | Finnhub `/company-news` | unchanged, existing subscription |
| US earnings calendar | Finnhub `/calendar/earnings` | swapped from FMP in PR #44 |
| UK earnings calendar | **GAP** | no free source; same gap as before |
| US insider (Form 4) | **available via SEC EDGAR** | not yet wired; wishlist |
| FX (GBP/USD) | Frankfurter.dev | ECB data, no auth |
| US quotes (runtime) | Yahoo v8 chart | was FMP `/stable/quote`; swapped in PR #44 |
| UK quotes (runtime) | IBKR via `broker/market-data` | unchanged |
| Historical bars | Yahoo v8 chart (US) + IBKR (UK) | was FMP in PR #44 |

**Zero FMP dependency.** Full refresh takes ~39s (iShares + Wikipedia + EDGAR + Yahoo enrichment, throttled).

## Progress logs (per PR)

- `docs/progress/2026-04-17-universe-research-step1-investable-universe.md`
- `docs/progress/2026-04-17-universe-research-step1a-metrics-enrichers.md` (if present)
- `docs/progress/2026-04-17-universe-step2-watchlist.md`
