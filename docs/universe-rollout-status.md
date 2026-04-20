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

1. **Merge PR [#36](https://github.com/CalNicklin/trader-v2/pull/36)** — `fix(universe): fail-partial when a constituent source is blocked`. Generic fix: any source failure no longer aborts the whole refresh, and rows from failed sources are not deactivated. Needed for both the current FMP path and the planned free hybrid stack below. **Status: open, ready to merge.**
2. **Resolve issue [#32](https://github.com/CalNicklin/trader-v2/issues/32)** — FMP paywalled LSE/FTSE endpoints post-Aug-2025; `investable_universe` is empty in prod. Research report: `docs/research/2026-04-20-data-provider-alternatives.md`. **Chosen path: free hybrid stack** (see below). Integration PoC on branch `poc/free-data-sources`.
3. **Review issue [#33](https://github.com/CalNicklin/trader-v2/issues/33)** — Drizzle `migrate()` silently skipped migrations 0014–0016 on prod. Hotfixed manually. Not blocking, but the next migration attempt will reveal whether the root cause remains. Consider adding a post-migrate assertion before Step 3.
4. **Let Step 2 bake for ~10 trading days** (per spec §rollout) — collect data on promotion quality, enrichment cost, demotion rates. Skipping this gate ships watchlist-dependent strategy behaviour without real-world validation. **Gated on #32 resolution** — no promotions until the universe populates.

## Resolution path for #32: Free Hybrid Stack

Full research in `docs/research/2026-04-20-data-provider-alternatives.md`. Chose Option 3 from that report: **free sources for constituents + Yahoo for UK quotes/news + keep FMP for everything still working**. Cost: $0 incremental.

**PoC on branch `poc/free-data-sources`** — two dry-run scripts verify every endpoint works end-to-end:

```bash
bun scripts/free-sources-dryrun.ts    # raw endpoint probes (9/10 pass)
bun scripts/free-hybrid-dryrun.ts     # end-to-end UK universe simulation
```

Verified live (2026-04-20):

| Need | Source | Status |
|---|---|---|
| Russell 1000 constituents | iShares IWB CSV | ✅ 1010 holdings |
| FTSE 100 constituents | iShares ISF CSV | ✅ 100 holdings |
| FTSE 250 constituents | Wikipedia scrape | ✅ 248 tickers |
| AIM All-Share constituents | **hand-curated** | ⚠️ ~5 names (GAW, FDEV, TET, JET2, BOWL) — no free source for full list |
| UK quotes (price + 30d avg vol) | Yahoo chart API | ✅ anonymous, works for AIM too |
| UK news | Yahoo RSS per `.L` symbol | ✅ 21+ items/symbol |
| GBP→USD FX | Frankfurter.dev | ✅ no key |
| US insider (Form 4) | SEC EDGAR direct | ✅ 591 Form-4 in AAPL buffer |
| UK fundamentals (mkt cap, free float, IPO date) | Yahoo v10 quoteSummary | ⚠️ crumb-protected; `yahoo-finance2` npm lib handles it, brittle |
| UK earnings calendar | — | ❌ **no free source** |

**Sample liquidity-filter run** (30 UK names, ≥$5M $ADV + ≥£1 price):
- 30/30 Yahoo fetches succeeded after fixing trailing-dot EPICs (BP., RR., BA.)
- 16/30 pass the filter → projected full UK universe ~187 names after filter
- FTSE 100 almost all pass; FTSE 250 ~50/50; AIM mixed

**Integration plan:**

1. Land PR #36 (fail-partial) — prerequisite
2. Create `src/universe/sources/free/` adapter layer:
   - `ishares-iwb.ts` — Russell 1000 from iShares holdings CSV
   - `ishares-isf.ts` — FTSE 100 from iShares holdings CSV
   - `wikipedia-ftse250.ts` — FTSE 250 from Wikipedia scrape
   - `aim-curated.ts` — hand-maintained AIM whitelist
3. Wire into `src/universe/source-aggregator.ts` as additional source entries; old FMP `fetchFtse350Constituents` / `fetchAimAllShareConstituents` stay as fallback (will gracefully no-op per PR #36 fail-partial semantics).
4. New fundamentals path for UK: since Yahoo v10 is crumb-protected, use iShares CSV `Market Value` column as an approximation for market cap (iShares reports each holding's market value in fund currency — good enough for the ≥£100M free-float filter within a ballpark).
5. Accept gaps: no full AIM, no UK earnings calendar for v1.

**Known fragility watch-list:**
- `yahoo-finance2` breaks ~quarterly when Yahoo rotates crumbs
- iShares CSV URL pattern differs US vs UK (US uses `1467271812596.ajax`, UK uses `1506575576011.ajax`); could change without notice
- BlackRock/iShares ToS technically prohibits automated use (grey zone, fine for paper trading)
- Wikipedia FTSE 250 lags quarterly reviews by ~1 week

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
- #20–#24: Step 1 (ETF exclusion, halt detection, SPAC, SEC flag, learning-loop exclude)
- #25–#31: Step 2 (demotion rules 3/6, N+1 pre-filter, index predicate, dead enum, ingest hot path, tags parsing)
- #32: Infrastructure — FTSE/LSE FMP paywall. **Resolution path chosen: free hybrid stack (Option 3 in research doc).** PoC verified on branch `poc/free-data-sources`. Integration PR pending.
- #33: Infrastructure — Drizzle migration pipeline silently skipping migrations. Hotfixed; needs root-cause fix before next schema change.

## Related PRs / branches

- **PR #36** — `fix/universe-fail-partial`: generic fail-partial source aggregator + deactivation guard. Prerequisite for #32 integration.
- **Branch `poc/free-data-sources`** — PoC scripts + research doc. No source code changes yet; integration PR to follow.
- **PR #34** — this status doc (merged).

## Progress logs (per PR)

- `docs/progress/2026-04-17-universe-research-step1-investable-universe.md`
- `docs/progress/2026-04-17-universe-research-step1a-metrics-enrichers.md` (if present)
- `docs/progress/2026-04-17-universe-step2-watchlist.md`
