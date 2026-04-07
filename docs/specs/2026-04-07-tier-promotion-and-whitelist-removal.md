# Tier Promotion Automation & Self-Improvement Whitelist Removal

**Date:** 2026-04-07
**Status:** Approved

## Problem

Only paper → probation promotion is automated. Strategies that graduate to probation and perform well in live trading are stuck there — probation → active and active → core require manual intervention. Additionally, the self-improvement module restricts PRs to a whitelist of paths, limiting its ability to improve the full codebase.

## Tier Promotion

### Schedule

Promotion checks run **daily at post-close (22:00)** as a new scheduled job, alongside other analysis jobs. Promotions are not time-sensitive and benefit from a full day's data.

### Probation → Active

All conditions must be met:

- **30+ live trades** since entering probation (counted from `promotedAt` timestamp)
- **Live metrics within 20% of paper values** for: Sharpe ratio, win rate, profit factor
- **No active demotion strikes** (first-strike capital reduction clears this gate)

### Active → Core

All conditions must be met:

- **100+ live trades** since entering active tier
- **Sharpe ≥ 0.5** over live trades
- **Expectancy > 0**
- **No demotions in last 60 days**

### Behavioral Divergence Gate (both transitions)

If live slippage/friction deviates > 20% from paper estimates, **block promotion** and log a warning. This is not a demotion — the strategy holds at its current tier until divergence resolves.

### Schema Change

Add `promotedAt` text column to `strategies` table. Set when a strategy enters any new tier (including paper → probation). Used to count "live trades since entering tier X". Backfill existing probation strategies with their `graduation_events` timestamp.

### Event Logging

All promotions logged as `"promoted"` events in `graduation_events` table with `fromTier`/`toTier` and evidence JSON containing the metrics snapshot that justified promotion.

### Thresholds

These are starting values. The learning loop and self-improvement system can propose adjustments via PRs as real promotion/demotion patterns emerge.

## Self-Improvement Whitelist Removal

### Current State

`src/self-improve/types.ts` defines `WHITELISTED_PATHS` (auto-PR) and `HUMAN_ONLY_PATHS` (issue only). `classifyProposal()` routes proposals to PR, issue, or skip based on these lists.

### Change

- Remove `WHITELISTED_PATHS` and `HUMAN_ONLY_PATHS` from `types.ts`
- Remove `classifyProposal()`, `isWhitelistedPath()`, `isHumanOnlyPath()` from `proposer.ts`
- All proposals become PRs — no more issue routing or skipping
- Budget guard remains as the only throttle
- Update tests to reflect removal

## Files Changed

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `promotedAt` column to strategies table |
| `drizzle/migrations/` | New migration for `promotedAt` column |
| `src/strategy/promotion.ts` | **New** — `checkPromotionEligibility()`, metric comparison, divergence gate |
| `src/scheduler/promotion-job.ts` | **New** — daily job calling promotion checks for all live-tier strategies |
| `src/scheduler/cron.ts` | Register promotion job at 22:05 |
| `src/monitoring/cron-schedule.ts` | Mirror new job |
| `src/strategy/graduation.ts` | Set `promotedAt` when graduating paper → probation |
| `src/self-improve/types.ts` | Remove `WHITELISTED_PATHS`, `HUMAN_ONLY_PATHS` |
| `src/self-improve/proposer.ts` | Remove `classifyProposal`, `isWhitelistedPath`, `isHumanOnlyPath`; all proposals → PR |
| `tests/self-improve/proposer.test.ts` | Update tests for whitelist removal |
| `tests/strategy/promotion.test.ts` | **New** — promotion eligibility tests |
