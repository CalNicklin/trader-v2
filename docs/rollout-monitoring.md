# Rollout Monitoring — Active Board

One-page index of everything currently in the watch window. Each section links to its own detailed doc where one exists.

Last refreshed: 2026-04-20.

## 1. Catalyst-triggered dispatch — **most recent, highest priority**

PR [#48](https://github.com/CalNicklin/trader-v2/pull/48) merged 2026-04-20. Detailed rollout checklist: **`docs/catalyst-dispatch-rollout-status.md`**.

Summary of phases:
- **A (Day 0, now):** verify migration 0018 applied on prod; service restarts clean.
- **B (first 24 h, flag OFF):** scheduled dispatch writes to new DB table; evaluator reads from it; trade volume unchanged; nightly cleanup fires.
- **C (flag flip):** `CATALYST_DISPATCH_ENABLED=true`, watch first 60 min for feedback-loop cap-out.
- **D (first 7 days post-flip):** cost < \$0.05 / day; cap hits rare; paper-trade hourly distribution broadens (target ≥ 30 % outside ±30 min dispatch boundaries); no elevated loss rate on catalyst-sourced trades.

**Kill-switch:** flip the env flag back to `false` and restart. Structural path cannot be flag-disabled — that's a revert of PR #48 on main.

## 2. Universe Step 2 — bake-in window

Detailed status: **`docs/universe-rollout-status.md`**.

- Step 2 (watchlist) merged 2026-04-18. ~10 trading days of bake before Step 3 can start. Currently day 2 of 10.
- Watchlist active count stable 15–40 (currently 22).
- Enrichment Opus spend bounded; demotion rules flushing rows.
- Step 3 kickoff checklist already documented in `docs/universe-rollout-status.md` §"Step 3 — kickoff checklist".

## 3. Post-FMP-removal stability

PRs [#44](https://github.com/CalNicklin/trader-v2/pull/44) (FMP removed) + [#46](https://github.com/CalNicklin/trader-v2/pull/46) (US spread-filter fix) + [#45](https://github.com/CalNicklin/trader-v2/pull/45) (classifier backfill) all merged 2026-04-20. Fresh; watch for regressions.

- [ ] Weekly universe refresh Mon 03:00 UTC produces ≥ 1,000 active rows.
  ```bash
  ./scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db 'SELECT COUNT(*) FROM investable_universe WHERE active=1;'"
  ```
- [ ] Canary mega-caps present: NFLX, AAPL, NVDA, META, GOOGL.
  ```bash
  ./scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db 'SELECT symbol FROM investable_universe WHERE symbol IN (\"NFLX\",\"AAPL\",\"NVDA\",\"META\",\"GOOGL\") AND active=1;'"
  ```
- [ ] `classified_at IS NULL` row count stays near zero. Backfill script exists (PR #45); root cause was credit exhaustion — monitor daily API spend.
- [ ] Yahoo RSS per-symbol polling still returns items for LSE (silent failure mode would starve UK news flow).
- [ ] iShares CSV fetchers still work. PR [#36](https://github.com/CalNicklin/trader-v2/pull/36) fail-partial mitigates partial failure, but a total outage would shrink the universe.

## 4. Drizzle migration pipeline — issue [#32](https://github.com/CalNicklin/trader-v2/issues/32)

Not yet root-caused. `migrate()` silently skipped migrations 0014–0016 on prod once. Hotfixed, but still load-bearing for every PR that ships a schema change.

- [ ] **Every PR adding a migration needs a post-deploy assertion** that `__drizzle_migrations` contains the new idx. PR #48 is the first post-incident schema change — confirms whether the hotfix held.
- [ ] Consider adding a startup-time sanity check (diff the journal against `__drizzle_migrations`) before next schema change.

## 5. Data-stack fragility (background watch)

Per `docs/universe-rollout-status.md` §"Known fragility watch-list". Weekly glance, not daily.

- iShares CSV URL patterns (US vs UK use different `.ajax` IDs). BlackRock ToS grey zone.
- Wikipedia FTSE 250 lags quarterly reviews ~1 week.
- Yahoo v8 chart API stability (no crumb required today; could change).
- Yahoo v10 `quoteSummary` crumb-protected — UK fundamentals stay null.

## How to use this doc

- **Daily ops:** skim §1 and §3 checklists; they have the most active alerts.
- **Before merging any schema change:** re-read §4.
- **Weekly:** glance at §5 fragility list in case a source has rotated.
- **Before starting Step 3:** read `docs/universe-rollout-status.md` end to end.

When a rollout phase is finished, move the item to that rollout's own status doc rather than leaving stale content here. This board is for **what is currently being watched**, not an archive.
