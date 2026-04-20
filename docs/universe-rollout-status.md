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

1. **Resolve issue [#32](https://github.com/CalNicklin/trader-v2/issues/32)** — FMP paywalled the LSE/FTSE endpoints; `investable_universe` is empty in prod. Until this is fixed, no strategy can benefit from the watchlist because promotions reject with `rejected_not_in_universe`. Options are tracked in the issue (upgrade FMP plan, relax fail-whole and ship US-only, swap sources, drop UK scope).
2. **Review issue [#33](https://github.com/CalNicklin/trader-v2/issues/33)** — Drizzle `migrate()` silently skipped migrations 0014–0016 on prod. Hotfixed manually. Not blocking, but the next migration attempt will reveal whether the root cause remains. Consider adding a post-migrate assertion before Step 3.
3. **Let Step 2 bake for ~10 trading days** (per spec §rollout) — collect data on promotion quality, enrichment cost, demotion rates. Skipping this gate ships watchlist-dependent strategy behaviour without real-world validation.

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

Current (2026-04-18):
- #20–#24: Step 1 (ETF exclusion, halt detection, SPAC, SEC flag, learning-loop exclude)
- #25–#31: Step 2 (demotion rules 3/6, N+1 pre-filter, index predicate, dead enum, ingest hot path, tags parsing)
- #32: Infrastructure — FTSE/LSE FMP paywall (BLOCKS Step 3 until resolved)
- #33: Infrastructure — Drizzle migration pipeline silently skipping migrations

## Progress logs (per PR)

- `docs/progress/2026-04-17-universe-research-step1-investable-universe.md`
- `docs/progress/2026-04-17-universe-research-step1a-metrics-enrichers.md` (if present)
- `docs/progress/2026-04-17-universe-step2-watchlist.md`
