# Universe Rollout Step 3 — `news_sentiment_mr_v1` migration

**Status:** Draft — 2026-04-23
**Ticket:** TRA-20
**Parent spec:** `docs/superpowers/specs/2026-04-17-universe-research-architecture-design.md` (§Step 3)
**Live status:** `docs/universe-rollout-status.md`

## One-line goal

Replace the static `universe` JSON column read-path on `news_sentiment_mr_v1` with a filter against the live `watchlist` table — keeping the static column as a compat fallback until dual-write telemetry confirms parity.

## Live watchlist snapshot (what we're migrating onto)

As of 2026-04-23 — Step 2 has been baking for 5 trading days:

| promotion_reasons      | n   |
|------------------------|----:|
| earnings               | 135 |
| news, research         | 11  |
| research               | 3   |
| earnings, news, research | 1 |
| news                   | 1   |
| feedback               | 1   |

- 241 enrichment calls total, $0.85 cost to date (well under budget).
- Active watchlist entries: 152. (Mostly earnings-driven — that's fuel for Step 4, not this step.)
- News/research–only rows: **~16 active** right now. That's the universe candidate size for `news_sentiment_mr_v1` on a typical day.

The strategy's current static universe is 20 symbols (AAPL/MSFT/GOOGL/…/GAW:AIM). Watchlist for news signals would trade a *different* ~16 per day — roughly the same order of magnitude, but dynamically tuned to where the news actually is.

## Schema changes

### `strategies` table

Add one column:

```sql
ALTER TABLE `strategies` ADD `watchlist_filter` text;  -- nullable JSON
```

- Nullable. A null value means "no migration; use static `universe` column as before" — default behaviour preserved.
- Non-null payload is JSON matching the schema below. When set AND the `USE_WATCHLIST` env flag is true, the strategy reads from watchlist.

### `watchlist_filter` JSON schema

```ts
interface WatchlistFilter {
  /** Require the watchlist row's `promotion_reasons` to include at least one of these. */
  promotionReasons: Array<"news" | "research" | "earnings" | "insider" | "volume" | "rotation" | "feedback">;

  /** If true, exclude rows where `enriched_at IS NULL` (Opus hasn't analysed yet). */
  enrichedRequired: boolean;

  /** Filter on `watchlist.horizon`. Empty array = no filter. */
  horizons: Array<"intraday" | "days" | "weeks">;

  /** Filter on `watchlist.directional_bias`. Empty array = no filter. */
  directionalBiases: Array<"long" | "short" | "ambiguous">;

  /** Optional exchange allow-list. Empty = all exchanges allowed. */
  exchanges?: Array<"NASDAQ" | "NYSE" | "LSE" | "AIM">;
}
```

### Migration payload for `news_sentiment_mr_v1`

```json
{
  "promotionReasons": ["news", "research"],
  "enrichedRequired": true,
  "horizons": ["intraday", "days"],
  "directionalBiases": ["long", "short", "ambiguous"],
  "exchanges": ["NASDAQ", "NYSE", "LSE", "AIM"]
}
```

Rationale:
- Strategy signals are `news_sentiment` + `rsi14`. Watchlist rows promoted for news/research are the ones with genuine sentiment evidence; earnings-only rows are Step 4's concern.
- `enrichedRequired: true` — the strategy's edge depends on the LLM's direction call. Rows without it are noise.
- `horizons: [intraday, days]` — strategy exits by `hold_days >= 3`. Don't enter `weeks` horizon rows.
- `directionalBiases` all-inclusive — strategy has both `entry_long` and `entry_short` branches.
- Exchanges explicit and exhaustive — makes it obvious what this filter covers; Step 5 can narrow when per-strategy needs emerge.

## Consumer changes

### New function: `getEffectiveUniverseForStrategy`

Location: `src/strategy/universe.ts` (next to the existing static-universe builder).

```ts
export async function getEffectiveUniverseForStrategy(
  strategy: { id: number; universe: string | null; watchlistFilter: string | null },
): Promise<string[]>;
```

Behaviour:

1. **If** `USE_WATCHLIST !== true` **OR** `strategy.watchlistFilter` is null/empty: return the parsed static `universe` (existing behaviour).
2. **Else**: return the watchlist-filtered symbols.
   - Parse `watchlistFilter` JSON.
   - Query `watchlist WHERE demoted_at IS NULL AND <filter predicates>`.
   - Return as `SYMBOL:EXCHANGE` strings (matching the existing bare/qualified format that `buildEffectiveUniverse` expects).
3. **Regardless of source**, the result continues to flow through the existing `buildEffectiveUniverse` and `filterByLiquidity` pipeline — those functions already handle dedup and stale-quote filtering.

### Evaluator wiring

`src/strategy/evaluator.ts::evaluateAllStrategies` currently reads `strategy.universe` directly and calls `buildEffectiveUniverse`. Change: replace the direct read with `getEffectiveUniverseForStrategy(strategy)`. All downstream paths (exchange-filter, liquidity-filter, dedup, basket-cap) are unchanged.

### Config flag

`src/config.ts`:

```ts
USE_WATCHLIST: z.enum(["true", "false"]).default("false").transform((v) => v === "true"),
```

Global kill switch. Default `false` means **nothing changes in production on deploy** — the watchlist read-path is dormant until the flag is flipped in `.env`.

## Dual-write / parity period

Per spec: ≥5 trading days of overlap before deprecating the static read-path.

### What gets logged each evaluation tick

Add a single structured log line per `evaluateAllStrategies` run **for the migrated strategy**:

```json
{
  "module": "evaluator:universe-compare",
  "strategyId": 1,
  "staticUniverseSize": 20,
  "watchlistUniverseSize": 14,
  "divergence": {
    "onlyStatic": ["JNJ", "GAW:AIM", "VOD:LSE", ...],
    "onlyWatchlist": ["NFLX", "PYPL"],
    "inBoth": ["AAPL", "MSFT", "GOOGL", ...]
  },
  "source": "watchlist" | "static"
}
```

- Log the comparison regardless of which source is live (compute the "off" side for visibility).
- Source = whichever actually drove evaluation this tick.
- Written at `log.info` level to avoid flooding; can be filtered in Grafana/dashboard.

### Success criteria (before Step 4)

After 5 trading days with `USE_WATCHLIST=true` + `news_sentiment_mr_v1` filter set:
- Watchlist path produces ≥50% of the static path's daily trade count (tolerance for legitimate improvement, not a regression).
- No widening of Sharpe drawdown > 20% vs the pre-migration 30d rolling metric.
- Zero ticks where watchlist size = 0 and static size ≥ 5 (would indicate catastrophic miss).

If any criterion fails, flip `USE_WATCHLIST=false` immediately and triage via logs.

## Rollback

Single env change: `USE_WATCHLIST=true → false`, then `systemctl restart trader-v2`. Code paths keep functioning on the static column.

## Eval changes

Add two scenario tasks to `src/evals/universe/`:

1. **Watchlist-only scenario.** Strategy with `watchlist_filter` set, `USE_WATCHLIST=true`. Mock watchlist table with 5 symbols matching the filter predicates. Assert: evaluator processes exactly those 5 symbols, not the static universe.
2. **Watchlist-empty scenario.** Strategy with `watchlist_filter` set, `USE_WATCHLIST=true`, watchlist empty. Assert: evaluator processes zero symbols, emits a clear `universe_empty` log line (not a crash, not silent).

Add to existing unit tests:
- `getEffectiveUniverseForStrategy` with null filter → static path.
- `getEffectiveUniverseForStrategy` with filter + flag false → static path.
- `getEffectiveUniverseForStrategy` with filter + flag true + populated watchlist → filtered watchlist symbols.

## Migration order

This spec delivers **code and schema only** in the first PR. Config (set `watchlist_filter` on strategy 1) is a separate, reversible action.

1. **PR 1 (this spec's output):**
   - Schema migration (add `watchlist_filter` column).
   - `getEffectiveUniverseForStrategy` implementation.
   - Evaluator wiring.
   - `USE_WATCHLIST` env flag.
   - Comparison logging.
   - Tests + evals.
   - `USE_WATCHLIST=false` default → prod behaviour unchanged on deploy.
2. **Config change (after PR 1 merges):**
   - SQL: `UPDATE strategies SET watchlist_filter = '<payload>' WHERE id = 1;`
   - `.env`: `USE_WATCHLIST=true`.
   - Service restart.
3. **Monitor** for 5 trading days via the comparison logs + dashboard.
4. **Close TRA-20** once parity holds.
5. **TRA-21 (Step 4)** covers `earnings_drift_v1` and `earnings_drift_aggressive_v1` with their own `watchlist_filter` payloads.

## Out of scope

- Dropping the static `universe` column — that's Step 5 (TRA-22).
- The `earnings_drift_*` strategies — TRA-21.
- Changes to watchlist promotion/demotion rules — those belong in the universe-followup queue (GH #20–31).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Watchlist empty / thin → strategy goes silent | Dual-write period catches it; `universe_empty` log line surfaces immediately; flag flip reverts in < 1 min |
| Schema migration fails mid-run | Additive column only, nullable; migration has no destructive step |
| Watchlist SQL predicate performance | Watchlist rarely exceeds 200 rows; single indexed query per tick; negligible |
| Divergence from static not matched by P&L improvement | 5-day comparison window; explicit rollback criterion |

## Open questions for reviewer

1. **Should `enrichedRequired: false` be supported?** Writing `true` in the v1 filter assumes Opus analysis is always a win. If an unenriched row is still actionable (cheap news signal), a strategy might want the broader pool. For v1 we keep it `true` — strategy 1's edge is explicitly LLM-assisted.
2. **Should we snapshot the watchlist→universe mapping per tick?** Would aid post-hoc P&L attribution ("why did we trade X? because it was on the watchlist at 14:08"). Out of scope for this PR; propose as a Step 5 follow-up.
3. **Is `USE_WATCHLIST` global or per-strategy?** Current design is global + per-strategy via `watchlist_filter` nullability. Alternative: per-strategy env var. Global + row-level feels cleaner; committing to that unless you disagree.
