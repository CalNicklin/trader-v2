# Rollout Monitoring — Active Board

One-page index of everything currently in the watch window. Each section links to its own detailed doc where one exists.

Last refreshed: 2026-04-23.

## 1. Universe Rollout Step 3 — **most recent, parity window open**

Activated 2026-04-23 09:34 UTC. `news_sentiment_mr_v1` now reads from the live watchlist instead of its static `universe` column. Flag: `USE_WATCHLIST=true`.

- [ ] **Days 1–5 post-activation:** log the `evaluator:universe-compare` line every eval cycle. Verify zero `universe_empty` ticks. Confirm trade count not materially regressed vs pre-activation baseline.
  ```bash
  ./scripts/vps-logs.sh --since "1 hour ago" | grep universe-compare | tail -5
  ```
- [ ] **Rollback drill (mental):** flip `USE_WATCHLIST=false` in `/opt/trader-v2/.env`, restart — strategy reverts to static column in under 60s.
- [ ] **UK blind spot follow-up:** watchlist has zero UK symbols today. Strategy 1's 10 UK exposures disappear under the filter. Decide before Step 5: UK-specific watchlist coverage, compat shim, or accept the loss. Ticket not yet filed.
- [ ] At T+5 trading days: close TRA-20 or roll back. Unblocks TRA-21 (Step 4) on success.

Detailed status + criteria: `docs/universe-rollout-status.md` §"Step 3 — active parity window".

## 2. AI-semi observation tier (TRA-11) — **new, 21-day window open**

Shipped 2026-04-23 via PR #67. Zero-size observation. Writes `gate_diagnostic` rows on high-urgency tradeable news from NVDA/AVGO/AMZN/MSFT/GOOGL/META; nightly sweep at 23:15 UK measures T+5 trading day basket moves.

- [ ] **Week 1:** confirm the observer is firing. Expect a handful of fires per week.
  ```bash
  ./scripts/vps-ssh.sh "sqlite3 /opt/trader-v2/data/trader.db 'SELECT COUNT(*), MIN(fired_at), MAX(fired_at) FROM gate_diagnostic;'"
  ```
- [ ] **Nightly:** verify the 23:15 UK sweep runs without error and fills `measured_at` on rows past 5 trading days.
- [ ] **T+21 (2026-05-14):** compute hit-rate. Decision:
  - ≥55% of in-window fires produce avg basket move ≥ +2% → file sized-tier seed ticket (`catalyst_long_semi_v1`).
  - <55% → archive data as null-day denominator; retire the tier.

Detailed spec: `docs/superpowers/specs/2026-04-23-ai-semi-observation-tier-design.md`.

## 3. Catalyst-triggered dispatch — settled baseline

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

## 4. CI/CD deploy health — **daily check**

Added 2026-04-21 after PR #46, #48, #49 all stacked up unmerged to prod for ~14 h because of a git-pull conflict on the VPS working tree. Failures were silent (no alert).

- [ ] **Daily:** `gh run list --limit 5 --branch main` — every entry should say `success`. Any `failure` blocks every subsequent deploy because the git state on the VPS rolls forward in-place.
- [ ] **Root cause of the 2026-04-20 incident:** two ad-hoc scripts (`scripts/backfill-news-classifications.ts`, `scripts/repromote-tradeable-news.ts`) had been `scp`'d or created in place on the prod working tree, then committed to main via PR #45. The subsequent `git pull` refused to overwrite the untracked files ("The following untracked working tree files would be overwritten by merge — Aborting"). Fix: `rm` the files on prod, re-run the workflow. **Rule to avoid repeat: never create or edit files directly on the VPS working tree** — if you need a one-shot script, put it in a PR first, let CI deploy it, then run it. `scp` / ad-hoc `ssh` file creation stacks up conflicts that silently freeze deploys.
- [ ] Consider adding a post-deploy health probe to GitHub Actions that fails the workflow if `/health` doesn't return 200 after the restart. Would turn this from "silent 14 h drift" into a broken-build alarm on the very first failed deploy.

## 5. Drizzle migration pipeline — issue [#32](https://github.com/CalNicklin/trader-v2/issues/32)

Not yet root-caused. `migrate()` silently skipped migrations 0014–0016 on prod once. Hotfixed, but still load-bearing for every PR that ships a schema change.

- [ ] **Every PR adding a migration needs a post-deploy assertion** that `__drizzle_migrations` contains the new idx. PR #48 is the first post-incident schema change — confirms whether the hotfix held.
- [ ] Consider adding a startup-time sanity check (diff the journal against `__drizzle_migrations`) before next schema change.

## 6. Data-stack fragility (background watch)

Per `docs/universe-rollout-status.md` §"Known fragility watch-list". Weekly glance, not daily.

- iShares CSV URL patterns (US vs UK use different `.ajax` IDs). BlackRock ToS grey zone.
- Wikipedia FTSE 250 lags quarterly reviews ~1 week.
- Yahoo v8 chart API stability (no crumb required today; could change).
- Yahoo v10 `quoteSummary` crumb-protected — UK fundamentals stay null.

## How to use this doc

- **Daily ops:** skim §1 + §3 checklists; run §4 CI health check.
- **Before merging any schema change:** re-read §5.
- **Weekly:** glance at §6 fragility list in case a source has rotated.
- **Before starting Step 3:** read `docs/universe-rollout-status.md` end to end.
- **Never create files directly on the prod working tree** — see §4 for why.

When a rollout phase is finished, move the item to that rollout's own status doc rather than leaving stale content here. This board is for **what is currently being watched**, not an archive.
